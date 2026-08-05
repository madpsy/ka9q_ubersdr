// UberSDR Bridge — content script
//
// Speaks the UberSDR v2 page API (see static/v2/BRIDGE_API.md) and relays it to
// the background script. Everything here runs in the content-script sandbox;
// there is no page-world injection, because the v2 API is a message channel
// rather than a JavaScript object.
//
// That is the whole reason this file is a third of what it replaced. The old
// version injected a <script> element into the page so it could reach
// `window.radioAPI`, polled for eight seconds hoping it would appear, watched a
// CSS class on an overlay to tell whether audio had started, polled two loose
// globals every 500 ms for the signal level, and performed a hand-written
// eight-step sequence of internal v1 calls to change frequency. None of that
// exists now: the page announces itself, pushes what changed, and answers
// commands.
//
// The protocol constants below are the published contract. They are duplicated
// here rather than imported because a content script cannot import from the
// page's bundle; they change only with the API's major version.

(function () {
    'use strict';

    const EVENT_TO_PAGE = 'ubersdr.to-page';
    const EVENT_FROM_PAGE = 'ubersdr.from-page';
    const PROTOCOL = 1;

    // What this extension understands. A page announcing a higher major would
    // be speaking a different language, and we would rather do nothing than
    // half-work.
    const API_MAJOR = 1;

    // The signal meter in the popup does not need ten readings a second, and
    // asking for fewer costs the page less.
    const SIGNAL_MS = 250;

    const CLIENT_ID = 'firefox-bridge-' + Math.random().toString(36).slice(2, 10);

    let seq = 0;
    const pending = new Map();          // request id -> what it was, for error reporting
    let descriptor = null;              // the page's last announce
    let registered = false;

    // ── the page API ──────────────────────────────────────────────────────────

    function send(type, fields) {
        seq += 1;
        const msg = Object.assign({
            v: PROTOCOL, from: 'client', client: CLIENT_ID, id: seq, type,
        }, fields || {});
        // hello is answered with an announce rather than a result, so it is
        // not something to wait on — tracking it would leak an entry per
        // handshake, and there is one on every reconnection.
        if (type !== 'hello') pending.set(seq, type);
        window.dispatchEvent(new CustomEvent(EVENT_TO_PAGE, { detail: JSON.stringify(msg) }));
        return seq;
    }

    window.addEventListener(EVENT_FROM_PAGE, function (e) {
        let msg = null;
        try {
            msg = JSON.parse(e.detail);
        } catch (err) {
            return;                     // not ours, or not a message at all
        }
        if (!msg || msg.v !== PROTOCOL || msg.from !== 'page') return;
        // Broadcasts have no client; a reply addressed to somebody else is not
        // ours to read. Two extensions on one page is an ordinary thing.
        if (msg.client && msg.client !== CLIENT_ID) return;

        switch (msg.type) {
            case 'announce': onAnnounce(msg); break;
            case 'state': onState(msg); break;
            case 'result': onResult(msg); break;
            case 'closing': onClosing(!!msg.client); break;
        }
    });

    // ── translation ───────────────────────────────────────────────────────────
    //
    // The background script and the popup speak in a flat state object that
    // predates this API. Mapping here keeps that intact: nothing beyond this
    // file needs to know the page's topic names.

    function flatten(topic, data) {
        const out = {};
        const has = (k) => k in data && data[k] !== null;
        if (topic === 'tuning') {
            // Nulls are dropped rather than forwarded: a topic always carries
            // every key, and "not known" is not something the popup can render
            // — it would print an empty frequency or throw on a null mode.
            // Signal is the exception below, where null means "no measurement"
            // and is worth showing as such.
            if (has('frequency')) out.freq = data.frequency;
            if (has('mode')) out.mode = data.mode;
            if (has('bandwidthLow')) out.bwLow = data.bandwidthLow;
            if (has('bandwidthHigh')) out.bwHigh = data.bandwidthHigh;
            if (has('band')) out.band = data.band;
        } else if (topic === 'audio') {
            if (has('muted')) out.muted = data.muted;
            if (has('volume')) out.volume = data.volume;
        } else if (topic === 'signal') {
            if ('dbfs' in data) out.dbfs = data.dbfs;
            if ('snr' in data) out.snr = data.snr;
            // The S-meter reading the page itself is showing, so the popup's
            // meter agrees with it instead of re-deriving one from dBFS.
            if ('s' in data) out.s = data.s;
        }
        return out;
    }

    /** A label for the tab list: the receiver, not the document title. */
    function label() {
        const rx = (descriptor && descriptor.receiver) || {};
        if (rx.callsign && rx.name) return rx.callsign + ' — ' + rx.name;
        return rx.name || rx.callsign || document.title || 'UberSDR';
    }

    const running = () => !!(descriptor && descriptor.session && descriptor.session.running);

    // ── page → background ─────────────────────────────────────────────────────

    function onAnnounce(msg) {
        if (!msg.api || msg.api.major !== API_MAJOR) {
            console.warn('[UberSDR Bridge] page API v' + (msg.api && msg.api.major)
                + ' — this extension speaks v' + API_MAJOR);
            return;
        }
        descriptor = msg;

        // An announce means the page has (re)started, so anything we knew is
        // from a previous life: register again and re-subscribe from scratch.
        registered = true;
        tell({
            type: 'ubersdr:register',
            sessionId: msg.session ? msg.session.id : null,
            receiver: msg.receiver || null,
            url: (msg.page && msg.page.url) || window.location.href,
            title: label(),
            audioStarted: running(),
        });

        send('subscribe', { topics: ['tuning', 'audio', 'session'] });
        send('subscribe', { topics: ['signal'], minIntervalMs: SIGNAL_MS });

        // One line, once, on a page that turned out to be a receiver.
        //
        // Nothing is logged on the way to finding out, and nothing at all on a
        // page that is not one: this content script runs on every page in the
        // browser, so a "looking for an UberSDR…" line would be noise on every
        // site you visit, and a "not found" line would need a timer on each of
        // them to decide when to give up.
        console.log('[UberSDR Bridge] attached to ' + label()
            + ' (API ' + msg.api.major + '.' + msg.api.minor + ')');
    }

    function onState(msg) {
        if (!registered) return;
        if (msg.topic === 'session') {
            if ('running' in msg.patch) {
                descriptor.session = Object.assign({}, descriptor.session, msg.patch);
                tell({ type: 'ubersdr:audio_started', running: !!msg.patch.running });
            }
            return;
        }
        const state = flatten(msg.topic, msg.patch || {});
        if (Object.keys(state).length) tell({ type: 'ubersdr:state', state: state });
    }

    function onResult(msg) {
        const what = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.ok) {
            // A subscribe answers with a full snapshot of each topic, which is
            // exactly the picture the popup wants when a tab is first selected.
            if (what === 'subscribe' || what === 'get') snapshot(msg.value);
            return;
        }
        // Refusals are reported rather than swallowed: a command that silently
        // does nothing is the thing this API was built to stop.
        console.warn('[UberSDR Bridge] ' + what + ' refused: '
            + (msg.error && msg.error.code) + ' — ' + (msg.error && msg.error.message));
    }

    function snapshot(value) {
        if (!value || typeof value !== 'object') return;
        let state = {};
        for (const topic of Object.keys(value)) {
            state = Object.assign(state, flatten(topic, value[topic] || {}));
        }
        if (descriptor && value.session && 'running' in value.session) {
            descriptor.session = Object.assign({}, descriptor.session, value.session);
        }
        if (Object.keys(state).length) tell({ type: 'ubersdr:state_snapshot', state: state });
    }

    function onClosing(addressedToUs) {
        registered = false;
        descriptor = null;
        tell({ type: 'ubersdr:deregister' });
        // Addressed to us means we were let go to make room for another client
        // — the page is still there and still willing, so introduce ourselves
        // again. A broadcast means the page is going away or the operator has
        // switched the bridge off; saying hello to that would only earn a
        // refusal, and the page announces itself again when it comes back.
        if (addressedToUs) send('hello');
    }

    function tell(msg) {
        browser.runtime.sendMessage(msg).catch(function () {
            // The background page may be asleep or the extension reloading.
            // Nothing here is worth retrying: the next announce or patch will
            // carry the same information.
        });
    }

    // ── background → page ─────────────────────────────────────────────────────

    browser.runtime.onMessage.addListener(function (msg) {
        if (!msg || !msg.type) return;

        // Sent when the extension is switched back on, to rediscover tabs that
        // were already open. Asking the page again is enough — its announce
        // does the registering.
        if (msg.type === 'cmd:reregister') {
            send('hello');
            return;
        }

        if (!registered) return;

        switch (msg.type) {
            case 'cmd:get_state':
                send('get', {});
                break;

            // Frequency, mode and passband in one call. Sending them separately
            // walks the receiver through intermediate mode/passband pairs on the
            // way, which is audible.
            case 'cmd:tune': {
                const args = {};
                if (msg.freq != null) args.frequency = msg.freq;
                if (msg.mode != null) args.mode = msg.mode;
                if (msg.low != null && msg.high != null) {
                    args.bandwidthLow = msg.low;
                    args.bandwidthHigh = msg.high;
                }
                if (Object.keys(args).length) send('command', { name: 'tune', args: args });
                break;
            }

            case 'cmd:set_freq':
                send('command', { name: 'tune', args: { frequency: msg.freq } });
                break;

            case 'cmd:adjust_freq':
                // Relative: the page stops at the band edge, as the dial does.
                send('command', { name: 'tune', args: { delta: msg.delta } });
                break;

            case 'cmd:set_mode':
                send('command', { name: 'mode', args: { mode: msg.mode } });
                break;

            case 'cmd:set_bandwidth':
                send('command', { name: 'passband', args: { low: msg.low, high: msg.high } });
                break;

            case 'cmd:set_mute':
                // Absolute, not a toggle: PTT mute is driven by "the rig is
                // transmitting: true/false", and a toggle desynchronises
                // permanently the first time a message is missed.
                send('command', { name: 'mute', args: { muted: !!msg.muted } });
                break;
        }
    });

    window.addEventListener('pagehide', function () {
        if (registered) tell({ type: 'ubersdr:deregister' });
    });

    // ── go ────────────────────────────────────────────────────────────────────
    //
    // One message, then listen. On a page that is not an UberSDR nothing ever
    // answers and this costs a single idle listener — no polling, no timers, no
    // eight-second probe. If the page mounts later, its own announce arrives
    // and registers us anyway.
    send('hello');
})();
