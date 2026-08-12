package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestV2Title(t *testing.T) {
	tests := []struct {
		callsign, location, name string
		want                     string
	}{
		{"M0ABC", "London, UK", "Loop", "M0ABC WebSDR – London, UK | UberSDR"},
		{"M0ABC", "", "Loop", "M0ABC WebSDR | UberSDR"},
		{"", "London, UK", "Active Loop", "Active Loop | UberSDR"},
		{"", "", "", "UberSDR – Web SDR Receiver"},
	}
	for _, tt := range tests {
		if got := v2Title(tt.callsign, tt.location, tt.name); got != tt.want {
			t.Errorf("v2Title(%q,%q,%q) = %q, want %q", tt.callsign, tt.location, tt.name, got, tt.want)
		}
	}
}

func TestV2Description(t *testing.T) {
	t.Run("prefers the plain-text name over the HTML description", func(t *testing.T) {
		config := &Config{}
		config.Admin.Name = "SDR with Active Loop"
		config.Admin.Description = `Welcome! <a href="https://ubersdr.org">UberSDR</a>`
		got := v2Description("M0ABC", "London, UK", config)
		want := "M0ABC WebSDR in London, UK. SDR with Active Loop."
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("falls back to the description with its markup stripped", func(t *testing.T) {
		config := &Config{}
		config.Admin.Description = "Welcome! This SDR is running <a href=\"https://ubersdr.org\" target=\"_blank\">UberSDR</a>"
		got := v2Description("M0ABC", "", config)
		if strings.ContainsAny(got, "<>") {
			t.Errorf("markup survived into the description: %q", got)
		}
		if !strings.Contains(got, "Welcome! This SDR is running UberSDR") {
			t.Errorf("text lost while stripping: %q", got)
		}
	})

	t.Run("says something useful with nothing configured", func(t *testing.T) {
		got := v2Description("", "", &Config{})
		if !strings.HasPrefix(got, "UberSDR web SDR receiver.") {
			t.Errorf("got %q", got)
		}
	})

	t.Run("stays inside the display budget", func(t *testing.T) {
		config := &Config{}
		config.Admin.Name = strings.Repeat("very long receiver name ", 20)
		got := v2Description("M0ABC", "London, UK", config)
		if n := len([]rune(got)); n > v2MaxDescription {
			t.Errorf("description is %d runes, want <= %d: %q", n, v2MaxDescription, got)
		}
		if !strings.HasSuffix(got, "…") {
			t.Errorf("truncated description should end in an ellipsis: %q", got)
		}
		// Cut at a word boundary, not mid-word.
		if strings.HasSuffix(got, "ver…") || strings.Contains(got, "  ") {
			t.Errorf("cut mid-word: %q", got)
		}
	})
}

func TestPageBaseURL(t *testing.T) {
	t.Run("uses the requested host", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/v2/", nil)
		req.Host = "sdr.example.org:8080"
		if got := pageBaseURL(req); got != "http://sdr.example.org:8080" {
			t.Errorf("got %q", got)
		}
	})

	t.Run("ignores forwarded headers from an untrusted peer", func(t *testing.T) {
		// globalConfig is nil in tests, so no peer is trusted — which is the
		// same answer an arbitrary client gets in production.
		req := httptest.NewRequest(http.MethodGet, "/v2/", nil)
		req.Host = "sdr.example.org"
		req.Header.Set("X-Forwarded-Host", "evil.example.com")
		req.Header.Set("X-Forwarded-Proto", "https")
		if got := pageBaseURL(req); got != "http://sdr.example.org" {
			t.Errorf("forwarded headers were believed: %q", got)
		}
	})

	t.Run("rejects a host that would break out of the attribute", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/v2/", nil)
		req.Host = `sdr.example.org/"><script>`
		if got := pageBaseURL(req); got != "" {
			t.Errorf("got %q, want empty", got)
		}
	})
}

func TestStripHTMLText(t *testing.T) {
	tests := []struct{ in, want string }{
		{`Welcome! <a href="https://x.example">UberSDR</a>`, "Welcome! UberSDR"},
		{"line one\n\nline two", "line one line two"},
		{"Tom &amp; Jerry", "Tom & Jerry"},
		{"", ""},
	}
	for _, tt := range tests {
		if got := stripHTMLText(tt.in); got != tt.want {
			t.Errorf("stripHTMLText(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// TestBuildV2PageMetaCanonical: the canonical URL follows whichever address the
// content is actually served under.
func TestBuildV2PageMetaCanonical(t *testing.T) {
	for _, tt := range []struct {
		name string
		v2   bool
		want string
	}{
		{"opt-in v2 canonicalises to /v2/", false, "http://sdr.example.org/v2/"},
		{"default v2 canonicalises to the root it redirects from", true, "http://sdr.example.org/"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			config := &Config{}
			config.UI.V2Interface = tt.v2
			req := httptest.NewRequest(http.MethodGet, "/v2/", nil)
			req.Host = "sdr.example.org"
			if got := buildV2PageMeta(config, req).CanonicalURL; got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

// TestV2MetaRendersIntoShell is the end-to-end check: the values reach the page,
// hostile config cannot break out of an attribute, and the JSON-LD stays valid
// JSON that cannot close its own <script>.
func TestV2MetaRendersIntoShell(t *testing.T) {
	if err := loadV2IndexTemplateForTest(); err != nil {
		t.Fatalf("parsing v2 index template: %v", err)
	}

	config := &Config{}
	config.Admin.Callsign = "m0abc" // lowercase on purpose: it should be upcased
	config.Admin.Location = "London, UK"
	config.Admin.Name = `Loop & "vertical" <script>alert(1)</script>`
	config.Admin.GPS.Lat = 51.5
	config.Admin.GPS.Lon = -0.12

	req := httptest.NewRequest(http.MethodGet, "/v2/", nil)
	req.Host = "sdr.example.org"
	rec := httptest.NewRecorder()
	handleV2IndexPage(rec, req, config)

	body := rec.Body.String()
	head := body[:strings.Index(body, "</head>")]

	for _, want := range []string{
		`<title>M0ABC WebSDR – London, UK | UberSDR</title>`,
		`<link rel="canonical" href="http://sdr.example.org/v2/">`,
		`<meta property="og:url" content="http://sdr.example.org/v2/">`,
		`<meta property="og:image" content="http://sdr.example.org/images/android-chrome-512x512.png">`,
		`<meta name="apple-mobile-web-app-title" content="M0ABC">`,
		`<meta name="twitter:card" content="summary">`,
		`<link rel="apple-touch-icon" href="/images/apple-touch-icon.png">`,
	} {
		if !strings.Contains(head, want) {
			t.Errorf("head is missing %s", want)
		}
	}

	// The operator's angle brackets must not become live markup.
	if strings.Contains(head, "<script>alert(1)</script>") {
		t.Errorf("config text was injected as markup, not escaped")
	}
	if !strings.Contains(head, "&lt;script&gt;") {
		t.Errorf("expected the escaped form of the operator's text in the head")
	}

	// JSON-LD: valid JSON, carries the geo, and contains no raw '<'.
	start := strings.Index(head, `<script type="application/ld+json">`)
	if start < 0 {
		t.Fatalf("no JSON-LD block")
	}
	start += len(`<script type="application/ld+json">`)
	ld := head[start : start+strings.Index(head[start:], "</script>")]
	if strings.ContainsAny(ld, "<>") {
		t.Errorf("JSON-LD contains raw angle brackets, so it could close its own script: %s", ld)
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(ld), &doc); err != nil {
		t.Fatalf("JSON-LD is not valid JSON: %v\n%s", err, ld)
	}
	if doc["@type"] != "WebApplication" {
		t.Errorf("@type = %v", doc["@type"])
	}
	place, ok := doc["contentLocation"].(map[string]any)
	if !ok {
		t.Fatalf("no contentLocation: %v", doc["contentLocation"])
	}
	if place["name"] != "London, UK" {
		t.Errorf("contentLocation name = %v", place["name"])
	}
	if geo, ok := place["geo"].(map[string]any); !ok || geo["latitude"] != 51.5 {
		t.Errorf("geo = %v", place["geo"])
	}
}

// TestV2JSONLDOmitsUnsetLocation: 0,0 is the Atlantic, not a receiver.
func TestV2JSONLDOmitsUnsetLocation(t *testing.T) {
	meta := buildV2PageMeta(&Config{}, httptest.NewRequest(http.MethodGet, "/v2/", nil))
	var doc map[string]any
	if err := json.Unmarshal([]byte(meta.JSONLD), &doc); err != nil {
		t.Fatalf("JSON-LD is not valid JSON: %v", err)
	}
	if _, present := doc["contentLocation"]; present {
		t.Errorf("contentLocation emitted with nothing configured: %v", doc["contentLocation"])
	}
}
