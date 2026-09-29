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
	}
	return "?"
}

// receiver is one DDC's connection to UberSDR: one WebSocket, one decoder, and
// the samples decoded but not yet sent.
type receiver struct {
	b   *Bridge
	idx int
	rxCounters

	// wake is poked whenever the bridge changes what this DDC should be doing.
	wake chan struct{}

	mu     sync.Mutex
	st     RxState
	detail string
	mode   string

	pending []float32
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

func (r *receiver) set(st RxState, detail string) {
	r.mu.Lock()
	r.st, r.detail = st, detail
	if st != RxStreaming {
		r.mode = ""
	}
	r.mu.Unlock()
}

func (r *receiver) state() (RxState, string, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.st, r.detail, r.mode
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

		delay, ok := r.session(ctx, w)
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
func (r *receiver) session(ctx context.Context, w want) (time.Duration, bool) {
	cfg := &r.b.cfg
	srv := cfg.Server

	// A fresh session ID every attempt: the server invalidates one when its
	// socket closes, and reusing it answers "Invalid session".
	id := ubersdr.NewSessionID()
	r.set(RxConnecting, "")
	res, err := srv.Check(ctx, id)
	if r.b.stopped() {
		return 0, false
	}
	if err != nil {
		r.set(RxError, err.Error())
		r.logf("%v", err)
		return cfg.RetryDelay, true
	}
	if !res.Allowed {
		reason := res.Refusal(srv.Password != "")
		r.set(RxRefused, reason)
		r.logf("connection refused: %s", reason)
		return cfg.RefusedDelay, true
	}

	conn, err := srv.DialIQ(ctx, id, w.freq, w.khz, cfg.MinMargin)
	if r.b.stopped() {
		if conn != nil {
			conn.Close()
		}
		return 0, false
	}
	if err != nil {
		r.set(RxError, err.Error())
		r.logf("%v", err)
		return cfg.RetryDelay, true
	}
	r.logf("connected at %s, %.6f MHz", ubersdr.ModeForKHz(w.khz), float64(w.freq)/1e6)
	why, err := r.stream(conn, w)
	conn.Close()
	switch why {
	case endStopped:
		return 0, false
	case endDisabled:
		r.logf("disconnected, the client no longer wants this DDC")
		return 0, true
	case endRateChange:
		return cfg.ReconnectDelay, true
	default:
		msg := "connection closed"
		if err != nil {
			msg = err.Error()
		}
		r.set(RxError, msg)
		r.logf("%s; reconnecting", msg)
		if errors.Is(err, ubersdr.ErrLegacyServer) {
			return cfg.RefusedDelay, true
		}
		return cfg.ReconnectDelay, true
	}
}

type streamEnd int

const (
	endClosed streamEnd = iota
	endStopped
	endDisabled
	endRateChange
)

// stream services one socket until it ends or has to be replaced.
func (r *receiver) stream(conn *ubersdr.IQConn, w want) (streamEnd, error) {
	type result struct {
		m   ubersdr.Message
		err error
	}
	msgs := make(chan result, 64)
	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			m, err := conn.ReadIdle(r.b.cfg.IdleTimeout)
			select {
			case msgs <- result{m, err}:
			case <-done:
				return
			}
			if err != nil {
				return
			}
		}
	}()

	r.set(RxStreaming, "")
	r.pending = r.pending[:0]
	khz, sentFreq := w.khz, w.freq
	lastRate := 0
	lastMode, lastModeRate := "", 0
	var lastBad time.Time

	for {
		select {
		case <-r.b.stop:
			return endStopped, nil

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
			if now.freq != sentFreq {
				if err := conn.Tune(now.freq, khz); err != nil {
					return endClosed, err
				}
				sentFreq = now.freq
			}

		case res := <-msgs:
			if res.err != nil {
				return endClosed, res.err
			}
			m := res.m
			if m.WireBytes > 0 {
				// Counted before the decode, because this is what the link
				// carried.
				r.logBytes.Add(uint64(m.WireBytes))
				r.uiBytes.Add(uint64(m.WireBytes))
			}
			switch m.Kind {
			case ubersdr.MsgIQ:
				// A rate change UNDER a live socket would silently reframe what
				// the client is sent, so it is a reconnect.
				if lastRate != 0 && m.SampleRate != lastRate {
					r.logf("server sample rate changed %d -> %d, reconnecting", lastRate, m.SampleRate)
					return endRateChange, nil
				}
				lastRate = m.SampleRate
				r.accept(m.Samples, m.SampleRate)
			case ubersdr.MsgStatus:
				// Sent after every tune; logged only when it changes.
				if m.Mode != lastMode || m.SampleRate != lastModeRate {
					lastMode, lastModeRate = m.Mode, m.SampleRate
					r.mu.Lock()
					r.mode = m.Mode
					r.mu.Unlock()
					r.logf("server serving %s at %d Hz", m.Mode, m.SampleRate)
					if want := ubersdr.ModeForKHz(khz); m.Mode != "" && m.Mode != want {
						r.logf("WARNING asked for %s but the server is serving %s", want, m.Mode)
					}
				}
			case ubersdr.MsgError:
				r.logf("server: %s", m.Text)
				r.mu.Lock()
				r.detail = m.Text
				r.mu.Unlock()
			case ubersdr.MsgText:
				r.logf("server: %s", m.Text)
			case ubersdr.MsgBad:
				if time.Since(lastBad) >= time.Second {
					lastBad = time.Now()
					r.logf("decode: %s", m.Text)
				}
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
