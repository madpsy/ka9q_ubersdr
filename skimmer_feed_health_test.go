package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// feedInState is a feed client as if it had been running: connected or not
// since `since` ago, with the skimmer's health message `health` (if any).
func feedInState(connected bool, since time.Duration, health string) *SkimmerFeedClient {
	c := NewSkimmerFeedClient(SkimmerFeedConfig{URL: "http://skimmer:6101/api/feed"}, 0)
	c.connected.Store(connected)
	c.startedAt = time.Now().Add(-time.Hour)
	c.changedAt = time.Now().Add(-since)
	if health != "" {
		c.handleHealth(health)
	}
	return c
}

const healthOK = `{"type":"health","v":1,"t":1791639264,"status":"ok","problems":[],"spotter":"M9PSY","version":"v2.3.0","uptime_s":86400,` +
	`"receivers":{"up":8,"total":8},"reporters":{"pskreporter":{"sent":97001,"send_errors":0}}}`
const healthWarn = `{"type":"health","v":1,"t":1791639264,"status":"warn","problems":[{"level":"warn","part":"pskreporter","text":"send failed: network unreachable"}],"spotter":"M9PSY","version":"v2.3.0","uptime_s":86400}`
const healthError = `{"type":"health","v":1,"t":1791639264,"status":"error","problems":[{"level":"error","part":"receivers","text":"no receiver sending samples"},{"level":"warn","part":"cpu","text":"92% busy"}],"spotter":"M9PSY","version":"v2.3.0","uptime_s":86400}`

func payloadIssues(p map[string]interface{}) []string {
	is, _ := p["issues"].([]string)
	return is
}

func TestSkimmerFeedHealthPayload(t *testing.T) {
	// Off: enabled false, nothing to say.
	p := buildSkimmerFeedHealthPayload(false, nil)
	if p["enabled"] != false || p["healthy"] != true || len(payloadIssues(p)) != 0 {
		t.Errorf("off = %v", p)
	}
	// On but no client (it could not start).
	p = buildSkimmerFeedHealthPayload(true, nil)
	if p["healthy"] != false || p["status"] != "critical" {
		t.Errorf("no client = %v", p)
	}

	// Connected, the skimmer fine: ok, its report passed on as it sent it.
	p = buildSkimmerFeedHealthPayload(true, feedInState(true, time.Hour, healthOK))
	if p["status"] != "ok" || p["healthy"] != true || p["connected"] != true || len(payloadIssues(p)) != 0 {
		t.Errorf("ok = %v", p)
	}
	sk, _ := p["skimmer"].(map[string]interface{})
	rep, _ := sk["reporters"].(map[string]interface{})
	if sk["spotter"] != "M9PSY" || rep["pskreporter"] == nil {
		t.Errorf("skimmer = %v", p["skimmer"])
	}

	// The skimmer warns: a warning, its problem among the issues.
	p = buildSkimmerFeedHealthPayload(true, feedInState(true, time.Hour, healthWarn))
	if p["status"] != "warning" || p["healthy"] != false || len(payloadIssues(p)) != 1 ||
		payloadIssues(p)[0] != "Skimmer pskreporter: send failed: network unreachable" {
		t.Errorf("warn = %v", p)
	}

	// The skimmer in error: critical, its errors before its warnings.
	p = buildSkimmerFeedHealthPayload(true, feedInState(true, time.Hour, healthError))
	is := payloadIssues(p)
	if p["status"] != "critical" || len(is) != 2 || !strings.Contains(is[0], "no receiver") || !strings.Contains(is[1], "cpu") {
		t.Errorf("error = %v", p)
	}

	// Lost for a moment (a reconnect, a skimmer restart): not yet an issue.
	p = buildSkimmerFeedHealthPayload(true, feedInState(false, 5*time.Second, healthOK))
	if p["status"] != "ok" {
		t.Errorf("briefly down = %v", p)
	}

	// Lost for longer: critical, with why; the skimmer's last report (stale)
	// no longer judged.
	c := feedInState(false, 2*time.Minute, healthError)
	c.lastError = "dial tcp 172.20.0.5:6101: connect: connection refused"
	p = buildSkimmerFeedHealthPayload(true, c)
	is = payloadIssues(p)
	if p["status"] != "critical" || len(is) != 1 || !strings.Contains(is[0], "Not connected to the skimmer feed (2.0 minutes)") ||
		!strings.Contains(is[0], "connection refused") {
		t.Errorf("down = %v", p)
	}

	// Never connected since start, for longer than the grace.
	c = NewSkimmerFeedClient(SkimmerFeedConfig{}, 0)
	c.startedAt = time.Now().Add(-time.Minute)
	c.changedAt = c.startedAt
	if p = buildSkimmerFeedHealthPayload(true, c); p["status"] != "critical" {
		t.Errorf("never connected = %v", p)
	}

	// Stalled: critical whatever the last report said.
	c = feedInState(true, time.Hour, healthOK)
	c.stalled = true
	p = buildSkimmerFeedHealthPayload(true, c)
	is = payloadIssues(p)
	if p["status"] != "critical" || len(is) != 1 || !strings.Contains(is[0], "stuck") {
		t.Errorf("stalled = %v", p)
	}
}

func TestSkimmerFeedMonitorItem(t *testing.T) {
	if _, ok := skimmerFeedMonitorItem(false, nil); ok {
		t.Error("an item for a feed that is off")
	}
	it, ok := skimmerFeedMonitorItem(true, feedInState(true, time.Hour, healthWarn))
	if !ok || it.Name != "Skimmer Feed" || it.Status != "warning" || len(it.Issues) != 1 {
		t.Errorf("item = %+v", it)
	}
}

func TestHandleSkimmerFeedHealth(t *testing.T) {
	for _, tc := range []struct {
		name    string
		enabled bool
		feed    *SkimmerFeedClient
		code    int
		status  string
	}{
		{"off", false, nil, http.StatusOK, "ok"},
		{"ok", true, feedInState(true, time.Hour, healthOK), http.StatusOK, "ok"},
		{"warning", true, feedInState(true, time.Hour, healthWarn), http.StatusServiceUnavailable, "warning"},
		{"down", true, feedInState(false, time.Hour, ""), http.StatusServiceUnavailable, "critical"},
	} {
		cfg := &Config{}
		cfg.SkimmerFeed.Enabled = tc.enabled
		ah := &AdminHandler{config: cfg}
		ah.SetSkimmerFeed(tc.feed)
		rec := httptest.NewRecorder()
		ah.HandleSkimmerFeedHealth(rec, httptest.NewRequest(http.MethodGet, "/admin/skimmer-feed-health", nil))
		var body map[string]interface{}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if rec.Code != tc.code || body["status"] != tc.status || body["enabled"] != tc.enabled {
			t.Errorf("%s: %d %v", tc.name, rec.Code, body)
		}
	}
}

// The notification probes: the feed's, unhealthy only when critical (its
// warnings come and go too often to notify on), and no decoder probe for a
// decoder that only delivers the feed's spots.
func TestSkimmerFeedNotificationProbe(t *testing.T) {
	probesFor := func(md *MultiDecoder, feed *SkimmerFeedClient) map[string]systemHealthProbe {
		out := map[string]systemHealthProbe{}
		for _, p := range BuildSystemHealthProbes(nil, nil, md, nil, feed, nil, nil, nil, nil, nil, nil, &Config{}, nil, nil) {
			out[p.component] = p
		}
		return out
	}
	if _, ok := probesFor(nil, nil)["skimmer_feed"]; ok {
		t.Error("a feed probe with no feed")
	}
	warn := probesFor(nil, feedInState(true, time.Hour, healthWarn))["skimmer_feed"]
	if ok, _ := warn.probe(); !ok {
		t.Error("a warning notified as unhealthy")
	}
	down := probesFor(nil, feedInState(false, time.Hour, ""))["skimmer_feed"]
	if ok, issues := down.probe(); ok || len(issues) == 0 {
		t.Errorf("down probed healthy (%v)", issues)
	}

	ingest := &MultiDecoder{ingestOnly: true}
	if _, ok := probesFor(ingest, nil)["decoder"]; ok {
		t.Error("a decoder probe for an ingest-only decoder")
	}
	if _, ok := probesFor(&MultiDecoder{}, nil)["decoder"]; !ok {
		t.Error("no decoder probe for local decoders")
	}
}

func TestIngestOnlyDecoderHealthMarked(t *testing.T) {
	md := &MultiDecoder{ingestOnly: true, decoderBands: map[string]*DecoderBand{}}
	if st := md.GetHealthStatus(); !st.IngestOnly || !st.Healthy {
		t.Errorf("ingest-only health = %+v", st)
	}
	if st := (&MultiDecoder{decoderBands: map[string]*DecoderBand{}}).GetHealthStatus(); st.IngestOnly {
		t.Error("local decoders marked ingest-only")
	}
}

// The connection's state changes are timed, for "connected for ..." and the
// grace before "not connected" is an issue.
func TestSkimmerFeedConnectionChangeTimed(t *testing.T) {
	c := NewSkimmerFeedClient(SkimmerFeedConfig{}, 0)
	before := time.Now()
	c.setConnected(true)
	st := c.Status()
	if !st.Connected || st.ChangedAt.Before(before) {
		t.Errorf("after connect: %+v", st)
	}
	at := st.ChangedAt
	c.setConnected(true) // no change: no new time
	if c.Status().ChangedAt != at {
		t.Error("the change time moved without a change")
	}
	time.Sleep(2 * time.Millisecond)
	c.setConnected(false)
	if st := c.Status(); st.Connected || !st.ChangedAt.After(at) {
		t.Errorf("after loss: %+v", st)
	}
}
