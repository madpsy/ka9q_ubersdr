package main

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

// newIdentityTestConfig builds a Config whose bypass rules are parsed, so
// IsIPTimeoutBypassed behaves the same way it does at runtime.
func newIdentityTestConfig(t *testing.T, bypassIPs []string, bypassPassword string) *Config {
	t.Helper()
	config := &Config{}
	config.Server.TimeoutBypassIPs = bypassIPs
	config.Server.BypassPassword = bypassPassword
	if err := config.Server.parseTimeoutBypassIPs(); err != nil {
		t.Fatalf("parseTimeoutBypassIPs: %v", err)
	}
	return config
}

// TestClientIdentityBanMatchesProtocolIdentity covers the reason this function
// exists: KiwiSDR and WebSDR clients carry no usable HTTP User-Agent, so a ban
// pattern has to be matched against the protocol identity string that
// SetUserAgent records and the admin UI displays.
func TestClientIdentityBanMatchesProtocolIdentity(t *testing.T) {
	ibm, _ := newTestBanManager(t)
	config := newIdentityTestConfig(t, nil, "")

	if err := ibm.BanUserAgent("KiwiSDR Client", "no bots", "admin", false); err != nil {
		t.Fatalf("BanUserAgent: %v", err)
	}

	ban := clientIdentityBan(config, ibm, "203.0.113.7", "", kiwiClientIdentity)
	if ban == nil {
		t.Fatal("expected the default KiwiSDR identity to be banned")
	}
	if ban.Reason != "no bots" {
		t.Errorf("ban.Reason = %q, want %q", ban.Reason, "no bots")
	}

	if got := clientIdentityBan(config, ibm, "203.0.113.7", "", websdrClientIdentity); got != nil {
		t.Errorf("expected the WebSDR identity to be unaffected, got pattern %q", got.Pattern)
	}
}

// TestClientIdentityBanMatchesClientSuppliedName covers a client that renames
// itself via "SET ident_user" / "/~~param?name=" into a banned pattern.
func TestClientIdentityBanMatchesClientSuppliedName(t *testing.T) {
	ibm, _ := newTestBanManager(t)
	config := newIdentityTestConfig(t, nil, "")

	if err := ibm.BanUserAgent("kiwirecorder", "unattended recorder", "admin", false); err != nil {
		t.Fatalf("BanUserAgent: %v", err)
	}

	if clientIdentityBan(config, ibm, "203.0.113.7", "", "kiwirecorder.py") == nil {
		t.Error("expected a client-supplied name matching the pattern to be banned")
	}
	if got := clientIdentityBan(config, ibm, "203.0.113.7", "", "M0ABC"); got != nil {
		t.Errorf("expected an unrelated name to be allowed, got pattern %q", got.Pattern)
	}
}

func TestClientIdentityBanExemptions(t *testing.T) {
	ibm, _ := newTestBanManager(t)
	if err := ibm.BanUserAgent("KiwiSDR Client", "no bots", "admin", false); err != nil {
		t.Fatalf("BanUserAgent: %v", err)
	}

	config := newIdentityTestConfig(t, []string{"198.51.100.0/24"}, "letmein")

	tests := []struct {
		name     string
		clientIP string
		password string
		identity string
		want     bool // true = blocked
	}{
		{"banned identity, ordinary client", "203.0.113.7", "", kiwiClientIdentity, true},
		{"bypassed IP", "198.51.100.5", "", kiwiClientIdentity, false},
		{"bypass password", "203.0.113.7", "letmein", kiwiClientIdentity, false},
		{"wrong bypass password", "203.0.113.7", "nope", kiwiClientIdentity, true},
		// An empty identity must never be treated as a match: patterns that match
		// the empty string are already refused by ValidateUserAgentPattern, and
		// treating "unknown" as "banned" would block every client.
		{"empty identity", "203.0.113.7", "", "", false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := clientIdentityBan(config, ibm, tc.clientIP, tc.password, tc.identity) != nil
			if got != tc.want {
				t.Errorf("clientIdentityBan blocked = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestClientIdentityBanNilManager(t *testing.T) {
	config := newIdentityTestConfig(t, nil, "")
	if got := clientIdentityBan(config, nil, "203.0.113.7", "", kiwiClientIdentity); got != nil {
		t.Errorf("expected nil with no ban manager, got %+v", got)
	}
}

// TestIdentityForSessionPrefersClientSuppliedName checks the resolvers both
// protocols feed into clientIdentityBan: the recorded name wins when a paired
// connection has already registered one, otherwise the protocol placeholder is
// used. Getting this wrong would silently exempt every named client.
func TestIdentityForSessionPrefersClientSuppliedName(t *testing.T) {
	sm := newTestSessionManager(t)

	kiwi := &KiwiWebSocketHandler{sessions: sm}
	websdr := &WebSDRHandler{sessions: sm}

	if got := kiwi.identityForSession("kiwi-1700000000-203.0.113.7"); got != kiwiClientIdentity {
		t.Errorf("unnamed KiwiSDR session identity = %q, want %q", got, kiwiClientIdentity)
	}
	if got := websdr.identityForSession("websdr-1700000000-203.0.113.7"); got != websdrClientIdentity {
		t.Errorf("unnamed WebSDR session identity = %q, want %q", got, websdrClientIdentity)
	}

	sm.SetUserAgent("kiwi-1700000000-203.0.113.7", "kiwirecorder.py")
	sm.SetUserAgent("websdr-1700000000-203.0.113.7", "M0ABC")

	if got := kiwi.identityForSession("kiwi-1700000000-203.0.113.7"); got != "kiwirecorder.py" {
		t.Errorf("named KiwiSDR session identity = %q, want %q", got, "kiwirecorder.py")
	}
	if got := websdr.identityForSession("websdr-1700000000-203.0.113.7"); got != "M0ABC" {
		t.Errorf("named WebSDR session identity = %q, want %q", got, "M0ABC")
	}
}

// TestBanMiddlewareBlocksUserAgentOnCompatibilityMux guards the wiring fix: the
// KiwiSDR (:8073) and WebSDR (:8901) listeners are separate http.Servers with
// their own muxes, and before they were wrapped in banMiddleware their HTTP
// endpoints — /status, /users, /snr, the static UI — enforced no User-Agent,
// country or ASN ban at all.
func TestBanMiddlewareBlocksUserAgentOnCompatibilityMux(t *testing.T) {
	ibm, _ := newTestBanManager(t)
	if err := ibm.BanUserAgent("python-requests", "scraper", "admin", false); err != nil {
		t.Fatalf("BanUserAgent: %v", err)
	}
	config := newIdentityTestConfig(t, nil, "")

	mux := http.NewServeMux()
	mux.HandleFunc("/status", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	handler := banMiddleware(config, ibm,
		NewCountryBanManager(filepath.Join(t.TempDir(), "banned_countries.yaml"), nil),
		NewASNBanManager(filepath.Join(t.TempDir(), "banned_asns.yaml"), nil),
		mux)

	for _, tc := range []struct {
		userAgent string
		wantCode  int
	}{
		{"python-requests/2.31.0", http.StatusForbidden},
		{"Mozilla/5.0 (X11; Linux x86_64) Firefox/126.0", http.StatusOK},
		{"", http.StatusOK}, // header-less clients cannot be matched by a valid pattern
	} {
		req := httptest.NewRequest(http.MethodGet, "/status", nil)
		if tc.userAgent != "" {
			req.Header.Set("User-Agent", tc.userAgent)
		}
		req.RemoteAddr = "203.0.113.7:12345"

		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != tc.wantCode {
			t.Errorf("User-Agent %q: status = %d, want %d", tc.userAgent, rec.Code, tc.wantCode)
		}
	}
}
