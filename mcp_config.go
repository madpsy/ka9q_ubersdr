package main

import (
	"fmt"
	"net"
	"strings"
)

// mcpDefaultAllowedIPs is the MCP allowlist when mcp.allowed_ips is empty or
// unset: the RFC 1918 private ranges plus loopback. Some of its tools describe
// the receiver's listeners, so it is closed to the internet unless the operator
// opens it deliberately, on top of the token check in mcp_auth.go.
//
// 172.16.0.0/12 also covers the Docker networks (172.20.0.0/16 and friends), so
// a client in a container next to UberSDR is allowed out of the box.
var mcpDefaultAllowedIPs = []string{
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"127.0.0.0/8",
	"::1",
}

// parseAllowedIPs fills in the default allowlist when none is configured and
// parses every entry, accepting single addresses as well as CIDRs.
func (mc *MCPConfig) parseAllowedIPs() error {
	if len(mc.AllowedIPs) == 0 {
		mc.AllowedIPs = append([]string(nil), mcpDefaultAllowedIPs...)
	}

	nets := make([]*net.IPNet, 0, len(mc.AllowedIPs))
	for _, raw := range mc.AllowedIPs {
		entry := strings.TrimSpace(raw)
		if _, ipNet, err := net.ParseCIDR(entry); err == nil {
			nets = append(nets, ipNet)
			continue
		}
		ip := net.ParseIP(entry)
		if ip == nil {
			return fmt.Errorf("invalid IP or CIDR: %q", raw)
		}
		bits := 128
		if v4 := ip.To4(); v4 != nil {
			ip, bits = v4, 32
		}
		nets = append(nets, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
	}
	mc.allowedNets = nets
	return nil
}

// IsIPAllowed reports whether a client may use the MCP endpoint. An address
// that does not parse is refused, as is everything before parseAllowedIPs has
// run.
func (mc *MCPConfig) IsIPAllowed(ipStr string) bool {
	ip := net.ParseIP(strings.TrimSpace(ipStr))
	if ip == nil {
		return false
	}
	for _, n := range mc.allowedNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// IsToolDisabled reports whether the named tool is listed in disabled_tools.
func (mc *MCPConfig) IsToolDisabled(name string) bool {
	for _, t := range mc.DisabledTools {
		if strings.EqualFold(strings.TrimSpace(t), name) {
			return true
		}
	}
	return false
}
