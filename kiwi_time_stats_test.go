package main

import (
	"net/url"
	"testing"
	"time"
)

func kiwiConnInTimezone(tz string) *kiwiConn {
	kc := &kiwiConn{config: &Config{}}
	kc.config.Admin.Timezone = tz
	return kc
}

func decodedStat(t *testing.T, stats map[string]interface{}, key string) string {
	t.Helper()
	raw, ok := stats[key].(string)
	if !ok {
		t.Fatalf("stat %q = %#v, want a string", key, stats[key])
	}
	// The client runs ti and tn through decodeURIComponent.
	decoded, err := url.PathUnescape(raw)
	if err != nil {
		t.Fatalf("stat %q = %q does not decode: %v", key, raw, err)
	}
	return decoded
}

// The whole point: the local clock must follow the receiver's configured
// timezone, not the server process's. Under Docker the process is on UTC, so
// reading it made the local clock a duplicate of the UTC one.
func TestAddTimeStatsUsesConfiguredTimezone(t *testing.T) {
	kc := kiwiConnInTimezone("America/New_York")
	stats := map[string]interface{}{}

	kc.addTimeStats(stats)

	utcClock, localClock := stats["tu"].(string), stats["tl"].(string)
	if utcClock == "" || localClock == "" {
		t.Fatalf("tu = %q, tl = %q; both must be set", utcClock, localClock)
	}

	// New York is never on UTC, so the two clocks must differ.
	if utcClock == localClock {
		t.Errorf("tu and tl are both %q; the local clock is not following America/New_York", utcClock)
	}

	// And the local clock must actually be New York's.
	loc, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skipf("tzdata unavailable: %v", err)
	}
	if want := time.Now().In(loc).Format("15:04"); localClock != want {
		t.Errorf("tl = %q, want %q", localClock, want)
	}
}

// A receiver configured for UTC should report UTC for both, which is the case
// the old code produced accidentally for everyone.
func TestAddTimeStatsUTCReceiver(t *testing.T) {
	kc := kiwiConnInTimezone("UTC")
	stats := map[string]interface{}{}

	kc.addTimeStats(stats)

	if stats["tu"] != stats["tl"] {
		t.Errorf("tu = %v, tl = %v; a UTC receiver's clocks should agree", stats["tu"], stats["tl"])
	}
	if got := decodedStat(t, stats, "tn"); got != "UTC" {
		t.Errorf("tn = %q, want %q", got, "UTC")
	}
}

// tn is the IANA name; the client turns its underscores into spaces for
// display, so it must go out with them intact rather than pre-substituted.
func TestAddTimeStatsReportsIANAName(t *testing.T) {
	for _, tz := range []string{"Europe/London", "America/New_York", "Australia/Sydney"} {
		t.Run(tz, func(t *testing.T) {
			if _, err := time.LoadLocation(tz); err != nil {
				t.Skipf("tzdata unavailable: %v", err)
			}
			kc := kiwiConnInTimezone(tz)
			stats := map[string]interface{}{}

			kc.addTimeStats(stats)

			if got := decodedStat(t, stats, "tn"); got != tz {
				t.Errorf("tn = %q, want %q", got, tz)
			}
			if got := decodedStat(t, stats, "ti"); got == "" {
				t.Error("ti is empty; the zone abbreviation should be reported")
			}
		})
	}
}

// The abbreviation must be the one in force now, so a receiver on summer time
// reports it rather than showing its winter zone all year.
func TestAddTimeStatsAbbreviationFollowsDST(t *testing.T) {
	loc, err := time.LoadLocation("Europe/London")
	if err != nil {
		t.Skipf("tzdata unavailable: %v", err)
	}
	kc := kiwiConnInTimezone("Europe/London")
	stats := map[string]interface{}{}

	kc.addTimeStats(stats)

	want, _ := time.Now().In(loc).Zone() // "GMT" or "BST" depending on the date
	if got := decodedStat(t, stats, "ti"); got != want {
		t.Errorf("ti = %q, want %q for the current date", got, want)
	}
}

// An invalid timezone must not take the stats payload down with it;
// TimezoneLocation falls back to UTC.
func TestAddTimeStatsInvalidTimezone(t *testing.T) {
	kc := kiwiConnInTimezone("Not/AZone")
	stats := map[string]interface{}{}

	kc.addTimeStats(stats)

	if stats["tu"] != stats["tl"] {
		t.Errorf("tu = %v, tl = %v; an unparseable zone should fall back to UTC",
			stats["tu"], stats["tl"])
	}
	if got := decodedStat(t, stats, "tn"); got != "UTC" {
		t.Errorf("tn = %q, want the UTC fallback", got)
	}
}

// Both fields pass through decodeURIComponent on the client, so a "+" would
// survive as a literal plus rather than becoming a space.
func TestAddTimeStatsEncodingSurvivesDecodeURIComponent(t *testing.T) {
	kc := kiwiConnInTimezone("Europe/London")
	stats := map[string]interface{}{}

	kc.addTimeStats(stats)

	for _, key := range []string{"ti", "tn"} {
		raw, ok := stats[key].(string)
		if !ok {
			t.Fatalf("%s = %#v, want a string", key, stats[key])
		}
		if _, err := url.PathUnescape(raw); err != nil {
			t.Errorf("%s = %q is not valid percent-encoding: %v", key, raw, err)
		}
	}
}
