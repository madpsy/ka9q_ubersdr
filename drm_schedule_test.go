package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A slice of the real drmrx.org feed: an all-day mediumwave entry, a normal
// shortwave window, a slot that wraps midnight, and one that does not run every
// day. The `[DRMSchedule]` header appears once at the top, as it does upstream.
const drmFeedFixture = `[DRMSchedule]
StartStopTimeUTC=0000-2400
Days[SMTWTFS]=1111111
Frequency=549
Target=India
Power=100
Programme=Akashvani
Language=Asmita Channel
Site=Mumbai B, Maharashtra
Country=India

StartStopTimeUTC=0500-0600
Days[SMTWTFS]=1111111
Frequency=5875
Target=Europe
Power=100
Programme=BBC World Service
Language=English
Site=Woofferton
Country=United Kingdom

StartStopTimeUTC=2000-1800
Days[SMTWTFS]=1111111
Frequency=3205
Target=Korea
Power=50
Programme=Korean Central Broadcasting Station
Language=Korean
Site=Pyongyang
Country=DPRK

StartStopTimeUTC=1030-1100
Days[SMTWTFS]=0010100
Frequency=15785
Target=Various
Power=1
Programme=funklust
Language=German
Site=Bayreuth
Country=Germany
`

func TestParseDRMScheduleFeed(t *testing.T) {
	entries, err := parseDRMScheduleFeed([]byte(drmFeedFixture))
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(entries) != 4 {
		t.Fatalf("got %d entries, want 4", len(entries))
	}

	akashvani := entries[0]
	if akashvani.Station != "Akashvani" {
		t.Errorf("station = %q, want Akashvani", akashvani.Station)
	}
	if akashvani.FreqKHz != 549 || akashvani.FreqHz != 549000 {
		t.Errorf("frequency = %v kHz / %v Hz, want 549 / 549000", akashvani.FreqKHz, akashvani.FreqHz)
	}
	if akashvani.StartUTC != 0 || akashvani.EndUTC != 2400 {
		t.Errorf("slot = %d-%d, want 0-2400", akashvani.StartUTC, akashvani.EndUTC)
	}
	if akashvani.Band != "MW" {
		t.Errorf("band = %q, want MW (549 kHz)", akashvani.Band)
	}
	if akashvani.Language != "Asmita Channel" || akashvani.Country != "India" || akashvani.PowerKW != "100" {
		t.Errorf("metadata not carried through: %+v", akashvani)
	}

	// The `[DRMSchedule]` header sits in the first block and must not have
	// displaced any field of it.
	if akashvani.Target != "India" || akashvani.Site != "Mumbai B, Maharashtra" {
		t.Errorf("header line disturbed the first block: %+v", akashvani)
	}

	if entries[1].Band != "SW" {
		t.Errorf("5875 kHz band = %q, want SW", entries[1].Band)
	}
	if entries[3].DaysMask != "0010100" {
		t.Errorf("days mask = %q, want 0010100", entries[3].DaysMask)
	}
}

// An HTML error page must be rejected rather than parsed into nothing, so the
// log says what actually came back.
func TestParseDRMScheduleFeedRejectsHTML(t *testing.T) {
	if _, err := parseDRMScheduleFeed([]byte("<!DOCTYPE html>\n<html><body>404</body></html>")); err == nil {
		t.Fatal("expected an error for an HTML response")
	}
}

func TestParseDRMScheduleFeedRejectsEmpty(t *testing.T) {
	if _, err := parseDRMScheduleFeed([]byte("\n\n  \n")); err == nil {
		t.Fatal("expected an error for an empty feed")
	}
}

// The KiwiSDR fallback, exercising every time form it uses: a "H:M" string, the
// leading minus that means "verified" rather than a negative time, the "5:60"
// that has to carry into the next hour, and a bare fractional hour.
func TestParseDRMScheduleCJSON(t *testing.T) {
	const fixture = `[
// a comment, which is legal in a cjson file
  {
  "SW": null,
      "BBC World Service": ["https://drmrx.org/x",5875,"-5:0","6:0",17575,"-15:0","16:0"],
      "Radio Romania International": ["https://drmrx.org/y",17680,"-5:30","5:60"],
      "Old_Format Station": [9800,3,-4.5]
  },
  {
  "MW": null,
      "Yunnan Broadcast": [1557,"-0:1","24:0"]
  },
  {}
]`

	entries, err := parseDRMScheduleCJSON([]byte(fixture))
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	if len(entries) != 5 {
		t.Fatalf("got %d entries, want 5: %+v", len(entries), entries)
	}

	byFreq := map[float64]DRMScheduleEntry{}
	for _, e := range entries {
		byFreq[e.FreqKHz] = e
	}

	if e := byFreq[5875]; e.StartUTC != 500 || e.EndUTC != 600 {
		t.Errorf("5875 slot = %d-%d, want 500-600", e.StartUTC, e.EndUTC)
	}
	// "5:60" is six o'clock, not five past sixty.
	if e := byFreq[17680]; e.StartUTC != 530 || e.EndUTC != 600 {
		t.Errorf("17680 slot = %d-%d, want 530-600", e.StartUTC, e.EndUTC)
	}
	// A bare fractional hour: 4.5 is 04:30, and the minus is not a negative.
	if e := byFreq[9800]; e.StartUTC != 300 || e.EndUTC != 430 {
		t.Errorf("9800 slot = %d-%d, want 300-430", e.StartUTC, e.EndUTC)
	}
	if e := byFreq[9800]; e.Station != "Old Format Station" {
		t.Errorf("station = %q, want the underscore replaced", e.Station)
	}
	if e := byFreq[1557]; e.Band != "MW" || e.EndUTC != 2400 {
		t.Errorf("1557 entry = %+v, want MW ending 2400", e)
	}
	// No day information in this format, so nothing may be filtered on it.
	if e := byFreq[5875]; e.DaysMask != "" || e.Days != "Daily" {
		t.Errorf("days = %q/%q, want empty mask labelled Daily", e.DaysMask, e.Days)
	}
}

func TestDRMSlotActive(t *testing.T) {
	cases := []struct {
		name             string
		start, end, when int
		want             bool
	}{
		{"all day", 0, 2400, 1234, true},
		{"inside window", 500, 600, 530, true},
		{"at the start", 500, 600, 500, true},
		{"at the end is over", 500, 600, 600, false},
		{"before", 500, 600, 459, false},
		{"wraps midnight, evening side", 2000, 1800, 2300, true},
		{"wraps midnight, morning side", 2000, 1800, 300, true},
		{"wraps midnight, the gap", 2000, 1800, 1900, false},
	}
	for _, c := range cases {
		if got := drmSlotActive(c.start, c.end, c.when); got != c.want {
			t.Errorf("%s: drmSlotActive(%d,%d,%d) = %v, want %v", c.name, c.start, c.end, c.when, got, c.want)
		}
	}
}

func TestDRMDaysMatch(t *testing.T) {
	// Mask is Sunday-first, which is the order time.Weekday counts in.
	const tueThu = "0010100"
	if drmDaysMatch(tueThu, time.Sunday) {
		t.Error("Tue/Thu mask matched Sunday")
	}
	if !drmDaysMatch(tueThu, time.Tuesday) || !drmDaysMatch(tueThu, time.Thursday) {
		t.Error("Tue/Thu mask did not match Tuesday or Thursday")
	}
	if drmDaysMatch("0000000", time.Wednesday) {
		t.Error("an all-zero mask is off air and must match nothing")
	}
	// No day information is not a reason to hide a broadcast.
	for _, mask := range []string{"", "junk"} {
		if !drmDaysMatch(mask, time.Friday) {
			t.Errorf("mask %q should be treated as daily", mask)
		}
	}
}

func TestDRMDaysLabel(t *testing.T) {
	cases := map[string]string{
		"1111111": "Daily",
		"":        "Daily",
		"0000000": "Off air",
		"0010100": "Tue, Thu",
		"1111110": "Sun–Fri",
		"0111110": "Mon–Fri",
		"1000001": "Sun, Sat",
		"1010101": "Sun, Tue, Thu, Sat",
	}
	for mask, want := range cases {
		if got := drmDaysLabel(mask); got != want {
			t.Errorf("drmDaysLabel(%q) = %q, want %q", mask, got, want)
		}
	}
}

func TestDRMEntryIsOnAir(t *testing.T) {
	entries, err := parseDRMScheduleFeed([]byte(drmFeedFixture))
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}

	// A Wednesday, 05:30 UTC.
	wed := time.Date(2026, 8, 26, 5, 30, 0, 0, time.UTC)

	if !entries[1].IsOnAir(wed) {
		t.Error("BBC 0500-0600 should be on air at 05:30")
	}
	if !entries[0].IsOnAir(wed) {
		t.Error("an 0000-2400 entry should always be on air")
	}
	// funklust is Tue/Thu only, and 05:30 is outside its slot anyway.
	if entries[3].IsOnAir(wed) {
		t.Error("funklust should not be on air on a Wednesday")
	}
	// Right day, wrong hour.
	tue := time.Date(2026, 8, 25, 5, 30, 0, 0, time.UTC)
	if entries[3].IsOnAir(tue) {
		t.Error("funklust should not be on air at 05:30 on a Tuesday")
	}
	// Right day, right hour.
	tueOn := time.Date(2026, 8, 25, 10, 45, 0, 0, time.UTC)
	if !entries[3].IsOnAir(tueOn) {
		t.Error("funklust should be on air at 10:45 on a Tuesday")
	}
}

// Out-of-range entries are dropped on the way out: the panel makes these
// clickable, and a row that can only refuse to tune is worse than an absent one.
func TestDRMScheduleEntriesRespectReceiverRange(t *testing.T) {
	entries, err := parseDRMScheduleFeed([]byte(drmFeedFixture))
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	s := &DRMSchedule{entries: entries}

	// A receiver starting at 1.8 MHz cannot reach the 549 kHz mediumwave entry.
	got := s.Entries(1_800_000, 30_000_000)
	for _, e := range got {
		if e.FreqHz < 1_800_000 {
			t.Errorf("entry below the receiver's minimum survived: %+v", e)
		}
	}
	if len(got) != 3 {
		t.Errorf("got %d entries, want 3 (549 kHz dropped)", len(got))
	}

	// And one stopping at 10 MHz cannot reach 15785.
	if got := s.Entries(0, 10_000_000); len(got) != 3 {
		t.Errorf("got %d entries, want 3 (15785 kHz dropped)", len(got))
	}
}

// A refresh that fails must not throw away what is already loaded — a schedule
// that changes twice a year is still worth showing when today's copy could not
// be had. This drives refresh() with both URLs pointed at a dead server.
func TestDRMScheduleFailureKeepsPreviousData(t *testing.T) {
	entries, err := parseDRMScheduleFeed([]byte(drmFeedFixture))
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}

	// A server that refuses everything, so both the primary and the fallback
	// exhaust their retries.
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusInternalServerError)
	}))
	defer dead.Close()

	loadedAt := time.Now().Add(-time.Hour)
	s := &DRMSchedule{
		entries:  entries,
		source:   "test",
		loadedAt: loadedAt,
		stopChan: make(chan struct{}),
		// Closed immediately: the retry backoff waits on this channel, so an
		// already-shut-down schedule runs the attempts without the delays and
		// the test does not spend half a minute sleeping.
	}
	close(s.stopChan)

	if err := s.refreshFrom(dead.URL, dead.URL); err == nil {
		t.Fatal("expected the refresh to fail")
	}

	if len(s.entries) != len(entries) {
		t.Errorf("entries = %d, want the %d already loaded", len(s.entries), len(entries))
	}
	if !s.loadedAt.Equal(loadedAt) {
		t.Error("loadedAt moved on a failed refresh — the data would be dated wrongly")
	}
	if s.lastError == "" {
		t.Error("no lastError recorded, so nothing can say why the schedule is old")
	}
	if s.failures != 1 {
		t.Errorf("failures = %d, want 1", s.failures)
	}
	if !s.IsLoaded() {
		t.Error("the schedule stopped reporting itself loaded despite still holding entries")
	}

	// And the status a failing-but-populated receiver reports.
	st := s.Status()
	if st["loaded"] != true {
		t.Error("Status says not loaded while entries are held")
	}
	if st["last_error"] == nil {
		t.Error("Status does not carry last_error")
	}
}

// Data that did load goes stale once the daily refresh has been failing for
// long enough, so the panel can stop presenting it as current.
func TestDRMScheduleStaleness(t *testing.T) {
	entries, _ := parseDRMScheduleFeed([]byte(drmFeedFixture))

	fresh := &DRMSchedule{entries: entries, loadedAt: time.Now().Add(-time.Hour)}
	if fresh.Status()["stale"] != false {
		t.Error("an hour-old schedule is not stale")
	}
	// A single missed refresh is not staleness: the schedule changes twice a
	// year, so yesterday's copy is still right.
	day := &DRMSchedule{entries: entries, loadedAt: time.Now().Add(-25 * time.Hour)}
	if day.Status()["stale"] != false {
		t.Error("a day-old schedule should not yet be called stale")
	}
	old := &DRMSchedule{entries: entries, loadedAt: time.Now().Add(-72 * time.Hour)}
	if old.Status()["stale"] != true {
		t.Error("a three-day-old schedule should be stale")
	}
	// Nothing loaded is a different thing from something stale, and saying both
	// would have the panel showing two contradictory notes.
	empty := &DRMSchedule{}
	if empty.Status()["stale"] != false {
		t.Error("an empty schedule must not report itself stale")
	}
}

// A receiver that could never fetch serves a well-formed empty answer carrying
// the reason, rather than an error the panel has to special-case.
func TestHandleDRMScheduleAfterFailure(t *testing.T) {
	cfg := &Config{}
	cfg.Receiver = testReceiver(30_000_000)

	s := &DRMSchedule{lastError: "both sources failed: HTTP 500", failures: 3, lastAttempt: time.Now()}

	rec := httptest.NewRecorder()
	handleDRMSchedule(rec, httptest.NewRequest(http.MethodGet, "/api/drm/schedule", nil), cfg, s)
	if rec.Code != http.StatusOK {
		t.Fatalf("HTTP %d", rec.Code)
	}

	var got struct {
		Enabled   bool          `json:"enabled"`
		Loaded    bool          `json:"loaded"`
		Stale     bool          `json:"stale"`
		LastError string        `json:"last_error"`
		Entries   []interface{} `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("%v (body %s)", err, rec.Body.String())
	}
	if !got.Enabled || got.Loaded || len(got.Entries) != 0 {
		t.Errorf("response = %+v, want enabled, not loaded, no entries", got)
	}
	if got.LastError == "" {
		t.Error("last_error is not served, so the panel cannot say why the list is empty")
	}
	if got.Stale {
		t.Error("nothing loaded must not also be reported stale")
	}
}

// A nil schedule is the disabled case and every method must tolerate it — the
// handler calls straight through when the config turns the fetch off.
func TestDRMScheduleNilSafe(t *testing.T) {
	var s *DRMSchedule
	if s.IsLoaded() {
		t.Error("a nil schedule is not loaded")
	}
	if got := s.Entries(0, 30_000_000); got != nil {
		t.Errorf("Entries on nil = %v, want nil", got)
	}
	if got := s.GetActiveEntries(time.Now(), 0, 30_000_000); got != nil {
		t.Errorf("GetActiveEntries on nil = %v, want nil", got)
	}
	if enabled, _ := s.Status()["enabled"].(bool); enabled {
		t.Error("a nil schedule reports itself enabled")
	}
	s.Stop() // must not panic
}

// The handler is what the panel actually sees, so it is worth testing as a
// whole: the shape of the response, the on-air flag, and the two filters that
// decide what is in it.
func TestHandleDRMSchedule(t *testing.T) {
	entries, err := parseDRMScheduleFeed([]byte(drmFeedFixture))
	if err != nil {
		t.Fatalf("parse failed: %v", err)
	}
	schedule := &DRMSchedule{entries: entries, source: "test", loadedAt: time.Now()}

	cfg := &Config{}
	cfg.Receiver = testReceiver(30_000_000)

	type row struct {
		DRMScheduleEntry
		OnAir bool `json:"on_air"`
	}
	type body struct {
		Enabled bool   `json:"enabled"`
		Loaded  bool   `json:"loaded"`
		NowUTC  string `json:"now_utc"`
		Entries []row  `json:"entries"`
	}

	get := func(target string) body {
		t.Helper()
		rec := httptest.NewRecorder()
		handleDRMSchedule(rec, httptest.NewRequest(http.MethodGet, target, nil), cfg, schedule)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: HTTP %d", target, rec.Code)
		}
		var got body
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("%s: %v (body %s)", target, err, rec.Body.String())
		}
		return got
	}

	all := get("/api/drm/schedule")
	if !all.Enabled || !all.Loaded {
		t.Errorf("enabled/loaded = %v/%v, want true/true", all.Enabled, all.Loaded)
	}
	if len(all.Entries) != 4 {
		t.Fatalf("got %d entries, want 4", len(all.Entries))
	}
	if all.NowUTC == "" {
		t.Error("no now_utc in the response — the panel has nothing to date the list by")
	}
	// The whole point of the row: enough to show and enough to tune.
	first := all.Entries[0]
	if first.FreqHz == 0 || first.Station == "" || first.Days == "" || first.Band == "" {
		t.Errorf("row is missing what the panel draws: %+v", first)
	}

	// The all-day mediumwave entry is on air whenever the request is made, so
	// on_air must be set on at least it.
	onAir := get("/api/drm/schedule?on_air=1")
	if len(onAir.Entries) == 0 || len(onAir.Entries) >= len(all.Entries) {
		t.Errorf("on_air=1 returned %d of %d entries", len(onAir.Entries), len(all.Entries))
	}
	for _, e := range onAir.Entries {
		if !e.OnAir {
			t.Errorf("on_air=1 returned an entry that is not on air: %+v", e)
		}
	}

	// A receiver that stops at 10 MHz must not be offered the 15785 kHz entry.
	cfg.Receiver = testReceiver(10_000_000)
	narrow := get("/api/drm/schedule")
	for _, e := range narrow.Entries {
		if e.FreqHz > 10_000_000 {
			t.Errorf("entry above the receiver's range was served: %+v", e)
		}
	}

	// Disabled: a well-formed empty answer, not an error the panel has to
	// special-case.
	rec := httptest.NewRecorder()
	handleDRMSchedule(rec, httptest.NewRequest(http.MethodGet, "/api/drm/schedule", nil), cfg, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("disabled: HTTP %d", rec.Code)
	}
	var off body
	if err := json.Unmarshal(rec.Body.Bytes(), &off); err != nil {
		t.Fatalf("disabled: %v (body %s)", err, rec.Body.String())
	}
	if off.Enabled || off.Loaded || len(off.Entries) != 0 {
		t.Errorf("disabled response = %+v, want enabled/loaded false and no entries", off)
	}
}
