package main

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync/atomic"

	"gopkg.in/yaml.v3"
)

// MCP token authentication.
//
// Auth is on by default: a config with no mcp.require_auth key requires a
// token, and a config with no mcp.auth_token gets a random one at startup,
// written back to config.yaml so it survives restarts and shows in the admin
// UI. The admin can replace the token or turn the requirement off from
// admin.html -> Config, and the change applies to the next request without a
// restart.
//
// The live settings sit behind an atomic pointer rather than in Config.MCP so
// the admin save path can swap them while HandleMCP is reading them.

// Token rules, for an admin-set token and one read from config.yaml alike.
// The charset is RFC 3986 "unreserved", so a token goes into a header, a URL
// query and YAML unchanged, with nothing to escape or mis-quote.
const (
	mcpMinTokenLength = 32
	mcpMaxTokenLength = 256
)

type mcpAuthSettings struct {
	required bool
	token    string
}

var mcpAuth atomic.Pointer[mcpAuthSettings]

// RequiresAuth reports the configured require_auth value, defaulting to true.
func (mc *MCPConfig) RequiresAuth() bool {
	return mc.RequireAuth == nil || *mc.RequireAuth
}

// setMCPAuth publishes the auth settings HandleMCP checks.
func setMCPAuth(required bool, token string) {
	mcpAuth.Store(&mcpAuthSettings{required: required, token: token})
}

// currentMCPToken returns the token in effect, or "" before startup has set one.
func currentMCPToken() string {
	if s := mcpAuth.Load(); s != nil {
		return s.token
	}
	return ""
}

// generateMCPToken returns 32 random bytes as 64 hex characters, which are safe
// in a header, a URL and YAML without quoting.
func generateMCPToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// validateMCPToken checks a token against the rules above.
func validateMCPToken(token string) error {
	if len(token) < mcpMinTokenLength || len(token) > mcpMaxTokenLength {
		return fmt.Errorf("MCP auth token must be %d to %d characters long", mcpMinTokenLength, mcpMaxTokenLength)
	}
	for i := 0; i < len(token); i++ {
		c := token[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		case c == '-', c == '.', c == '_', c == '~':
		default:
			return fmt.Errorf("MCP auth token may only contain letters, digits and - . _ ~")
		}
	}
	return nil
}

// mcpRequestToken returns the token a request carries, from the Authorization
// header or, for clients that can only be given a URL, the token query
// parameter.
func mcpRequestToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); h != "" {
		if scheme, rest, ok := strings.Cut(h, " "); ok && strings.EqualFold(scheme, "Bearer") {
			return strings.TrimSpace(rest)
		}
	}
	return r.URL.Query().Get("token")
}

// checkMCPAuth reports whether the request may proceed. When it returns false
// it has already written a 401.
func checkMCPAuth(w http.ResponseWriter, r *http.Request) bool {
	s := mcpAuth.Load()
	if s == nil || !s.required {
		return true
	}
	got := mcpRequestToken(r)
	if s.token != "" && got != "" && len(got) <= mcpMaxTokenLength && subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) == 1 {
		return true
	}
	log.Printf("MCP access denied for IP %s (missing or wrong auth token)", getClientIP(r))
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("WWW-Authenticate", `Bearer realm="UberSDR MCP"`)
	w.WriteHeader(http.StatusUnauthorized)
	w.Write([]byte(`{"error":"Unauthorized: send the MCP auth token as 'Authorization: Bearer <token>' or ?token=<token>"}` + "\n"))
	return false
}

// ensureMCPAuthForStartup fills in the auth defaults — require_auth: true and a
// generated auth_token — writes any it added back to config.yaml, and
// publishes the result. A config file that cannot be written is not fatal: the
// generated token works until the next restart, which will generate another.
func ensureMCPAuthForStartup(config *Config, configPath string) {
	mc := &config.MCP
	addFlag := mc.RequireAuth == nil
	addToken := strings.TrimSpace(mc.AuthToken) == ""

	if addFlag {
		t := true
		mc.RequireAuth = &t
	}
	if addToken {
		token, err := generateMCPToken()
		if err != nil {
			// No token means no one gets in while auth is required, which is
			// the safe way to fail.
			log.Printf("Warning: failed to generate MCP auth token: %v", err)
		}
		mc.AuthToken = token
	}
	effective := mc.AuthToken
	if effective != "" {
		if err := validateMCPToken(effective); err != nil {
			// Fail closed: a weak or malformed token in config.yaml is not
			// accepted, so no client gets in until it is fixed.
			log.Printf("ERROR: mcp.auth_token in %s is invalid (%v); MCP clients will be refused until it is replaced", configPath, err)
			effective = ""
		}
	}
	setMCPAuth(mc.RequiresAuth(), effective)

	if !addFlag && !addToken {
		return
	}
	set := map[string]interface{}{}
	if addFlag {
		set["require_auth"] = true
	}
	if addToken && mc.AuthToken != "" {
		set["auth_token"] = mc.AuthToken
	}
	if err := writeMCPKeys(configPath, set); err != nil {
		log.Printf("Warning: MCP auth defaults could not be saved to %s: %v (the token will change on restart)", configPath, err)
		return
	}
	if addToken {
		log.Printf("Generated MCP auth token and saved it to %s (mcp.auth_token)", configPath)
	}
}

// writeMCPKeys sets keys under the top-level mcp mapping of the YAML file,
// creating the mapping if needed. It edits the node tree rather than a
// map[string]interface{} so comments and key order survive.
func writeMCPKeys(path string, set map[string]interface{}) error {
	if len(set) == 0 {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return err
	}
	if len(doc.Content) == 0 {
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}}
	}
	root := doc.Content[0]
	if root.Kind != yaml.MappingNode {
		return fmt.Errorf("top level of config is not a mapping")
	}

	mcpNode := yamlMapValue(root, "mcp")
	if mcpNode == nil || mcpNode.Kind != yaml.MappingNode {
		fresh := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		if mcpNode == nil {
			root.Content = append(root.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "mcp"}, fresh)
		} else {
			// mcp: with no value (null) — replace it in place.
			*mcpNode = *fresh
		}
		mcpNode = yamlMapValue(root, "mcp")
	}

	for _, key := range []string{"require_auth", "auth_token"} {
		v, ok := set[key]
		if !ok {
			continue
		}
		var val yaml.Node
		if err := val.Encode(v); err != nil {
			return err
		}
		if existing := yamlMapValue(mcpNode, key); existing != nil {
			existing.Kind, existing.Tag, existing.Value, existing.Style, existing.Content = val.Kind, val.Tag, val.Value, val.Style, nil
		} else {
			mcpNode.Content = append(mcpNode.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, &val)
		}
	}

	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&doc); err != nil {
		return err
	}
	if err := enc.Close(); err != nil {
		return err
	}
	return writeConfigAtomic(path, buf.Bytes())
}

// yamlMapValue returns the value node for key in a mapping node, or nil.
func yamlMapValue(m *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

// prepareMCPAuthForSave runs on the admin write path against the config map
// about to be written. A blank or missing token keeps the current one (so an
// import of an older config, or clearing the field, does not lock clients
// out); anything else must pass validateMCPToken.
func prepareMCPAuthForSave(configMap map[string]interface{}, current string) error {
	mcpSec, ok := configMap["mcp"].(map[string]interface{})
	if !ok {
		if v, present := configMap["mcp"]; present && v != nil {
			return fmt.Errorf("mcp must be a mapping")
		}
		return nil
	}
	// require_auth is left to marshalMainConfigYAML, which coerces it to the
	// declared bool or rejects it.
	raw, present := mcpSec["auth_token"]
	tok := ""
	if present && raw != nil {
		s, ok := raw.(string)
		if !ok {
			return fmt.Errorf("mcp.auth_token must be a string")
		}
		tok = s
	}
	if tok == "" {
		if current == "" {
			return fmt.Errorf("mcp.auth_token is empty and no token is in effect; set or generate one")
		}
		mcpSec["auth_token"] = current
		return nil
	}
	if err := validateMCPToken(tok); err != nil {
		return err
	}
	return nil
}

// applyMCPAuthFromYAML publishes the auth settings in a config file that has
// just been written, so they apply without a restart.
func applyMCPAuthFromYAML(data []byte) {
	var parsed struct {
		MCP MCPConfig `yaml:"mcp"`
	}
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		log.Printf("Warning: MCP auth settings not applied live: %v", err)
		return
	}
	token := parsed.MCP.AuthToken
	if validateMCPToken(token) != nil {
		token = ""
	}
	if token == "" {
		if cur := mcpAuth.Load(); cur != nil {
			token = cur.token
		}
	}
	setMCPAuth(parsed.MCP.RequiresAuth(), token)
}
