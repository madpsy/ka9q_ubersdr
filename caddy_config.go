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

// isExampleEmail checks if an email address ends with @example.com
// These are placeholder emails and should not be used for Let's Encrypt
func isExampleEmail(email string) bool {
	return strings.HasSuffix(strings.ToLower(email), "@example.com")
}

// GenerateCaddyfile generates a Caddyfile based on the instance configuration
// and writes it to the shared volume for Caddy to use.
//
// Logic:
// - If generate_tls is false: Generate HTTP-only config (regardless of other settings)
// - If generate_tls is true AND host is empty OR host is an IP address OR tls is false OR admin.email is empty OR email ends with @example.com: Generate HTTP-only config
// - If generate_tls is true AND host is a valid domain AND tls is true AND admin.email is set AND email is not @example.com: Generate HTTPS config with Let's Encrypt
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
	generateTLS := config.InstanceReporting.GenerateTLS
	redirectToHTTPS := config.InstanceReporting.RedirectToHTTPS
	email := strings.TrimSpace(config.Admin.Email)

	var caddyfileContent string
	var mode string

	// Decision logic: Only enable HTTPS if generate_tls is true AND ALL other conditions are met
	// AND host is not an IP address (Let's Encrypt requires a domain name)
	// AND email is not a placeholder @example.com address
	if generateTLS && host != "" && !isIPAddress(host) && tls && email != "" && !isExampleEmail(email) {
		// HTTPS mode with Let's Encrypt
		if redirectToHTTPS {
			mode = "HTTPS with Let's Encrypt (HTTP redirects to HTTPS)"
		} else {
			mode = "HTTPS with Let's Encrypt (HTTP and HTTPS both serve content)"
		}
		caddyfileContent = generateHTTPSCaddyfile(host, email, redirectToHTTPS)
		log.Printf("Generating Caddyfile for HTTPS mode: domain=%s, email=%s, redirect=%v", host, email, redirectToHTTPS)
	} else {
		// HTTP-only mode (safe default)
		mode = "HTTP-only"
		caddyfileContent = generateHTTPCaddyfile()

		// Log why we're using HTTP-only mode
		if !generateTLS {
			log.Printf("Generating Caddyfile for HTTP-only mode: generate_tls is false")
		} else if host == "" {
			log.Printf("Generating Caddyfile for HTTP-only mode: host is empty")
		} else if isIPAddress(host) {
			log.Printf("Generating Caddyfile for HTTP-only mode: host is an IP address (%s), Let's Encrypt requires a domain name", host)
		} else if !tls {
			log.Printf("Generating Caddyfile for HTTP-only mode: TLS is disabled (host=%s)", host)
		} else if email == "" {
			log.Printf("Generating Caddyfile for HTTP-only mode: admin email is empty (host=%s)", host)
		} else if isExampleEmail(email) {
			log.Printf("Generating Caddyfile for HTTP-only mode: admin email is a placeholder @example.com address (%s), use a real email for Let's Encrypt", email)
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

	// Trigger Caddy restart by creating restart trigger file
	restartTriggerPath := "/var/run/restart-trigger/restart-caddy"
	restartTriggerDir := filepath.Dir(restartTriggerPath)

	// Check if restart trigger directory exists (Docker environment)
	if _, err := os.Stat(restartTriggerDir); err == nil {
		// Create the restart trigger file
		if err := os.WriteFile(restartTriggerPath, []byte{}, 0644); err != nil {
			log.Printf("Warning: Failed to create Caddy restart trigger at %s: %v", restartTriggerPath, err)
		} else {
			log.Printf("Created Caddy restart trigger at %s", restartTriggerPath)
		}
	} else {
		log.Printf("Restart trigger directory not found (not in Docker), skipping Caddy restart trigger")
	}

	return nil
}

// generateHTTPCaddyfile generates an HTTP-only Caddyfile
// This is the safe default that works everywhere without certificate requests
func generateHTTPCaddyfile() string {
	return `# HTTP-only configuration - no certificate requests
# Generated automatically by UberSDR based on config.yaml
# To enable HTTPS: set instance_reporting.generate_tls=true, instance.host, instance.tls=true, and admin.email

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
// If redirectToHTTPS is true, HTTP requests will be redirected to HTTPS
func generateHTTPSCaddyfile(host, email string, redirectToHTTPS bool) string {
	var httpBlock string

	if redirectToHTTPS {
		// HTTP block with redirect to HTTPS
		// Use the specific domain name to ensure consistent HTTPS URLs
		httpBlock = fmt.Sprintf(`# HTTP (port 80) - redirect to HTTPS
:80 {
	   # Redirect all HTTP traffic to HTTPS using the configured domain
	   redir https://%s{uri} permanent

	   # Logging
	   log {
	       output file /data/access.log
	       format json
	   }
}`, host)
	} else {
		// HTTP block serving content directly (no redirect)
		httpBlock = `# HTTP (port 80) - respond to any host header
:80 {
    # Reverse proxy to ubersdr container
    reverse_proxy ubersdr:8080
    
    # Enable compression
    encode gzip
    
    # Security headers (no HSTS for HTTP)
    header {
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
}`
	}

	// Main domain configuration with both HTTP and HTTPS
	mainConfig := fmt.Sprintf(`# HTTPS configuration with automatic Let's Encrypt certificates
# Generated automatically by UberSDR based on config.yaml
# Domain: %s
# Email: %s
# HTTP Redirect: %v

{
    # Disable automatic HTTPS redirects - we handle them manually
    auto_https disable_redirects
    # Email for Let's Encrypt certificate notifications
    email %s
}

%s

# HTTPS (port 443) - with Let's Encrypt
https://%s {
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
`, host, email, redirectToHTTPS, email, httpBlock, host)

	return mainConfig
}
