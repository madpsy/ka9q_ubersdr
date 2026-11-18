package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateMCPToken(t *testing.T) {
	good := []string{
		strings.Repeat("a", 32),
		strings.Repeat("Z9", 128),
		"abcdefghijklmnopqrstuvwxyz-._~0123456789",
	}
	for _, tok := range good {
		if err := validateMCPToken(tok); err != nil {
			t.Errorf("validateMCPToken(%q) = %v, want ok", tok, err)
		}
	}
	bad := []string{
		"",
		strings.Repeat("a", 31),
		strings.Repeat("a", 257),
		strings.Repeat("a", 31) + " ",
		strings.Repeat("a", 31) + "\n",
		strings.Repeat("a", 31) + "&",
		strings.Repeat("a", 31) + "=",
		strings.Repeat("a", 31) + "#",
		strings.Repeat("a", 31) + "\"",
		strings.Repeat("a", 31) + "é",
		strings.Repeat("a", 31) + "\x00",
	}
	for _, tok := range bad {
		if err := validateMCPToken(tok); err == nil {
			t.Errorf("validateMCPToken(%q) = nil, want error", tok)
		}
	}
}

func TestGenerateMCPTokenIsValid(t *testing.T) {
	a, err := generateMCPToken()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := generateMCPToken()
	if len(a) != 64 || a == b {
		t.Fatalf("tokens %q %q: want 64 chars and distinct", a, b)
	}
	if err := validateMCPToken(a); err != nil {
		t.Fatalf("generated token fails validation: %v", err)
	}
}

func TestCheckMCPAuth(t *testing.T) {
	defer mcpAuth.Store(nil)
	tok := strings.Repeat("k", 40)
	setMCPAuth(true, tok)

	cases := []struct {
		name   string
		header string
		query  string
		want   bool
	}{
		{"none", "", "", false},
		{"bearer", "Bearer " + tok, "", true},
		{"bearer lowercase scheme", "bearer " + tok, "", true},
		{"wrong bearer", "Bearer " + strings.Repeat("x", 40), "", false},
		{"prefix only", "Bearer " + tok[:39], "", false},
		{"basic scheme", "Basic " + tok, "", false},
		{"query", "", tok, true},
		{"wrong query", "", "nope", false},
	}
	for _, c := range cases {
		u := "/api/mcp"
		if c.query != "" {
			u += "?token=" + c.query
		}
		r := httptest.NewRequest(http.MethodPost, u, nil)
		if c.header != "" {
			r.Header.Set("Authorization", c.header)
		}
		w := httptest.NewRecorder()
		if got := checkMCPAuth(w, r); got != c.want {
			t.Errorf("%s: checkMCPAuth = %v, want %v", c.name, got, c.want)
		}
		if !c.want && w.Code != http.StatusUnauthorized {
			t.Errorf("%s: status %d, want 401", c.name, w.Code)
		}
	}

	// An empty token in effect (invalid config) refuses everyone, even an
	// empty credential.
	setMCPAuth(true, "")
	r := httptest.NewRequest(http.MethodPost, "/api/mcp?token=", nil)
	r.Header.Set("Authorization", "Bearer ")
	if checkMCPAuth(httptest.NewRecorder(), r) {
		t.Error("empty token in effect let a request through")
	}

	// Auth off lets everything through.
	setMCPAuth(false, tok)
	if !checkMCPAuth(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/mcp", nil)) {
		t.Error("require_auth false still refused")
	}
}

func TestEnsureMCPAuthForStartupWritesDefaults(t *testing.T) {
	defer mcpAuth.Store(nil)
	path := filepath.Join(t.TempDir(), "config.yaml")
	orig := "# top comment\nadmin:\n  callsign: N0CALL\nmcp:\n  # keep me\n  enabled: true\n"
	if err := os.WriteFile(path, []byte(orig), 0644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	ensureMCPAuthForStartup(cfg, path)

	if !cfg.MCP.RequiresAuth() || validateMCPToken(cfg.MCP.AuthToken) != nil {
		t.Fatalf("defaults not applied: require=%v token=%q", cfg.MCP.RequiresAuth(), cfg.MCP.AuthToken)
	}
	data, _ := os.ReadFile(path)
	out := string(data)
	for _, want := range []string{"# top comment", "# keep me", "require_auth: true", "auth_token: " + cfg.MCP.AuthToken} {
		if !strings.Contains(out, want) {
			t.Errorf("rewritten config missing %q:\n%s", want, out)
		}
	}

	// Second boot keeps the same token.
	cfg2, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	ensureMCPAuthForStartup(cfg2, path)
	if cfg2.MCP.AuthToken != cfg.MCP.AuthToken {
		t.Fatalf("token changed across restarts")
	}
	if currentMCPToken() != cfg.MCP.AuthToken {
		t.Fatalf("token not published")
	}
}

func TestEnsureMCPAuthForStartupFailsClosedOnBadToken(t *testing.T) {
	defer mcpAuth.Store(nil)
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("mcp:\n  require_auth: true\n  auth_token: short\n"), 0644); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	ensureMCPAuthForStartup(cfg, path)
	r := httptest.NewRequest(http.MethodPost, "/api/mcp", nil)
	r.Header.Set("Authorization", "Bearer short")
	if checkMCPAuth(httptest.NewRecorder(), r) {
		t.Fatal("invalid configured token was accepted")
	}
}

func TestPrepareMCPAuthForSave(t *testing.T) {
	cur := strings.Repeat("c", 64)

	m := map[string]interface{}{"mcp": map[string]interface{}{"auth_token": ""}}
	if err := prepareMCPAuthForSave(m, cur); err != nil {
		t.Fatal(err)
	}
	if m["mcp"].(map[string]interface{})["auth_token"] != cur {
		t.Error("blank token did not keep the current one")
	}

	m = map[string]interface{}{"mcp": map[string]interface{}{}}
	if err := prepareMCPAuthForSave(m, cur); err != nil || m["mcp"].(map[string]interface{})["auth_token"] != cur {
		t.Error("missing token did not keep the current one")
	}

	for _, v := range []interface{}{"short", strings.Repeat("a", 31) + "<", float64(1234567890), true, []interface{}{"x"}} {
		m = map[string]interface{}{"mcp": map[string]interface{}{"auth_token": v}}
		if err := prepareMCPAuthForSave(m, cur); err == nil {
			t.Errorf("auth_token %#v accepted", v)
		}
	}

	good := strings.Repeat("g", 40)
	m = map[string]interface{}{"mcp": map[string]interface{}{"auth_token": good, "require_auth": false}}
	if err := prepareMCPAuthForSave(m, cur); err != nil {
		t.Fatal(err)
	}
}

func TestApplyMCPAuthFromYAML(t *testing.T) {
	defer mcpAuth.Store(nil)
	setMCPAuth(true, strings.Repeat("o", 40))
	newTok := strings.Repeat("n", 40)
	applyMCPAuthFromYAML([]byte("mcp:\n  require_auth: false\n  auth_token: " + newTok + "\n"))
	s := mcpAuth.Load()
	if s.required || s.token != newTok {
		t.Fatalf("got required=%v token=%q", s.required, s.token)
	}
	// Absent require_auth means on.
	applyMCPAuthFromYAML([]byte("mcp:\n  auth_token: " + newTok + "\n"))
	if !mcpAuth.Load().required {
		t.Fatal("absent require_auth did not default to true")
	}
}
