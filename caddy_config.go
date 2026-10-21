package main

import (
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// isIPAddress checks if a string is a valid IP address (IPv4 or IPv6)
func isIPAddress(host string) bool {
	return net.ParseIP(host) != nil
}

// caddyHostnameRe is a DNS hostname: one or more labels of letters, digits
// and hyphens (not at either end), each at most 63 characters, joined by
// dots. Internationalised names must be given in punycode. Anything else
// (a scheme, port, path, wildcard, whitespace, brace, comma or quote) is
// rejected rather than written into the Caddyfile, where it would either
// change the meaning of the site address or make Caddy refuse to start.
var caddyHostnameRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)

// caddyExtraHosts sanitises instance_reporting.extra_hosts for use as Caddy
// site addresses: entries are trimmed and lower-cased, and blanks, duplicates,
// the primary host, IP addresses and anything that is not a bare hostname are
// dropped. Let's Encrypt cannot issue for an IP address, and an invalid
// address would take Caddy down with it, so bad entries are logged and
// skipped; the remaining names are still served.
func caddyExtraHosts(extra []string, primary string) []string {
	primary = strings.ToLower(strings.TrimSpace(primary))
	seen := map[string]bool{primary: true}
	var out []string
	for _, raw := range extra {
		h := strings.ToLower(strings.TrimSpace(raw))
		if h == "" || seen[h] {
			continue
		}
		if isIPAddress(h) {
			log.Printf("Caddy: ignoring extra_hosts entry %q: Let's Encrypt requires a domain name, not an IP address", raw)
			continue
		}
		if len(h) > 253 || !caddyHostnameRe.MatchString(h) {
			log.Printf("Caddy: ignoring extra_hosts entry %q: must be a bare hostname such as example.com (no scheme, port, path or wildcard)", raw)
			continue
		}
		seen[h] = true
		out = append(out, h)
	}
	return out
}

// caddyValidUpstream reports whether u is something Caddy's reverse_proxy
// will accept as a single upstream: host:port, optionally prefixed with
// http:// or https://, where host is a hostname or an IP address. Anything
// else would be written verbatim into the Caddyfile and could stop Caddy
// starting, so it is rejected here instead.
func caddyValidUpstream(u string) bool {
	rest := strings.TrimPrefix(strings.TrimPrefix(u, "https://"), "http://")
	h, port, err := net.SplitHostPort(rest)
	if err != nil {
		return false
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return false
	}
	h = strings.ToLower(h)
	return net.ParseIP(h) != nil || caddyHostnameRe.MatchString(h)
}

// CaddyProxy is one parsed instance_reporting.extra_proxies entry: a hostname
// Caddy should serve (with its own certificate in HTTPS mode) and proxy to an
// upstream other than UberSDR, such as a KiwiSDR on another machine.
type CaddyProxy struct {
	Host     string // Hostname to serve, e.g. kiwisdr.example.com
	Upstream string // Where to send it, host:port with optional http:// or https://, e.g. 192.168.1.50:8073
}

// String renders the entry in the same "host upstream" form the config uses.
func (p CaddyProxy) String() string { return p.Host + " " + p.Upstream }

// caddyExtraProxies parses and sanitises instance_reporting.extra_proxies.
// Each entry is a "host upstream" pair separated by whitespace: a list of
// strings so the admin UI edits it one line at a time, like extra_hosts.
// Hosts are checked exactly like extra_hosts and must not collide with the
// primary host, an extra host or another proxy (a duplicate site address is
// a Caddyfile error); upstreams must satisfy caddyValidUpstream. Bad entries
// are logged and skipped so the rest still work.
func caddyExtraProxies(entries []string, primary string, extraHosts []string) []CaddyProxy {
	seen := map[string]bool{strings.ToLower(strings.TrimSpace(primary)): true}
	for _, h := range extraHosts {
		seen[h] = true
	}
	var out []CaddyProxy
	for _, raw := range entries {
		fields := strings.Fields(raw)
		if len(fields) == 0 {
			continue
		}
		if len(fields) != 2 {
			log.Printf("Caddy: ignoring extra_proxies entry %q: expected \"host upstream\", e.g. \"kiwisdr.example.com 192.168.1.50:8073\"", raw)
			continue
		}
		h, up := strings.ToLower(fields[0]), fields[1]
		switch {
		case isIPAddress(h) || len(h) > 253 || !caddyHostnameRe.MatchString(h):
			log.Printf("Caddy: ignoring extra_proxies entry %q: host must be a bare hostname such as kiwisdr.example.com", raw)
			continue
		case seen[h]:
			log.Printf("Caddy: ignoring extra_proxies entry %q: hostname already used by instance.host, extra_hosts or another proxy", raw)
			continue
		case !caddyValidUpstream(up):
			log.Printf("Caddy: ignoring extra_proxies entry %q: upstream must be host:port such as 192.168.1.50:8073", raw)
			continue
		}
		seen[h] = true
		out = append(out, CaddyProxy{Host: h, Upstream: up})
	}
	return out
}

// caddyProxySiteBlocks renders one site block per proxy. scheme is "https"
// or "http"; a block serves that name on that scheme and proxies it to the
// upstream. WebSockets pass through reverse_proxy untouched, which is what a
// KiwiSDR or WebSDR client needs.
func caddyProxySiteBlocks(proxies []CaddyProxy, scheme string) string {
	var b strings.Builder
	for _, p := range proxies {
		fmt.Fprintf(&b, `
# Extra proxy: %s -> %s
%s://%s {
    reverse_proxy %s

    # Logging
    log {
        output file /data/access.log
        format json
    }
}
`, p.Host, p.Upstream, scheme, p.Host, p.Upstream)
	}
	return b.String()
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
	extraHosts := caddyExtraHosts(config.InstanceReporting.ExtraHosts, host)
	extraProxies := caddyExtraProxies(config.InstanceReporting.ExtraProxies, host, extraHosts)

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
		caddyfileContent = generateHTTPSCaddyfile(host, extraHosts, extraProxies, email, redirectToHTTPS)
		log.Printf("Generating Caddyfile for HTTPS mode: domain=%s, extra_hosts=%v, extra_proxies=%v, email=%s, redirect=%v", host, extraHosts, extraProxies, email, redirectToHTTPS)
	} else {
		// HTTP-only mode (safe default)
		mode = "HTTP-only"
		caddyfileContent = generateHTTPCaddyfile(extraProxies)
		if len(extraHosts) > 0 {
			log.Printf("Caddy: extra_hosts %v only apply in HTTPS mode; the HTTP-only listener already answers on any name", extraHosts)
		}

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
// extraProxies get their own http:// site blocks; a site block with an explicit
// host takes precedence over the :80 catch-all.
func generateHTTPCaddyfile(extraProxies []CaddyProxy) string {
	return `# HTTP-only configuration - no certificate requests
# Generated automatically by UberSDR based on config.yaml
# To enable HTTPS: set instance_reporting.generate_tls=true, instance.host, instance.tls=true, and admin.email

{
    # Bound the shutdown grace period. UberSDR keeps long-lived connections
    # open (/audio/stream, /api/noisefloor/spectrum/stream, /ws/dxcluster,
    # /api/decoder/stream); with Caddy's default "eternal" grace period those
    # never drain, so a SIGTERM from docker/caddy-entrypoint.sh closes the
    # listeners but the process never exits and the container never restarts.
    grace_period 10s
}

:80 {
    reverse_proxy ubersdr:8080 {
        # Strip client-supplied proxy headers to prevent IP spoofing.
        # X-Forwarded-For is NOT stripped so Caddy can append the real client IP to it.
        header_up -X-Real-IP
        header_up -X-Forwarded-Host
        header_up -X-Forwarded-Proto
    }
    encode gzip
    
    # Security headers
    header {
        X-Frame-Options "SAMEORIGIN"
        X-Content-Type-Options "nosniff"
        X-XSS-Protection "1; mode=block"
        Referrer-Policy "strict-origin-when-cross-origin"
    }

    # Short TTL for static assets — set only if upstream did not already set Cache-Control
    @static {
        path *.js *.css *.png *.jpg *.jpeg *.gif *.svg *.ico *.woff *.woff2 *.webp *.html *.htm
    }
    header @static ?Cache-Control "public, max-age=300, must-revalidate"
    
    # Logging
    log {
        output file /data/access.log
        format json
    }
}
` + caddyProxySiteBlocks(extraProxies, "http")
}

// generateHTTPSCaddyfile generates an HTTPS Caddyfile with Let's Encrypt
// This requires a valid domain, TLS enabled, and admin email configured
// If redirectToHTTPS is true, HTTP requests will be redirected to HTTPS
// extraHosts are served by the same site block as host, so each gets its own
// certificate and is proxied to UberSDR identically. extraProxies each get
// their own site block pointing at their upstream.
func generateHTTPSCaddyfile(host string, extraHosts []string, extraProxies []CaddyProxy, email string, redirectToHTTPS bool) string {
	var httpBlock string

	// Site addresses: the primary host plus every extra host, all HTTPS.
	addrs := make([]string, 0, 1+len(extraHosts))
	addrs = append(addrs, "https://"+host)
	for _, h := range extraHosts {
		addrs = append(addrs, "https://"+h)
	}
	siteAddr := strings.Join(addrs, ", ")
	extraHostsComment := "(none)"
	if len(extraHosts) > 0 {
		extraHostsComment = strings.Join(extraHosts, ", ")
	}
	extraProxiesComment := "(none)"
	if len(extraProxies) > 0 {
		parts := make([]string, 0, len(extraProxies))
		for _, p := range extraProxies {
			parts = append(parts, p.Host+" -> "+p.Upstream)
		}
		extraProxiesComment = strings.Join(parts, ", ")
	}

	if redirectToHTTPS {
		// HTTP block with redirect to HTTPS
		// Use the specific domain name to ensure consistent HTTPS URLs
		// Exclude specific API endpoints that need to remain accessible via HTTP
		httpBlock = fmt.Sprintf(`# HTTP (port 80) - redirect to HTTPS (except specific API endpoints)
:80 {
	   # Allow these endpoints to be accessed via HTTP without redirect
	   # These are used by external services that may not support HTTPS
	   @api_exceptions {
	       path /api/instance /api/description
	   }
	   handle @api_exceptions {
	       reverse_proxy ubersdr:8080 {
	           # Strip client-supplied proxy headers to prevent IP spoofing.
	           # X-Forwarded-For is NOT stripped so Caddy can append the real client IP to it.
	           header_up -X-Real-IP
	           header_up -X-Forwarded-Host
	           header_up -X-Forwarded-Proto
	       }
	   }

	   # Redirect all other HTTP traffic to HTTPS using the configured domain
	   handle {
	       redir https://%s{uri} permanent
	   }

	   # Logging
	   log {
	       output file /data/access.log
	       format json
	   }
}`, host)

		// Extra hosts and proxies redirect to themselves over HTTPS rather
		// than to the primary host, so e.g. http://example.com/ads.txt lands
		// on https://example.com/ads.txt. A site block with explicit host
		// matchers takes precedence over the :80 catch-all above.
		if len(extraHosts)+len(extraProxies) > 0 {
			httpAddrs := make([]string, 0, len(extraHosts)+len(extraProxies))
			for _, h := range extraHosts {
				httpAddrs = append(httpAddrs, "http://"+h)
			}
			for _, p := range extraProxies {
				httpAddrs = append(httpAddrs, "http://"+p.Host)
			}
			httpBlock += fmt.Sprintf(`

# HTTP (port 80) for extra hosts and proxies - redirect to the same name over HTTPS
%s {
	   redir https://{host}{uri} permanent

	   # Logging
	   log {
	       output file /data/access.log
	       format json
	   }
}`, strings.Join(httpAddrs, ", "))
		}
	} else {
		// HTTP block serving content directly (no redirect)
		httpBlock = `# HTTP (port 80) - respond to any host header
:80 {
	   # Reverse proxy to ubersdr container
	   reverse_proxy ubersdr:8080 {
	       # Strip client-supplied proxy headers to prevent IP spoofing.
	       # X-Forwarded-For is NOT stripped so Caddy can append the real client IP to it.
	       header_up -X-Real-IP
	       header_up -X-Forwarded-Host
	       header_up -X-Forwarded-Proto
	   }
	   
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

	   # Short TTL for static assets — set only if upstream did not already set Cache-Control
	   @static {
	       path *.js *.css *.png *.jpg *.jpeg *.gif *.svg *.ico *.woff *.woff2 *.webp *.html *.htm
	   }
	   header @static ?Cache-Control "public, max-age=300, must-revalidate"
	   
	   # Logging
	   log {
	       output file /data/access.log
	       format json
	   }
}` + caddyProxySiteBlocks(extraProxies, "http")
	}

	// Main domain configuration with both HTTP and HTTPS
	mainConfig := fmt.Sprintf(`# HTTPS configuration with automatic Let's Encrypt certificates
# Generated automatically by UberSDR based on config.yaml
# Domain: %s
# Extra hosts: %s
# Extra proxies: %s
# Email: %s
# HTTP Redirect: %v

{
    # Disable automatic HTTPS redirects - we handle them manually
    auto_https disable_redirects
    # Email for Let's Encrypt certificate notifications
    email %s
    # Bound the shutdown grace period. UberSDR keeps long-lived connections
    # open (/audio/stream, /api/noisefloor/spectrum/stream, /ws/dxcluster,
    # /api/decoder/stream); with Caddy's default "eternal" grace period those
    # never drain, so a SIGTERM from docker/caddy-entrypoint.sh closes the
    # listeners but the process never exits and the container never restarts.
    grace_period 10s
}

%s

# HTTPS (port 443) - with Let's Encrypt, one certificate per name
%s {
    # Reverse proxy to ubersdr container
    reverse_proxy ubersdr:8080 {
        # Strip client-supplied proxy headers to prevent IP spoofing.
        # X-Forwarded-For is NOT stripped so Caddy can append the real client IP to it.
        header_up -X-Real-IP
        header_up -X-Forwarded-Host
        header_up -X-Forwarded-Proto
    }
    
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

    # Short TTL for static assets — set only if upstream did not already set Cache-Control
    @static {
        path *.js *.css *.png *.jpg *.jpeg *.gif *.svg *.ico *.woff *.woff2 *.webp *.html *.htm
    }
    header @static ?Cache-Control "public, max-age=300, must-revalidate"
    
    # Logging
    log {
        output file /data/access.log
        format json
    }
}
`+caddyProxySiteBlocks(extraProxies, "https"), host, extraHostsComment, extraProxiesComment, email, redirectToHTTPS, email, httpBlock, siteAddr)

	return mainConfig
}
