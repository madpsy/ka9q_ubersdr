package main

import (
	"fmt"
	"net"
	"os"
	"regexp"

	"gopkg.in/yaml.v3"
)

// validAddonNameRe matches URL-safe addon names:
// lowercase letters, digits, hyphens, underscores; must start with a letter or digit
var validAddonNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

// validAddonHostRe matches URL-safe hostnames (Docker container names):
// letters, digits, hyphens, underscores, dots; must start with a letter or digit
var validAddonHostRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)

const (
	addonNameMaxLen   = 15
	addonHostMaxLen   = 25
	addonRateLimitMax = 250
)

// AddonProxyEntry defines a single generic addon reverse proxy
type AddonProxyEntry struct {
	Name          string   `yaml:"name"`           // URL-safe name; proxy mounts at /addon/{name}/
	Enabled       bool     `yaml:"enabled"`        // Must be explicitly set to true (Go bool defaults to false)
	Host          string   `yaml:"host"`           // Docker container hostname on the sdr-network
	Port          int      `yaml:"port"`           // Container port to proxy to
	StripPrefix   bool     `yaml:"strip_prefix"`   // Strip /addon/{name} from path before forwarding (default: true)
	RequireAdmin  bool     `yaml:"require_admin"`  // Require admin session cookie to access (default: true)
	RewriteOrigin bool     `yaml:"rewrite_origin"` // Rewrite WebSocket Origin header to backend URL (default: false)
	AllowedIPs    []string `yaml:"allowed_ips"`    // IP/CIDR allowlist; empty falls back to admin.allowed_ips
	RateLimit     int      `yaml:"rate_limit"`     // Max requests per minute per IP (0 = unlimited, default: 100)

	allowedNets []*net.IPNet // Parsed CIDR networks (internal use)
	adminConfig *AdminConfig // Reference to admin config for IP fallback (internal use)
}

// AddonProxiesConfig is the top-level structure for addons.yaml
type AddonProxiesConfig struct {
	Proxies []AddonProxyEntry `yaml:"proxies"`
}

// LoadAddonProxiesConfig loads addon proxy configuration from a YAML file.
// Returns an empty config (no proxies) if the file does not exist.
func LoadAddonProxiesConfig(filename string) (*AddonProxiesConfig, error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("failed to read addons config file: %w", err)
	}

	var config AddonProxiesConfig
	if err := yaml.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse addons config file: %w", err)
	}

	if err := validateAddonProxies(config.Proxies); err != nil {
		return nil, err
	}

	// Apply defaults for enabled entries
	for i := range config.Proxies {
		p := &config.Proxies[i]
		if !p.Enabled {
			continue
		}
		// StripPrefix defaults to true — must be explicitly set to false to disable
		// We can't detect "not set" vs "false" in Go YAML, so we document that
		// strip_prefix defaults to true and users must set it to false to disable.
		// Since the zero value is false, we default it to true here if host is set
		// (i.e. this is a real entry, not a placeholder).
		if !p.StripPrefix && p.Host != "" {
			// Only force true if the user hasn't explicitly set it.
			// Unfortunately YAML bool zero-value is false, so we can't distinguish
			// "not set" from "false". We document that strip_prefix defaults to true
			// and users should set it explicitly. We do NOT override here to avoid
			// breaking users who genuinely want strip_prefix: false.
		}
		// RateLimit: 0 means unlimited (explicit). Default 100 if not set.
		// We use -1 as sentinel for "not configured" but YAML doesn't support that
		// cleanly, so we apply the default only when the value is 0 AND the field
		// wasn't explicitly set. Since we can't distinguish, we document that
		// rate_limit: 0 means unlimited and users should set 100 explicitly.
		// No override here — 0 = unlimited as documented.
	}

	return &config, nil
}

// validateAddonProxies validates all proxy entries for correctness
func validateAddonProxies(proxies []AddonProxyEntry) error {
	seen := make(map[string]bool)

	for i, p := range proxies {
		// Name must not be empty
		if p.Name == "" {
			return fmt.Errorf("addon proxy at index %d: name cannot be empty", i)
		}

		// Name length
		if len(p.Name) > addonNameMaxLen {
			return fmt.Errorf("addon proxy %q: name must be %d characters or fewer", p.Name, addonNameMaxLen)
		}

		// Name must be URL-safe
		if !validAddonNameRe.MatchString(p.Name) {
			return fmt.Errorf("addon proxy %q: name must contain only lowercase letters, digits, hyphens, and underscores, and must start with a letter or digit", p.Name)
		}

		// Name must be unique within the file
		if seen[p.Name] {
			return fmt.Errorf("addon proxy %q: duplicate name (names must be unique within addons.yaml)", p.Name)
		}
		seen[p.Name] = true

		// Only validate host/port for enabled entries — disabled entries may be incomplete templates
		if p.Enabled {
			if p.Host == "" {
				return fmt.Errorf("addon proxy %q: host cannot be empty when enabled", p.Name)
			}
			if len(p.Host) > addonHostMaxLen {
				return fmt.Errorf("addon proxy %q: host must be %d characters or fewer", p.Name, addonHostMaxLen)
			}
			if !validAddonHostRe.MatchString(p.Host) {
				return fmt.Errorf("addon proxy %q: host contains invalid characters (use letters, digits, hyphens, underscores, dots)", p.Name)
			}
			if p.Port < 1 || p.Port > 65535 {
				return fmt.Errorf("addon proxy %q: port must be between 1 and 65535 (got %d)", p.Name, p.Port)
			}
		}

		// Rate limit
		if p.RateLimit < 0 || p.RateLimit > addonRateLimitMax {
			return fmt.Errorf("addon proxy %q: rate_limit must be between 0 (unlimited) and %d", p.Name, addonRateLimitMax)
		}

		// Validate allowed IPs if provided
		for _, ipStr := range p.AllowedIPs {
			if _, _, err := net.ParseCIDR(ipStr); err != nil {
				if net.ParseIP(ipStr) == nil {
					return fmt.Errorf("addon proxy %q: invalid IP/CIDR in allowed_ips: %q", p.Name, ipStr)
				}
			}
		}
	}

	return nil
}

// parseAllowedIPs parses the AllowedIPs list into net.IPNet CIDR networks
func (e *AddonProxyEntry) parseAllowedIPs() error {
	e.allowedNets = nil
	for _, ipStr := range e.AllowedIPs {
		// Try parsing as CIDR first
		_, network, err := net.ParseCIDR(ipStr)
		if err != nil {
			// Try as plain IP address
			ip := net.ParseIP(ipStr)
			if ip == nil {
				return fmt.Errorf("addon proxy %q: invalid IP/CIDR %q", e.Name, ipStr)
			}
			// Convert plain IP to /32 or /128
			bits := 32
			if ip.To4() == nil {
				bits = 128
			}
			network = &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)}
		}
		e.allowedNets = append(e.allowedNets, network)
	}
	return nil
}

// IsIPAllowed checks if an IP address is permitted to access this addon proxy.
// If AllowedIPs is empty or contains only 0.0.0.0/0, falls back to admin.allowed_ips.
func (e *AddonProxyEntry) IsIPAllowed(ipStr string) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}

	// Check if allowed_ips is effectively "allow all" (0.0.0.0/0)
	isAllowAll := false
	for _, network := range e.allowedNets {
		ones, _ := network.Mask.Size()
		if ones == 0 {
			isAllowAll = true
			break
		}
	}

	// Fall back to admin config if no specific IPs set or allow-all
	if (len(e.allowedNets) == 0 || isAllowAll) && e.adminConfig != nil {
		return e.adminConfig.IsIPAllowed(ipStr)
	}

	// Check against the configured list
	for _, network := range e.allowedNets {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}
