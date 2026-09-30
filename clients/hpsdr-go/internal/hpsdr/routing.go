package hpsdr

import (
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/ubersdr"
)

// Band is an amateur allocation.
type Band struct {
	Name   string
	Lo, Hi int64
}

// Bands are the amateur HF and 6m allocations, 2200m to 6m.
//
// Each edge is the widest allocation any country has, not one region's: 80m
// is 3.5-4.0 MHz because it is in the Americas, though the UK stops at 3.8. A
// band here only decides which instance a DDC is sent to, so erring wide sends
// a DDC just outside someone's allocation to the instance they chose for that
// band, which is what they would want. 60m is the widest of the many national
// allocations, most of which are narrower or channelised.
var Bands = []Band{
	{"2200m", 135_700, 137_800},
	{"630m", 472_000, 479_000},
	{"160m", 1_800_000, 2_000_000},
	{"80m", 3_500_000, 4_000_000},
	{"60m", 5_250_000, 5_450_000},
	{"40m", 7_000_000, 7_300_000},
	{"30m", 10_100_000, 10_150_000},
	{"20m", 14_000_000, 14_350_000},
	{"17m", 18_068_000, 18_168_000},
	{"15m", 21_000_000, 21_450_000},
	{"12m", 24_890_000, 24_990_000},
	{"10m", 28_000_000, 29_700_000},
	{"6m", 50_000_000, 54_000_000},
}

// BandNamed looks a band up by name, ignoring case.
func BandNamed(name string) (Band, bool) {
	for _, b := range Bands {
		if strings.EqualFold(b.Name, strings.TrimSpace(name)) {
			return b, true
		}
	}
	return Band{}, false
}

// BandAt is the band containing hz, if any.
func BandAt(hz int64) (Band, bool) {
	for _, b := range Bands {
		if hz >= b.Lo && hz <= b.Hi {
			return b, true
		}
	}
	return Band{}, false
}

// Covers reports whether a tuning range reaches any of the band, and whether it
// reaches all of it.
func (b Band) Covers(minHz, maxHz int64) (any, all bool) {
	return minHz <= b.Hi && maxHz >= b.Lo, minHz <= b.Lo && maxHz >= b.Hi
}

// Route is one UberSDR instance DDCs can be sent to.
type Route struct {
	// Name labels it in the log: the host, unless set.
	Name string
	// Callsign is the receiver's own, for the status; the host when it
	// publishes none.
	Callsign string
	Server   *ubersdr.Server
	// Bands are the bands sent here. None makes this the catch-all, which
	// takes everything no other route claims. Exactly one route is.
	Bands []string
	// MinHz and MaxHz are its tuning range; zero for both is the default.
	MinHz, MaxHz int64

	gate gate
}

// CatchAll reports whether this route takes what no band route claims.
func (r *Route) CatchAll() bool { return len(r.Bands) == 0 }

func (r *Route) covers(hz int64) bool { return hz >= r.MinHz && hz <= r.MaxHz }

func (r *Route) owns(hz int64) bool {
	b, ok := BandAt(hz)
	if !ok {
		return false
	}
	for _, n := range r.Bands {
		if strings.EqualFold(n, b.Name) {
			return true
		}
	}
	return false
}

// Label is the name with the bands, for the log.
func (r *Route) Label() string {
	if r.CatchAll() {
		return r.Name
	}
	return r.Name + " (" + strings.Join(r.Bands, " ") + ")"
}

// Why says why a DDC is on its instance, as the one letter the status shows.
type Why byte

const (
	WhyNone  Why = 0
	WhyBand  Why = 'B' // the band is assigned to it
	WhyAll   Why = 'A' // the catch-all: every frequency no band takes
	WhyRange Why = 'R' // the only instance that tunes there
	WhyOut   Why = 'O' // no instance tunes there; waiting for a retune
)

// WhyKeys are the letters in the order the status explains them.
var WhyKeys = []struct {
	Why  Why
	Text string
}{
	{WhyBand, "band assigned"},
	{WhyAll, "all others"},
	{WhyRange, "only one in range"},
	{WhyOut, "out of range"},
}

// routeEdgeHz is the hysteresis at a band or range edge: a DDC tuned by less
// than this, that stays within this of the edge it is on, keeps its instance.
// Without it a client stepping back and forth across 7.000 MHz would reconnect
// on every step. A jump is always routed straight away; this only holds a DDC
// that is creeping. Small enough for 2200m, which is 2.1 kHz wide.
const routeEdgeHz = 500

// router picks the instance for a frequency.
type router struct {
	routes   []*Route
	catchAll *Route
}

func newRouter(routes []*Route) (*router, error) {
	rt := &router{routes: routes}
	claimed := map[string]string{}
	for i, r := range routes {
		if r.Server == nil {
			return nil, fmt.Errorf("instance %d has no server", i+1)
		}
		if r.Name == "" {
			r.Name = r.Server.Host()
		}
		if r.Callsign == "" {
			r.Callsign = r.Server.Host()
		}
		if r.MinHz == 0 && r.MaxHz == 0 {
			r.MinHz, r.MaxHz = ubersdr.DefaultMinHz, ubersdr.DefaultMaxHz
		}
		if r.CatchAll() {
			if rt.catchAll != nil {
				return nil, fmt.Errorf("%s and %s are both set for every band; only one instance can be", rt.catchAll.Name, r.Name)
			}
			rt.catchAll = r
			continue
		}
		for j, n := range r.Bands {
			b, ok := BandNamed(n)
			if !ok {
				return nil, fmt.Errorf("%s: %q is not a band (%s)", r.Name, n, BandNames())
			}
			r.Bands[j] = b.Name
			if other, dup := claimed[b.Name]; dup {
				return nil, fmt.Errorf("%s is set for both %s and %s", b.Name, other, r.Name)
			}
			claimed[b.Name] = r.Name
		}
	}
	if rt.catchAll == nil {
		return nil, fmt.Errorf("no instance is set for everything else")
	}
	return rt, nil
}

// BandNames lists the band names, for messages.
func BandNames() string {
	n := make([]string, len(Bands))
	for i, b := range Bands {
		n[i] = b.Name
	}
	return strings.Join(n, " ")
}

// pickAt is the route for a frequency, with no history:
//
//  1. the route the band is assigned to, if it tunes there;
//  2. the catch-all, if it tunes there;
//  3. the first route, in order, that tunes there;
//  4. the catch-all, WhyOut: nobody tunes there. The receiver does not
//     connect at all then; this answer is only for completeness.
//
// The Why is which case it was, which the status shows.
func (rt *router) pickAt(hz int64) (*Route, Why) {
	for _, r := range rt.routes {
		if !r.CatchAll() && r.owns(hz) && r.covers(hz) {
			return r, WhyBand
		}
	}
	if rt.catchAll.covers(hz) {
		return rt.catchAll, WhyAll
	}
	for _, r := range rt.routes {
		if r.covers(hz) {
			return r, WhyRange
		}
	}
	return rt.catchAll, WhyOut
}

// pick is pickAt with hysteresis: a DDC on cur, moved from prev by no more than
// routeEdgeHz, stays on cur while cur would still be picked within routeEdgeHz
// of hz and tunes hz itself. prev is 0 when the DDC has no route yet.
func (rt *router) pick(hz, prev int64, cur *Route) (*Route, Why) {
	r, why := rt.pickAt(hz)
	// Never held on an instance that cannot tune hz: the server would refuse
	// the tune.
	if cur == nil || r == cur || prev == 0 || !cur.covers(hz) {
		return r, why
	}
	d := hz - prev
	if d < 0 {
		d = -d
	}
	if d > routeEdgeHz {
		return r, why
	}
	for _, near := range []int64{hz - routeEdgeHz, hz + routeEdgeHz} {
		if n, nw := rt.pickAt(near); n == cur {
			return cur, nw
		}
	}
	return r, why
}

// anyCovers reports whether some route tunes hz. Zero, a DDC nobody has tuned,
// is never out of range.
func (rt *router) anyCovers(hz int64) bool {
	if hz == 0 {
		return true
	}
	for _, r := range rt.routes {
		if r.covers(hz) {
			return true
		}
	}
	return false
}

// span is the lowest and highest frequency any route tunes.
func (rt *router) span() (lo, hi int64) {
	for i, r := range rt.routes {
		if i == 0 || r.MinHz < lo {
			lo = r.MinHz
		}
		if i == 0 || r.MaxHz > hi {
			hi = r.MaxHz
		}
	}
	return lo, hi
}

// ---- rate limits -------------------------------------------------------------

// gate spaces out connections to one instance after it says "too many".
//
// The server allows an address about ten prechecks a minute (one more every 6
// seconds) and four sockets a second, unless the session is bypassed. Every DDC
// of this bridge shares that allowance, so a 429 to one of them means the rest
// would get one too. Once limited, every DDC headed there waits for the same
// moment, and then only one tries: if it gets through the rest follow, and if
// not the wait doubles. A refused request does not spend the server's
// allowance, so waiting is all it takes.
type gate struct {
	mu      sync.Mutex
	until   time.Time
	backoff time.Duration
	trying  bool
}

// gateTrialWait is how often DDCs held behind another's trial look again.
const gateTrialWait = 250 * time.Millisecond

// reserve returns zero when the caller may connect now, or how long to wait.
// A caller given zero after a limit must report back with done.
func (g *gate) reserve(now time.Time) time.Duration {
	g.mu.Lock()
	defer g.mu.Unlock()
	if now.Before(g.until) {
		return g.until.Sub(now)
	}
	if g.backoff > 0 {
		if g.trying {
			return gateTrialWait
		}
		g.trying = true
	}
	return 0
}

// done reports how a reserved attempt went. limited doubles the wait, starting
// at base and stopping at max; ok clears the limit; neither (an error that says
// nothing about the limit) only ends the trial. It returns the new wait when
// limited.
func (g *gate) done(now time.Time, limited, ok bool, base, max time.Duration) time.Duration {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.trying = false
	switch {
	case limited:
		if g.backoff == 0 {
			g.backoff = base
		} else if g.backoff *= 2; g.backoff > max {
			g.backoff = max
		}
		g.until = now.Add(g.backoff)
		return g.backoff
	case ok:
		g.backoff, g.until = 0, time.Time{}
	}
	return 0
}

// state is the limit for the status: the time it lifts, zero if not limited.
func (g *gate) state(now time.Time) (until time.Time, backoff time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.backoff == 0 {
		return time.Time{}, 0
	}
	if now.After(g.until) {
		return now, g.backoff
	}
	return g.until, g.backoff
}
