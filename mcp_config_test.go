package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMCPAllowedIPsDefaultIsPrivateOnly(t *testing.T) {
	var mc MCPConfig
	if err := mc.parseAllowedIPs(); err != nil {
		t.Fatalf("parseAllowedIPs: %v", err)
	}
	if len(mc.AllowedIPs) != len(mcpDefaultAllowedIPs) {
		t.Fatalf("AllowedIPs = %v, want the defaults filled in", mc.AllowedIPs)
	}

	allowed := []string{
		"10.0.0.1", "10.255.255.254", // 10/8
		"172.16.0.1", "172.20.0.1", "172.31.255.254", // 172.16/12, incl. the Docker host gateway
		"192.168.0.1", "192.168.255.254", // 192.168/16
		"127.0.0.1", "127.1.2.3", "::1", // loopback
		"::ffff:192.168.1.10", // IPv4-mapped form of a private address
		" 192.168.1.10 ",      // surrounding space
	}
	for _, ip := range allowed {
		if !mc.IsIPAllowed(ip) {
			t.Errorf("default allowlist refuses %q, want allowed", ip)
		}
	}

	refused := []string{
		"8.8.8.8", "203.0.113.5", "1.1.1.1",
		"172.15.255.255", "172.32.0.0", // just outside 172.16/12
		"192.169.0.1", "11.0.0.1", "9.255.255.255",
		"169.254.1.1",                       // link-local is not RFC 1918
		"100.64.0.1",                        // carrier-grade NAT is not RFC 1918
		"2001:db8::1", "fd00::1", "fe80::1", // public, ULA and link-local IPv6
		"", "not-an-ip", "192.168.1.10:443",
	}
	for _, ip := range refused {
		if mc.IsIPAllowed(ip) {
			t.Errorf("default allowlist allows %q, want refused", ip)
		}
	}
}

func TestMCPAllowedIPsCustom(t *testing.T) {
	mc := MCPConfig{AllowedIPs: []string{"203.0.113.7", "198.51.100.0/24", "2001:db8::/32"}}
	if err := mc.parseAllowedIPs(); err != nil {
		t.Fatalf("parseAllowedIPs: %v", err)
	}
	for ip, want := range map[string]bool{
		"203.0.113.7":   true,
		"203.0.113.8":   false, // single address means exactly that address
		"198.51.100.99": true,
		"198.51.101.1":  false,
		"2001:db8::5":   true,
		"192.168.1.1":   false, // a configured list replaces the defaults
		"127.0.0.1":     false,
	} {
		if got := mc.IsIPAllowed(ip); got != want {
			t.Errorf("IsIPAllowed(%q) = %v, want %v", ip, got, want)
		}
	}

	open := MCPConfig{AllowedIPs: []string{"0.0.0.0/0", "::/0"}}
	if err := open.parseAllowedIPs(); err != nil {
		t.Fatalf("parseAllowedIPs: %v", err)
	}
	for _, ip := range []string{"8.8.8.8", "2001:db8::1", "10.0.0.1"} {
		if !open.IsIPAllowed(ip) {
			t.Errorf("0.0.0.0/0 + ::/0 refuses %q", ip)
		}
	}

	bad := MCPConfig{AllowedIPs: []string{"192.168.1.0/24", "192.168.1.300"}}
	if err := bad.parseAllowedIPs(); err == nil {
		t.Error("an invalid entry parsed without error")
	}
}

func TestMCPUnparsedConfigRefusesEveryone(t *testing.T) {
	var mc MCPConfig // parseAllowedIPs never ran
	if mc.IsIPAllowed("127.0.0.1") {
		t.Error("an unparsed allowlist allowed a client; it must fail closed")
	}
}

func TestMCPIsToolDisabled(t *testing.T) {
	mc := MCPConfig{DisabledTools: []string{"get_active_sessions", " GET_SNR "}}
	for name, want := range map[string]bool{
		"get_active_sessions": true,
		"get_snr":             true, // case and spacing are forgiven
		"get_session_history": false,
	} {
		if got := mc.IsToolDisabled(name); got != want {
			t.Errorf("IsToolDisabled(%q) = %v, want %v", name, got, want)
		}
	}
}

// LoadConfig fills in the default allowlist when the config has no
// mcp.allowed_ips, and rejects a bad entry at startup.
func TestLoadConfigMCPAllowedIPs(t *testing.T) {
	write := func(t *testing.T, body string) string {
		t.Helper()
		path := filepath.Join(t.TempDir(), "config.yaml")
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}

	cfg, err := LoadConfig(write(t, "mcp:\n  enabled: true\n"))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if !cfg.MCP.IsIPAllowed("192.168.1.20") || cfg.MCP.IsIPAllowed("8.8.8.8") {
		t.Errorf("unset allowed_ips: want the private-only default, got %v", cfg.MCP.AllowedIPs)
	}

	cfg, err = LoadConfig(write(t, "mcp:\n  enabled: true\n  allowed_ips:\n    - \"0.0.0.0/0\"\n"))
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if !cfg.MCP.IsIPAllowed("8.8.8.8") {
		t.Error("allowed_ips 0.0.0.0/0 still refuses a public address")
	}

	if _, err := LoadConfig(write(t, "mcp:\n  allowed_ips:\n    - \"nonsense\"\n")); err == nil {
		t.Error("an invalid mcp.allowed_ips entry loaded without error")
	}
}
