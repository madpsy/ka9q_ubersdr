package main

// Simultaneous VFOs: one listener hearing up to server.audio_vfos channels at
// once.
//
// VFO 0 is the listener's ordinary audio session -- the "primary" -- and
// nothing about it changes.  VFOs 1..N-1 are secondary audio sessions on the
// same user_session_id, and they are deliberately a lower class of session:
//
//   - They exist only alongside a live primary.  They are refused without one,
//     and reapOrphanedSecondaries tears them down once the primary has been gone
//     for secondaryOrphanGrace.  There is no cascade in DestroySession, because
//     a primary *reconnecting* goes through DestroySession on the old primary,
//     and that must not take the secondaries down with it.
//   - They are not users.  The primary already holds the UUID's slot against
//     max_sessions and max_sessions_ip, so a secondary is not counted again, is
//     not logged or announced as a connect, and is left out of every listener
//     list and every "the audio session of this UUID" lookup.
//   - They are never IQ and never get the DSP insert.  The client mixes them
//     into its main audio context at the main channel's rate, so anything but
//     a demodulated mono stream has nowhere to go.  They use whichever audio
//     format the client's main audio does (opus or pcm-zstd), so a listener
//     recording losslessly gets lossless secondaries too.
//   - They are never pinged, so the idle sweep skips them; their lifetime is
//     the primary's.

import (
	"errors"
	"fmt"
	"log"
	"strconv"
	"time"
)

// secondaryOrphanGrace is how long secondaries outlive their primary.  Long
// enough to ride out the primary reconnecting (a network blip, a mode change
// that recreates the socket) without the secondaries being torn down and
// rebuilt behind it; short enough that a closed tab does not hold radiod
// channels for long.  A var so tests can see it, though they pass a clock to
// reapOrphanedSecondariesAt rather than change it.
var secondaryOrphanGrace = 10 * time.Second

// errSecondaryNoPrimary is the refusal a client should treat as "try again
// once the main audio is back", not as a hard failure.
var errSecondaryNoPrimary = errors.New("No primary audio session for this user; connect the main VFO first")

// parseAudioVFOParam reads the vfo query parameter of /ws: absent is 0, the
// primary.  Anything that is not a non-negative integer is refused rather than
// read as 0, since a client asking for a secondary and silently getting a
// replacement primary would tear down its own main audio.
func parseAudioVFOParam(v string) (int, error) {
	if v == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("Invalid vfo '%s'", v)
	}
	return n, nil
}

// secondaryAudioConnectError is what a secondary is refused for by its own
// connect parameters alone, before any session state is looked at.  nil for
// the primary, which keeps every option it has always had.
func secondaryAudioConnectError(vfo int, mode string) error {
	if vfo == 0 {
		return nil
	}
	if isIQModeName(mode) {
		return fmt.Errorf("Mode '%s' is not available on an additional VFO", mode)
	}
	return nil
}

// checkSecondaryAudioLocked is the session-state half of admitting a secondary:
// the index must be within this listener's allowance and the UUID must have a
// live primary.  Caller holds sm.mu.
func (sm *SessionManager) checkSecondaryAudioLocked(mode, clientIP, userSessionID, password string, vfo int) error {
	if userSessionID == "" {
		return fmt.Errorf("Additional VFOs require a user_session_id")
	}
	if limit := sm.config.Server.AudioVFOLimit(clientIP, password); vfo >= limit {
		return fmt.Errorf("This receiver allows %d VFOs", limit)
	}
	if isIQModeName(mode) {
		return fmt.Errorf("Mode '%s' is not available on an additional VFO", mode)
	}
	if _, ok := sm.uuidAudioSessions[userSessionID]; !ok {
		return errSecondaryNoPrimary
	}
	return nil
}

// CreateSecondaryAudioSession creates audio session vfo (1..N-1) for a listener
// who already has a primary.  See the top of this file.
func (sm *SessionManager) CreateSecondaryAudioSession(frequency uint64, mode string, bandwidth int, sourceIP, clientIP, userSessionID, password string, vfo int) (*Session, error) {
	if vfo < 1 {
		return nil, fmt.Errorf("secondary VFO index must be 1 or more, got %d", vfo)
	}
	return sm.createAudioSession(frequency, mode, bandwidth, sourceIP, clientIP, userSessionID, password, vfo)
}

// reapOrphanedSecondaries destroys the secondaries of any UUID that has had no
// primary for secondaryOrphanGrace.  Run from cleanupLoop.
func (sm *SessionManager) reapOrphanedSecondaries() {
	sm.reapOrphanedSecondariesAt(time.Now())
}

// reapOrphanedSecondariesAt is reapOrphanedSecondaries against a given clock.
//
// The orphan clock starts the first time a pass finds the UUID without a
// primary, not when the primary actually went, so the real grace is up to one
// cleanupLoop tick longer than secondaryOrphanGrace.  That costs nothing and
// saves hooking DestroySession for it.
func (sm *SessionManager) reapOrphanedSecondariesAt(now time.Time) {
	var toDestroy []string

	sm.mu.Lock()
	for uuid, byVFO := range sm.uuidSecondaryAudio {
		if _, ok := sm.uuidAudioSessions[uuid]; ok {
			delete(sm.secondaryOrphanSince, uuid)
			continue
		}
		since, seen := sm.secondaryOrphanSince[uuid]
		if !seen {
			sm.secondaryOrphanSince[uuid] = now
			continue
		}
		if now.Sub(since) < secondaryOrphanGrace {
			continue
		}
		for _, id := range byVFO {
			toDestroy = append(toDestroy, id)
		}
	}
	sm.mu.Unlock()

	for _, id := range toDestroy {
		log.Printf("Tearing down secondary audio session %s: its user has had no primary for over %v", id, secondaryOrphanGrace)
		_ = sm.DestroySession(id)
	}
}
