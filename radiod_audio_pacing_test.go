package main

import (
	"testing"
	"time"
)

// The audio command pacer exists because radiod drops, silently, any command
// that arrives while the previous one for that channel is still queued.  What it
// has to guarantee is a floor on the gap between two commands to one channel,
// and no floor at all between channels or on the first command to any of them --
// session creation happens under the session manager's lock, so a pacer that
// delayed a create would serialise every connection.

func TestAudioPacerSpacesOneChannel(t *testing.T) {
	p := &audioCommandPacer{minGap: 30 * time.Millisecond}

	start := time.Now()
	p.reserve(7)
	if d := time.Since(start); d > 5*time.Millisecond {
		t.Errorf("first command to a channel waited %v; it has nothing to wait for", d)
	}

	p.reserve(7)
	if d := time.Since(start); d < p.minGap {
		t.Errorf("second command went out %v after the first, inside the %v gap radiod needs", d, p.minGap)
	}
}

func TestAudioPacerDoesNotSpaceAcrossChannels(t *testing.T) {
	// radiod's queue is per channel, so one channel's traffic must not hold up
	// another's -- the keepalive sweep walks every live session in a loop.
	p := &audioCommandPacer{minGap: 50 * time.Millisecond}

	start := time.Now()
	for ssrc := uint32(1); ssrc <= 20; ssrc++ {
		p.reserve(ssrc)
	}
	if d := time.Since(start); d > 20*time.Millisecond {
		t.Errorf("20 different channels took %v; they were paced against each other", d)
	}
}

func TestAudioPacerForgetsTornDownChannels(t *testing.T) {
	p := &audioCommandPacer{minGap: 30 * time.Millisecond}
	p.reserve(7)
	p.Forget(7)

	if _, ok := p.lastSent[7]; ok {
		t.Fatal("Forget left the entry behind; the map grows once per session served")
	}
	// And a channel reusing that SSRC is not made to wait for its predecessor.
	start := time.Now()
	p.reserve(7)
	if d := time.Since(start); d > 5*time.Millisecond {
		t.Errorf("a recreated channel waited %v on the entry Forget should have dropped", d)
	}
}

func TestAudioPacerSweepsIdleChannels(t *testing.T) {
	// The backstop for channels that never reached Forget.
	p := &audioCommandPacer{minGap: time.Millisecond}
	p.lastSent = map[uint32]time.Time{
		1: time.Now().Add(-2 * audioPacerMaxIdle),
		2: time.Now(),
	}
	p.reserve(99) // an unseen SSRC is what triggers the sweep

	if _, ok := p.lastSent[1]; ok {
		t.Error("an entry idle for twice the maximum survived the sweep")
	}
	if _, ok := p.lastSent[2]; !ok {
		t.Error("the sweep dropped a channel that was commanded a moment ago")
	}
}
