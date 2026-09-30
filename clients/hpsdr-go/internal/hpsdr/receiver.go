package hpsdr

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/ubersdr"
)

// RxState is what a receiver's socket is doing.
type RxState int

const (
	RxIdle       RxState = iota // no client wants this DDC
	RxNotOffered                // the client asked for a rate this session may not use
	RxConnecting
	RxStreaming
	RxRefused // /connection said no
	RxError   // could not connect, or the server closed on us; retrying
	// RxRateLimited: the instance said too many connections; waiting it out.
	RxRateLimited
	// RxSwitching: tuned to another instance's frequency, moving there.
	RxSwitching
	// RxOutOfRange: tuned where no instance tunes. Nothing is opened: the
	// server refuses the socket and closes it, and retrying would only spend
	// the session allowance. It waits for a retune.
	RxOutOfRange
)

func (s RxState) String() string {
	switch s {
	case RxIdle:
		return "idle"
	case RxNotOffered:
		return "rate not allowed"
	case RxConnecting:
		return "connecting"
	case RxStreaming:
		return "streaming"
	case RxRefused:
		return "refused"
	case RxError:
		return "retrying"
	case RxRateLimited:
		return "rate limited"
	case RxSwitching:
		return "switching"
	case RxOutOfRange:
		return "out of range"
	}
	return "?"
}

// receiver is one DDC's connection to UberSDR: one WebSocket, one decoder, and
// the samples decoded but not yet sent. With several instances it is still one
// socket: a DDC tuned to another instance's frequency closes it and opens one
// there.
type receiver struct {
	b   *Bridge
	idx int
	rxCounters

	// wake is poked whenever the bridge changes what this DDC should be doing.
	wake chan struct{}

	mu      sync.Mutex
	st      RxState
	detail  string
	mode    string
	retryAt time.Time
	// route is the instance this DDC is on or headed for, and why. routeFreq is the frequency it was last routed at, which the
	// edge hysteresis measures a move from.
	route     *Route
	why       Why
	routeFreq int64

	pending []float32

	// fails counts sessions in a row that failed; from quietAfter on, their
	// log lines are held back (held counts them) until a stream lasts
	// quietRecover. Only the run goroutine touches these.
	fails int
	held  int
}

// A receiver whose server is down, or refuses, retries every few seconds for
// as long as that lasts; logging each attempt would bury everything else. The
// first few say what is wrong, then it goes quiet until it streams again. The
// status screen shows every attempt regardless.
const quietAfter = 3

// quietRecover is how long a stream must last to count as recovered: a server
// that accepts and then drops the socket is still failing. A variable so the
// tests need not wait it out.
var quietRecover = 10 * time.Second

// noisy logs a line that a failing receiver repeats on every retry.
func (r *receiver) noisy(format string, args ...any) {
	if r.fails >= quietAfter {
		r.held++
		return
	}
	r.logf(format, args...)
}

// failed counts a failed session, saying once when the receiver goes quiet.
func (r *receiver) failed() {
	r.fails++
	if r.fails == quietAfter {
		r.logf("still failing after %d attempts; retrying without logging each one until it streams again", quietAfter)
	}
}

// streamed resets the count once a stream has lasted quietRecover.
func (r *receiver) streamed() {
	if r.held > 0 {
		r.logf("streaming again (%d repeated messages were not logged)", r.held)
	}
	r.fails, r.held = 0, 0
}

// rxView is a receiver's state for the status.
type rxView struct {
	st           RxState
	detail, mode string
	retryAt      time.Time
	route        *Route
	why          Why
}

func newReceiver(b *Bridge, idx int) *receiver {
	return &receiver{b: b, idx: idx, wake: make(chan struct{}, 1)}
}

func (r *receiver) poke() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

func (r *receiver) set(st RxState, detail string) { r.setUntil(st, detail, time.Time{}) }

// setUntil is set for a state that ends at a known time.
func (r *receiver) setUntil(st RxState, detail string, at time.Time) {
	r.mu.Lock()
	r.st, r.detail, r.retryAt = st, detail, at
	if st != RxStreaming {
		r.mode = ""
	}
	r.mu.Unlock()
}

func (r *receiver) view() rxView {
	r.mu.Lock()
	defer r.mu.Unlock()
	return rxView{st: r.st, detail: r.detail, mode: r.mode, retryAt: r.retryAt, route: r.route, why: r.why}
}

// routeTo records where the DDC is going, logging a move between instances.
func (r *receiver) routeTo(rt *Route, why Why, hz int64) {
	r.mu.Lock()
	prev := r.route
	r.route, r.why, r.routeFreq = rt, why, hz
	r.mu.Unlock()
	if rt != prev && r.b.multi() {
		how := ""
		switch why {
		case WhyRange:
			how = ", the only instance that tunes there"
		case WhyOut:
			how = ", though no instance tunes there"
		}
		r.logf("%.6f MHz -> %s%s", float64(hz)/1e6, rt.Label(), how)
	}
}

func (r *receiver) current() (*Route, int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.route, r.routeFreq
}

func (r *receiver) logf(format string, args ...any) {
	r.b.logf("DDC%d: %s", r.idx, fmt.Sprintf(format, args...))
}

// pause waits for d, or less if what the DDC should do changes. Returns false
// when the bridge stops.
func (r *receiver) pause(d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-r.b.stop:
		return false
	case <-t.C:
	case <-r.wake:
		// Consumed, not re-queued: the loop re-reads what is wanted anyway,
		// and a wake left behind would end the next pause at once -- which
		// turned a refused session into a tight loop on /connection.
	}
	return true
}

// run is the receiver's life: wait until a client wants this DDC, connect,
// stream until something changes, and go round again.
func (r *receiver) run() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-r.b.stop
		cancel()
	}()

	lastNotOffered := 0
	for {
		w := r.b.want(r.idx)
		if !w.active {
			r.set(RxIdle, "")
			select {
			case <-r.b.stop:
				return
			case <-r.wake:
			}
			continue
		}
		if !r.b.offers(w.khz) {
			r.set(RxNotOffered, fmt.Sprintf("%d kHz", w.khz))
			if lastNotOffered != w.khz {
				lastNotOffered = w.khz
				r.logf("client asked for %d kHz, which this session may not use (offered: %s kHz)",
					w.khz, joinInts(r.b.cfg.RatesKHz))
			}
			select {
			case <-r.b.stop:
				return
			case <-r.wake:
			}
			continue
		}
		lastNotOffered = 0

		if !r.b.router.anyCovers(w.freq) {
			// Already warned about by the bridge when the client tuned here.
			r.mu.Lock()
			r.why = WhyOut
			r.mu.Unlock()
			r.set(RxOutOfRange, fmt.Sprintf("%.3f MHz: %s", float64(w.freq)/1e6, r.b.rangeText()))
			select {
			case <-r.b.stop:
				return
			case <-r.wake:
			}
			continue
		}

		cur, prev := r.current()
		rt, why := r.b.router.pick(w.freq, prev, cur)
		r.routeTo(rt, why, w.freq)
		delay, ok := r.session(ctx, w, rt)
		if !ok {
			return
		}
		if delay > 0 && !r.pause(delay) {
			return
		}
	}
}

// session is one connect attempt and, if it succeeds, the stream. It returns
// how long to wait before the next attempt, and false when the bridge stopped.
func (r *receiver) session(ctx context.Context, w want, rt *Route) (time.Duration, bool) {
	cfg := &r.b.cfg
	srv := rt.Server

	// Another DDC was rate limited by this instance: wait with it rather than
	// be refused too.
	if wait := rt.gate.reserve(time.Now()); wait > 0 {
		r.setUntil(RxRateLimited, r.limitDetail(rt), time.Now().Add(wait))
		return wait, true
	}
	limited := func() (time.Duration, bool) {
		d := rt.gate.done(time.Now(), true, false, cfg.RateLimitDelay, cfg.RateLimitMax)
		r.setUntil(RxRateLimited, r.limitDetail(rt), time.Now().Add(d))
		r.b.once("ratelimit-"+rt.Name, "%s is rate limiting connections: a public session may open about "+
			"10 a minute, and each band change is one. A password for a bypassed session lifts the limit.", rt.Name)
		r.noisy("rate limited by %s, retrying in %s", rt.Name, d)
		r.failed()
		return d, true
	}

	// A fresh session ID every attempt: the server invalidates one when its
	// socket closes, and reusing it answers "Invalid session".
	id := ubersdr.NewSessionID()
	r.set(RxConnecting, "")
	res, err := srv.Check(ctx, id)
	if r.b.stopped() {
		rt.gate.done(time.Now(), false, false, 0, 0)
		return 0, false
	}
	if err != nil {
		rt.gate.done(time.Now(), false, false, 0, 0)
		r.set(RxError, err.Error())
		r.noisy("%v", err)
		r.failed()
		return cfg.RetryDelay, true
	}
	if res.RateLimited() {
		return limited()
	}
	if !res.Allowed {
		rt.gate.done(time.Now(), false, false, 0, 0)
		reason := res.Refusal(srv.Password != "")
		r.set(RxRefused, r.named(rt, reason))
		r.noisy("connection refused%s: %s", r.by(rt), reason)
		r.failed()
		return cfg.RefusedDelay, true
	}

	conn, err := srv.DialIQ(ctx, id, w.freq, w.khz, cfg.MinMargin)
	if r.b.stopped() {
		rt.gate.done(time.Now(), false, false, 0, 0)
		if conn != nil {
			conn.Close()
		}
		return 0, false
	}
	if errors.Is(err, ubersdr.ErrRateLimited) {
		return limited()
	}
	if err != nil {
		rt.gate.done(time.Now(), false, false, 0, 0)
		r.set(RxError, r.named(rt, err.Error()))
		r.noisy("%v", err)
		r.failed()
		return cfg.RetryDelay, true
	}
	rt.gate.done(time.Now(), false, true, 0, 0)
	r.noisy("connected%s at %s, %.6f MHz", r.to(rt), ubersdr.ModeForKHz(w.khz), float64(w.freq)/1e6)
	why, err := r.stream(conn, w, rt)
	conn.Close()
	switch why {
	case endStopped:
		return 0, false
	case endDisabled:
		r.logf("disconnected, the client no longer wants this DDC")
		return 0, true
	case endRouteChange:
		// Straight on: the move was already held for RouteDelay.
		return 0, true
	case endOutOfRange:
		r.logf("disconnected, tuned where no instance tunes")
		return 0, true
	case endRateChange:
		return cfg.ReconnectDelay, true
	default:
		msg := "connection closed"
		if err != nil {
			msg = err.Error()
		}
		r.set(RxError, msg)
		r.noisy("%s; reconnecting", msg)
		r.failed()
		if errors.Is(err, ubersdr.ErrLegacyServer) {
			return cfg.RefusedDelay, true
		}
		return cfg.ReconnectDelay, true
	}
}

// limitDetail is the status detail while waiting out a rate limit.
func (r *receiver) limitDetail(rt *Route) string { return "rate limited by " + rt.Name }

// named, by and to mention the instance only when there is more than one:
// with one, the header already says which.
func (r *receiver) named(rt *Route, s string) string {
	if r.b.multi() {
		return rt.Name + ": " + s
	}
	return s
}

func (r *receiver) by(rt *Route) string {
	if r.b.multi() {
		return " by " + rt.Name
	}
	return ""
}

func (r *receiver) to(rt *Route) string {
	if r.b.multi() {
		return " to " + rt.Name
	}
	return ""
}

type streamEnd int

const (
	endClosed streamEnd = iota
	endStopped
	endDisabled
	endRateChange
	endRouteChange
	endOutOfRange
)

// stream services one socket until it ends or has to be replaced.
//
// A retune to a frequency another instance should serve is held for RouteDelay
// before the socket is given up: a client sweeping across several bands would
// otherwise open a socket on each one it passed, and a public session may open
// only about ten a minute. Meanwhile this socket follows the dial where it can.
//
// IQ never comes through here. The server sends about a thousand frames a
// second at 384 kHz, and handing each one to this loop cost a goroutine wake
// apiece, more than decoding them did; so the reader decodes, scales and sends
// them itself, and passes on only what needs deciding: the server's messages,
// a rate change, and the socket's end.
func (r *receiver) stream(conn *ubersdr.IQConn, w want, rt *Route) (streamEnd, error) {
	type result struct {
		m        ubersdr.Message
		err      error
		rateFrom int // set: the server changed rate under the socket
	}
	msgs := make(chan result, 64)
	done := make(chan struct{})
	readerDone := make(chan struct{})
	// The reader must be gone before this returns: the next socket's reader
	// sends from the same DDC's buffers, and two at once would interleave.
	defer func() {
		close(done)
		conn.Close()
		<-readerDone
	}()

	r.pending = r.pending[:0]
	go func() {
		defer close(readerDone)
		send := func(res result) bool {
			select {
			case msgs <- res:
				return true
			case <-done:
				return false
			}
		}
		lastRate := 0
		for {
			m, err := conn.ReadIdle(r.b.cfg.IdleTimeout)
			if err != nil {
				send(result{err: err})
				return
			}
			if m.WireBytes > 0 {
				// Counted before the decode, because this is what the link
				// carried.
				r.logBytes.Add(uint64(m.WireBytes))
				r.uiBytes.Add(uint64(m.WireBytes))
			}
			switch m.Kind {
			case ubersdr.MsgIQ:
				// A rate change UNDER a live socket would silently reframe
				// what the client is sent, so it is a reconnect.
				if lastRate != 0 && m.SampleRate != lastRate {
					send(result{m: m, rateFrom: lastRate})
					return
				}
				lastRate = m.SampleRate
				r.accept(m.Samples, m.SampleRate)
			case ubersdr.MsgBad:
				r.b.every(fmt.Sprintf("decode-%d", r.idx), time.Minute, "DDC%d: decode: %s", r.idx, m.Text)
			default:
				if !send(result{m: m}) {
					return
				}
			}
		}
	}()

	r.set(RxStreaming, "")
	khz, sentFreq := w.khz, w.freq
	lastMode, lastModeRate := "", 0

	var (
		next     *Route // the instance a pending move goes to
		nextWhy  Why
		moveT    *time.Timer
		moveC    <-chan time.Time
		moveFreq int64
	)
	defer func() {
		if moveT != nil {
			moveT.Stop()
		}
	}()
	okT := time.NewTimer(quietRecover)
	defer okT.Stop()

	for {
		select {
		case <-r.b.stop:
			return endStopped, nil

		case <-okT.C:
			r.streamed()

		case <-moveC:
			moveC = nil
			r.routeTo(next, nextWhy, moveFreq)
			return endRouteChange, nil

		case <-r.wake:
			now := r.b.want(r.idx)
			if !now.active {
				return endDisabled, nil
			}
			if now.khz != khz {
				// The mode is baked into the URL, so a rate change is a new socket.
				r.logf("rate changed %d -> %d kHz, reconnecting", khz, now.khz)
				return endRateChange, nil
			}
			if now.freq != sentFreq && !r.b.router.anyCovers(now.freq) {
				// The server would refuse the tune and keep serving the old
				// frequency, which the client would take for the new one.
				return endOutOfRange, nil
			}
			if now.freq != sentFreq {
				_, prev := r.current()
				target, why := r.b.router.pick(now.freq, prev, rt)
				if target == rt {
					// Back on this instance's patch before the move was due.
					if moveC != nil {
						moveT.Stop()
						moveC = nil
						r.set(RxStreaming, "")
					}
					r.mu.Lock()
					r.routeFreq, r.why = now.freq, why
					r.mu.Unlock()
				} else {
					// Restarted on every retune: the dial has to settle.
					next, nextWhy, moveFreq = target, why, now.freq
					if moveT == nil {
						moveT = time.NewTimer(r.b.cfg.RouteDelay)
					} else {
						moveT.Stop()
						moveT.Reset(r.b.cfg.RouteDelay)
					}
					moveC = moveT.C
					r.mu.Lock()
					r.st, r.detail = RxSwitching, "to "+target.Name
					r.mu.Unlock()
				}
				if target == rt || rt.covers(now.freq) {
					if err := conn.Tune(now.freq, khz); err != nil {
						return endClosed, err
					}
					sentFreq = now.freq
				}
			}

		case res := <-msgs:
			if res.err != nil {
				return endClosed, res.err
			}
			m := res.m
			if res.rateFrom != 0 {
				r.logf("server sample rate changed %d -> %d, reconnecting", res.rateFrom, m.SampleRate)
				return endRateChange, nil
			}
			switch m.Kind {
			case ubersdr.MsgStatus:
				// Sent after every tune; logged only when it changes.
				if m.Mode != lastMode || m.SampleRate != lastModeRate {
					lastMode, lastModeRate = m.Mode, m.SampleRate
					r.mu.Lock()
					r.mode = m.Mode
					r.mu.Unlock()
					r.noisy("server serving %s at %d Hz", m.Mode, m.SampleRate)
					if want := ubersdr.ModeForKHz(khz); m.Mode != "" && m.Mode != want {
						r.noisy("WARNING asked for %s but the server is serving %s", want, m.Mode)
					}
				}
			case ubersdr.MsgError:
				r.noisy("server: %s", m.Text)
				r.mu.Lock()
				r.detail = m.Text
				r.mu.Unlock()
			case ubersdr.MsgText:
				r.noisy("server: %s", m.Text)
			}
		}
	}
}

// accept scales decoded samples and sends every whole packet's worth.
//
// Scaled to the rate the samples ARRIVED at, not the one the client asked for,
// so a session served narrower than requested is still scaled for what it is.
// The arithmetic is float32 in the C bridge's order -- sample/32768, then times
// the gain, then truncated -- so both bridges put the same integers on the wire.
func (r *receiver) accept(samples []int16, rate int) {
	scale := ScaleForKHz(rate / 1000)
	n := len(samples) &^ 1
	for i := 0; i < n; i++ {
		r.pending = append(r.pending, float32(samples[i])/32768*scale)
	}
	off := 0
	for {
		per := 2 * r.b.samplesPerPacket()
		if len(r.pending)-off < per {
			break
		}
		if r.b.emit(r.idx, r.pending[off:off+per]) {
			r.packets.Add(1)
		}
		off += per
	}
	r.pending = append(r.pending[:0], r.pending[off:]...)
}
