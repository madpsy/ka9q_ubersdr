package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func TestNormalizeBanTarget(t *testing.T) {
	ok := map[string]string{
		"192.0.2.0/24":   "192.0.2.0/24",
		" 192.0.2.5/24 ": "192.0.2.0/24",
		"203.0.113.7":    "203.0.113.7",
		"203.0.113.7/32": "203.0.113.7/32",
		"2001:DB8::1":    "2001:db8::1",
		"2001:db8::5/32": "2001:db8::/32",
	}
	for in, want := range ok {
		got, err := normalizeBanTarget(in)
		if err != nil || got != want {
			t.Errorf("normalizeBanTarget(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "192.0.2.0/33", "192.0.2/24", "not-an-ip", "1.2.3.4/", "/24", "1.2.3.4 5.6.7.8"} {
		if got, err := normalizeBanTarget(in); err == nil {
			t.Errorf("normalizeBanTarget(%q) = %q, want error", in, got)
		}
	}
}

// The admin Banned tab sends ranges to /admin/ban; they used to be refused
// with "Invalid IP address" even though the ban list supports them.
func TestHandleBanUserAcceptsCIDR(t *testing.T) {
	dir := t.TempDir()
	ban := NewIPBanManager(filepath.Join(dir, "banned_ips.yaml"))
	ah := &AdminHandler{
		config:       &Config{},
		ipBanManager: ban,
		sessions: &SessionManager{
			config:               &Config{},
			uuidToIP:             map[string]string{},
			userAgents:           map[string]string{},
			userAgentLastSeen:    map[string]time.Time{},
			kickedUUIDs:          map[string]time.Time{},
			kickedUUIDLastLogged: map[string]time.Time{},
		},
	}
	post := func(ip string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"ip": ip, "reason": "test"})
		w := httptest.NewRecorder()
		ah.HandleBanUser(w, httptest.NewRequest(http.MethodPost, "/admin/ban", bytes.NewReader(body)))
		return w
	}

	if w := post("192.0.2.0/24"); w.Code != http.StatusOK {
		t.Fatalf("ban 192.0.2.0/24: status %d: %s", w.Code, w.Body.String())
	}
	if !ban.IsBanned("192.0.2.42") || ban.IsBanned("192.0.3.1") {
		t.Fatal("CIDR ban does not cover exactly 192.0.2.0/24")
	}

	// A host address with a prefix is stored as its network.
	if w := post("198.51.100.77/24"); w.Code != http.StatusOK {
		t.Fatalf("ban 198.51.100.77/24: status %d: %s", w.Code, w.Body.String())
	}
	if _, ok := ban.GetBanInfo("198.51.100.0/24"); !ok {
		t.Fatal("range not stored in canonical form 198.51.100.0/24")
	}

	// Single addresses still work.
	if w := post("203.0.113.7"); w.Code != http.StatusOK || !ban.IsBanned("203.0.113.7") {
		t.Fatalf("single IP ban failed: status %d", w.Code)
	}

	for _, bad := range []string{"192.0.2.0/33", "192.0.2/24", "nonsense", " "} {
		if w := post(bad); w.Code != http.StatusBadRequest {
			t.Errorf("ban %q: status %d, want 400", bad, w.Code)
		}
	}
}
