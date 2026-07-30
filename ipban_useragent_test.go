package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func newTestBanManager(t *testing.T) (*IPBanManager, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "banned_ips.yaml")
	return NewIPBanManager(path), path
}

func TestUserAgentBanMatching(t *testing.T) {
	ibm, _ := newTestBanManager(t)

	if err := ibm.BanUserAgent("python-requests", "scraper", "admin", false); err != nil {
		t.Fatalf("BanUserAgent: %v", err)
	}

	// Unanchored substring search, case-insensitive by default
	for _, ua := range []string{"python-requests/2.31.0", "PYTHON-REQUESTS/2.31.0", "x python-requests x"} {
		if !ibm.IsUserAgentBanned(ua) {
			t.Errorf("expected %q to be banned", ua)
		}
	}

	for _, ua := range []string{"", "Mozilla/5.0 (X11; Linux x86_64) Firefox/126.0", "curl/8.5.0"} {
		if ibm.IsUserAgentBanned(ua) {
			t.Errorf("expected %q to be allowed", ua)
		}
	}

	ban := ibm.MatchingUserAgentBan("python-requests/2.31.0")
	if ban == nil || ban.Reason != "scraper" {
		t.Fatalf("MatchingUserAgentBan returned %+v, want reason %q", ban, "scraper")
	}
}

func TestUserAgentBanCaseSensitive(t *testing.T) {
	ibm, _ := newTestBanManager(t)

	if err := ibm.BanUserAgent("Scrapy", "scraper", "admin", true); err != nil {
		t.Fatalf("BanUserAgent: %v", err)
	}

	if !ibm.IsUserAgentBanned("Scrapy/2.11") {
		t.Error("expected exact-case match to be banned")
	}
	if ibm.IsUserAgentBanned("scrapy/2.11") {
		t.Error("expected differing case to be allowed when case_sensitive is set")
	}
}

func TestUserAgentBanRejectsCatchAll(t *testing.T) {
	ibm, _ := newTestBanManager(t)

	// Patterns that match the empty string match every possible User-Agent.
	for _, pattern := range []string{".*", "", "   ", "a?", "x*", "^$", "curl|"} {
		if err := ibm.BanUserAgent(pattern, "oops", "admin", false); err == nil {
			t.Errorf("expected catch-all pattern %q to be rejected", pattern)
		}
	}

	if got := len(ibm.GetBannedUserAgents()); got != 0 {
		t.Errorf("rejected patterns must not be stored, got %d entries", got)
	}
}

func TestUserAgentBanRejectsInvalidRegex(t *testing.T) {
	ibm, _ := newTestBanManager(t)

	if err := ibm.BanUserAgent("(unclosed", "bad", "admin", false); err == nil {
		t.Fatal("expected invalid regex to be rejected")
	}
	// RE2 has no backreferences; make sure we surface that rather than accept it.
	if err := ibm.BanUserAgent(`(a)\1`, "bad", "admin", false); err == nil {
		t.Fatal("expected backreference to be rejected by RE2")
	}
}

// TestBanFileRoundTrip is the important one: saveToFile rewrites the whole
// file, so an IP ban saved after a User-Agent ban (or vice versa) must not
// erase the other key.
func TestBanFileRoundTrip(t *testing.T) {
	ibm, path := newTestBanManager(t)

	if err := ibm.BanUserAgent("curl", "cli tool", "admin", false); err != nil {
		t.Fatalf("BanUserAgent: %v", err)
	}
	// This save must preserve the User-Agent ban written above.
	if err := ibm.BanIP("192.0.2.5", "abuse", "admin"); err != nil {
		t.Fatalf("BanIP: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !strings.Contains(string(data), "banned_user_agents:") {
		t.Fatalf("banned_user_agents key missing after an IP ban:\n%s", data)
	}

	// Reload from disk into a fresh manager
	reloaded := NewIPBanManager(path)
	if !reloaded.IsUserAgentBanned("curl/8.5.0") {
		t.Error("User-Agent ban did not survive save/reload")
	}
	if !reloaded.IsBanned("192.0.2.5") {
		t.Error("IP ban did not survive save/reload")
	}

	// Unbanning the IP must likewise leave the User-Agent ban intact
	if err := reloaded.UnbanIP("192.0.2.5"); err != nil {
		t.Fatalf("UnbanIP: %v", err)
	}
	if !NewIPBanManager(path).IsUserAgentBanned("curl/8.5.0") {
		t.Error("User-Agent ban lost when an IP was unbanned")
	}
}

// A file with no User-Agent bans must not grow an empty key, so existing
// deployments see no change to banned_ips.yaml.
func TestBanFileOmitsEmptyUserAgentKey(t *testing.T) {
	ibm, path := newTestBanManager(t)

	if err := ibm.BanIP("192.0.2.9", "abuse", "admin"); err != nil {
		t.Fatalf("BanIP: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if strings.Contains(string(data), "banned_user_agents") {
		t.Errorf("unexpected banned_user_agents key in file:\n%s", data)
	}
}

// An unusable pattern must be kept (so the operator can fix it) but must never
// match anything. This covers hand-edited files, including a catch-all that
// would otherwise block every client of the receiver.
func TestUserAgentBanKeepsUnusablePatternInactive(t *testing.T) {
	for name, pattern := range map[string]string{
		"uncompilable": "(unclosed",
		"catch-all":    ".*",
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "banned_ips.yaml")
			yaml := "banned_ips: []\nbanned_user_agents:\n" +
				"    - pattern: \"" + pattern + "\"\n      reason: broken\n      banned_by: hand-edit\n"
			if err := os.WriteFile(path, []byte(yaml), 0644); err != nil {
				t.Fatalf("WriteFile: %v", err)
			}

			ibm := NewIPBanManager(path)

			bans := ibm.GetBannedUserAgents()
			if len(bans) != 1 {
				t.Fatalf("expected the entry to be kept, got %d entries", len(bans))
			}
			if bans[0].InactiveReason == "" {
				t.Error("expected InactiveReason to be recorded")
			}
			if ibm.IsUserAgentBanned(pattern) || ibm.IsUserAgentBanned("Mozilla/5.0") || ibm.IsUserAgentBanned("") {
				t.Error("an unusable pattern must never match")
			}
		})
	}
}

func TestUserAgentBanExpiry(t *testing.T) {
	ibm, _ := newTestBanManager(t)

	if err := ibm.BanUserAgentWithDuration("scrapy", "temp", "admin", false, 20*time.Millisecond); err != nil {
		t.Fatalf("BanUserAgentWithDuration: %v", err)
	}
	if !ibm.IsUserAgentBanned("Scrapy/2.11") {
		t.Fatal("expected temporary ban to be active")
	}

	time.Sleep(40 * time.Millisecond)

	if ibm.IsUserAgentBanned("Scrapy/2.11") {
		t.Error("expected temporary ban to have expired")
	}
}

func TestUnbanUserAgent(t *testing.T) {
	ibm, _ := newTestBanManager(t)

	if err := ibm.BanUserAgent("curl", "cli", "admin", false); err != nil {
		t.Fatalf("BanUserAgent: %v", err)
	}
	if err := ibm.UnbanUserAgent("curl"); err != nil {
		t.Fatalf("UnbanUserAgent: %v", err)
	}
	if ibm.IsUserAgentBanned("curl/8.5.0") {
		t.Error("expected pattern to be unbanned")
	}
	if err := ibm.UnbanUserAgent("curl"); err == nil {
		t.Error("expected unbanning an unknown pattern to error")
	}
}
