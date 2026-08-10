// A browser, enough of one to run the content script — the Chrome half.
//
// Identical to the Firefox harness except for the last argument: the content
// script picks its extension API with
//
//     const api = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;
//
// so passing `browser` as undefined and a fake `chrome` exercises the branch
// Chrome actually takes. The script file itself is byte-identical in both
// extensions, and contract.test.js asserts it.
//
// The content script is loaded as it ships — the file is read and executed with
// `window`, `document`, `browser`, `CustomEvent` and `console` supplied as
// arguments, so its free variables resolve to ours. No edits, no exports, no
// build step: what the tests exercise is the artefact that goes in the .xpi.
//
// The other end is the *real* v2 page API — `createHost` out of static/v2,
// bundled by run.sh. So a test that sends a command from the popup drives the
// actual receiver actions, through the actual protocol, into the actual
// content script. Nothing between the two is stubbed.

const fs = require('fs');
const path = require('path');

const { createHost } = require('./.build/bridgehost.cjs');
const { API_VERSION, LIVE_TOPICS, STATIC_TOPICS, encodeMessage } = require('./.build/bridgeprotocol.cjs');
const { COMMAND_NAMES, runCommand } = require('./.build/bridgecommands.cjs');
const { describePage, snapshotFor } = require('./.build/bridgesnapshots.cjs');

const SCRIPT = path.join(__dirname, '..', 'extension', 'content_script.js');

// vfos.js keeps its slots in localStorage.
globalThis.localStorage = (() => {
    const map = new Map();
    return {
        get length() { return map.size; },
        key: (i) => [...map.keys()][i] ?? null,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
    };
})();

class CE extends Event {
    constructor(type, init) {
        super(type);
        this.detail = init && init.detail;
    }
}

/**
 * A page, a content script and a background script.
 *
 * @param over.receiver   what /api/description said, or null for a page that
 *                        has not heard back from its server yet
 * @param over.api        the API version to announce, for the mismatch case
 * @param over.enabled    the operator's bridge switch
 * @param over.running    is audio playing
 * @param over.silent     true for a page with no UberSDR on it at all
 */
function makePage(over = {}) {
    const window = new EventTarget();
    const document = { title: 'M9PSY UberSDR - 14.074 MHz USB' };

    // Everything the content script sends to the background script.
    const toBackground = [];
    // The background script's listeners, so a test can send it commands.
    const commandListeners = [];
    const chromeApi = {
        runtime: {
            sendMessage: (msg) => { toBackground.push(msg); return Promise.resolve(); },
            onMessage: { addListener: (fn) => commandListeners.push(fn) },
        },
    };

    const warnings = [];
    const logs = [];
    const fakeConsole = {
        warn: (...a) => warnings.push(a.join(' ')),
        log: (...a) => logs.push(a.join(' ')),
        error: (...a) => warnings.push(a.join(' ')),
    };

    // --- the receiver, as the command layer sees it -------------------------
    const calls = [];
    const record = (name) => (...args) => { calls.push([name, ...args]); };
    const state = {
        tuning: { frequency: 14074000, mode: 'usb', bandwidthLow: 50, bandwidthHigh: 2700 },
        audio: { volume: 0.7, muted: false, channel: 'both', bufferSec: 0.2 },
        squelch: { value: 24, enabled: false, threshold: null },
        view: { centerFreq: 14100000, span: 204800, binBandwidth: 100, binCount: 2048 },
        dsp: { schemas: null },
    };
    const ctx = {
        stepHz: 1000,
        state: () => state,
        actions: {
            tuneTo: record('tuneTo'),
            stepBy: record('stepBy'),
            setMode: record('setMode'),
            setBandwidth: record('setBandwidth'),
            setVolume: record('setVolume'),
            toggleMute: record('toggleMute'),
            setMuted: record('setMuted'),
            setDucked: record('setDucked'),
            setSquelch: record('setSquelch'),
            autoSquelch: record('autoSquelch'),
            ensureVisible: record('ensureVisible'),
            setSpectrumCenter: record('setSpectrumCenter'),
            setSpectrumView: record('setSpectrumView'),
            setSpan: record('setSpan'),
            zoomSteps: record('zoomSteps'),
            resetSpectrum: record('resetSpectrum'),
            centerOnTuned: record('centerOnTuned'),
            powerOff: record('powerOff'),
        },
    };

    const sources = () => ({
        tuning: state.tuning,
        audio: state.audio,
        squelch: state.squelch,
        view: state.view,
        meters: over.meters || { basebandPower: -73, noiseDensity: -110, snr: 37, level: 0.4 },
        running: over.running !== false,
        session: { maxSec: 0, idleSec: 300, startedAt: 0 },
        sessionId: 'sess-1',
        receiverId: over.receiver === null ? null : 'uuid-1',
        serverInfo: over.receiver === null ? null : (over.receiver || {
            public_uuid: 'uuid-1',
            version: '1.2.3',
            receiver: {
                name: 'Test RX', callsign: 'M9PSY', location: 'IO91',
                public_url: 'https://rx.example/',
            },
        }),
        vfo: 'A',
        band: '20m',
        url: 'https://rx.example/v2/',
        title: document.title,
        dspSchemas: null,
        hardware: null,
        // What the Radio Control panel is set to, which is what a registered
        // transport reads to know whether it is the selected one.
        controlSettings: over.controlSettings || null,
    });

    let clock = 0;
    const host = over.silent ? null : createHost({
        send: (msg) => window.dispatchEvent(new CE('ubersdr.from-page', { detail: encodeMessage(msg) })),
        now: () => clock,
        enabled: () => over.enabled !== false,
        describe: () => describePage({
            ...sources(),
            api: over.api || API_VERSION,
            capabilities: COMMAND_NAMES,
            topics: [...LIVE_TOPICS, ...STATIC_TOPICS],
            commands: COMMAND_NAMES,
        }),
        snapshot: (topic) => snapshotFor(topic, sources()),
        command: (name, args) => runCommand(name, args, ctx),
        run: (fn) => ({ dispatched: fn }),
    });
    if (host) window.addEventListener('ubersdr.to-page', (e) => host.handle(e.detail));

    // The content script, exactly as it ships.
    const src = fs.readFileSync(SCRIPT, 'utf8');
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'browser', 'chrome', 'CustomEvent', 'console', src)(
        window, document, undefined, chromeApi, CE, fakeConsole,
    );

    return {
        window,
        document,
        host,
        state,
        calls,
        warnings,
        logs,
        toBackground,
        /** What the background script would send to this tab. */
        fromBackground: (msg) => commandListeners.forEach((fn) => fn(msg)),
        /** Messages of one type that reached the background script. */
        sent: (type) => toBackground.filter((m) => m.type === type),
        lastSent: () => toBackground[toBackground.length - 1],
        advance: (ms) => { clock += ms; },
        publish: (topic, value) => host.publish(topic, value),
        unload: () => window.dispatchEvent(new CE('pagehide', {})),
        CE,
    };
}

module.exports = { makePage, CE };
