package hpsdr

import (
	"encoding/binary"
	"strings"
	"testing"
	"time"

	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/ubersdr"
)

// ---- the band table and picking an instance ------------------------------------

func TestBandTable(t *testing.T) {
	if len(Bands) != 13 || Bands[0].Name != "2200m" || Bands[len(Bands)-1].Name != "6m" {
		t.Fatalf("bands %s", BandNames())
	}
	for i, b := range Bands {
		if b.Lo >= b.Hi {
			t.Errorf("%s: %d-%d", b.Name, b.Lo, b.Hi)
		}
		if i > 0 && b.Lo <= Bands[i-1].Hi {
			t.Errorf("%s overlaps %s", b.Name, Bands[i-1].Name)
		}
	}
	// The widest allocation anywhere, not one region's.
	for name, edges := range map[string][2]int64{
		"80m": {3_500_000, 4_000_000}, "40m": {7_000_000, 7_300_000}, "160m": {1_800_000, 2_000_000},
		"20m": {14_000_000, 14_350_000}, "6m": {50_000_000, 54_000_000},
	} {
		b, ok := BandNamed(strings.ToUpper(name))
		if !ok || b.Lo != edges[0] || b.Hi != edges[1] {
			t.Errorf("%s: %+v", name, b)
		}
	}
	if b, ok := BandAt(7_074_000); !ok || b.Name != "40m" {
		t.Fatalf("7.074 MHz in %+v", b)
	}
	if _, ok := BandAt(9_500_000); ok {
		t.Fatal("9.5 MHz is in a band")
	}
	if any, all := Bands[len(Bands)-1].Covers(10_000, 30_000_000); any || all {
		t.Fatal("a 30 MHz receiver covers 6m")
	}
	if any, all := Bands[11].Covers(10_000, 29_000_000); !any || all {
		t.Fatal("a 29 MHz receiver should cover part of 10m")
	}
}

func routesFor(t *testing.T) (main, forty, six *Route, rt *router) {
	t.Helper()
	main = &Route{Server: mustServer(t, "http://main:8073")}
	forty = &Route{Server: mustServer(t, "http://forty:8073"), Bands: []string{"40m", "20M"}}
	six = &Route{Server: mustServer(t, "http://six:8073"), Bands: []string{"6m"}, MinHz: 10_000, MaxHz: 60_000_000}
	rt, err := newRouter([]*Route{forty, main, six})
	if err != nil {
		t.Fatal(err)
	}
	return
}

func TestPickAt(t *testing.T) {
	main, forty, six, rt := routesFor(t)
	if forty.Name != "forty:8073" || forty.Callsign != "forty:8073" || forty.Bands[1] != "20m" || main.MaxHz != ubersdr.DefaultMaxHz {
		t.Fatalf("defaults not applied: %+v", forty)
	}
	for _, c := range []struct {
		hz   int64
		want *Route
		why  Why
	}{
		{7_074_000, forty, WhyBand},  // its band
		{14_074_000, forty, WhyBand}, // its other band
		{3_573_000, main, WhyAll},    // another band: the catch-all
		{9_500_000, main, WhyAll},    // general coverage
		{50_313_000, six, WhyBand},   // 6m, beyond the catch-all
		{35_000_000, six, WhyRange},  // nobody's band, only six tunes it
		{70_000_000, main, WhyOut},   // nobody tunes it: the catch-all, warned
	} {
		got, why := rt.pickAt(c.hz)
		if got != c.want || why != c.why {
			t.Errorf("%d Hz: %s %c, want %s %c", c.hz, got.Name, why, c.want.Name, c.why)
		}
	}
	// A band owner that cannot tune part of its band loses that part to
	// whoever can.
	forty.MaxHz = 7_100_000
	if got, _ := rt.pickAt(7_200_000); got != main {
		t.Fatalf("7.2 MHz beyond forty's range went to %s", got.Name)
	}
	if !rt.anyCovers(0) || rt.anyCovers(70_000_000) || !rt.anyCovers(50_000_000) {
		t.Fatal("anyCovers")
	}
	if lo, hi := rt.span(); lo != 10_000 || hi != 60_000_000 {
		t.Fatalf("span %d-%d", lo, hi)
	}
}

// Creeping across a band edge holds the instance for routeEdgeHz; a jump does
// not.
func TestPickHysteresis(t *testing.T) {
	main, forty, _, rt := routesFor(t)
	// Stepping up from 6.9996 MHz on the catch-all.
	if got, _ := rt.pick(7_000_100, 6_999_600, main); got != main {
		t.Fatal("a 500 Hz step over the edge moved")
	}
	if got, _ := rt.pick(7_000_600, 7_000_100, main); got != forty {
		t.Fatal("still held 600 Hz inside the band")
	}
	// And back down.
	if got, _ := rt.pick(6_999_800, 7_000_200, forty); got != forty {
		t.Fatal("a small step back out moved")
	}
	// A jump to just inside the band is routed straight away.
	if got, _ := rt.pick(7_000_100, 3_573_000, main); got != forty {
		t.Fatal("a jump was held")
	}
	// No history: no hysteresis.
	if got, _ := rt.pick(7_000_100, 0, nil); got != forty {
		t.Fatal("first pick held")
	}
}

func TestRouterValidation(t *testing.T) {
	srv := func(h string) *ubersdr.Server { return mustServer(t, "http://"+h) }
	for name, routes := range map[string][]*Route{
		"no catch-all":   {{Server: srv("a"), Bands: []string{"40m"}}},
		"two catch-alls": {{Server: srv("a")}, {Server: srv("b")}},
		"unknown band":   {{Server: srv("a")}, {Server: srv("b"), Bands: []string{"11m"}}},
		"band twice":     {{Server: srv("a")}, {Server: srv("b"), Bands: []string{"40m"}}, {Server: srv("c"), Bands: []string{"20m", "40M"}}},
		"no server":      {{Server: srv("a")}, {Bands: []string{"40m"}}},
	} {
		if _, err := newRouter(routes); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// ---- the rate limit gate -------------------------------------------------------

func TestGate(t *testing.T) {
	var g gate
	t0 := time.Unix(1000, 0)
	base, max := 6*time.Second, 60*time.Second
	if g.reserve(t0) != 0 {
		t.Fatal("an unlimited gate made a DDC wait")
	}
	// Two DDCs connect at once; neither was limited, so both go.
	if g.reserve(t0) != 0 {
		t.Fatal("second DDC held")
	}
	if d := g.done(t0, true, false, base, max); d != base {
		t.Fatalf("first limit %s", d)
	}
	if w := g.reserve(t0.Add(time.Second)); w != 5*time.Second {
		t.Fatalf("wait %s", w)
	}
	// When it lifts, one DDC tries and the rest wait on its result.
	t1 := t0.Add(base)
	if g.reserve(t1) != 0 {
		t.Fatal("nobody may try after the wait")
	}
	if g.reserve(t1) != gateTrialWait {
		t.Fatal("a second DDC tried alongside the first")
	}
	// Limited again: the wait doubles, and stops at max.
	for want := 2 * base; want <= max; want *= 2 {
		if d := g.done(t1, true, false, base, max); d != want && !(want > max && d == max) {
			t.Fatalf("backoff %s, want %s", d, want)
		}
	}
	for i := 0; i < 5; i++ {
		g.done(t1, true, false, base, max)
	}
	if until, backoff := g.state(t1); backoff != max || !until.Equal(t1.Add(max)) {
		t.Fatalf("state %s %s", until, backoff)
	}
	// An error that says nothing about the limit only ends the trial.
	t2 := t1.Add(max)
	g.reserve(t2)
	g.done(t2, false, false, base, max)
	if _, backoff := g.state(t2); backoff != max {
		t.Fatal("an unrelated error cleared the limit")
	}
	// A success clears it.
	g.reserve(t2)
	g.done(t2, false, true, base, max)
	if until, backoff := g.state(t2); !until.IsZero() || backoff != 0 || g.reserve(t2) != 0 || g.reserve(t2) != 0 {
		t.Fatal("success left a limit")
	}
}

// ---- end to end: two instances ------------------------------------------------

// startRouted runs a bridge whose catch-all is main and whose 40m and 20m go to
// bands.
func startRouted(t *testing.T, main, bands *fakeServer, numRx int) (*Bridge, *logBuf, *hpClient) {
	t.Helper()
	b, logs := startBridge(t, main, "", func(c *Config) {
		c.NumRx = numRx
		c.Routes = []*Route{
			{Name: "main", Callsign: "M41N", Server: mustServer(t, main.srv.URL)},
			{Name: "forty", Callsign: "T3ST", Server: mustServer(t, bands.srv.URL), Bands: []string{"40m", "20m"}},
		}
		c.RouteDelay = 80 * time.Millisecond
		c.RateLimitDelay = 150 * time.Millisecond
		c.RateLimitMax = 600 * time.Millisecond
	})
	c := newClient(t, b.cfg.BasePort)
	keepAlive(t, c)
	return b, logs, c
}

func closedWithin(t *testing.T, fc *fakeConn, what string) {
	t.Helper()
	select {
	case <-fc.closed:
	case <-time.After(wait):
		t.Fatalf("%s not closed", what)
	}
}

func lastSeq(t *testing.T, c *hpClient, ddc int) uint32 {
	t.Helper()
	c.drain(PortDDC0 + ddc)
	return binary.BigEndian.Uint32(c.recv(PortDDC0+ddc, wait))
}

// A DDC tuned from a catch-all band into an assigned one moves to that
// instance, the same DDC and the same sequence, and back again.
func TestRouteFollowsTheDial(t *testing.T) {
	main, forty := newFakeServer(t), newFakeServer(t)
	b, logs, c := startRouted(t, main, forty, 1)
	startP2(t, c, 0, map[int]int{0: 192}, 3_573_000)

	ws := main.nextConn(t, wait)
	if ws.query.Get("frequency") != "3573000" {
		t.Fatalf("main opened at %s", ws.query.Get("frequency"))
	}
	waitStatus(t, b, "on main", func(s Status) bool {
		r := s.Receivers[0]
		return r.State == RxStreaming && r.Instance == "main" && r.Callsign == "M41N" && r.Why == WhyAll
	})
	seq := lastSeq(t, c, 0)

	c.send(PortHighPrio, highPrio(1, true, 7_074_000))
	ws2 := forty.nextConn(t, wait)
	if ws2.query.Get("frequency") != "7074000" || ws2.query.Get("mode") != "iq192" {
		t.Fatalf("forty opened with %v", ws2.query)
	}
	closedWithin(t, ws, "main's socket")
	st := waitStatus(t, b, "on forty", func(s Status) bool {
		return s.Receivers[0].State == RxStreaming && s.Receivers[0].Instance == "forty"
	})
	if st.Receivers[0].Why != WhyBand || st.Receivers[0].Callsign != "T3ST" {
		t.Fatal("an assigned band reported as by range")
	}
	logs.waitFor(t, "7.074000 MHz -> forty (40m 20m)", wait)
	// The client sees one DDC whose sequence carried on.
	if s2 := lastSeq(t, c, 0); s2 <= seq {
		t.Fatalf("sequence went from %d to %d", seq, s2)
	}
	// Within the band it is a tune on the same socket.
	c.send(PortHighPrio, highPrio(2, true, 14_074_000))
	select {
	case m := <-ws2.tunes:
		if m["frequency"] != float64(14_074_000) {
			t.Fatalf("tune %v", m)
		}
	case <-time.After(wait):
		t.Fatal("no tune on forty's socket")
	}
	forty.noConn(t, 200*time.Millisecond)

	// Back out to general coverage.
	c.send(PortHighPrio, highPrio(3, true, 9_500_000))
	ws3 := main.nextConn(t, wait)
	if ws3.query.Get("frequency") != "9500000" {
		t.Fatalf("main reopened at %s", ws3.query.Get("frequency"))
	}
	closedWithin(t, ws2, "forty's socket")
}

// Sweeping the dial through an assigned band faster than RouteDelay opens
// nothing there, and the socket already open follows the dial.
func TestRouteSweepOpensNothing(t *testing.T) {
	main, forty := newFakeServer(t), newFakeServer(t)
	b, _, c := startRouted(t, main, forty, 1)
	startP2(t, c, 0, map[int]int{0: 96}, 3_573_000)
	ws := main.nextConn(t, wait)

	c.send(PortHighPrio, highPrio(1, true, 7_074_000))
	waitStatus(t, b, "switching", func(s Status) bool {
		return s.Receivers[0].State == RxSwitching && s.Receivers[0].Detail == "to forty"
	})
	c.send(PortHighPrio, highPrio(2, true, 10_136_000))
	forty.noConn(t, 250*time.Millisecond)
	waitStatus(t, b, "streaming again", func(s Status) bool { return s.Receivers[0].State == RxStreaming })
	// main was told about both, since it tunes both.
	var got []float64
	for len(got) < 2 {
		select {
		case m := <-ws.tunes:
			got = append(got, m["frequency"].(float64))
		case <-time.After(wait):
			t.Fatalf("tunes %v", got)
		}
	}
	if got[0] != 7_074_000 || got[1] != 10_136_000 {
		t.Fatalf("tunes %v", got)
	}
	select {
	case <-ws.closed:
		t.Fatal("main's socket closed on a sweep")
	default:
	}
	if n := forty.checkCount(); n != 0 {
		t.Fatalf("%d prechecks to forty", n)
	}
}

// A rate limit is waited out per instance: every DDC headed there waits for the
// same moment, they do not hammer the server, the status says so, and a DDC
// tuned back elsewhere meanwhile goes straight there.
func TestRateLimitedInstance(t *testing.T) {
	main, forty := newFakeServer(t), newFakeServer(t)
	forty.set(func(f *fakeServer) {
		f.allow, f.status, f.reason = false, 429, "Rate limit exceeded. Please wait before trying again."
	})
	b, logs, c := startRouted(t, main, forty, 2)
	startP2(t, c, 0, map[int]int{0: 48, 1: 48}, 7_074_000, 14_074_000)

	st := waitStatus(t, b, "rate limited", func(s Status) bool {
		return s.Receivers[0].State == RxRateLimited && s.Receivers[1].State == RxRateLimited
	})
	for _, rx := range st.Receivers {
		if rx.Instance != "forty" || rx.RetryAt.IsZero() || rx.Detail != "rate limited by forty" {
			t.Fatalf("status %+v", rx)
		}
	}
	if r := st.Routes[1]; r.Name != "forty" || r.LimitedUntil.IsZero() || r.Backoff == 0 {
		t.Fatalf("route status %+v", r)
	}
	logs.waitFor(t, "forty is rate limiting connections", wait)
	logs.waitFor(t, "rate limited by forty, retrying in", wait)

	// With 150 ms doubling to 600 ms, a second holds a handful of prechecks,
	// not one per DDC per retry.
	n0 := forty.checkCount()
	time.Sleep(time.Second)
	if d := forty.checkCount() - n0; d > 4 {
		t.Fatalf("%d prechecks in a second while limited", d)
	}

	// Tuning DDC1 back to general coverage connects there without waiting.
	c.send(PortHighPrio, highPrio(1, true, 7_074_000, 9_500_000))
	if ws := main.nextConn(t, wait); ws.query.Get("frequency") != "9500000" {
		t.Fatalf("main opened at %s", ws.query.Get("frequency"))
	}

	// When the limit lifts DDC0 gets through, and the route's limit clears.
	forty.set(func(f *fakeServer) { f.allow, f.status, f.reason = true, 200, "" })
	forty.nextConn(t, 2*wait)
	waitStatus(t, b, "cleared", func(s Status) bool {
		return s.Receivers[0].State == RxStreaming && s.Routes[1].LimitedUntil.IsZero()
	})
}

// The socket's own rate limit (429 before the upgrade) is the same wait, not a
// connection error.
func TestRateLimitedSocket(t *testing.T) {
	f := newFakeServer(t)
	f.set(func(f *fakeServer) { f.wsStatus = 429 })
	b, _ := startBridge(t, f, "", func(c *Config) {
		c.RateLimitDelay, c.RateLimitMax = 150*time.Millisecond, 600*time.Millisecond
	})
	c := newClient(t, b.cfg.BasePort)
	keepAlive(t, c)
	startP2(t, c, 0, map[int]int{0: 192}, 7_000_000)
	st := waitStatus(t, b, "rate limited", func(s Status) bool { return s.Receivers[0].State == RxRateLimited })
	// One instance: the detail still names it, and the log does not.
	if st.Receivers[0].Detail == "" || len(st.Routes) != 1 {
		t.Fatalf("status %+v", st)
	}
	f.set(func(f *fakeServer) { f.wsStatus = 0 })
	waitStatus(t, b, "streaming", func(s Status) bool { return s.Receivers[0].State == RxStreaming })
}

// One instance, the default: nothing about routing shows or changes.
func TestSingleInstanceUnchanged(t *testing.T) {
	f := newFakeServer(t)
	b, logs := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)
	startP2(t, c, 0, map[int]int{0: 192}, 7_074_000)
	ws := f.nextConn(t, wait)
	c.send(PortHighPrio, highPrio(1, true, 14_074_000))
	select {
	case <-ws.tunes:
	case <-time.After(wait):
		t.Fatal("no tune")
	}
	f.noConn(t, 200*time.Millisecond)
	logs.waitFor(t, "connected at iq192", wait)
	if logs.has("->") || logs.has("Instance ") {
		t.Fatal("routing logged with one instance")
	}
	if st := b.Status(); len(st.Routes) != 1 || !st.Routes[0].CatchAll {
		t.Fatalf("routes %+v", st.Routes)
	}
}

// Creeping past the edge of an instance's range moves at once: the hysteresis
// that holds a DDC at a band edge must not hold it where its instance cannot
// tune.
func TestPickNeverHoldsOutOfRange(t *testing.T) {
	main, _, six, rt := routesFor(t)
	// main tunes to 30 MHz, six to 60.
	if got, _ := rt.pick(30_000_200, 29_999_900, main); got != six {
		t.Fatalf("held on %s past its range", got.Name)
	}
	// The other way six tunes both sides, so a small step may hold it there.
	if got, _ := rt.pick(29_999_900, 30_000_200, six); got != six {
		t.Fatalf("went to %s", got.Name)
	}
}

// Tuned where no instance tunes: nothing is opened, the status says so, and a
// retune back into range connects.
func TestOutOfRangeOpensNothing(t *testing.T) {
	f := newFakeServer(t)
	b, logs := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)
	keepAlive(t, c)
	startP2(t, c, 0, map[int]int{0: 192}, 64_000_000)
	st := waitStatus(t, b, "out of range", func(s Status) bool { return s.Receivers[0].State == RxOutOfRange })
	if st.Receivers[0].Why != WhyOut || !strings.Contains(st.Receivers[0].Detail, "64.000 MHz: the receiver tunes 10.000 kHz - 30.000 MHz") {
		t.Fatalf("status %+v", st.Receivers[0])
	}
	f.noConn(t, 300*time.Millisecond)
	if n := f.checkCount(); n != 0 {
		t.Fatalf("%d prechecks for a frequency nobody tunes", n)
	}
	logs.waitFor(t, "outside the receiver's", wait)

	c.send(PortHighPrio, highPrio(1, true, 7_074_000))
	ws := f.nextConn(t, wait)
	if ws.query.Get("frequency") != "7074000" {
		t.Fatalf("opened at %s", ws.query.Get("frequency"))
	}
	waitStatus(t, b, "streaming", func(s Status) bool { return s.Receivers[0].State == RxStreaming })

	// Retuned out of range while streaming: the socket closes rather than be
	// sent a tune the server refuses, and nothing reconnects.
	c.send(PortHighPrio, highPrio(2, true, 64_000_000))
	closedWithin(t, ws, "the socket")
	select {
	case m := <-ws.tunes:
		t.Fatalf("sent %v", m)
	default:
	}
	waitStatus(t, b, "out of range", func(s Status) bool { return s.Receivers[0].State == RxOutOfRange })
	f.noConn(t, 300*time.Millisecond)
	c.quiet(PortDDC0, 150*time.Millisecond)

	c.send(PortHighPrio, highPrio(3, true, 14_074_000))
	if ws := f.nextConn(t, wait); ws.query.Get("frequency") != "14074000" {
		t.Fatalf("reopened at %s", ws.query.Get("frequency"))
	}
}

// With two instances, out of both ranges is the same: silent, O, no socket on
// either.
func TestOutOfRangeRouted(t *testing.T) {
	main, forty := newFakeServer(t), newFakeServer(t)
	b, logs, c := startRouted(t, main, forty, 1)
	startP2(t, c, 0, map[int]int{0: 48}, 7_074_000)
	ws := forty.nextConn(t, wait)
	c.send(PortHighPrio, highPrio(1, true, 64_000_000))
	closedWithin(t, ws, "forty's socket")
	st := waitStatus(t, b, "out of range", func(s Status) bool { return s.Receivers[0].State == RxOutOfRange })
	if st.Receivers[0].Why != WhyOut || !strings.Contains(st.Receivers[0].Detail, "no instance tunes it") {
		t.Fatalf("status %+v", st.Receivers[0])
	}
	main.noConn(t, 300*time.Millisecond)
	forty.noConn(t, 10*time.Millisecond)
	logs.waitFor(t, "which no instance tunes", wait)
}

// A high priority packet that overtakes the general packet announcing phase
// words is read again when it arrives, not left tuned to 125 MHz.
func TestHighPriorityBeforeGeneral(t *testing.T) {
	f := newFakeServer(t)
	b, logs := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)
	keepAlive(t, c)
	w := func(hz float64) uint32 { return uint32(hz*4294967296.0/DDCClockHz + 0.5) }
	d := make([]byte, 60)
	d[4] = 0x02
	c.send(PortDiscovery, d)
	c.recv(PortDiscovery, wait)
	c.send(PortDDCSpecific, ddcSpec(0, map[int]int{0: 48}))
	c.send(PortHighPrio, highPrio(5, true, w(3_573_000)))
	waitStatus(t, b, "misread", func(s Status) bool { return s.Receivers[0].FreqHz > 100_000_000 })
	c.send(PortDiscovery, general(0, 0x08))
	ws := f.nextConn(t, wait)
	if ws.query.Get("frequency") != "3573000" {
		t.Fatalf("opened at %s", ws.query.Get("frequency"))
	}
	if logs.has("SEQ ERROR") {
		t.Fatal("the reread logged a sequence error")
	}
}
