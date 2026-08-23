package main

import (
	"sync"
	"time"
)

// Pacing for audio channel commands.
//
// The same constraint radiod_spectrum_pacing.go is built around, on the other
// half of the traffic.  radiod holds ONE pending command per channel and drops
// anything that arrives while that slot is occupied -- silently, with no error,
// no reply and nothing logged (ka9q-radio src/radio_status.c: "An entry already
// exists. Drop ours, until we make this a queue").  The channel thread empties
// the slot once per output block, 20 ms at this receiver's 50 Hz block rate.
//
// Audio channels get commands from three unsynchronised places: the client's
// tunes, the keepalive sweep that refreshes every channel's lifetime every three
// seconds, and the squelch and AGC handlers.  Two of those landing in the same
// block means one is thrown away, and which one is a coin toss -- a tune lost
// that way leaves radiod on the previous mode while every session record says
// otherwise, which is heard as the wrong mode and never as an error.  Rare per
// command, but a VFO scan issues several a second and runs for minutes.
//
// So commands to one channel are spaced out far enough that radiod has taken the
// previous one.  Unlike the spectrum pacer this never coalesces: two commands to
// an audio channel are two different intentions, and a keepalive is not a
// substitute for a tune.  It delays, and only ever by less than a block.
//
// This bounds what WE send.  It cannot help against another process sharing the
// same radiod, which is a reason to keep the number of commands per retune to
// one -- see buildUpdateCommand.

// audioCommandMinGap is the shortest interval between two commands to one audio
// channel.  Slightly over one 20 ms radiod block, so the previous command has
// been taken off the queue before the next one lands.
const audioCommandMinGap = 25 * time.Millisecond

// audioPacerMaxIdle is how long a channel's entry outlives its last command
// before being swept.  Forget drops entries as channels are torn down; this only
// catches anything that never got that far.
const audioPacerMaxIdle = 5 * time.Minute

// audioCommandPacer records when each audio channel was last commanded.
type audioCommandPacer struct {
	mu       sync.Mutex
	minGap   time.Duration
	lastSent map[uint32]time.Time
}

// reserve blocks until it is safe to send another command to ssrc, and claims
// that slot before returning.  The wait is bounded by minGap.
func (p *audioCommandPacer) reserve(ssrc uint32) {
	for {
		p.mu.Lock()
		if p.lastSent == nil {
			p.lastSent = make(map[uint32]time.Time)
		}
		now := time.Now()
		if _, known := p.lastSent[ssrc]; !known {
			// Only when a channel first appears, so the sweep costs one pass
			// over a map the size of the session count.
			p.sweepLocked(now)
		}
		// An unknown SSRC has the zero time here, which is long enough ago.
		wait := p.minGap - now.Sub(p.lastSent[ssrc])
		if wait <= 0 {
			p.lastSent[ssrc] = now
			p.mu.Unlock()
			return
		}
		p.mu.Unlock()
		time.Sleep(wait)
	}
}

// Forget drops a channel's entry.  Called on teardown so a long-lived receiver
// does not accumulate one per session it has ever served.
func (p *audioCommandPacer) Forget(ssrc uint32) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.lastSent, ssrc)
}

func (p *audioCommandPacer) sweepLocked(now time.Time) {
	for ssrc, at := range p.lastSent {
		if now.Sub(at) > audioPacerMaxIdle {
			delete(p.lastSent, ssrc)
		}
	}
}

// audioPacer returns the controller's audio command pacer, built on first use so
// a zero-value RadiodController (as the tests build) still works.
func (rc *RadiodController) audioPacer() *audioCommandPacer {
	rc.audioPacerOnce.Do(func() {
		rc.audioCmdPacer = &audioCommandPacer{minGap: audioCommandMinGap}
	})
	return rc.audioCmdPacer
}

// sendAudioCommand paces a command to an audio channel and sends it.
//
// Every command aimed at an audio channel goes through here, teardown excepted:
// a terminate is not worth delaying, and a lost one is covered by the LIFETIME
// tag every command carries.
func (rc *RadiodController) sendAudioCommand(ssrc uint32, cmd []byte) error {
	rc.audioPacer().reserve(ssrc)
	return rc.sendCommand(cmd)
}
