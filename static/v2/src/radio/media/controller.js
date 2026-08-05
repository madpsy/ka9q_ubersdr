// Media Session: OS-level media controls for a live receiver.
//
// Framework-free on purpose — React drives it through MediaSessionContext, and
// everything platform-specific lives in the three modules beside this one:
// support.js decides what has to be playing, httpStream.js is the Android
// anchor, artwork.js and metadata.js are what gets shown.
//
// The rules below are not preferences. Each one is a browser behaviour that
// breaks the feature outright if ignored, and each cost v1 real debugging:
//
//   1. Disabled means metadata = null and playbackState = 'none'. Merely not
//      updating is not enough — the next metadata assignment from anywhere
//      re-associates the page and the widget comes back uninvited.
//
//   2. On the 'stream' anchor, nothing may touch MediaSession until the element
//      reports it is stably playing. Assigning playbackState while it is
//      buffering makes Chrome fire the 'pause' action; the handler answers with
//      play; that buffers; which fires pause. The loop pins a core.
//
//   3. Chrome dismisses the widget when playbackState is 'paused'. So on Chrome
//      the state is always 'playing' and the pause button is wired as a mute
//      toggle — you can still silence it, and the controls survive. Safari and
//      Firefox keep the widget through a pause, so there the state is honest.
//
//   4. Replacing MediaMetadata re-fetches every artwork URL, identical content
//      or not. Hence the dedup, and hence blob: artwork (see artwork.js).

import { logoArtwork, logoNow, photoArtwork, photoPlaceholder, trimPhotoCache } from './artwork.js';
import { buildMetadata, sameMetadata } from './metadata.js';
import { HttpAudioStream } from './httpStream.js';
import { mediaSupport, resolveAnchor } from './support.js';
import { noteExternalActivity } from '../idle.js';

// How often the lock-screen scrubber is refreshed. It shows session time
// remaining, which moves slowly; five seconds is v1's rate and is plenty.
const POSITION_TICK_MS = 5000;
// A session with no time limit still needs a duration for the scrubber to
// exist at all, so it gets a nominal day.
const LIVE_DURATION_SEC = 86400;

const RETRY_DELAY_MS = 3000;
const MAX_RETRIES = 5;

export class MediaSessionController {
    // `host` is everything the controller cannot know by itself:
    //   player        the AudioPlayer, for the bridge anchor and for silencing
    //                 local output while the HTTP stream owns playback
    //   sessionId()   the current user session UUID
    //   step(dir)     what ⏮/⏭ do
    //   setMuted(b)   what play/pause do
    //   position()    { duration, position } in seconds, or null
    //   onStatus(s)   called whenever the panel's view of things changes
    constructor(host) {
        this.host = host;
        this.support = mediaSupport();
        this.enabled = false;
        this.running = false;       // is there an audio session to anchor to
        this.snapshot = { frequency: 0, mode: '', receiver: '', marker: null, lookup: null, photo: '' };
        this.muted = false;
        this.stream = null;
        this.retries = 0;
        this.retryTimer = null;
        this.positionTimer = null;
        this.lastMetadata = null;
        this.error = '';
        // Mirrors of the operator's output settings, so the HTTP stream element
        // can be brought into line the moment it starts playing. Set for real by
        // setOutput before anything is ever anchored.
        this.volume = 1;
        this.sinkId = '';
        // 'auto', or an anchor forced from the panel. Which anchor a browser
        // actually needs is not specified anywhere and moves between releases,
        // so detection is a default rather than a verdict.
        this.override = 'auto';
        // The anchor that is *running*, which is not the same as the one wanted
        // — switching has to tear down what was built, not what was asked for.
        this.activeAnchor = null;
        this.offFlowing = null;
        // Whether audio has actually been heard since this was enabled. Until
        // it has, nothing may be handed to MediaSession at all — see _activate.
        this.activated = false;
    }

    get anchor() {
        return resolveAnchor(this.support, this.override);
    }

    async setAnchorOverride(override) {
        if (override === this.override) return;
        this.override = override;
        if (!this.enabled) {
            this._emit();
            return;
        }
        this._stopAnchor();
        if (this.running) {
            try {
                await this._startAnchor();
            } catch (err) {
                this.error = err.message || String(err);
            }
        }
        // The card has to be pushed again: switching anchors can take it away,
        // and the dedup would otherwise recognise identical text and skip it.
        this.lastMetadata = null;
        this._pushMetadata();
        this._applyPlaybackState();
        this._emit();
    }

    // What the panel renders. One object so a single subscription covers it.
    get status() {
        return {
            available: this.support.available,
            enabled: this.enabled,
            anchor: this.anchor,
            running: this.running,
            // 'off' | 'waiting' | 'active'. 'waiting' is the honest answer while
            // the HTTP anchor is still buffering, or before the receiver starts.
            state: !this.enabled ? 'off' : this._anchorReady() ? 'active' : 'waiting',
            streamMode: this.stream ? this.stream.mode : null,
            // What the OS was actually handed, so "nothing happened" can be
            // told apart from "we never set anything".
            card: this.lastMetadata ? this.lastMetadata.artist : '',
            error: this.error,
        };
    }

    _emit() {
        if (this.host.onStatus) this.host.onStatus(this.status);
    }

    // ON AIR means the OS has actually been handed the card, not merely that
    // the switch is on — which for most of this feature's life was the same
    // claim and the wrong one.
    _anchorReady() {
        return this.activated;
    }

    // ---- lifecycle ---------------------------------------------------------

    async setEnabled(on) {
        if (on === this.enabled) return;
        this.enabled = on;
        this.error = '';
        if (on) await this._start();
        else this._stop();
        this._emit();
    }

    // Called when the receiver starts or stops. The HTTP anchor needs a live
    // WebSocket audio session to attach to — the endpoint 404s without one — so
    // enabling before pressing start defers the anchor rather than failing.
    setRunning(running) {
        if (running === this.running) return;
        this.running = running;
        if (!this.enabled) return;
        if (running) {
            this._start().catch(() => {});
        } else {
            // Audio has stopped, so the browser's session goes with it. Saying
            // so keeps a later tuning change from pushing into nothing.
            this.activated = false;
            this._stopAnchor();
        }
        this._emit();
    }

    async _start() {
        if (!this.support.available) {
            this.error = 'This browser has no Media Session support.';
            return;
        }
        // Warmed, not awaited. The artwork only has to be ready before the
        // metadata is *set*, and _pushMetadata re-pushes when it resolves — but
        // awaiting here would put three image fetches between the operator's
        // click and the anchor's play() call, and a play() that has lost its
        // user activation is refused by the autoplay policy.
        logoArtwork().catch(() => { /* falls back to plain paths */ });

        if (this.running) {
            try {
                await this._startAnchor();
            } catch (err) {
                this.error = err.message || String(err);
            }
        }
        this._installHandlers();

        // The one that actually makes the controls appear.
        //
        // Chrome does not build a media session from a metadata assignment; it
        // builds one from Web Audio that is genuinely playing, and only then
        // does an assignment attach to anything. Setting metadata at the moment
        // the operator flicks the switch therefore lands on nothing — and the
        // dedup below then guarantees it is never set again while the dial sits
        // on one frequency, so the controls never appear at all.
        //
        // So the metadata is (re)pushed on the first buffer that is really
        // played after this point. v1 does exactly this from inside its
        // playback loop (app.js:5612, "Activated with real audio flowing") and
        // re-arms it whenever the AudioContext is rebuilt (app.js:4529, 5389),
        // which is what the player's `flowing` event covers here.
        //
        // Nothing is pushed from here, deliberately. Setting metadata while no
        // audio is playing makes Chrome create a session for something that is
        // not there: the toolbar icon appears and is dropped a second later,
        // and the operator sees the feature flicker and fail. v1 refuses the
        // same case outright — "Media Session enabled — will activate on next
        // audio start" (app.js:13539) — and waits for the playback loop.
        //
        // Arming covers both orders. Enable while audio is already flowing and
        // the next buffer activates within about 20 ms; enable beforehand, or
        // with the receiver stopped, and it activates the moment audio starts.
        this._watchAudio();
        if (this.host.player) this.host.player.armFlowing();
    }

    // Re-pushes everything the OS needs, from a point where the browser has a
    // session to attach it to. The dedup has to be cleared or the identical
    // text would be recognised as already set — which is precisely the state
    // that made this invisible.
    _activate() {
        this.activated = true;
        this.lastMetadata = null;
        this._pushMetadata();
        this._applyPlaybackState();
        // Position state belongs here rather than at enable: it describes a
        // session that has to exist first, and setting it against nothing
        // throws — harmlessly caught, but it was never going to work.
        this._startPositionUpdates();
        // The panel learns everything through _emit, so reaching the state it
        // exists to report has to say so — without this the badge sits on
        // WAITING while the OS is already showing the card.
        this._emit();
    }

    _watchAudio() {
        if (this.offFlowing || !this.host.player) return;
        this.offFlowing = this.host.player.on('flowing', () => {
            if (this.enabled) this._activate();
        });
    }

    _stop() {
        this.activated = false;
        if (this.offFlowing) {
            this.offFlowing();
            this.offFlowing = null;
        }
        this._stopAnchor();
        this._clearHandlers();
        this._stopPositionUpdates();
        this.lastMetadata = null;
        if ('mediaSession' in navigator) {
            try { navigator.mediaSession.metadata = null; } catch (e) { /* ignore */ }
            try { navigator.mediaSession.playbackState = 'none'; } catch (e) { /* ignore */ }
        }
    }

    async _startAnchor() {
        this.activeAnchor = this.anchor;
        if (this.anchor === 'bridge') {
            // The same hidden element the output-device picker uses. Asking for
            // it here rather than building a second one is what lets the two
            // features coexist — in v1 they each made their own, so choosing a
            // device silently switched Media Session off.
            await this.host.player.setAnchorWanted(true);
            return;
        }
        if (this.anchor !== 'stream' || this.stream) return;

        const id = this.host.sessionId();
        if (!id) throw new Error('No session yet.');

        const stream = new HttpAudioStream(id);
        this.stream = stream;

        stream.on('playing', () => {
            if (this.stream !== stream) return;
            this.retries = 0;
            this.error = '';
            // Only now is it safe to speak to MediaSession at all (rule 2), and
            // only now should the context stop playing the same audio itself.
            this.host.player.setExternalPlayback(true);
            this._syncStreamOutput();
            // Same milestone as the player's `flowing` event, reached the other
            // way: audio is now genuinely playing, from the element rather than
            // from the graph.
            this._activate();
            this._emit();
        });

        stream.on('error', (message) => {
            if (this.stream !== stream) return;
            this.error = message;
            this._emit();
        });

        stream.on('ended', () => {
            if (this.stream !== stream) return;
            this.stream = null;
            this.host.player.setExternalPlayback(false);
            this._emit();
            this._scheduleRetry();
        });

        try {
            await stream.start();
        } catch (err) {
            if (this.stream === stream) {
                this.stream = null;
                stream.stop();
            }
            throw err;
        }
    }

    _stopAnchor() {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.retries = 0;
        if (this.stream) {
            const stream = this.stream;
            this.stream = null;
            stream.stop();
            this.host.player.setExternalPlayback(false);
            // The dedup cache has to go with it. Tearing the stream down can
            // take the OS card with it, so when the stream comes back the
            // metadata must be pushed again — and identical content would
            // otherwise be recognised as "already set" and skipped.
            this.lastMetadata = null;
        }
        if (this.activeAnchor === 'bridge') {
            this.host.player.setAnchorWanted(false).catch(() => {});
        }
        this.activeAnchor = null;
    }

    // The stream can drop for reasons that fix themselves — a backgrounded tab
    // suspending the fetch, a brief network stall. Bounded, because a stream
    // that fails because the session has gone will never come back and retrying
    // forever would hammer the endpoint.
    _scheduleRetry() {
        if (!this.enabled || !this.running || this.anchor !== 'stream') return;
        if (this.retries >= MAX_RETRIES) {
            this.error = 'Lock-screen stream stopped. Turn it off and on to retry.';
            this._emit();
            return;
        }
        this.retries++;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
            if (!this.enabled || !this.running) return;
            this._startAnchor().catch((err) => {
                this.error = err.message || String(err);
                this._emit();
            });
        }, RETRY_DELAY_MS);
    }

    // ---- what the operator hears -------------------------------------------

    // While the HTTP stream owns playback the AudioContext is silent, so volume,
    // mute and the chosen output device have to be applied to the element too —
    // otherwise the volume slider does nothing and the device picker moves audio
    // that is not being played.
    _syncStreamOutput() {
        if (!this.stream) return;
        this.stream.setVolume(this.muted ? 0 : this.volume);
        this.stream.setSinkId(this.sinkId || '').catch(() => { /* device refused */ });
    }

    setOutput({ volume, muted, sinkId }) {
        this.volume = volume;
        this.muted = muted;
        this.sinkId = sinkId;
        this._syncStreamOutput();
        this._applyPlaybackState();
    }

    // ---- metadata ----------------------------------------------------------

    // Called on every tuning change, marker change and lookup result. Cheap
    // when nothing has changed, which is the common case.
    update(snapshot) {
        this.snapshot = { ...this.snapshot, ...snapshot };
        this._pushMetadata();
    }

    _pushMetadata() {
        if (!this.enabled || !this.support.available) return;
        // The gate that keeps a tuning change from doing what the enable click
        // used to: creating a session with no audio behind it, which Chrome
        // shows for a second and then drops.
        if (!this.activated) return;
        // Rule 2: on the stream anchor, silence until it is stably playing.
        if (this.anchor === 'stream' && !(this.stream && this.stream.playing)) return;

        const text = buildMetadata(this.snapshot);
        const photo = this.snapshot.photo || '';
        const next = { ...text, photo };
        if (sameMetadata(next, this.lastMetadata)) return;
        this.lastMetadata = next;

        if (photo) {
            // The proxy path first so the lock screen shows something at once,
            // then the blob when it resolves — the fetch can take a second on a
            // phone and a blank cover in the meantime looks like a failure.
            this._setMetadata(text, photoPlaceholder(photo));
            photoArtwork(photo).then((art) => {
                if (this.lastMetadata !== next) return;   // moved on while fetching
                this._setMetadata(text, art);
                trimPhotoCache(photo);
            });
            return;
        }
        this._setMetadata(text, logoNow());
        logoArtwork().then((art) => {
            if (this.lastMetadata !== next) return;
            this._setMetadata(text, art);
        });
    }

    _setMetadata(text, artwork) {
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: text.title,
                artist: text.artist,
                album: text.album,
                artwork: artwork || [],
            });
        } catch (err) {
            console.warn('[media] metadata:', err.message);
        }
    }

    _applyPlaybackState() {
        if (!this.enabled || !this.support.available) return;
        try {
            if (this.anchor === 'bridge') {
                // Rule 3: these browsers keep the widget through a pause, so
                // the state can say what is actually true.
                navigator.mediaSession.playbackState = this.muted ? 'paused' : 'playing';
            } else if (this.anchor === 'stream') {
                if (this.stream && this.stream.playing) navigator.mediaSession.playbackState = 'playing';
            } else {
                navigator.mediaSession.playbackState = 'playing';
            }
        } catch (err) { /* not all browsers accept every value */ }
    }

    // ---- controls ----------------------------------------------------------

    _installHandlers() {
        if (!this.support.available) return;
        const ms = navigator.mediaSession;
        // Every one of these is the operator doing something, and none of them
        // reaches the DOM — so the idle watch is told, or a listener working
        // from their lock screen gets disconnected for being "inactive".
        const set = (action, fn) => {
            const wrapped = (...args) => {
                noteExternalActivity();
                fn(...args);
            };
            try { ms.setActionHandler(action, wrapped); } catch (e) { /* unsupported action */ }
        };

        set('previoustrack', () => this.host.step(-1));
        set('nexttrack', () => this.host.step(1));
        // Seek maps to tuning as well: on a car stereo the seek buttons are
        // often the only ones on the wheel, and there is nothing to seek in a
        // live stream for them to do instead.
        set('seekbackward', () => this.host.step(-1));
        set('seekforward', () => this.host.step(1));

        // There is no pausing a live receiver, so both map to mute. On Chrome
        // the state never leaves 'playing' (rule 3), which means the widget
        // always offers pause — so pause has to work as a toggle or muting
        // would be a one-way trip.
        set('play', () => {
            this.host.setMuted(false);
            this._applyPlaybackState();
        });
        set('pause', () => {
            const toChrome = this.anchor !== 'bridge';
            this.host.setMuted(toChrome ? !this.muted : true);
            this._applyPlaybackState();
        });
        // The notification's dismiss button. Routed through the host so the
        // panel switch follows: turning the feature off from the lock screen
        // and leaving the panel saying "On" would be a lie.
        set('stop', () => this.host.disable());
    }

    _clearHandlers() {
        if (!this.support.available) return;
        for (const a of ['previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'play', 'pause', 'stop']) {
            try { navigator.mediaSession.setActionHandler(a, null); } catch (e) { /* ignore */ }
        }
    }

    // The scrubber shows how much of your session is left, which is the only
    // thing about a live stream that has a genuine start and end. Chrome also
    // needs a position state before it will light the seek buttons at all.
    _startPositionUpdates() {
        this._stopPositionUpdates();
        const tick = () => {
            if (!this.enabled || !this.support.available) return;
            const p = this.host.position && this.host.position();
            const state = p && p.duration > 0
                ? { duration: p.duration, position: Math.min(Math.max(0, p.position), p.duration), playbackRate: 1 }
                : { duration: LIVE_DURATION_SEC, position: Math.min(this._liveElapsed(), LIVE_DURATION_SEC - 1), playbackRate: 1 };
            try { navigator.mediaSession.setPositionState(state); } catch (e) { /* ignore */ }
        };
        this.liveStart = Date.now();
        tick();
        this.positionTimer = setInterval(tick, POSITION_TICK_MS);
    }

    _liveElapsed() {
        return (Date.now() - (this.liveStart || Date.now())) / 1000;
    }

    _stopPositionUpdates() {
        clearInterval(this.positionTimer);
        this.positionTimer = null;
    }

    destroy() {
        this._stop();
    }
}
