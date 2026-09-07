package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// A slice of the real ng3k.com/adxo.xml, chosen for the cases that actually
// bite: a same-month range, a cross-month range, a cross-YEAR range, an entry
// whose call field is a bare prefix but whose callsign the text goes on to give,
// another whose text never does, an entry with its own website, one with a grid
// square and an IOTA reference, and the "By <CALL> fm <place>" opening that
// every single announcement carries.
const adxoFixture = `<?xml version="1.0" ?>
<rss version="2.0">
<channel>
<title>ADXO</title>

<item>
<title>Namibia: Aug 25-Oct 10, 2026 -- V51WH -- QSL via: DK2WH</title>
<description>
Aug 25-Oct 10, 2026 --
Namibia --
V51WH --
QSL: DK2WH --
Source: MM0NDX (Jul 5, 2026) --
By DK2WH fm nr Omaruru; 160-6m, incl 60m; QRV as V55Y in CQWW RTTY Contest
</description>
<link>http://www.ng3k.com/Misc/adxo.html</link>
</item>

<item>
<title>Papua New Guinea: Aug 29-Sep 8, 2026 -- P29YY -- QSL via: LoTW</title>
<description>
Aug 29-Sep 8, 2026 --
Papua New Guinea --
P29YY --
QSL: LoTW --
Source: 425DXN (Aug 28, 2026) --
By OH7O fm Kavieng, New Ireland I (IOTA OC-008, QI57jk); 80-10m, perhaps 160m; SSB FT8, QRS CW by request (not during pileups)
</description>
<link>https://oh7o.com/p29yy/</link>
</item>

<item>
<title>Iceland: Aug 30-Sep 13, 2026 -- TF -- QSL via: LoTW)</title>
<description>
Aug 30-Sep 13, 2026 --
Iceland --
TF --
QSL: LoTW) --
Source: OPDX (Aug 30, 2026) --
By DA6IC as TF/DA6IC/p fm Iceland's Ring Road; focus on 40 15 10m; SSB, FT8 FT4 as needed due to propagation; 50-100w;POTA activations
</description>
<link>http://www.ng3k.com/Misc/adxo.html</link>
</item>

<item>
<title>San Andres: Oct 1-9, 2026 -- HK0 -- QSL via: Club Log</title>
<description>
Oct 1-9, 2026 --
San Andres I --
HK0 --
QSL: Club Log --
Source: DX-World (Sep 1, 2026) --
By PY8WW fm IOTA NA-033; 20-6m; SSB CW + digital; holiday style operation
</description>
<link>http://www.ng3k.com/Misc/adxo.html</link>
</item>

<item>
<title>Guyana: Dec 23, 2026-Jan 6, 2027 -- 8R1TM -- QSL via: PY1SAD</title>
<description>
Dec 23, 2026-Jan 6, 2027 --
Guyana --
8R1TM --
QSL: PY1SAD --
Source: DX-World (Nov 1, 2026) --
By PY1SAD fm Georgetown (GJ06vs); HF + 6m; CW SSB + digital; QSL via PY1SAD direct
</description>
<link>javascript:alert(1)</link>
</item>

</channel>
</rss>`

func parseFixture(t *testing.T) []DXpedition {
	t.Helper()
	entries, err := parseADXO([]byte(adxoFixture))
	if err != nil {
		t.Fatalf("parseADXO: %v", err)
	}
	if len(entries) != 5 {
		t.Fatalf("parsed %d entries, want 5", len(entries))
	}
	return entries
}

func byCall(t *testing.T, entries []DXpedition, call string) DXpedition {
	t.Helper()
	for _, e := range entries {
		if e.Call == call {
			return e
		}
	}
	t.Fatalf("no entry for %q", call)
	return DXpedition{}
}

func TestParseADXOFields(t *testing.T) {
	entries := parseFixture(t)
	v51 := byCall(t, entries, "V51WH")

	if v51.Entity != "Namibia" {
		t.Errorf("entity = %q, want Namibia", v51.Entity)
	}
	if v51.QSL != "DK2WH" {
		t.Errorf("qsl = %q, want DK2WH", v51.QSL)
	}
	if v51.Source != "MM0NDX (Jul 5, 2026)" {
		t.Errorf("source = %q", v51.Source)
	}
	if v51.Dates != "Aug 25-Oct 10, 2026" {
		t.Errorf("dates = %q", v51.Dates)
	}
	// The raw info line ships verbatim: the band parse below drops the "incl
	// 60m" qualifier's nuance, and the client must still be able to show what
	// the announcement said.
	if want := "By DK2WH fm nr Omaruru; 160-6m, incl 60m; QRV as V55Y in CQWW RTTY Contest"; v51.Info != want {
		t.Errorf("info = %q, want %q", v51.Info, want)
	}
}

func TestParseADXODateShapes(t *testing.T) {
	entries := parseFixture(t)

	cases := []struct {
		call             string
		wantStart        string // RFC3339 UTC
		wantEndInclusive string
	}{
		// Cross-month, one year on the right.
		{"V51WH", "2026-08-25T00:00:00Z", "2026-10-10T23:59:59Z"},
		// Same year, two months.
		{"P29YY", "2026-08-29T00:00:00Z", "2026-09-08T23:59:59Z"},
		// Cross-YEAR: both halves carry their own year.
		{"8R1TM", "2026-12-23T00:00:00Z", "2027-01-06T23:59:59Z"},
	}
	for _, c := range cases {
		e := byCall(t, entries, c.call)
		gotStart := time.Unix(e.StartUnix, 0).UTC().Format(time.RFC3339)
		gotEnd := time.Unix(e.EndUnix, 0).UTC().Format(time.RFC3339)
		if gotStart != c.wantStart {
			t.Errorf("%s start = %s, want %s", c.call, gotStart, c.wantStart)
		}
		// The last announced day must be INSIDE the range. An exclusive end
		// silently drops the final day of every operation.
		if gotEnd != c.wantEndInclusive {
			t.Errorf("%s end = %s, want %s", c.call, gotEnd, c.wantEndInclusive)
		}
	}
}

func TestParseADXODatesSameMonthAndRollback(t *testing.T) {
	// "Sep 1-12, 2026": the right half is a bare day and inherits both the
	// month and the year from the left.
	start, end, ok := parseADXODates("Sep 1-12, 2026")
	if !ok {
		t.Fatal("Sep 1-12, 2026 did not parse")
	}
	if got := time.Unix(start, 0).UTC().Format("2006-01-02"); got != "2026-09-01" {
		t.Errorf("start = %s", got)
	}
	if got := time.Unix(end, 0).UTC().Format("2006-01-02"); got != "2026-09-12" {
		t.Errorf("end = %s", got)
	}

	// "Dec 28-Jan 8, 2027" written without the start year: the start must roll
	// back a year rather than landing eleven months after the end.
	start, end, ok = parseADXODates("Dec 28-Jan 8, 2027")
	if !ok {
		t.Fatal("Dec 28-Jan 8, 2027 did not parse")
	}
	if got := time.Unix(start, 0).UTC().Format("2006-01-02"); got != "2026-12-28" {
		t.Errorf("start = %s, want 2026-12-28 (rolled back a year)", got)
	}
	if end <= start {
		t.Errorf("end %d is not after start %d", end, start)
	}

	if _, _, ok := parseADXODates("not a date at all"); ok {
		t.Error("garbage parsed as a date range")
	}
}

func TestParseADXOBands(t *testing.T) {
	entries := parseFixture(t)

	// "160-6m" is a run across the ladder, and the range must not also be read
	// as a bare "6m" by the list pass.
	v51 := byCall(t, entries, "V51WH")
	wantV51 := []string{"160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m"}
	assertStrings(t, "V51WH bands", v51.Bands, wantV51)

	// "focus on 40 15 10m" — three bands sharing one trailing "m". And "50-100w"
	// in the same line is a power figure, not a band.
	tf := byCall(t, entries, "TF/DA6IC")
	assertStrings(t, "TF bands", tf.Bands, []string{"40m", "15m", "10m"})

	// "HF + 6m" expands HF to the nine HF bands and adds 6m on top.
	g := byCall(t, entries, "8R1TM")
	assertStrings(t, "8R1TM bands", g.Bands,
		[]string{"160m", "80m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m"})

	// An announcement that says nothing about bands yields nothing — never a
	// guess, and never "all of them".
	if got := parseADXOBands("By G0ABC fm somewhere; details to follow"); len(got) != 0 {
		t.Errorf("bands from a bandless line = %v, want none", got)
	}
}

func TestParseADXOModesIgnoresLowercaseFm(t *testing.T) {
	entries := parseFixture(t)

	// Every announcement in the feed opens "By <CALL> fm <place>", where "fm"
	// means "from". Matching modes case-insensitively reports FM on all of them.
	for _, e := range entries {
		for _, m := range e.Modes {
			if m == "FM" {
				t.Errorf("%s: 'fm' (from) was read as the FM mode — modes: %v", e.Call, e.Modes)
			}
		}
	}

	assertStrings(t, "P29YY modes", byCall(t, entries, "P29YY").Modes, []string{"CW", "SSB", "FT8"})
	assertStrings(t, "TF modes", byCall(t, entries, "TF/DA6IC").Modes, []string{"SSB", "FT8", "FT4"})
	// "+ digital" is lower case and a category rather than a mode.
	assertStrings(t, "8R1TM modes", byCall(t, entries, "8R1TM").Modes, []string{"CW", "SSB", "DIGITAL"})

	// An uppercase FM really is the mode.
	assertStrings(t, "explicit FM", parseADXOModes("By G0ABC fm home; 2m FM only"), []string{"FM"})
}

func TestParseADXOGridAndIOTA(t *testing.T) {
	entries := parseFixture(t)

	p29 := byCall(t, entries, "P29YY")
	if p29.Grid != "QI57jk" {
		t.Errorf("grid = %q, want QI57jk", p29.Grid)
	}
	if p29.IOTA != "OC-008" {
		t.Errorf("iota = %q, want OC-008", p29.IOTA)
	}

	// The locator's lowercase tail is what stops an all-caps callsign matching.
	if got := adxoGridRe.FindString("By DK2WH fm nr Omaruru; worked AB12CD"); got != "" {
		t.Errorf("an all-caps token matched as a grid: %q", got)
	}
}

func TestADXOPrefixOnly(t *testing.T) {
	// adxoPrefixOnly is about the SHAPE of a callsign field, before any recovery.
	prefixes := []string{"TF", "J3", "9N", "HP", "HK0", "V4", "S79", "PJ2", "FO", "FS", "VP9", "JD1", "ZA", "J6"}
	for _, c := range prefixes {
		if !adxoPrefixOnly(c) {
			t.Errorf("%q read as an issued callsign, want prefix-only", c)
		}
	}
	calls := []string{
		"V51WH", "P29YY", "D44TWO", "8R1TM", "T88PB", "3W9C", "Z68PX",
		// Three characters and every one an issued DXpedition call. A length
		// floor here reported them as prefixes, which took them out of any spot
		// matching downstream — see adxoPrefixOnly.
		"S9R", "C8K", "C5H",
	}
	for _, c := range calls {
		if adxoPrefixOnly(c) {
			t.Errorf("%q read as a bare prefix, want a callsign", c)
		}
	}
}

func TestPrefixOnlyMeansNothingToListenFor(t *testing.T) {
	// The published flag is not the shape test above: it says whether anything
	// can be listened for at all. A prefix whose callsign the announcement went
	// on to state is not prefix-only — Call carries the recovered callsign, the
	// prefix moves to AnnouncedAs, and a consumer can match spots on Call
	// without knowing any of that happened.
	entries := parseFixture(t)

	tf := byCall(t, entries, "TF/DA6IC")
	if tf.PrefixOnly {
		t.Error("TF/DA6IC: a recovered callsign is still flagged prefix-only")
	}
	if tf.AnnouncedAs != "TF" {
		t.Errorf("announced_as = %q, want TF", tf.AnnouncedAs)
	}
	assertStrings(t, "TF operating_calls", tf.OperatingCalls, []string{"TF/DA6IC"})
	assertStrings(t, "TF also_calls", tf.AlsoCalls, nil)

	// An announcement that already carried a callsign is untouched: nothing to
	// recover, so nothing to say about what it was announced as.
	v51 := byCall(t, entries, "V51WH")
	if v51.PrefixOnly || v51.AnnouncedAs != "" {
		t.Errorf("V51WH: prefix_only=%v announced_as=%q, want false and empty", v51.PrefixOnly, v51.AnnouncedAs)
	}

	// And the case the flag exists for: a prefix with nothing recoverable.
	bare := byCall(t, entries, "HK0")
	if !bare.PrefixOnly {
		t.Error("HK0: nothing was recovered, so it must still be prefix-only")
	}
	if bare.AnnouncedAs != "" {
		t.Errorf("HK0 announced_as = %q, want empty — nothing was promoted", bare.AnnouncedAs)
	}
	if len(bare.OperatingCalls) != 0 {
		t.Errorf("HK0 operating_calls = %v, want none", bare.OperatingCalls)
	}
}

func TestADXOWebsite(t *testing.T) {
	entries := parseFixture(t)

	if got := byCall(t, entries, "P29YY").Website; got != "https://oh7o.com/p29yy/" {
		t.Errorf("website = %q", got)
	}
	// A link back at the generic ADXO listing is not the operation's own page.
	if got := byCall(t, entries, "V51WH").Website; got != "" {
		t.Errorf("the generic ADXO link was published as a website: %q", got)
	}
	// Third-party content: anything that is not http(s) must be refused here,
	// not at the point some future client opens it.
	if got := byCall(t, entries, "8R1TM").Website; got != "" {
		t.Errorf("a javascript: URL survived: %q", got)
	}
	for _, bad := range []string{"file:///etc/passwd", "data:text/html,x", "http://a b", ""} {
		if got := adxoWebsite(bad); got != "" {
			t.Errorf("adxoWebsite(%q) = %q, want empty", bad, got)
		}
	}
}

func TestParseADXOAlsoCalls(t *testing.T) {
	entries := parseFixture(t)

	// "QRV as V55Y in CQWW RTTY Contest" — a contest call, listed but never
	// substituted for the announced one.
	v51 := byCall(t, entries, "V51WH")
	assertStrings(t, "V51WH also_calls", v51.AlsoCalls, []string{"V55Y"})
	if v51.Call != "V51WH" {
		t.Errorf("the announced call was overwritten: %q", v51.Call)
	}

	// "By DA6IC as TF/DA6IC/p" is the operation's OWN call, so it is promoted
	// into Call rather than listed as a secondary one — see
	// TestPrefixOnlyMeansNothingToListenFor.
	assertStrings(t, "TF/DA6IC also_calls", byCall(t, entries, "TF/DA6IC").AlsoCalls, nil)

	// "FT8 FT4 as needed due to propagation" is not a callsign.
	for _, c := range byCall(t, entries, "TF/DA6IC").AlsoCalls {
		if c == "NEEDED" || c == "needed" {
			t.Error("'as needed' was read as a callsign")
		}
	}
}

func TestParseADXOOperatingCalls(t *testing.T) {
	// The portable convention: an operator working from another country signs
	// that country's prefix, an oblique and their own call. So an announcement
	// made before the operation's callsign was issued — which can only put the
	// PREFIX in the callsign field — still says what will be on the air, one
	// line down. Sixteen of the eighteen prefix-only entries in a sampled feed
	// name one this way.
	cases := []struct {
		name   string
		prefix string
		info   string
		want   []string
	}{
		{
			// The common form, and the one the convention names.
			name: "prefix first", prefix: "PJ2",
			info: "By K5SL as PJ2/K5SL; 40-17m; CW; mornings and late afternoons",
			want: []string{"PJ2/K5SL"},
		},
		{
			name: "prefix first, with more text after it", prefix: "S79",
			info: "By DL2SBY as S79/DL2SBY fm Mahe I (IOTA AF-024, LI75rk); 80-6m; CW SSB FT8; QSL via DL2SBY direct",
			want: []string{"S79/DL2SBY"},
		},
		{
			// The same convention with the parts the other way round, which is
			// how some countries issue it. Missing this form loses the entry
			// entirely — there is nothing else in the line to find.
			name: "prefix appended instead", prefix: "VP9",
			info: "By W9HT as W9HT/VP9; HF + 6m; CW SSB FT8; QSL via W9HT Direct",
			want: []string{"W9HT/VP9"},
		},
		{
			// Not portable at all: a call actually issued in that prefix, which
			// is what a planned operation gets once the licence comes through.
			name: "an issued call in the prefix", prefix: "J3",
			info: "By MM8IJU as J38LD and GM5RDX as J38DX fm IOTA NA-024; 80-6m; SSB FT8 FT4",
			want: []string{"J38LD", "J38DX"},
		},
		{
			// Four operators, and both forms in the same announcement.
			name: "several operators, both forms", prefix: "JD1",
			info: "By JA1XYZ as JD1BON, JD1BOK, JE1NVD/JD1 and JI1CRM/JD1; 160-6m",
			want: []string{"JD1BON", "JD1BOK", "JE1NVD/JD1", "JI1CRM/JD1"},
		},
		{
			// The announcement really has not said. Nothing is invented: the
			// operator's home call is not what will be on the air.
			name: "not announced", prefix: "HK0",
			info: "By PY8WW fm IOTA NA-033; 20-6m; SSB CW + digital; holiday style operation",
			want: nil,
		},
		{
			// A mode is not a callsign, however its letters start. There is an
			// FT prefix, and "FT8" is in almost every announcement in the feed.
			name: "a mode is not a call", prefix: "FT",
			info: "By G0ABC; 20m; FT8 FT4; 100w",
			want: nil,
		},
		{
			// The bare prefix is the thing being replaced, not an answer to it.
			name: "the prefix itself does not count", prefix: "FS",
			info: "By DL1MGB; FS is the entity; 160-10m; CW",
			want: nil,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := parseADXOOperatingCalls(c.info, c.prefix)
			assertStrings(t, "operating calls", got, c.want)
		})
	}
}

func TestOperatingCallsOnlyWhenTheCallIsAPrefix(t *testing.T) {
	// An announcement that already carries a callsign has nothing to recover:
	// that call IS the operating call, and a second list would be a second
	// answer to a question that has one.
	entries := parseFixture(t)
	v51 := byCall(t, entries, "V51WH")
	if len(v51.OperatingCalls) != 0 {
		t.Errorf("V51WH already has a call but got operating_calls %v", v51.OperatingCalls)
	}
	// Its contest call is still reported, as the secondary thing it is.
	assertStrings(t, "V51WH also_calls", v51.AlsoCalls, []string{"V55Y"})
}

func TestParseADXORejectsUnusableFeed(t *testing.T) {
	// A feed whose items exist but no longer parse is a FORMAT CHANGE, and must
	// surface as an error — the caller's contract on error is to keep the
	// previous dataset, which is the right answer here.
	broken := `<rss version="2.0"><channel>
	  <item><title>x</title><description>nothing useful</description><link>x</link></item>
	</channel></rss>`
	if _, err := parseADXO([]byte(broken)); err == nil {
		t.Error("a feed with no parseable items returned success")
	}
	if _, err := parseADXO([]byte(`<rss version="2.0"><channel></channel></rss>`)); err == nil {
		t.Error("an empty feed returned success")
	}
	if _, err := parseADXO([]byte("this is not xml")); err == nil {
		t.Error("non-XML returned success")
	}
}

// newTestDXpeditions is a fetcher with no background loop, wired to a receiver
// that covers the whole of HF.
func newTestDXpeditions() *DXpeditions {
	return &DXpeditions{
		minFreq:  10000,
		maxFreq:  30000000,
		stopChan: make(chan struct{}),
	}
}

func TestDXpeditionsKeepsPreviousDatasetOnFailure(t *testing.T) {
	// The backoff is 2s/4s/8s in production; four failing attempts would put
	// fourteen seconds of sleep in this test.
	restore := adxoRetryDelay
	adxoRetryDelay = time.Millisecond
	defer func() { adxoRetryDelay = restore }()

	var serveOK atomic.Bool
	serveOK.Store(true)
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if !serveOK.Load() {
			http.Error(w, "upstream is down", http.StatusInternalServerError)
			return
		}
		w.Write([]byte(adxoFixture))
	}))
	defer srv.Close()

	d := newTestDXpeditions()
	if err := d.refreshFrom(srv.URL); err != nil {
		t.Fatalf("first refresh: %v", err)
	}
	if got := len(d.Entries()); got != 5 {
		t.Fatalf("loaded %d entries, want 5", got)
	}

	// Now the feed goes away.
	serveOK.Store(false)
	hits.Store(0)
	err := d.refreshFrom(srv.URL)
	if err == nil {
		t.Fatal("a refresh against a dead feed reported success")
	}
	// The whole point: the previous dataset is still what /api/dxpeditions
	// serves. An empty calendar is a worse answer than a six-hour-old one.
	if got := len(d.Entries()); got != 5 {
		t.Errorf("after a failed refresh: %d entries, want the previous 5", got)
	}
	// One initial attempt plus adxoRetries retries.
	if got := hits.Load(); got != int32(adxoRetries+1) {
		t.Errorf("made %d attempts, want %d", got, adxoRetries+1)
	}
	status := d.Status()
	if status["last_error"] == nil {
		t.Error("last_error is not set after a failure")
	}
	if status["loaded"] != true {
		t.Error("loaded went false while entries were still being served")
	}

	// And it recovers, clearing the error.
	serveOK.Store(true)
	if err := d.refreshFrom(srv.URL); err != nil {
		t.Fatalf("recovery refresh: %v", err)
	}
	if _, present := d.Status()["last_error"]; present {
		t.Error("last_error survived a successful refresh")
	}
}

func TestDXpeditionsConditionalGet(t *testing.T) {
	const etag = `"deadbeef"`
	var conditional atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("If-None-Match") == etag {
			conditional.Store(true)
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", etag)
		w.Write([]byte(adxoFixture))
	}))
	defer srv.Close()

	d := newTestDXpeditions()
	if err := d.refreshFrom(srv.URL); err != nil {
		t.Fatalf("first refresh: %v", err)
	}
	loadedAt := d.loadedAt

	// The second refresh replays the validator and gets a 304.
	if err := d.refreshFrom(srv.URL); err != nil {
		t.Fatalf("conditional refresh: %v", err)
	}
	if !conditional.Load() {
		t.Error("the second fetch did not send If-None-Match")
	}
	if got := len(d.Entries()); got != 5 {
		t.Errorf("a 304 emptied the calendar: %d entries", got)
	}
	// loadedAt stamps the DATA, and a 304 means the data did not change.
	if !d.loadedAt.Equal(loadedAt) {
		t.Error("a 304 moved loaded_at")
	}
	if d.lastAttempt.Before(loadedAt) {
		t.Error("a 304 did not move last_attempt")
	}
}

func TestHandleDXpeditionsFilters(t *testing.T) {
	d := newTestDXpeditions()
	now := time.Now().UTC()
	d.entries = []DXpedition{
		{Call: "ON1NOW", StartUnix: now.Add(-24 * time.Hour).Unix(), EndUnix: now.Add(24 * time.Hour).Unix(), InRange: true},
		{Call: "SO2ON", StartUnix: now.Add(48 * time.Hour).Unix(), EndUnix: now.Add(96 * time.Hour).Unix(), InRange: true},
		{Call: "FA3R", StartUnix: now.Add(60 * 24 * time.Hour).Unix(), EndUnix: now.Add(65 * 24 * time.Hour).Unix(), InRange: true},
		{Call: "VH4F", StartUnix: now.Add(-24 * time.Hour).Unix(), EndUnix: now.Add(24 * time.Hour).Unix(), InRange: false},
		{Call: "PA5ST", StartUnix: now.Add(-96 * time.Hour).Unix(), EndUnix: now.Add(-48 * time.Hour).Unix(), InRange: true},
	}
	d.loadedAt = now

	get := func(query string) map[string]interface{} {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/dxpeditions"+query, nil)
		rec := httptest.NewRecorder()
		handleDXpeditions(rec, req, d)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: HTTP %d", query, rec.Code)
		}
		var body map[string]interface{}
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("%s: decoding response: %v", query, err)
		}
		return body
	}
	calls := func(body map[string]interface{}) []string {
		var out []string
		for _, row := range body["entries"].([]interface{}) {
			out = append(out, row.(map[string]interface{})["call"].(string))
		}
		return out
	}

	all := get("")
	if got := len(calls(all)); got != 5 {
		t.Errorf("unfiltered: %d entries, want 5", got)
	}
	if all["loaded"] != true || all["enabled"] != true {
		t.Errorf("envelope: enabled=%v loaded=%v", all["enabled"], all["loaded"])
	}

	assertStrings(t, "active=1", calls(get("?active=1")), []string{"ON1NOW", "VH4F"})
	assertStrings(t, "in_range=1&active=1", calls(get("?in_range=1&active=1")), []string{"ON1NOW"})
	// A forward window includes what is already running, and excludes what has
	// already finished however wide the window is.
	assertStrings(t, "days=7", calls(get("?days=7")), []string{"ON1NOW", "SO2ON", "VH4F"})
	assertStrings(t, "limit=2", calls(get("?limit=2")), []string{"ON1NOW", "SO2ON"})

	// active is computed per request, not baked in at refresh.
	for _, row := range get("?active=1")["entries"].([]interface{}) {
		if row.(map[string]interface{})["active"] != true {
			t.Errorf("active=1 returned a row with active=false: %v", row)
		}
	}

	for _, bad := range []string{"?days=-1", "?days=soon", "?limit=-3"} {
		req := httptest.NewRequest(http.MethodGet, "/api/dxpeditions"+bad, nil)
		rec := httptest.NewRecorder()
		handleDXpeditions(rec, req, d)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: HTTP %d, want 400", bad, rec.Code)
		}
	}
}

func TestHandleDXpeditionsDisabled(t *testing.T) {
	// A nil fetcher is the disabled case and must still answer — reporting that
	// it is off, rather than 500ing or looking like an empty calendar.
	req := httptest.NewRequest(http.MethodGet, "/api/dxpeditions", nil)
	rec := httptest.NewRecorder()
	handleDXpeditions(rec, req, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("HTTP %d", rec.Code)
	}
	var body map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decoding: %v", err)
	}
	if body["enabled"] != false || body["loaded"] != false {
		t.Errorf("enabled=%v loaded=%v, want both false", body["enabled"], body["loaded"])
	}
}

func TestDXpeditionsBandsInRange(t *testing.T) {
	// A 30 MHz HF receiver.
	hf := &DXpeditions{minFreq: 10000, maxFreq: 30000000}
	if !hf.bandsInRange([]string{"20m", "6m"}) {
		t.Error("20m should be in range on an HF receiver")
	}
	if hf.bandsInRange([]string{"6m", "2m"}) {
		t.Error("a VHF-only operation was reported in range on an HF receiver")
	}
	// Bands we could not read are not evidence that the receiver cannot hear
	// them — the row stays.
	if !hf.bandsInRange(nil) {
		t.Error("an operation with no parsed bands was filtered out")
	}
}

func assertStrings(t *testing.T, what string, got, want []string) {
	t.Helper()
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("%s = %v, want %v", what, got, want)
	}
}

// ── Enrichment ──────────────────────────────────────────────────────────────

func TestEnrichPositionPrecedence(t *testing.T) {
	if err := InitCTYDatabase("cty/cty.dat"); err != nil {
		t.Fatalf("InitCTYDatabase: %v", err)
	}
	// A receiver in London.
	d := &DXpeditions{siteLat: 51.507, siteLon: -0.128, minFreq: 10000, maxFreq: 30000000}

	cases := []struct {
		name       string
		in         DXpedition
		wantSource string
		wantCty    string
		wantLat    float64
		wantLon    float64
		tol        float64
	}{
		{
			// Nothing but a callsign: CTY on the call, entity centroid.
			name:       "callsign only",
			in:         DXpedition{Call: "V51WH", Entity: "Namibia"},
			wantSource: "callsign", wantCty: "Namibia", wantLat: -22, wantLon: 17, tol: 0.5,
		},
		{
			// A bare PREFIX still places: CTY.DAT is a prefix database, so the
			// third of the feed announced before its call exists is not lost.
			name:       "bare prefix",
			in:         DXpedition{Call: "9N", PrefixOnly: true, Entity: "Nepal"},
			wantSource: "callsign", wantCty: "Nepal", wantLat: 27.7, wantLon: 85.33, tol: 0.5,
		},
		{
			// The announcement's stated entity beats the callsign's prefix.
			// VK2LHW is a mainland call operating from Lord Howe — a different
			// DXCC entity 600 km away — and resolving the CALL gets it wrong.
			name:       "stated entity beats callsign",
			in:         DXpedition{Call: "VK2LHW", Entity: "Lord Howe I"},
			wantSource: "entity", wantCty: "Lord Howe Island", wantLat: -31.55, wantLon: 159.08, tol: 0.5,
		},
		{
			// The same, and the worst case in the live feed: CTY resolves 3Y to
			// Antarctica and puts the pin on the South Pole, 2,400 km from
			// Peter I and at a bearing of exactly 180 from anywhere.
			name:       "3Y is not the South Pole",
			in:         DXpedition{Call: "3Y0L", Entity: "Peter I"},
			wantSource: "entity", wantCty: "Peter 1 Island", wantLat: -68.77, wantLon: -90.58, tol: 0.5,
		},
		{
			// A locator in the free text beats every centroid.
			name:       "grid beats both",
			in:         DXpedition{Call: "P29YY", Entity: "Papua New Guinea", Grid: "QI57jk"},
			wantSource: "grid", wantCty: "Papua New Guinea", wantLat: -2.56, wantLon: 150.79, tol: 0.1,
		},
		{
			// Source shorthand resolves to nothing and falls back to the call,
			// which is right here — never a guess at a near-miss entity.
			name:       "unknown entity name falls back",
			in:         DXpedition{Call: "V26JJ", Entity: "Antigua"},
			wantSource: "callsign", wantCty: "Antigua & Barbuda", wantLat: 17.07, wantLon: -61.80, tol: 0.5,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := c.in
			d.enrich(&p)
			if p.PositionSource != c.wantSource {
				t.Errorf("position_source = %q, want %q", p.PositionSource, c.wantSource)
			}
			if p.Country != c.wantCty {
				t.Errorf("country = %q, want %q", p.Country, c.wantCty)
			}
			if p.Latitude == nil || p.Longitude == nil {
				t.Fatal("unplaced")
			}
			if diff := *p.Latitude - c.wantLat; diff > c.tol || diff < -c.tol {
				t.Errorf("lat = %.3f, want %.3f", *p.Latitude, c.wantLat)
			}
			if diff := *p.Longitude - c.wantLon; diff > c.tol || diff < -c.tol {
				t.Errorf("lon = %.3f, want %.3f", *p.Longitude, c.wantLon)
			}
			// approx is true for a centroid and false for a locator.
			if wantApprox := c.wantSource != "grid"; p.Approx != wantApprox {
				t.Errorf("approx = %v, want %v", p.Approx, wantApprox)
			}
			if p.DistanceKm == nil || p.BearingDeg == nil {
				t.Error("distance/bearing not computed from a placed position")
			}
		})
	}
}

func TestEnrichWithoutReceiverCoordinates(t *testing.T) {
	if err := InitCTYDatabase("cty/cty.dat"); err != nil {
		t.Fatalf("InitCTYDatabase: %v", err)
	}
	// A receiver that has not been told where it is: the operation is still
	// placed and named, but distance and bearing stay null rather than being
	// measured from 0,0 in the Gulf of Guinea.
	d := &DXpeditions{minFreq: 10000, maxFreq: 30000000}
	p := DXpedition{Call: "V51WH", Entity: "Namibia"}
	d.enrich(&p)
	if p.Latitude == nil || p.Country != "Namibia" {
		t.Fatal("the operation was not placed")
	}
	if p.DistanceKm != nil || p.BearingDeg != nil {
		t.Errorf("distance/bearing computed from an unconfigured site: %v %v", p.DistanceKm, p.BearingDeg)
	}
}
