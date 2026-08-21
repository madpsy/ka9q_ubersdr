package main

import (
	"log"
	"sync"
	"time"
)

// Pacing for spectrum retune commands.
//
// radiod takes one command per channel per block off its queue — 20 ms with the
// 50 Hz block rate this receiver runs at — and anything that arrives while the
// queue is still occupied is dropped where it lands: no error, no reply, and
// nothing logged even at the highest verbosity.  The poll that fetches each
// frame of bins goes through that same queue, so retunes and polls compete for
// the same slots.
//
// A drag that emits one command per pointer event asks for two to four times
// what radiod will take, so some of them are lost — and the one that decides
// where the view ends up is the last one, which is the most likely to arrive
// while the queue is still full.  The watchdog in user_spectrum.go repairs that
// afterwards; this keeps it from happening in the first place, for every client,
// including the ones we do not ship.
//
// Only the rate is capped, never the destination: within a burst the newest
// request replaces the pending one and a trailing send always follows, so where
// a gesture finishes is where the channel ends up.

// spectrumUpdateMinGap is the shortest interval between two retune commands for
// one channel.  Two radiod blocks, which leaves the other half of its command
// capacity for the polls that actually fetch the bins.
const spectrumUpdateMinGap = 40 * time.Millisecond

// spectrumPacerMaxIdle is how long a channel's pacing entry outlives its last
// command before being dropped.  TerminateChannel removes entries as channels
// go away; this only catches anything that never got that far.
const spectrumPacerMaxIdle = 5 * time.Minute

// spectrumUpdate is one requested spectrum geometry, as it goes on the wire.
type spectrumUpdate struct {
	frequency    uint64
	binBandwidth float64
	binCount     int
	sendBinCount bool
}

// merge folds a newer request into a pending one.
//
// The newer values win, but only where it has any: zero means "leave this
// alone" on the wire, so a field the newer request left empty keeps whatever
// the older one asked for.  Coalescing may drop commands; it may not drop
// parameters.  A zoom carries a bin count and a pan does not, so a pan
// coalesced on top of a zoom would otherwise swallow the new bin count and
// leave radiod rebuilding nothing.
func (u *spectrumUpdate) merge(next spectrumUpdate) {
	prev := *u
	*u = next
	u.sendBinCount = prev.sendBinCount || next.sendBinCount
	if next.frequency == 0 {
		u.frequency = prev.frequency
	}
	if next.binBandwidth == 0 {
		u.binBandwidth = prev.binBandwidth
	}
	if next.binCount == 0 {
		u.binCount = prev.binCount
	}
}

type spectrumPacerEntry struct {
	lastSent time.Time
	pending  *spectrumUpdate
	timer    *time.Timer
}

// spectrumUpdatePacer rate-limits retune commands per channel, coalescing
// whatever arrives inside the gap into a single trailing send.
type spectrumUpdatePacer struct {
	mu      sync.Mutex
	minGap  time.Duration
	entries map[uint32]*spectrumPacerEntry
	send    func(ssrc uint32, u spectrumUpdate) error
}

func newSpectrumUpdatePacer(minGap time.Duration, send func(ssrc uint32, u spectrumUpdate) error) *spectrumUpdatePacer {
	return &spectrumUpdatePacer{
		minGap:  minGap,
		entries: make(map[uint32]*spectrumPacerEntry),
		send:    send,
	}
}

// Submit sends the update now if this channel has been quiet for long enough,
// and otherwise holds it for a trailing send.  The error returned is only ever
// from an immediate send; a deferred one reports its own failures.
func (p *spectrumUpdatePacer) Submit(ssrc uint32, u spectrumUpdate) error {
	p.mu.Lock()

	entry := p.entries[ssrc]
	if entry == nil {
		p.sweepLocked(time.Now())
		entry = &spectrumPacerEntry{}
		p.entries[ssrc] = entry
	}

	// A pending update is older than this one but newer than anything already
	// sent, so it cannot be jumped over: merging keeps the channel's commands in
	// the order they were asked for.
	if entry.pending != nil {
		entry.pending.merge(u)
		p.mu.Unlock()
		return nil
	}

	now := time.Now()
	if wait := p.minGap - now.Sub(entry.lastSent); wait > 0 {
		held := u
		entry.pending = &held
		entry.timer = time.AfterFunc(wait, func() { p.flush(ssrc) })
		p.mu.Unlock()
		return nil
	}

	entry.lastSent = now
	p.mu.Unlock()
	return p.send(ssrc, u)
}

// Cancel drops anything held for a channel.  Called when the channel goes away:
// a trailing send that arrived after the channel was terminated would not be
// ignored — radiod creates a channel for any command carrying parameters, so it
// would raise the dead.
func (p *spectrumUpdatePacer) Cancel(ssrc uint32) {
	p.mu.Lock()
	defer p.mu.Unlock()
	entry := p.entries[ssrc]
	if entry == nil {
		return
	}
	if entry.timer != nil {
		entry.timer.Stop()
	}
	delete(p.entries, ssrc)
}

func (p *spectrumUpdatePacer) flush(ssrc uint32) {
	p.mu.Lock()
	entry := p.entries[ssrc]
	if entry == nil {
		p.mu.Unlock()
		return
	}
	entry.timer = nil
	held := entry.pending
	entry.pending = nil
	if held == nil {
		p.mu.Unlock()
		return
	}
	entry.lastSent = time.Now()
	p.mu.Unlock()

	if err := p.send(ssrc, *held); err != nil {
		log.Printf("ERROR: Failed to send coalesced spectrum update for SSRC 0x%08x: %v", ssrc, err)
	}
}

// sweepLocked drops entries for channels that have been quiet long enough that
// they are almost certainly gone.  Called only when a new channel appears, so
// it costs one pass over a map the size of the spectrum session count.
func (p *spectrumUpdatePacer) sweepLocked(now time.Time) {
	for ssrc, entry := range p.entries {
		if entry.pending == nil && entry.timer == nil && now.Sub(entry.lastSent) > spectrumPacerMaxIdle {
			delete(p.entries, ssrc)
		}
	}
}

// spectrumPacer returns the controller's pacer, creating it on first use so a
// zero-value RadiodController (as the tests build) still works.
func (rc *RadiodController) spectrumPacer() *spectrumUpdatePacer {
	rc.pacerOnce.Do(func() {
		rc.pacer = newSpectrumUpdatePacer(spectrumUpdateMinGap, rc.sendSpectrumUpdate)
	})
	return rc.pacer
}

// sendSpectrumUpdate puts one retune command on the wire.
func (rc *RadiodController) sendSpectrumUpdate(ssrc uint32, u spectrumUpdate) error {
	return rc.sendCommand(buildUpdateSpectrumCommand(ssrc, u))
}
