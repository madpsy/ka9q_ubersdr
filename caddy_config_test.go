package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestCaddyExtraHosts(t *testing.T) {
	got := caddyExtraHosts([]string{
		" Example.COM ",        // trimmed and lower-cased
		"www.example.com",      //
		"example.com",          // duplicate after normalisation
		"",                     // blank
		"ubersdr.example.com",  // primary host
		"192.0.2.1",            // IP address
		"https://bad.example",  // scheme
		"bad.example:8080",     // port
		"bad.example/path",     // path
		"*.example.com",        // wildcard
		"a b.example",          // internal whitespace
		"-bad.example",         // label starts with hyphen
		"bad-.example",         // label ends with hyphen
		"bad_host.example",     // underscore
		"x.example, y.example", // comma: would inject a second address
		"x.example {",          // brace: would inject a block
		"ünïcode.example",      // non-ASCII (needs punycode)
	}, "ubersdr.example.com")
	want := []string{"example.com", "www.example.com"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("caddyExtraHosts = %v, want %v", got, want)
	}
	if got := caddyExtraHosts(nil, "ubersdr.example.com"); len(got) != 0 {
		t.Fatalf("nil input gave %v", got)
	}
	// Valid shapes: single label, digits, hyphens inside labels, punycode.
	got = caddyExtraHosts([]string{"localhost", "sdr1", "my-sdr.k3fef.com", "xn--bcher-kva.example"}, "")
	if len(got) != 4 {
		t.Fatalf("valid hostnames rejected: %v", got)
	}
}

func TestCaddyExtraProxies(t *testing.T) {
	got := caddyExtraProxies([]string{
		"  KiwiSDR.Example.COM   192.168.1.50:8073 ", // normalised, extra whitespace
		"websdr.example.com\tubersdr:8901",           // tab separated, service name upstream
		"tls.example.com https://10.0.0.2:8443",      // scheme allowed
		"six.example.com [fd00::1]:8073",             // IPv6 upstream
		"",                                           // blank line
		"   ",                                        // whitespace only
		"nohost",                                     // one field
		"a.example.com 1.2.3.4:80 extra",             // three fields
		"ubersdr.example.com 1.2.3.4:80",             // primary host
		"www.example.com 1.2.3.4:80",                 // extra host
		"kiwisdr.example.com 1.2.3.4:80",             // duplicate proxy
		"192.0.2.9 1.2.3.4:80",                       // IP as host
		"bad_host.example 1.2.3.4:80",                // invalid host
		"p1.example.com 192.168.1.50",                // no port
		"p2.example.com 192.168.1.50:99999",          // bad port
		"p3.example.com 192.168.1.50:8073/path",      // path
		"p5.example.com x:8073}",                     // brace
	}, "ubersdr.example.com", []string{"example.com", "www.example.com"})
	want := []CaddyProxy{
		{Host: "kiwisdr.example.com", Upstream: "192.168.1.50:8073"},
		{Host: "websdr.example.com", Upstream: "ubersdr:8901"},
		{Host: "tls.example.com", Upstream: "https://10.0.0.2:8443"},
		{Host: "six.example.com", Upstream: "[fd00::1]:8073"},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("caddyExtraProxies = %v, want %v", got, want)
	}
}

func TestGenerateHTTPSCaddyfileExtraHosts(t *testing.T) {
	extra := []string{"example.com", "www.example.com"}
	proxies := []CaddyProxy{{Host: "kiwisdr.example.com", Upstream: "192.168.1.50:8073"}}
	out := generateHTTPSCaddyfile("ubersdr.example.com", extra, proxies, "op@example.org", true)

	for _, want := range []string{
		"https://ubersdr.example.com, https://example.com, https://www.example.com {",
		"http://example.com, http://www.example.com, http://kiwisdr.example.com {",
		"redir https://{host}{uri} permanent",
		"redir https://ubersdr.example.com{uri} permanent",
		"https://kiwisdr.example.com {\n    reverse_proxy 192.168.1.50:8073",
		"# Extra hosts: example.com, www.example.com",
		"# Extra proxies: kiwisdr.example.com -> 192.168.1.50:8073",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("HTTPS Caddyfile missing %q", want)
		}
	}
	if strings.Contains(out, "http://kiwisdr.example.com {\n    reverse_proxy") {
		t.Errorf("redirect mode should not serve the proxy over plain HTTP")
	}

	// Without extras the site address is the primary host alone and there is
	// no per-host HTTP redirect block.
	out = generateHTTPSCaddyfile("ubersdr.example.com", nil, nil, "op@example.org", true)
	if !strings.Contains(out, "\nhttps://ubersdr.example.com {") {
		t.Errorf("primary-only site address missing")
	}
	if strings.Contains(out, "redir https://{host}{uri}") {
		t.Errorf("per-host redirect block emitted with no extra hosts")
	}
	if !strings.Contains(out, "# Extra proxies: (none)") {
		t.Errorf("empty proxies not reported as none")
	}

	// No-redirect mode: extra hosts are already served by the :80 catch-all,
	// but a proxy needs its own http block or the catch-all would send its
	// name to UberSDR.
	out = generateHTTPSCaddyfile("ubersdr.example.com", extra, proxies, "op@example.org", false)
	if strings.Contains(out, "http://example.com") {
		t.Errorf("per-host redirect block emitted in no-redirect mode")
	}
	if !strings.Contains(out, "http://kiwisdr.example.com {\n    reverse_proxy 192.168.1.50:8073") {
		t.Errorf("no-redirect mode missing http proxy block")
	}
	if !strings.Contains(out, "https://kiwisdr.example.com {\n    reverse_proxy 192.168.1.50:8073") {
		t.Errorf("no-redirect mode missing https proxy block")
	}
}

func TestGenerateHTTPCaddyfileProxies(t *testing.T) {
	out := generateHTTPCaddyfile(nil)
	if strings.Contains(out, "Extra proxy") {
		t.Fatalf("HTTP-only Caddyfile has a proxy block with none configured")
	}
	out = generateHTTPCaddyfile([]CaddyProxy{{Host: "kiwisdr.example.com", Upstream: "192.168.1.50:8073"}})
	if !strings.Contains(out, "http://kiwisdr.example.com {\n    reverse_proxy 192.168.1.50:8073") {
		t.Fatalf("HTTP-only Caddyfile missing proxy block")
	}
	if strings.Contains(out, "https://") {
		t.Fatalf("HTTP-only Caddyfile must not reference https")
	}
}
