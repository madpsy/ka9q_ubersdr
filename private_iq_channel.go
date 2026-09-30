package main

// private_iq_channel.go — a radiod channel an audio extension owns.
//
// An audio extension normally hears whatever its listener hears: the extension
// tap is fed from the listener's own session. That is no use to a decoder that
// needs IQ wider than the listener's mode, and switching the listener into that
// mode would send them the IQ as well — a lot of bandwidth, and wide IQ is not
// even public by default. So an extension that declares PrivateIQ in its
// AudioExtensionInfo is given a channel of its own instead:
//
//   - an internal session, built the way the decoders build theirs: in
//     sm.sessions (which is what keepaliveAudioChannels refreshes) and in
//     ssrcToSession (which is how routeAudio finds it), with no ClientIP and no
//     UserSessionID, so every user count, list, limit, event and activity log
//     passes it by. It must not carry the owner's UserSessionID: the manager
//     keeps one audio session per UUID and would take it for a reconnection
//     and destroy the owner's real one, and findAudioSessionByUserID could
//     return it in place of the owner's.
//
//   - created on the owner's behalf, so the checks that an internal session
//     skips are made here against the owner's credentials: the session
//     creation rate limit, the radiod channel cap, and blocked ranges. Its
//     blockExempt is the owner's rather than an internal session's automatic
//     exemption, which is what makes routeAudio zero its IQ inside a blocked
//     range exactly as it would the owner's own IQ.
//
//   - kept on the owner's dial frequency. UpdateSessionChannel tells the owner's
//     retuneFollower of every retune; followRetune records the frequency and
//     wakes retuneLoop, which sends only the latest, confirms from radiod's
//     channel status that it landed, and sends it again if not: radiod keeps
//     one pending command per channel and drops anything that arrives while
//     it is pending, so a burst of retunes (a VFO being scrolled) loses all
//     but the first otherwise.
//
//   - silent while it moves. Until radiod has confirmed the new frequency and
//     a short settling tail has passed, the relay passes the extension nothing:
//     the blocks in between are still the old frequency's, and when that was
//     inside a blocked range they must not reach the extension at all. Once
//     settled, onSettled tells the manager, which tells the extension (Retune)
//     and the listener's client.
//
// close() is the one teardown: it stops the retuner, lets go of the owner's
// retunes and destroys the session, which terminates the radiod channel. It is
// idempotent, since the manager reaches it from detach, disconnect, a crash
// and the end of the owner's session.

import (
	"fmt"
	"log"
	"math"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"
)

// Timing of the retune confirmation. Variables rather than constants so tests
// can run the same logic in milliseconds.
var (
	// privateIQPollInterval is how often channel status is checked for the
	// answer to a retune.
	privateIQPollInterval = 20 * time.Millisecond

	// privateIQConfirmTimeout is how long a retune waits for radiod to report
	// the new frequency before it is sent again.
	privateIQConfirmTimeout = 600 * time.Millisecond

	// privateIQMaxAttempts bounds the resends. If radiod never reports the new
	// frequency the status path is broken rather than the command lost, and
	// holding the extension's audio back for ever would help nothing.
	privateIQMaxAttempts = 3

	// privateIQSettleTail is how long after the confirmation the relay stays
	// shut, as retuneSettleTail is for a listener: radiod answers from the
	// command decode, before the demodulator has rebuilt its filter.
	privateIQSettleTail = retuneSettleTail
)

// privateIQFrequencyTolerance is how far radiod's reported frequency may be
// from the one asked for and still count as the answer.
const privateIQFrequencyTolerance = 10.0 // Hz

// privateIQChannel is a radiod channel owned by one audio extension instance.
type privateIQChannel struct {
	sm      *SessionManager
	owner   *Session
	session *Session

	// wanted is the frequency the channel should be on: the owner's, as of
	// its latest retune. kick (capacity 1) wakes retuneLoop to look at it.
	wanted atomic.Uint64
	kick   chan struct{}

	// paused holds the relay shut while the channel is moving.
	paused atomic.Bool

	// onSettled is called from retuneLoop each time the channel has settled
	// on a new frequency. blocked says whether the owner may not be served
	// that frequency, in which case the relay is passing silence.
	onSettled func(frequency uint64, blocked bool)

	// followerGen is the owner's retune-follower installation this channel
	// holds, 0 until start. Written once, by start, before any goroutine
	// that could call close exists.
	followerGen uint64

	stop      chan struct{}
	closeOnce sync.Once
	wg        sync.WaitGroup
}

// recoverPrivateIQ is deferred at the top of every goroutine this file starts,
// and around every call into an extension: an unrecovered panic in any
// goroutine ends the whole server, and nothing here is worth that.
func recoverPrivateIQ(where string) {
	if r := recover(); r != nil {
		log.Printf("Private channel: panic in %s recovered: %v\n%s", where, r, debug.Stack())
	}
}

// newPrivateIQChannel creates a channel in the given IQ mode on the owner's
// current frequency, for the named extension. It is not following the owner
// until start is called.
func (sm *SessionManager) newPrivateIQChannel(owner *Session, extensionName, mode string) (*privateIQChannel, error) {
	if !isIQModeName(mode) {
		return nil, fmt.Errorf("private channel mode %q is not an IQ mode", mode)
	}

	owner.mu.RLock()
	frequency := owner.Frequency
	owner.mu.RUnlock()
	// Fixed for the life of the owner's session.
	clientIP, userSessionID, password := owner.ClientIP, owner.UserSessionID, owner.BypassPassword

	sm.mu.Lock()
	defer sm.mu.Unlock()

	// The checks an internal session skips, made against the owner: this
	// channel exists because a listener asked for it. A distinct kind, so
	// attaching does not spend the listener's audio or spectrum allowance.
	if err := sm.checkSessionCreateRate("extension", userSessionID, clientIP, password); err != nil {
		return nil, err
	}
	if sm.audioBlockedFor(frequency, clientIP, password) {
		return nil, fmt.Errorf("mode '%s' is not available on this frequency", mode)
	}
	if clientIP != "" {
		if currentChannels, full := sm.radiodChannelCapReachedLocked(); full {
			return nil, fmt.Errorf("radiod channel limit reached (%d/%d); try again later",
				currentChannels, maxRadiodChannels)
		}
	}

	ssrc, err := allocateSSRC(func(candidate uint32) bool {
		_, exists := sm.ssrcToSession[candidate]
		return exists
	})
	if err != nil {
		return nil, err
	}

	owner8 := userSessionID
	if len(owner8) > 8 {
		owner8 = owner8[:8]
	}
	if owner8 == "" {
		owner8 = fmt.Sprintf("%05d", ssrc)
	}
	sessionID := fmt.Sprintf("ext-%s-%s-%05d", extensionName, owner8, ssrc)
	channelName := fmt.Sprintf("ext-%s-%s", extensionName, owner8)
	sampleRate := sm.config.Audio.GetSampleRateForMode(mode)

	// Bandwidth 0: the IQ presets carry their own filter, as for a listener's
	// wide IQ channel.
	if err := sm.radiod.CreateChannelWithBandwidth(channelName, frequency, translateModeForRadiod(mode), sampleRate, ssrc, 0); err != nil {
		return nil, fmt.Errorf("failed to create radiod channel: %w", err)
	}

	now := time.Now()
	session := &Session{
		ID:          sessionID,
		ChannelName: channelName,
		SSRC:        ssrc,
		Frequency:   frequency,
		Mode:        mode,
		SampleRate:  sampleRate,
		Channels:    2,
		CreatedAt:   now,
		LastActive:  now,
		// Nothing reads AudioChan: the extension tap is this session's only
		// consumer. A nil channel makes routeAudio's send fall straight
		// through to its default rather than fill a buffer nobody drains.
		AudioChan:         nil,
		Done:              make(chan struct{}),
		AudioGateMinSNR:   audioGateDisabled,
		AudioGateMinPower: audioGateDisabled,
		VisitedBands:      make(map[string]bool),
		VisitedModes:      make(map[string]bool),
		// The owner's, not the automatic exemption of an internal session:
		// routeAudio then zeroes this IQ inside a blocked range just as it
		// would the owner's own.
		blockExempt: owner.blockExempt,
	}
	sm.sessions[sessionID] = session
	sm.ssrcToSession[ssrc] = session

	log.Printf("Private %s channel created for %s: %s (SSRC 0x%08x, %d Hz, owner session %s)",
		mode, extensionName, channelName, ssrc, frequency, owner.ID)

	p := &privateIQChannel{
		sm:      sm,
		owner:   owner,
		session: session,
		kick:    make(chan struct{}, 1),
		stop:    make(chan struct{}),
	}
	p.wanted.Store(frequency)
	return p, nil
}

// start begins following the owner's retunes. onSettled may be nil.
func (p *privateIQChannel) start(onSettled func(frequency uint64, blocked bool)) {
	p.onSettled = onSettled
	p.wg.Add(1)
	go p.retuneLoop()
	p.followerGen = p.owner.setRetuneFollower(p)
	// The owner may have been retuned between creation and here, with nobody
	// yet listening; catch up. A no-op if it was not.
	p.owner.mu.RLock()
	frequency := p.owner.Frequency
	p.owner.mu.RUnlock()
	p.followRetune(frequency)
}

// followRetune is the owner's retuneFollower. It records the frequency and
// wakes retuneLoop, and never blocks: it runs on whichever goroutine retuned
// the owner.
func (p *privateIQChannel) followRetune(frequency uint64) {
	p.wanted.Store(frequency)
	select {
	case p.kick <- struct{}{}:
	default:
		// Already woken; it reads wanted afresh.
	}
}

// relay forwards the extension tap to the extension, except while the channel
// is moving. It closes out when tap is closed, which is how the extension is
// told the audio has ended. Must be running before audio is expected.
func (p *privateIQChannel) relay(tap <-chan AudioSample, out chan<- AudioSample) {
	// Deferred first so it runs last, after any recovery: the extension is
	// told its audio has ended however the relay ends. Only the relay ever
	// sends on or closes out.
	defer close(out)
	defer recoverPrivateIQ("relay")
	for sample := range tap {
		if p.paused.Load() {
			continue
		}
		select {
		case out <- sample:
		default:
			// The extension is not keeping up; drop, as the tap itself does.
		}
	}
}

// retuneLoop keeps the channel on the owner's frequency.
func (p *privateIQChannel) retuneLoop() {
	// wg.Done deferred first so it runs last: close waits on it, and must not
	// wait for ever because the loop ended in a panic.
	defer p.wg.Done()
	defer recoverPrivateIQ("retune loop")

	p.session.mu.RLock()
	applied := p.session.Frequency
	p.session.mu.RUnlock()

	for {
		select {
		case <-p.stop:
			return
		case <-p.kick:
		}
		if !p.catchUp(&applied) {
			return
		}
	}
}

// catchUp moves the channel to the owner's latest frequency, following any
// further retunes that arrive meanwhile, and reports false once the channel
// is being closed. A panic here is recovered and the pass abandoned rather
// than the loop: the channel carries on following the next retune, and its
// audio is released rather than held back for ever.
func (p *privateIQChannel) catchUp(applied *uint64) (keepGoing bool) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("Private channel %s: panic while retuning recovered: %v\n%s",
				p.session.ChannelName, r, debug.Stack())
			p.paused.Store(false)
			keepGoing = true
		}
	}()

	for {
		want := p.wanted.Load()
		if want == 0 || want == *applied {
			return true
		}
		p.paused.Store(true)
		if !p.moveTo(want) {
			return false // stopped
		}
		*applied = want
		if p.wanted.Load() != *applied {
			continue // retuned again meanwhile: go straight on
		}
		if !p.sleep(privateIQSettleTail) {
			return false
		}
		if p.wanted.Load() != *applied {
			continue
		}
		p.paused.Store(false)
		blocked := p.sm.audioBlockedFor(*applied, p.owner.ClientIP, p.owner.BypassPassword)
		p.settled(*applied, blocked)
		return true
	}
}

// settled calls onSettled, which reaches into the extension (Retune), under
// its own recovery: a fault there must not stop the channel following the
// listener. onSettled must never call close -- close waits for this loop.
func (p *privateIQChannel) settled(frequency uint64, blocked bool) {
	if p.onSettled == nil {
		return
	}
	defer recoverPrivateIQ("settle callback")
	p.onSettled(frequency, blocked)
}

// moveTo retunes the channel and waits for radiod to confirm it, sending the
// command again if the confirmation does not come. It returns early, true, if
// the owner is retuned again meanwhile: the caller moves on to that. It
// returns false only if the channel is being closed.
func (p *privateIQChannel) moveTo(frequency uint64) bool {
	for attempt := 1; ; attempt++ {
		sentAt := time.Now()
		// Through UpdateSessionChannel, like any retune, so the session's own
		// Frequency (which routeAudio's blocked-range check reads) moves with
		// the radiod channel. This session has no follower of its own.
		if err := p.sm.UpdateSessionChannel(p.session.ID, frequency, "", 0, 0, false, nil); err != nil {
			log.Printf("Private channel %s: retune to %d Hz failed: %v", p.session.ChannelName, frequency, err)
		}

		deadline := sentAt.Add(privateIQConfirmTimeout)
		for time.Now().Before(deadline) {
			if !p.sleep(privateIQPollInterval) {
				return false
			}
			if p.wanted.Load() != frequency {
				return true
			}
			if p.confirmed(frequency, sentAt) {
				return true
			}
		}

		if attempt >= privateIQMaxAttempts {
			log.Printf("Private channel %s: radiod never confirmed %d Hz after %d attempts; carrying on",
				p.session.ChannelName, frequency, attempt)
			return true
		}
		log.Printf("Private channel %s: no confirmation of %d Hz from radiod, sending again",
			p.session.ChannelName, frequency)
	}
}

// confirmed reports whether radiod has answered since sentAt with the channel
// on frequency. radiod answers every command it applies with a status packet;
// one from before the command, or on another frequency, is not the answer.
func (p *privateIQChannel) confirmed(frequency uint64, sentAt time.Time) bool {
	cs := p.sm.radiod.GetChannelStatus(p.session.SSRC)
	if cs == nil || !cs.LastUpdate.After(sentAt) {
		return false
	}
	return math.Abs(cs.RadioFrequency-float64(frequency)) <= privateIQFrequencyTolerance
}

// sleep waits d, and reports false if the channel was closed meanwhile.
func (p *privateIQChannel) sleep(d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-p.stop:
		return false
	case <-t.C:
		return true
	}
}

// close stops following the owner and destroys the channel. Idempotent. The
// extension tap is not closed here: the manager owns it, and closing it is
// what ends the relay.
func (p *privateIQChannel) close() {
	p.closeOnce.Do(func() {
		close(p.stop)
		p.owner.clearRetuneFollower(p.followerGen)
		p.wg.Wait()
		if err := p.sm.DestroySession(p.session.ID); err != nil {
			log.Printf("Private channel %s: %v", p.session.ChannelName, err)
		}
	})
}
