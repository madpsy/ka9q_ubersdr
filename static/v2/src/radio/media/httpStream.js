// The Android Chrome anchor: an <audio> element playing a real media URL.
//
// Chrome on Android will not raise the lock-screen / notification widget for a
// MediaStream-backed element, so the bridge that satisfies Safari and Firefox
// is not enough here. The server has an endpoint that serves the same audio as
// a live WebM/Opus stream (audio_http_stream.go), and this drives it.
//
// Two things about the server side are worth knowing before touching this:
//
//   * It is not a second copy of the audio. While the HTTP stream is connected
//     the server routes packets *there instead of* the WebSocket, so bandwidth
//     is unchanged — but the WebSocket audio stops, which means the client-side
//     DSP, the audio scope and the recorder go quiet for as long as this runs.
//     Signal-quality packets keep coming, so the S-meter and squelch are fine.
//
//   * Stopping is an explicit DELETE. Without it the server keeps routing to a
//     stream nobody is reading until it times out, and the operator hears
//     nothing at all. That call is the one part of teardown that must not be
//     skipped, which is why it is not conditional on anything.
//
// MSE is used rather than a plain <audio src>: Chrome's pre-buffering
// heuristic sits on roughly six seconds of a URL-sourced stream before it
// starts, and feeding the chunks into a SourceBuffer ourselves brings that to
// about 200 ms. The plain path is kept as a fallback because it always works.

import { Emitter } from '../emitter.js';

// How much decoded audio to keep behind the playhead. The stream is live and
// nobody scrubs backwards, so this is pure memory growth otherwise.
const KEEP_SEC = 2;
// After a QuotaExceededError, trim harder than usual before retrying.
const PANIC_KEEP_SEC = 0.5;
const MIME = 'audio/webm; codecs=opus';
// Only reached if the browser never fires sourceopen at all.
const SOURCE_OPEN_TIMEOUT_MS = 10000;

export function canUseMSE() {
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(MIME);
}

export function streamUrl(sessionId) {
    return `/audio/stream?session=${encodeURIComponent(sessionId)}`;
}

// Events: 'playing' once the element is stably playing (nothing may touch
// MediaSession before this — see the controller), 'ended' when it stops for any
// reason, 'error' with a message.
export class HttpAudioStream extends Emitter {
    constructor(sessionId) {
        super();
        this.sessionId = sessionId;
        this.el = null;
        this.playing = false;
        this.mode = null;           // 'mse' | 'direct', for the panel to report
        this.stopped = false;
        this._ms = null;
        this._sb = null;
        this._abort = null;
        this._queue = [];
        this._appending = false;
        this._onUpdateEnd = () => {
            this._appending = false;
            this._flush();
        };
    }

    async start() {
        if (this.el) return;
        const url = streamUrl(this.sessionId);
        if (canUseMSE()) {
            try {
                await this._startMSE(url);
                return;
            } catch (err) {
                console.warn('[media] MSE stream failed, falling back:', err.message);
                this._teardownElement();
            }
        }
        await this._startDirect(url);
    }

    // The element is created the same way on both paths; only the source
    // differs. Kept here so the two paths cannot drift apart in their event
    // wiring, which in v1 they had begun to.
    _createElement() {
        const el = document.createElement('audio');
        el.setAttribute('playsinline', '');
        el.style.display = 'none';
        document.body.appendChild(el);
        this.el = el;

        el._onError = () => {
            // Code 4 is the element being torn down under us on purpose.
            if (el.error && el.error.code === 4) return;
            this.emit('error', (el.error && el.error.message) || 'audio element error');
            this._ended();
        };
        el._onEnded = () => this._ended();
        el.addEventListener('error', el._onError);
        el.addEventListener('ended', el._onEnded);
        el.addEventListener('abort', el._onEnded);

        el.addEventListener('playing', () => {
            this.playing = true;
            this.emit('playing');
        }, { once: true });

        // Chrome dismisses the widget when the element is genuinely paused, and
        // it pauses the element itself when the user taps pause on the lock
        // screen. So pause is treated as "mute" by the controller and playback
        // is resumed immediately here — otherwise the first tap on pause is
        // also the last thing the widget ever does.
        el.addEventListener('pause', () => {
            if (this.el === el && !this.stopped) el.play().catch(() => {});
        });

        return el;
    }

    async _startMSE(url) {
        const ms = new MediaSource();
        this._ms = ms;
        this.mode = 'mse';

        // The listener must be attached before the element gets the blob URL:
        // Chrome can fire sourceopen synchronously with the assignment, and a
        // listener added afterwards misses it entirely — which lands in the
        // timeout and silently demotes every page load to the 6 s direct path.
        const opened = new Promise((resolve, reject) => {
            ms.addEventListener('sourceopen', resolve, { once: true });
            ms.addEventListener('error', () => reject(new Error('MediaSource error')), { once: true });
            setTimeout(() => reject(new Error('sourceopen timed out')), SOURCE_OPEN_TIMEOUT_MS);
        });

        // Element into the DOM before the src is assigned — the spec requires
        // it to be in a document when the blob URL resolves.
        const el = this._createElement();
        el.src = URL.createObjectURL(ms);

        await opened;
        if (this.stopped) return;
        if (ms.readyState !== 'open') throw new Error(`MediaSource ${ms.readyState}`);

        const sb = ms.addSourceBuffer(MIME);
        // The stream is a sequence of live clusters with no seekable timeline,
        // so timestamps are appended in order rather than placed.
        sb.mode = 'sequence';
        sb.addEventListener('updateend', this._onUpdateEnd);
        this._sb = sb;

        const abort = new AbortController();
        this._abort = abort;
        const resp = await fetch(url, { signal: abort.signal });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        el.play().catch((err) => console.warn('[media] play() rejected:', err.message));
        this._read(resp.body.getReader());
    }

    async _read(reader) {
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done || this.stopped) {
                    if (!this.stopped) this._ended();
                    return;
                }
                this._queue.push(value);
                this._flush();
                this._trim(KEEP_SEC);
            }
        } catch (err) {
            if (err.name === 'AbortError') return;
            this.emit('error', err.message);
            this._ended();
        }
    }

    // A SourceBuffer takes one append at a time, so chunks queue behind the
    // one in flight and `updateend` pulls the next.
    _flush() {
        const sb = this._sb;
        if (!sb || this._appending || sb.updating || !this._queue.length) return;
        try {
            this._appending = true;
            sb.appendBuffer(this._queue.shift());
        } catch (err) {
            this._appending = false;
            if (err.name === 'QuotaExceededError') this._trim(PANIC_KEEP_SEC);
            else console.error('[media] appendBuffer:', err.message);
        }
    }

    _trim(keepSec) {
        const sb = this._sb;
        if (!sb || !this.el || sb.updating) return;
        try {
            const buffered = sb.buffered;
            if (!buffered.length) return;
            const start = buffered.start(0);
            const until = this.el.currentTime - keepSec;
            // Below 100 ms the remove costs more than it reclaims.
            if (until > start + 0.1) sb.remove(start, until);
        } catch (err) {
            // The buffer can detach mid-teardown; nothing to do about it.
        }
    }

    async _startDirect(url) {
        this.mode = 'direct';
        const el = this._createElement();
        el.src = url;
        try {
            await el.play();
        } catch (err) {
            this.emit('error', err.message);
            this._teardownElement();
            throw err;
        }
    }

    _ended() {
        if (this.stopped) return;
        this.stop();
        this.emit('ended');
    }

    // Volume and mute have to be applied here as well as to the AudioContext:
    // while this is running the context is silent and the element is what the
    // operator actually hears.
    setVolume(v) {
        if (this.el) this.el.volume = Math.max(0, Math.min(1, v));
    }

    // The output-device picker has to reach this element too. Without it,
    // choosing a device would appear to work — the context would take the sink
    // — while the audio came out of the default device via this element.
    async setSinkId(id) {
        if (!this.el || typeof this.el.setSinkId !== 'function') return;
        await this.el.setSinkId(id || '');
    }

    _teardownElement() {
        const el = this.el;
        if (!el) return;
        this.el = null;    // first, so the pause handler does not resurrect it
        el.removeEventListener('error', el._onError);
        el.removeEventListener('ended', el._onEnded);
        el.removeEventListener('abort', el._onEnded);
        if (el.src && el.src.startsWith('blob:')) URL.revokeObjectURL(el.src);
        // src before pause: clearing the source cancels a pending play()
        // cleanly, where pausing first logs "play() interrupted by pause()".
        el.src = '';
        try { el.load(); } catch (e) { /* resetting a dead element */ }
        if (el.parentNode) el.parentNode.removeChild(el);
    }

    stop() {
        if (this.stopped) return;
        this.stopped = true;
        this.playing = false;

        if (this._abort) {
            this._abort.abort();
            this._abort = null;
        }
        if (this._sb) {
            try { this._sb.removeEventListener('updateend', this._onUpdateEnd); } catch (e) { /* detached */ }
            this._sb = null;
        }
        this._queue = [];
        this._appending = false;
        if (this._ms) {
            try { if (this._ms.readyState === 'open') this._ms.endOfStream(); } catch (e) { /* already closed */ }
            this._ms = null;
        }
        this._teardownElement();

        // The one call that must always happen: until the server is told, it
        // keeps routing audio to a stream nobody is reading and the WebSocket
        // stays silent. keepalive so it still goes out from a closing page.
        fetch(streamUrl(this.sessionId), { method: 'DELETE', keepalive: true })
            .catch(() => { /* the server may have closed it already */ });
    }
}
