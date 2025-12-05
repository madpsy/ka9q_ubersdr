package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
)

// isIPAddress checks if a string is a valid IP address (IPv4 or IPv6)
func isIPAddress(host string) bool {
	return net.ParseIP(host) != nil
}

// GenerateCaddyfile generates a Caddyfile based on the instance configuration
// and writes it to the shared volume for Caddy to use.
//
// Logic:
// - If host is empty OR host is an IP address OR tls is false OR admin.email is empty: Generate HTTP-only config
// - If host is a valid domain AND tls is true AND admin.email is set: Generate HTTPS config with Let's Encrypt
//
// The function writes to /etc/caddy-shared/Caddyfile which is mounted as a shared volume
// between the ubersdr and caddy containers.
func GenerateCaddyfile(config *Config) error {
	// Determine the Caddyfile path
	// In Docker, this will be /etc/caddy-shared/Caddyfile
	// For local development, create it in the current directory
	caddyfilePath := "/etc/caddy-shared/Caddyfile"

	// Check if we're in Docker (shared volume exists)
	if _, err := os.Stat("/etc/caddy-shared"); os.IsNotExist(err) {
		// Not in Docker, use local path for development
		caddyfilePath = "./Caddyfile"
		log.Printf("Caddy shared volume not found, using local path: %s", caddyfilePath)
	}

	// Determine which template to use
	host := strings.TrimSpace(config.InstanceReporting.Instance.Host)
	tls := config.InstanceReporting.Instance.TLS
	email := strings.TrimSpace(config.Admin.Email)

	var caddyfileContent string
	var mode string

	// Decision logic: Only enable HTTPS if ALL conditions are met
	// AND host is not an IP address (Let's Encrypt requires a domain name)
	if host != "" && !isIPAddress(host) && tls && email != "" {
		// HTTPS mode with Let's Encrypt
		mode = "HTTPS with Let's Encrypt"
		caddyfileContent = generateHTTPSCaddyfile(host, email)
		log.Printf("Generating Caddyfile for HTTPS mode: domain=%s, email=%s", host, email)
	} else {
		// HTTP-only mode (safe default)
		mode = "HTTP-only"
		caddyfileContent = generateHTTPCaddyfile()

		// Log why we're using HTTP-only mode
		if host == "" {
			log.Printf("Generating Caddyfile for HTTP-only mode: host is empty")
		} else if isIPAddress(host) {
			log.Printf("Generating Caddyfile for HTTP-only mode: host is an IP address (%s), Let's Encrypt requires a domain name", host)
		} else if !tls {
			log.Printf("Generating Caddyfile for HTTP-only mode: TLS is disabled (host=%s)", host)
		} else if email == "" {
			log.Printf("Generating Caddyfile for HTTP-only mode: admin email is empty (host=%s)", host)
		}
	}

	// Ensure directory exists
	dir := filepath.Dir(caddyfilePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create directory %s: %w", dir, err)
	}

	// Write Caddyfile
	if err := os.WriteFile(caddyfilePath, []byte(caddyfileContent), 0644); err != nil {
		return fmt.Errorf("failed to write Caddyfile to %s: %w", caddyfilePath, err)
	}

	log.Printf("Successfully generated Caddyfile at %s (mode: %s)", caddyfilePath, mode)
	return nil
}

// generateHTTPCaddyfile generates an HTTP-only Caddyfile
// This is the safe default that works everywhere without certificate requests
func generateHTTPCaddyfile() string {
	return `# HTTP-only configuration - no certificate requests
# Generated automatically by UberSDR based on config.yaml
# To enable HTTPS: set instance_reporting.instance.host, tls=true, and admin.email

:80 {
    reverse_proxy ubersdr:8080
    encode gzip
    
    # Security headers
    header {
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
    
    # Logging
    log {
        output file /data/access.log
        format json
    }
}
`
}

// generateHTTPSCaddyfile generates an HTTPS Caddyfile with Let's Encrypt
// This requires a valid domain, TLS enabled, and admin email configured
func generateHTTPSCaddyfile(host, email string) string {
	// Main domain configuration
	mainConfig := fmt.Sprintf(`# HTTPS configuration with automatic Let's Encrypt certificates
# Generated automatically by UberSDR based on config.yaml
# Domain: %s
# Email: %s

%s {
    # Email for Let's Encrypt certificate notifications
    tls %s
    
    # Reverse proxy to ubersdr container
    reverse_proxy ubersdr:8080
    
    # Enable compression
    encode gzip
    
    # Security headers
    header {
        # Enable HSTS
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        # Prevent clickjacking
        X-Frame-Options "SAMEORIGIN"
        # Prevent MIME type sniffing
        X-Content-Type-Options "nosniff"
        # Enable XSS protection
        X-XSS-Protection "1; mode=block"
        # Referrer policy
        Referrer-Policy "strict-origin-when-cross-origin"
    }
    
    # Logging
    log {
        output file /data/access.log
        format json
    }
}
`, host, email, host, email)

	// Add www redirect if domain doesn't start with www
	if !strings.HasPrefix(host, "www.") {
		wwwRedirect := fmt.Sprintf(`
# Redirect www to non-www
www.%s {
    redir https://%s{uri} permanent
}
`, host, host)
		return mainConfig + wwwRedirect
	}

	return mainConfig
}
