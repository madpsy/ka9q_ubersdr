package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Spot messages as the skimmer sends them (docs/feed.md, v=1).  The FT and CW
// ones were captured from a live skimmer feed; the rest follow the same code
// paths' output (spot_map.cpp: feed_spot_fields, feed_place, feed_qrz), keys
// sorted as nlohmann::json writes them.
const (
	feedFT8Locator = `{"type":"spot","seq":1791789752549,"band":"40","bearing":122,"call":"DG8LAS","continent":"EU","country_code":"DE","cq_zone":14,"dial_hz":7074000,"dt":0.2,"entity":"Fed. Rep. of Germany","family":"FT","freq_hz":7074318,"itu_zone":28,"km":1024,"lat":50.5,"loc_source":"locator","locator":"JO40","lon":9.0,"message":"G0ABI DG8LAS JO40","mode":"FT8","snr":-17,"spot_type":"DE","spotter":"M9PSY","t":1791789765,"utc_offset":1.0,"v":1}`
	feedFT8Cty     = `{"type":"spot","seq":1791789752548,"band":"40","bearing":192,"call":"CT1DHR","continent":"EU","country_code":"PT","cq_zone":14,"dial_hz":7074000,"dt":0.6,"entity":"Portugal","family":"FT","freq_hz":7075999,"itu_zone":37,"km":1871,"lat":39.5,"loc_source":"cty","lon":-8.0,"message":"EA1DFQ CT1DHR R+21","mode":"FT8","snr":-5,"spot_type":"DE","spotter":"M9PSY","t":1791789765,"utc_offset":-0.0,"v":1}`
	feedCWCty      = `{"type":"spot","seq":1791789752582,"band":"40","bearing":117,"call":"DL6LV/P","continent":"EU","country_code":"DE","cq_zone":14,"entity":"Fed. Rep. of Germany","family":"CW","freq_hz":7033995.5,"itu_zone":28,"km":1043,"lat":51.0,"loc_source":"cty","lon":10.0,"mode":"CW","snr":24,"spot_type":"CQ","spotter":"M9PSY","t":1791789782,"utc_offset":1.0,"v":1,"wpm":23}`

	feedCWQRZ = `{"type":"spot","seq":1791639174496,"band":"20","bearing":104,"call":"HG0R","continent":"EU","country_code":"HU","cq_zone":15,"entity":"Hungary","family":"CW","freq_hz":14018995.5,"itu_zone":28,"km":1617,"lat":47.5,"loc_source":"qrz","lon":19.04,"mode":"CW","qrz":{"at":1791630000,"call":"HG0R","city":"Budapest","country":"Hungary","cq_zone":15,"eqsl":false,"geoloc":"user","grid":"JN97ma","home_only":false,"itu_zone":28,"lat":47.5,"lon":19.04,"lotw":true,"mqsl":false,"name":"Hungarian Radio Club","tz_iana":"Europe/Budapest"},"snr":37,"spot_type":"CQ","spotter":"M9PSY","t":1791639189,"utc_offset":1.0,"v":1,"wpm":27}`
	// Signing away from home: QRZ's place is the home station's, so the skimmer
	// places it by its country (loc_source cty) and flags home_only.
	feedCWAway = `{"type":"spot","seq":1791639174497,"band":"20","bearing":190,"call":"EA5/G4ABC","continent":"EU","country_code":"ES","cq_zone":14,"entity":"Spain","family":"CW","freq_hz":14025000.0,"itu_zone":37,"km":1730,"lat":40.37,"loc_source":"cty","lon":-4.88,"mode":"CW","qrz":{"at":1791630000,"call":"G4ABC","country":"England","eqsl":false,"geoloc":"user","grid":"IO91lk","home_only":true,"lat":51.45,"lon":-0.97,"lotw":false,"mqsl":false,"name":"Jo Bloggs","tz_iana":"Europe/London"},"snr":12,"spot_type":"DE","spotter":"M9PSY","t":1791639190,"utc_offset":-1.0,"v":1,"wpm":22}`
	feedRTTY   = `{"type":"spot","seq":1791639174498,"band":"20","baud":45,"bearing":63,"call":"OH2BH","continent":"EU","country_code":"FI","cq_zone":15,"entity":"Finland","family":"RTTY","freq_hz":14085000.0,"itu_zone":18,"km":1680,"lat":63.78,"loc_source":"cty","lon":26.38,"mode":"RTTY","snr":12,"spot_type":"CQ","spotter":"M9PSY","t":1791639191,"utc_offset":-2.0,"v":1}`
	feedJTTY   = `{"type":"spot","seq":1791639174499,"band":"20","baud":50,"bearing":104,"call":"HA5X","continent":"EU","country_code":"HU","cq_zone":15,"entity":"Hungary","family":"JTTY","freq_hz":14079500.0,"itu_zone":28,"km":1617,"lat":47.5,"loc_source":"locator","locator":"JN97","lon":19.0,"mode":"JTTY","snr":8,"spot_type":"CQ","spotter":"M9PSY","t":1791639192,"utc_offset":1.0,"v":1}`
	feedWSPR   = `{"type":"spot","seq":1791639174500,"band":"20","bearing":295,"call":"ND6P","continent":"NA","country_code":"US","cq_zone":3,"dbm":30,"dial_hz":14095600,"drift":-1,"dt":1.13,"entity":"United States","family":"WSPR","freq_hz":14097046,"itu_zone":6,"km":8270,"lat":34.5,"loc_source":"locator","locator":"DM04","lon":-119.0,"message":"ND6P DM04 30","mode":"WSPR-2","snr":-9,"spot_type":"DE","spotter":"M9PSY","t":1791639120,"utc_offset":-8.0,"v":1}`
	feedFST4W  = `{"type":"spot","seq":1791639174501,"band":"160","bearing":110,"call":"DL0HOT","continent":"EU","country_code":"DE","cq_zone":14,"dbm":30,"dial_hz":1836600,"dt":0.28,"entity":"Fed. Rep. of Germany","family":"WSPR","freq_hz":1838033,"itu_zone":28,"km":1100,"lat":50.5,"loc_source":"locator","locator":"JO60","lon":13.0,"message":"DL0HOT JO60 30","mode":"FST4W-300","snr":-43,"spot_type":"DE","spread_hz":0.214,"spotter":"M9PSY","t":1791639000,"utc_offset":1.0,"v":1}`
	feedJS8    = `{"type":"spot","seq":1791787090453,"band":"40","bearing":121,"call":"DK1NJB","continent":"EU","country_code":"DE","cq_zone":14,"dial_hz":7078000,"entity":"Fed. Rep. of Germany","family":"JS8","freq_hz":7079075,"itu_zone":28,"km":1100,"lat":50.5,"loc_source":"locator","locator":"JO50","lon":11.0,"mode":"JS8-Normal","snr":-2,"spot_type":"CQ","spotter":"M9PSY","t":1791787136,"utc_offset":1.0,"v":1}`

	feedHealth = `{"type":"health","v":1,"t":1791639264,"status":"warn","problems":[{"level":"warn","part":"pskreporter","text":"send failed: network unreachable"}],"spotter":"M9PSY","version":"v2.3.0","uptime_s":86400,"cpu":{"percent":41.2,"cores":4},"receivers":{"up":8,"total":8},"reporters":{"pskreporter":{"sent":97001}}}`
)

func parseFeedSpot(t *testing.T, data string) *skimmerFeedSpot {
	t.Helper()
	s := &skimmerFeedSpot{}
	if err := json.Unmarshal([]byte(data), s); err != nil { // as handleSpot decodes it
		t.Fatalf("fixture does not decode: %v", err)
	}
	return s
}

// jsonUnmarshalStrict fails a fixture with a field the client's struct does
// not know of, so fixtures and struct agree.
func jsonUnmarshalStrict(data string, v any) error {
	dec := json.NewDecoder(strings.NewReader(data))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func ptrEq(p *float64, want float64) bool { return p != nil && *p == want }

func TestSkimmerFeedReadSSE(t *testing.T) {
	stream := "retry: 3000\n\n: \n\n" +
		"id: 1791639174496\r\nevent: spot\r\ndata: {\"a\":1}\r\n\r\n" +
		": keep-alive\n\n" +
		"event: health\ndata: {\"b\":2}\n\n" +
		"data: line one\ndata: line two\n\n" +
		"data:no-space\n\n" +
		"id: 99\nevent: spot\ndata: {\"never\":\"dispatched\"}" // no blank line: not an event
	var events []sseEvent
	lines := 0
	if err := readSSE(strings.NewReader(stream), func() { lines++ }, func(ev sseEvent) { events = append(events, ev) }); err != nil {
		t.Fatal(err)
	}
	want := []sseEvent{
		{ID: "1791639174496", Event: "spot", Data: `{"a":1}`},
		{Event: "health", Data: `{"b":2}`},
		{Data: "line one\nline two"},
		{Data: "no-space"},
	}
	if len(events) != len(want) {
		t.Fatalf("got %d events %+v, want %d", len(events), events, len(want))
	}
	for i := range want {
		if events[i] != want[i] {
			t.Errorf("event %d = %+v, want %+v", i, events[i], want[i])
		}
	}
	if lines < 15 {
		t.Errorf("onLine called %d times; every line (comments too) must reset the watchdog", lines)
	}
}

func TestSkimmerFeedFixturesMatchStruct(t *testing.T) {
	for name, data := range map[string]string{
		"ft8 locator": feedFT8Locator, "ft8 cty": feedFT8Cty, "cw cty": feedCWCty, "cw qrz": feedCWQRZ,
		"cw away": feedCWAway, "rtty": feedRTTY, "jtty": feedJTTY, "wspr": feedWSPR, "fst4w": feedFST4W, "js8": feedJS8,
	} {
		// The qrz block carries fields the client has no use for (lotw, at...),
		// so only the spot's own fields are held strictly.
		s := &skimmerFeedSpot{}
		if err := jsonUnmarshalStrict(stripQRZ(data), s); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// stripQRZ removes a fixture's "qrz":{...} object (it holds no nested braces).
func stripQRZ(data string) string {
	i := strings.Index(data, `"qrz":{`)
	if i < 0 {
		return data
	}
	j := strings.Index(data[i:], "},")
	return data[:i] + data[i+j+2:]
}

func TestSkimmerFeedCWSpot(t *testing.T) {
	s := parseFeedSpot(t, feedCWCty)
	got := skimmerFeedCWSpot(s)
	if got.DXCall != "DL6LV/P" || got.Spotter != "M9PSY" || got.Mode != "CW" || got.WPM != 23 || got.SNR != 24 {
		t.Errorf("basic fields: %+v", got)
	}
	if got.Frequency != 7033995.5 || got.Band != "40m" {
		t.Errorf("frequency/band = %v/%q", got.Frequency, got.Band)
	}
	if got.Comment != "CQ" {
		t.Errorf("comment = %q, want CQ (as the telnet client gives CW)", got.Comment)
	}
	if !got.Time.Equal(time.Unix(1791789782, 0)) || got.Time.Location() != time.UTC {
		t.Errorf("time = %v", got.Time)
	}
	if got.Country != "Fed. Rep. of Germany" || got.CountryCode != "DE" || got.Continent != "EU" || got.CQZone != 14 || got.ITUZone != 28 {
		t.Errorf("cty fields: %+v", got)
	}
	if got.Latitude != 51.0 || got.Longitude != 10.0 || got.LocSource != "cty" {
		t.Errorf("position = %v,%v %q", got.Latitude, got.Longitude, got.LocSource)
	}
	if !ptrEq(got.DistanceKm, 1043) || !ptrEq(got.BearingDeg, 117) {
		t.Errorf("distance/bearing = %v/%v", got.DistanceKm, got.BearingDeg)
	}
	if got.Name != "" || got.Timezone != "" || got.GeoLoc != "" {
		t.Errorf("no qrz block, yet QRZ fields set: %+v", got)
	}
}

func TestSkimmerFeedCWSpotQRZ(t *testing.T) {
	got := skimmerFeedCWSpot(parseFeedSpot(t, feedCWQRZ))
	if got.Name != "Hungarian Radio Club" || got.Grid != "JN97ma" {
		t.Errorf("qrz name/grid = %q/%q", got.Name, got.Grid)
	}
	if got.LocSource != "qrz" || got.Latitude != 47.5 || got.Longitude != 19.04 {
		t.Errorf("position = %v,%v %q", got.Latitude, got.Longitude, got.LocSource)
	}
	if got.GeoLoc != "user" || got.Timezone != "Europe/Budapest" {
		t.Errorf("geoloc/tz = %q/%q; QRZ's position is used, so both apply", got.GeoLoc, got.Timezone)
	}

	// Away from home: QRZ's name and grid still describe the operator, but its
	// position, how QRZ placed it and its time zone are the home station's.
	away := skimmerFeedCWSpot(parseFeedSpot(t, feedCWAway))
	if away.Name != "Jo Bloggs" {
		t.Errorf("name = %q", away.Name)
	}
	if away.LocSource != "cty" || away.Latitude != 40.37 {
		t.Errorf("position = %v %q, want Spain's middle", away.Latitude, away.LocSource)
	}
	if away.GeoLoc != "" || away.Timezone != "" {
		t.Errorf("geoloc/tz = %q/%q, want none: they describe the home station", away.GeoLoc, away.Timezone)
	}
	if away.CountryCode != "ES" {
		t.Errorf("country code = %q, want where it is (ES)", away.CountryCode)
	}
}

func TestSkimmerFeedRTTYAndJTTY(t *testing.T) {
	r := skimmerFeedCWSpot(parseFeedSpot(t, feedRTTY))
	if r.Mode != "RTTY" || r.WPM != 45 || r.Comment != "CQ RTTY" {
		t.Errorf("RTTY = mode %q speed %d comment %q; want RTTY, 45 baud, \"CQ RTTY\" as the telnet client gives it", r.Mode, r.WPM, r.Comment)
	}
	j := skimmerFeedCWSpot(parseFeedSpot(t, feedJTTY))
	if j.Mode != "JTTY" || j.WPM != 50 || j.Comment != "CQ JTTY" || j.LocSource != "locator" {
		t.Errorf("JTTY = %+v", j)
	}
}

func TestSkimmerFeedFT8(t *testing.T) {
	d := skimmerFeedDecode(parseFeedSpot(t, feedFT8Locator))
	if d.Callsign != "DG8LAS" || d.Locator != "JO40" || d.Mode != "FT8" || d.Submode != "" || d.SNR != -17 {
		t.Errorf("basic fields: %+v", d)
	}
	if d.Frequency != 7074318 || d.DialFrequency != 7074000 || d.TxFrequency != 0 {
		t.Errorf("frequencies = %d/%d/%d", d.Frequency, d.DialFrequency, d.TxFrequency)
	}
	if d.Message != "G0ABI DG8LAS JO40" || math.Abs(float64(d.DT)-0.2) > 1e-6 {
		t.Errorf("message/dt = %q/%v", d.Message, d.DT)
	}
	if !d.Timestamp.Equal(time.Unix(1791789765, 0)) {
		t.Errorf("timestamp = %v", d.Timestamp)
	}
	if d.BandName != "skimmer_40m_FT8" {
		t.Errorf("band name = %q", d.BandName)
	}
	if !d.HasCallsign || !d.HasLocator || d.IsWSPR {
		t.Errorf("flags: has call %v, has locator %v, wspr %v", d.HasCallsign, d.HasLocator, d.IsWSPR)
	}
	if d.Country != "Fed. Rep. of Germany" || d.CountryCode != "DE" || d.CQZone != 14 || d.ITUZone != 28 || d.Continent != "EU" || d.TimeOffset != 1 {
		t.Errorf("cty fields: %+v", d)
	}
	if !ptrEq(d.DistanceKm, 1024) || !ptrEq(d.BearingDeg, 122) {
		t.Errorf("distance/bearing = %v/%v; from its own locator, so given", d.DistanceKm, d.BearingDeg)
	}

	// Placed only by its country: no distance, as UberSDR's own decoders give
	// none without a locator.
	c := skimmerFeedDecode(parseFeedSpot(t, feedFT8Cty))
	if c.DistanceKm != nil || c.BearingDeg != nil {
		t.Errorf("cty-placed spot has distance %v / bearing %v", c.DistanceKm, c.BearingDeg)
	}
	if c.HasLocator || c.TimeOffset != 0 || math.Signbit(c.TimeOffset) {
		t.Errorf("has locator %v, offset %v", c.HasLocator, c.TimeOffset)
	}
}

func TestSkimmerFeedWSPR(t *testing.T) {
	d := skimmerFeedDecode(parseFeedSpot(t, feedWSPR))
	if d.Mode != "WSPR" || d.Submode != "" || !d.IsWSPR {
		t.Errorf("mode %q/%q wspr %v; WSPR-2 is UberSDR's WSPR", d.Mode, d.Submode, d.IsWSPR)
	}
	// As UberSDR's WSPR decoder fills them.
	if d.Frequency != 14095600 || d.DialFrequency != 14095600 || d.TxFrequency != 14097046 {
		t.Errorf("frequency %d dial %d tx %d", d.Frequency, d.DialFrequency, d.TxFrequency)
	}
	if d.DBm != 30 || d.Drift != -1 || d.Message != "ND6P DM04 30" || math.Abs(float64(d.DT)-1.13) > 1e-6 {
		t.Errorf("dbm %d drift %d message %q dt %v", d.DBm, d.Drift, d.Message, d.DT)
	}
	if d.BandName != "skimmer_20m_WSPR" || d.TimeOffset != -8 {
		t.Errorf("band name %q offset %v", d.BandName, d.TimeOffset)
	}

	// FST4W folded into WSPR, the variant kept as its submode.
	f := skimmerFeedDecode(parseFeedSpot(t, feedFST4W))
	if f.Mode != "WSPR" || f.Submode != "FST4W-300" || !f.IsWSPR || f.Drift != 0 || f.DBm != 30 || f.TxFrequency != 1838033 {
		t.Errorf("FST4W = mode %q/%q wspr %v drift %d dbm %d tx %d", f.Mode, f.Submode, f.IsWSPR, f.Drift, f.DBm, f.TxFrequency)
	}
	if f.BandName != "skimmer_160m_WSPR" {
		t.Errorf("band name = %q", f.BandName)
	}
	for mode, sub := range map[string]string{"WSPR-2": "", "WSPR": "", "WSPR-15": "WSPR-15", "FST4W-120": "FST4W-120", "FST4W-1800": "FST4W-1800"} {
		if m, s := skimmerFeedDigitalMode("WSPR", mode); m != "WSPR" || s != sub {
			t.Errorf("%s = %s/%s, want WSPR/%s", mode, m, s, sub)
		}
	}
}

func TestSkimmerFeedJS8(t *testing.T) {
	d := skimmerFeedDecode(parseFeedSpot(t, feedJS8))
	if d.Mode != "JS8" || d.Submode != "A" || d.Frequency != 7079075 || d.DialFrequency != 7078000 {
		t.Errorf("JS8 = mode %q sub %q freq %d dial %d", d.Mode, d.Submode, d.Frequency, d.DialFrequency)
	}
	if d.Message != "" || d.DT != 0 {
		t.Errorf("JS8 carries no message or dt; got %q %v", d.Message, d.DT)
	}
	for mode, sub := range map[string]string{"JS8-Normal": "A", "JS8-Fast": "B", "JS8-Turbo": "C", "JS8-Slow": "E"} {
		if m, s := skimmerFeedDigitalMode("JS8", mode); m != "JS8" || s != sub {
			t.Errorf("%s = %s/%s, want JS8/%s", mode, m, s, sub)
		}
	}
	for _, mode := range []string{"FT8", "FT4", "FT2"} {
		if m, s := skimmerFeedDigitalMode("FT", mode); m != mode || s != "" {
			t.Errorf("%s = %s/%s", mode, m, s)
		}
	}
}

// fakeSkimmer serves /api/feed: each connection gets the next script, and the
// request's Last-Event-ID and query are recorded.
type fakeSkimmer struct {
	mu       sync.Mutex
	scripts  []func(w http.ResponseWriter, f http.Flusher, r *http.Request)
	lastIDs  []string
	queries  []string
	accepts  []string
	conns    atomic.Int32
	finished chan struct{}
}

func (fs *fakeSkimmer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	fs.mu.Lock()
	n := int(fs.conns.Add(1)) - 1
	fs.lastIDs = append(fs.lastIDs, r.Header.Get("Last-Event-ID"))
	fs.queries = append(fs.queries, r.URL.RawQuery)
	fs.accepts = append(fs.accepts, r.Header.Get("Accept"))
	var script func(http.ResponseWriter, http.Flusher, *http.Request)
	if n < len(fs.scripts) {
		script = fs.scripts[n]
	}
	fs.mu.Unlock()
	if script == nil {
		<-r.Context().Done() // nothing more to say; hold until the client goes
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	f := w.(http.Flusher)
	f.Flush()
	script(w, f, r)
}

func sseSpot(data string) string {
	seq := ""
	if i := strings.Index(data, `"seq":`); i >= 0 {
		rest := data[i+6:]
		seq = rest[:strings.IndexAny(rest, ",}")]
	}
	return "id: " + seq + "\nevent: spot\ndata: " + data + "\n\n"
}

func newTestFeedClient(url string) *SkimmerFeedClient {
	c := NewSkimmerFeedClient(SkimmerFeedConfig{Enabled: true, URL: url}, 30_000_000)
	c.backoffMin = 10 * time.Millisecond
	c.backoffMax = 20 * time.Millisecond
	c.idleTimeout = 2 * time.Second
	return c
}

func waitForFeed(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestSkimmerFeedClientDeliversAndResumes(t *testing.T) {
	fs := &fakeSkimmer{}
	fs.scripts = []func(http.ResponseWriter, http.Flusher, *http.Request){
		// First connection: health, a comment, three spots, then it drops.
		func(w http.ResponseWriter, f http.Flusher, r *http.Request) {
			fmt.Fprint(w, "retry: 3000\n\n")
			fmt.Fprint(w, "event: health\ndata: "+feedHealth+"\n\n")
			fmt.Fprint(w, ": \n\n")
			fmt.Fprint(w, sseSpot(feedCWCty))
			fmt.Fprint(w, sseSpot(feedFT8Locator))
			fmt.Fprint(w, sseSpot(feedRTTY))
			f.Flush()
		},
		// Second: resumed after the last spot; one lost spot reported, then more.
		func(w http.ResponseWriter, f http.Flusher, r *http.Request) {
			fmt.Fprint(w, "event: gap\ndata: {\"type\":\"gap\",\"since\":1,\"oldest\":2}\n\n")
			fmt.Fprint(w, sseSpot(feedWSPR))
			fmt.Fprint(w, sseSpot(feedJS8))
			f.Flush()
			<-r.Context().Done()
		},
	}
	srv := httptest.NewServer(fs)
	defer srv.Close()

	c := newTestFeedClient(srv.URL + "/api/feed")
	var mu sync.Mutex
	var order []string
	var health []SkimmerFeedHealth
	c.OnCWSpot(func(s CWSkimmerSpot) { mu.Lock(); order = append(order, s.Mode+":"+s.DXCall); mu.Unlock() })
	c.OnDigitalSpot(func(d DecodeInfo) { mu.Lock(); order = append(order, d.Mode+":"+d.Callsign); mu.Unlock() })
	c.OnHealth(func(h SkimmerFeedHealth) { mu.Lock(); health = append(health, h); mu.Unlock() })
	c.Start()
	defer c.Stop()

	waitForFeed(t, "five spots", func() bool { mu.Lock(); defer mu.Unlock(); return len(order) == 5 })
	c.Stop()

	mu.Lock()
	want := []string{"CW:DL6LV/P", "FT8:DG8LAS", "RTTY:OH2BH", "WSPR:ND6P", "JS8:DK1NJB"}
	if strings.Join(order, " ") != strings.Join(want, " ") {
		t.Errorf("spots %v, want %v in the feed's order, each once", order, want)
	}
	if len(health) != 1 || health[0].Status != "warn" || health[0].Version != "v2.3.0" || len(health[0].Problems) != 1 ||
		health[0].Problems[0].Part != "pskreporter" || !strings.Contains(string(health[0].Raw), `"reporters"`) {
		t.Errorf("health = %+v", health)
	}
	mu.Unlock()

	fs.mu.Lock()
	defer fs.mu.Unlock()
	if len(fs.lastIDs) < 2 || fs.lastIDs[0] != "" || fs.lastIDs[1] != "1791639174498" {
		t.Errorf("Last-Event-ID per connection = %q; the reconnect must resume after the last spot (RTTY's)", fs.lastIDs)
	}
	if fs.queries[0] != "types=spot,health" {
		t.Errorf("query = %q, want types=spot,health", fs.queries[0])
	}
	if fs.accepts[0] != "text/event-stream" {
		t.Errorf("Accept = %q", fs.accepts[0])
	}

	st := c.Status()
	if st.Spots["CW"] != 1 || st.Spots["FT"] != 1 || st.Spots["RTTY"] != 1 || st.Spots["WSPR"] != 1 || st.Spots["JS8"] != 1 {
		t.Errorf("status spots = %v", st.Spots)
	}
	if st.Gaps != 1 || st.LastEventID != "1791787090453" || st.Health == nil || st.Health.Status != "warn" {
		t.Errorf("status = %+v", st)
	}
}

func TestSkimmerFeedClientSkips(t *testing.T) {
	v2 := strings.Replace(feedFT8Cty, `"v":1`, `"v":2`, 1)
	v2 = strings.Replace(v2, `"seq":1791789752548`, `"seq":1791789752600`, 1)
	high := strings.Replace(feedCWCty, `"freq_hz":7033995.5`, `"freq_hz":50313000.0`, 1)
	high = strings.Replace(high, `"seq":1791789752582`, `"seq":1791789752601`, 1)
	alien := `{"type":"spot","seq":1791789752602,"v":1,"t":1,"family":"PSK31","mode":"PSK31","band":"20","freq_hz":14070000,"call":"G4ABC","snr":1,"spot_type":"CQ"}`

	fs := &fakeSkimmer{}
	fs.scripts = []func(http.ResponseWriter, http.Flusher, *http.Request){
		func(w http.ResponseWriter, f http.Flusher, r *http.Request) {
			fmt.Fprint(w, "event: whatever\ndata: {\"type\":\"whatever\"}\n\n") // a type not known: ignored
			fmt.Fprint(w, sseSpot(v2))                                          // a newer form: skipped
			fmt.Fprint(w, sseSpot(high))                                        // above the receiver's range
			fmt.Fprint(w, sseSpot(alien))                                       // a family not known
			fmt.Fprint(w, "id: 1791789752603\nevent: spot\ndata: {not json\n\n")
			fmt.Fprint(w, sseSpot(feedJS8)) // and then one that is delivered
			f.Flush()
			<-r.Context().Done()
		},
	}
	srv := httptest.NewServer(fs)
	defer srv.Close()

	c := newTestFeedClient(srv.URL + "/api/feed")
	c.maxFrequency = 30_000_000
	var delivered atomic.Int32
	c.OnCWSpot(func(CWSkimmerSpot) { delivered.Add(1) })
	c.OnDigitalSpot(func(DecodeInfo) { delivered.Add(1) })
	c.Start()
	defer c.Stop()
	waitForFeed(t, "the JS8 spot", func() bool { return c.Status().Spots["JS8"] == 1 })

	if n := delivered.Load(); n != 1 {
		t.Errorf("delivered %d spots, want only the JS8 one", n)
	}
	st := c.Status()
	if st.Skipped != 4 {
		t.Errorf("skipped = %d, want 4 (v2, above range, unknown family, unreadable)", st.Skipped)
	}
	if st.LastEventID != "1791787090453" {
		t.Errorf("last id = %q: skipped spots must still move it on", st.LastEventID)
	}
}

func TestSkimmerFeedClientIdleAndErrors(t *testing.T) {
	var conns atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := conns.Add(1)
		if n == 1 {
			http.Error(w, "not yet", http.StatusServiceUnavailable)
			return
		}
		// Headers, then silence: the watchdog must drop it.
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()

	c := newTestFeedClient(srv.URL)
	c.idleTimeout = 100 * time.Millisecond
	c.Start()
	waitForFeed(t, "a reconnect after a silent connection", func() bool { return conns.Load() >= 3 })
	c.Stop()
	if st := c.Status(); st.Connected {
		t.Error("still connected after Stop")
	}
}

func TestSkimmerFeedClientStopsPromptly(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer srv.Close()
	c := newTestFeedClient(srv.URL)
	c.Start()
	waitForFeed(t, "connected", func() bool { return c.Status().Connected })
	start := time.Now()
	c.Stop()
	if d := time.Since(start); d > time.Second {
		t.Errorf("Stop took %v", d)
	}
}

func TestSkimmerFeedRequestURL(t *testing.T) {
	for _, tc := range []struct {
		in, want    string
		wantsHealth bool
	}{
		// The comma is sent as is: older skimmers do not percent-decode.
		{"http://skimmer:6101/api/feed", "http://skimmer:6101/api/feed?types=spot,health", true},
		{"http://skimmer:6101/api/feed?modes=CW,FT8", "http://skimmer:6101/api/feed?modes=CW,FT8&types=spot,health", true},
		{"http://skimmer:6101/api/feed?types=spot&bands=20,40", "http://skimmer:6101/api/feed?types=spot&bands=20,40", false},
		{"http://skimmer:6101/api/feed?types=spot,Health", "http://skimmer:6101/api/feed?types=spot,Health", true},
		{"http://skimmer:6101/api/feed?types=all", "http://skimmer:6101/api/feed?types=all", true},
	} {
		c := NewSkimmerFeedClient(SkimmerFeedConfig{URL: tc.in}, 0)
		got, wantsHealth, err := c.requestURL()
		if err != nil || got != tc.want || wantsHealth != tc.wantsHealth {
			t.Errorf("%s -> %q health %v, %v; want %q health %v", tc.in, got, wantsHealth, err, tc.want, tc.wantsHealth)
		}
	}
	if c := NewSkimmerFeedClient(SkimmerFeedConfig{}, 0); c.url != "http://skimmer:6101/api/feed" {
		t.Errorf("default URL = %q", c.url)
	}
	if _, _, err := NewSkimmerFeedClient(SkimmerFeedConfig{URL: "http://bad host/"}, 0).requestURL(); err == nil {
		t.Error("an invalid URL was accepted")
	}
}

// The skimmer reports to PSK Reporter, wsprnet and RBN itself; UberSDR must
// never send its spots again.  The feed client may not so much as name the
// uploaders, so a later change that wires one in fails here.
func TestSkimmerFeedNeverReports(t *testing.T) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "skimmer_feed.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	banned := []string{"PSKReporter", "pskReporter", "WSPRNet", "wsprNet", "RBN", "Submit"}
	ast.Inspect(f, func(n ast.Node) bool {
		id, ok := n.(*ast.Ident)
		if !ok {
			return true
		}
		for _, b := range banned {
			if strings.Contains(id.Name, b) {
				t.Errorf("%s: skimmer_feed.go names %q; feed spots must never reach an uploader", fset.Position(id.Pos()), id.Name)
			}
		}
		return true
	})
}

// healthAt is a health message from the skimmer's clock second t, up uptime s.
func healthAt(t, uptime int64) string {
	return fmt.Sprintf(`{"type":"health","v":1,"t":%d,"status":"ok","problems":[],"spotter":"M9PSY","version":"v2.3.0","uptime_s":%d}`, t, uptime)
}

// keepAlive writes the skimmer's keep-alive comment every 20 ms until the
// client goes: the connection stays open with no messages on it.
func keepAlive(w http.ResponseWriter, f http.Flusher, r *http.Request) {
	tick := time.NewTicker(20 * time.Millisecond)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
			fmt.Fprint(w, ": \n\n")
			f.Flush()
		}
	}
}

// A skimmer whose connection stays open, keep-alives and all, but whose health
// has stopped is stuck: the client reconnects, and the latest health replayed
// to each new connection is not taken for a sign of life.
func TestSkimmerFeedHealthStall(t *testing.T) {
	var conns atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conns.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		f := w.(http.Flusher)
		fmt.Fprint(w, "event: health\ndata: "+healthAt(1000, 500)+"\n\n") // the same one each time
		f.Flush()
		keepAlive(w, f, r)
	}))
	defer srv.Close()

	c := newTestFeedClient(srv.URL)
	c.healthTimeout = 150 * time.Millisecond
	c.idleTimeout = 5 * time.Second // keep-alives keep coming: only the health watchdog may act
	var healths atomic.Int32
	c.OnHealth(func(SkimmerFeedHealth) { healths.Add(1) })
	c.Start()
	defer c.Stop()

	waitForFeed(t, "reconnects after the health stopped", func() bool { return conns.Load() >= 3 })
	st := c.Status()
	if !st.Stalled || !strings.Contains(st.LastError, "health") {
		t.Errorf("stalled %v, last error %q", st.Stalled, st.LastError)
	}
	if st.Reconnects < 2 {
		t.Errorf("reconnects = %d", st.Reconnects)
	}
	if n := healths.Load(); n != 1 {
		t.Errorf("health handler called %d times; the replayed message is not new", n)
	}
	if st.Health == nil || st.Health.T != 1000 {
		t.Errorf("health = %+v", st.Health)
	}
}

// Once health comes again the stall clears, and the connection is kept.
func TestSkimmerFeedHealthResumes(t *testing.T) {
	var conns atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := conns.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		f := w.(http.Flusher)
		fmt.Fprint(w, "event: health\ndata: "+healthAt(1000, 500)+"\n\n")
		f.Flush()
		if n == 1 {
			keepAlive(w, f, r) // stuck
			return
		}
		// Unstuck: a new health message every 30 ms.
		for i := int64(1); ; i++ {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(30 * time.Millisecond):
				fmt.Fprint(w, "event: health\ndata: "+healthAt(1000+i, 500+i)+"\n\n")
				f.Flush()
			}
		}
	}))
	defer srv.Close()

	c := newTestFeedClient(srv.URL)
	c.healthTimeout = 150 * time.Millisecond
	c.Start()
	defer c.Stop()

	waitForFeed(t, "the second connection's new health", func() bool {
		st := c.Status()
		return conns.Load() >= 2 && !st.Stalled && st.Health != nil && st.Health.T > 1002
	})
	time.Sleep(400 * time.Millisecond) // well past healthTimeout: healthy, so no reconnect
	if n := conns.Load(); n != 2 {
		t.Errorf("connections = %d, want 2: a healthy feed is kept", n)
	}
	if st := c.Status(); st.Stalled || st.LastError != "" || !st.Connected || st.HealthAt.IsZero() {
		t.Errorf("status = %+v", st)
	}
}

// Silence (no keep-alives either) is the skimmer down, not stuck, even when
// the health watchdog is the one to notice first.
func TestSkimmerFeedSilenceIsNotAStall(t *testing.T) {
	var conns atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conns.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "event: health\ndata: "+healthAt(1000, 500)+"\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done() // then nothing at all: frozen
	}))
	defer srv.Close()
	c := newTestFeedClient(srv.URL)
	c.healthTimeout = 150 * time.Millisecond
	c.idleTimeout = 150 * time.Millisecond
	c.Start()
	defer c.Stop()
	waitForFeed(t, "a reconnect", func() bool { return conns.Load() >= 2 })
	st := c.Status()
	if st.Stalled || !strings.Contains(st.LastError, "not even a keep-alive") {
		t.Errorf("stalled %v, last error %q: want down, not stuck", st.Stalled, st.LastError)
	}
}

// A feed asked for spots only has no health to watch: the keep-alives keep it.
func TestSkimmerFeedSpotsOnlyHasNoHealthWatchdog(t *testing.T) {
	var conns atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conns.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		keepAlive(w, w.(http.Flusher), r)
	}))
	defer srv.Close()
	c := newTestFeedClient(srv.URL + "/api/feed?types=spot")
	c.healthTimeout = 50 * time.Millisecond
	c.Start()
	defer c.Stop()
	time.Sleep(400 * time.Millisecond)
	if n := conns.Load(); n != 1 {
		t.Errorf("connections = %d, want 1", n)
	}
	if st := c.Status(); st.Stalled || !st.Connected {
		t.Errorf("status = %+v", st)
	}
}

// A 200 that is not an event stream (a proxy's page, the wrong port) is an
// error, and retried.
func TestSkimmerFeedRejectsNonEventStream(t *testing.T) {
	var conns atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conns.Add(1)
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, "<html>data: {}</html>\n\n")
	}))
	defer srv.Close()
	c := newTestFeedClient(srv.URL)
	var got atomic.Int32
	c.OnDigitalSpot(func(DecodeInfo) { got.Add(1) })
	c.Start()
	waitForFeed(t, "retries", func() bool { return conns.Load() >= 2 })
	c.Stop()
	if st := c.Status(); !strings.Contains(st.LastError, "not an event stream") {
		t.Errorf("last error = %q", st.LastError)
	}
	if got.Load() != 0 {
		t.Error("a spot was read from a page that is not the feed")
	}
}

// A connection cut mid-event delivers nothing of it and does not move the
// resume point: the next connection asks from the last whole spot.
func TestSkimmerFeedCutMidEvent(t *testing.T) {
	fs := &fakeSkimmer{}
	fs.scripts = []func(http.ResponseWriter, http.Flusher, *http.Request){
		func(w http.ResponseWriter, f http.Flusher, r *http.Request) {
			fmt.Fprint(w, sseSpot(feedCWCty))
			// The next spot's id and half its data, then the connection ends.
			fmt.Fprint(w, "id: 1791789752600\nevent: spot\ndata: "+feedFT8Cty[:60])
			f.Flush()
		},
	}
	srv := httptest.NewServer(fs)
	defer srv.Close()
	c := newTestFeedClient(srv.URL)
	var spots atomic.Int32
	c.OnCWSpot(func(CWSkimmerSpot) { spots.Add(1) })
	c.OnDigitalSpot(func(DecodeInfo) { spots.Add(1) })
	c.Start()
	waitForFeed(t, "the reconnect", func() bool { return fs.conns.Load() >= 2 })
	c.Stop()
	if n := spots.Load(); n != 1 {
		t.Errorf("delivered %d spots, want the whole one only", n)
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()
	if fs.lastIDs[1] != "1791789752582" {
		t.Errorf("resumed after %q, want the last whole spot 1791789752582", fs.lastIDs[1])
	}
	if !strings.Contains(c.Status().LastError, "closed") {
		t.Errorf("last error = %q", c.Status().LastError)
	}
}

// With no progress the delay between attempts doubles up to backoffMax.
func TestSkimmerFeedBackoffGrows(t *testing.T) {
	var mu sync.Mutex
	var at []time.Time
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		at = append(at, time.Now())
		mu.Unlock()
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	c := newTestFeedClient(srv.URL)
	c.backoffMin = 20 * time.Millisecond
	c.backoffMax = 80 * time.Millisecond
	c.Start()
	waitForFeed(t, "six attempts", func() bool { mu.Lock(); defer mu.Unlock(); return len(at) >= 6 })
	c.Stop()
	mu.Lock()
	defer mu.Unlock()
	// Waits of 20, 40, 80, 80, 80 ms: each at least its delay, and capped.
	mins := []time.Duration{20, 40, 80, 80, 80}
	for i, m := range mins {
		gap := at[i+1].Sub(at[i])
		if gap < m*time.Millisecond {
			t.Errorf("wait %d = %v, want at least %v ms", i, gap, m)
		}
		if gap > 2*time.Second {
			t.Errorf("wait %d = %v: not capped", i, gap)
		}
	}
	if !strings.Contains(c.Status().LastError, "HTTP 503") {
		t.Errorf("last error = %q", c.Status().LastError)
	}
}

// A restarted skimmer's health is new even though its clock second may not be
// later (its uptime has gone back).
func TestSkimmerFeedHealthFreshness(t *testing.T) {
	c := NewSkimmerFeedClient(SkimmerFeedConfig{}, 0)
	for i, tc := range []struct {
		msg   string
		fresh bool
	}{
		{healthAt(1000, 500), true},  // the first
		{healthAt(1000, 500), false}, // replayed on a reconnect
		{healthAt(999, 499), false},  // older
		{healthAt(1010, 510), true},  // the next
		{healthAt(1010, 3), true},    // restarted: uptime back to 3 s
		{`{not json`, false},
	} {
		if got := c.handleHealth(tc.msg); got != tc.fresh {
			t.Errorf("%d: fresh = %v, want %v", i, got, tc.fresh)
		}
	}
	if h := c.Status().Health; h == nil || h.UptimeS != 3 {
		t.Errorf("kept health = %+v, want the restarted skimmer's", h)
	}
}

// TestSkimmerFeedLive reads a real skimmer's feed:
//
//	SKIMMER_FEED_TEST_URL=http://localhost:9101/api/feed go test -short -run TestSkimmerFeedLive .
func TestSkimmerFeedLive(t *testing.T) {
	feedURL := os.Getenv("SKIMMER_FEED_TEST_URL")
	if feedURL == "" {
		t.Skip("SKIMMER_FEED_TEST_URL not set")
	}
	c := NewSkimmerFeedClient(SkimmerFeedConfig{Enabled: true, URL: feedURL}, 0)
	var mu sync.Mutex
	var cw []CWSkimmerSpot
	var digital []DecodeInfo
	c.OnCWSpot(func(s CWSkimmerSpot) { mu.Lock(); cw = append(cw, s); mu.Unlock() })
	c.OnDigitalSpot(func(d DecodeInfo) { mu.Lock(); digital = append(digital, d); mu.Unlock() })
	c.Start()
	defer c.Stop()

	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		enough := len(cw) > 0 && len(digital) > 0
		mu.Unlock()
		if enough && c.Status().Health != nil {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	c.Stop()
	st := c.Status()
	mu.Lock()
	defer mu.Unlock()
	t.Logf("status: %+v", st)
	if st.Health == nil {
		t.Error("no health message")
	}
	if len(cw)+len(digital) == 0 {
		t.Fatal("no spots")
	}
	for _, s := range cw {
		if s.DXCall == "" || s.Frequency <= 0 || s.Band == "" || s.Spotter == "" || s.Time.IsZero() || s.Mode == "" {
			t.Errorf("CW spot missing basics: %+v", s)
		}
		if s.Country != "" && s.CountryCode == "" {
			t.Logf("no ISO code for %s (%s)", s.DXCall, s.Country)
		}
	}
	for _, d := range digital {
		if d.Callsign == "" || d.Frequency == 0 || d.DialFrequency == 0 || d.Mode == "" || d.Timestamp.IsZero() || !strings.HasPrefix(d.BandName, "skimmer_") {
			t.Errorf("digital spot missing basics: %+v", d)
		}
		if d.Mode != "JS8" && d.Message == "" {
			t.Errorf("%s spot without its message: %+v", d.Mode, d)
		}
	}
	t.Logf("%d CW-family spots (first %+v), %d digital (first %+v)", len(cw), cw[0:min(1, len(cw))], len(digital), digital[0:min(1, len(digital))])
}

// cwAt is a CW-family spot message of call on band at time t.
func cwAt(seq int64, family, band, call string, t int64) string {
	freq := map[string]string{"20": "14025000.0", "40": "7025000.0"}[band]
	speed := `"wpm":25`
	if family != "CW" {
		speed = `"baud":45`
	}
	return fmt.Sprintf(`{"type":"spot","seq":%d,"v":1,"t":%d,"spotter":"M9PSY","family":"%s","mode":"%s","band":"%s","freq_hz":%s,"call":"%s","snr":10,"spot_type":"CQ",%s}`,
		seq, t, family, family, band, freq, call, speed)
}

// Repeats of a CW call on a band within the hold are held back; another band,
// another family (RTTY), or the hold passed lets one through.  Digital spots
// are never held.
func TestSkimmerFeedCWHold(t *testing.T) {
	c := NewSkimmerFeedClient(SkimmerFeedConfig{}, 0)
	var got []string
	c.OnCWSpot(func(s CWSkimmerSpot) {
		got = append(got, fmt.Sprintf("%s %s %s %d", s.Mode, s.Band, s.DXCall, s.Time.Unix()))
	})
	var digital int
	c.OnDigitalSpot(func(DecodeInfo) { digital++ })
	const t0 = 1791639000
	for i, msg := range []string{
		cwAt(1, "CW", "20", "G4ABC", t0),      // first: through
		cwAt(2, "CW", "20", "G4ABC", t0+30),   // repeat: held
		cwAt(3, "CW", "20", "g4abc", t0+60),   // the same call in other case: held
		cwAt(4, "CW", "40", "G4ABC", t0+70),   // another band: through
		cwAt(5, "RTTY", "20", "G4ABC", t0+80), // another family: through
		cwAt(6, "CW", "20", "G4ABC", t0+599),  // still within 10 min of the first: held
		cwAt(7, "CW", "20", "G4ABC", t0+600),  // 10 min on: through
		cwAt(8, "CW", "20", "G4ABC", t0+601),  // held again, from the new one
		cwAt(9, "CW", "20", "K1ABC", t0+602),  // another call: through
		feedFT8Locator, feedFT8Locator,        // digital: never held
	} {
		c.handleSpot(sseEvent{ID: fmt.Sprint(i + 1), Data: msg})
	}
	want := []string{
		fmt.Sprintf("CW 20m G4ABC %d", t0), fmt.Sprintf("CW 40m G4ABC %d", t0+70), fmt.Sprintf("RTTY 20m G4ABC %d", t0+80),
		fmt.Sprintf("CW 20m G4ABC %d", t0+600), fmt.Sprintf("CW 20m K1ABC %d", t0+602),
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("let through:\n %v\nwant\n %v", got, want)
	}
	if digital != 2 {
		t.Errorf("digital spots delivered = %d, want 2 (never held)", digital)
	}
	st := c.Status()
	if st.Held != 4 || st.Skipped != 0 || st.Spots["CW"] != 4 || st.Spots["RTTY"] != 1 {
		t.Errorf("status held %d skipped %d spots %v", st.Held, st.Skipped, st.Spots)
	}
	if st.LastEventID != "11" {
		t.Errorf("last id %q: held spots still move the resume point on", st.LastEventID)
	}
}

// Out of order in time (a restarted skimmer's clock set back): within the
// hold either way is a repeat.  And calls not heard for a hold are forgotten.
func TestSkimmerFeedCWHoldOrderAndPruning(t *testing.T) {
	c := NewSkimmerFeedClient(SkimmerFeedConfig{}, 0)
	n := 0
	c.OnCWSpot(func(CWSkimmerSpot) { n++ })
	const t0 = 1791639000
	c.handleSpot(sseEvent{Data: cwAt(1, "CW", "20", "G4ABC", t0)})
	c.handleSpot(sseEvent{Data: cwAt(2, "CW", "20", "G4ABC", t0-100)})
	if n != 1 {
		t.Errorf("an earlier repeat within the hold let through")
	}
	for i := 0; i < 50; i++ {
		c.handleSpot(sseEvent{Data: cwAt(int64(10+i), "CW", "40", fmt.Sprintf("K%dABC", i), t0+int64(i))})
	}
	if len(c.cwLast) != 51 {
		t.Fatalf("remembered %d calls, want 51", len(c.cwLast))
	}
	c.handleSpot(sseEvent{Data: cwAt(99, "CW", "20", "W1AW", t0+700)}) // a hold on: the rest forgotten
	if len(c.cwLast) != 1 {
		t.Errorf("remembered %d calls after a hold; the old ones are to be pruned", len(c.cwLast))
	}

	// Off: every spot let through.
	off := NewSkimmerFeedClient(SkimmerFeedConfig{}, 0)
	off.cwHold = 0
	m := 0
	off.OnCWSpot(func(CWSkimmerSpot) { m++ })
	for i := 0; i < 3; i++ {
		off.handleSpot(sseEvent{Data: cwAt(int64(i), "CW", "20", "G4ABC", t0+int64(i))})
	}
	if m != 3 {
		t.Errorf("with no hold, %d of 3 let through", m)
	}
}
