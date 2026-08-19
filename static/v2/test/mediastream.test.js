// The HTTP audio anchor: what happens when the server says no.
//
// Two failures this covers are ones nothing throws about on a desktop. The
// endpoint refuses a session it cannot serve as WebM/Opus — no audio session
// yet, or an IQ mode, whose raw stereo RF a mono Opus encoder cannot carry —
// and the client used to answer a refusal by asking the same endpoint the same
// question over the plain <audio> path, which is told the same thing a second
// time and reports it as a bare element error. And the retry budget that guards
// against a session that has gone for good would then be spent on that, leaving
// the widget dead after the operator tuned back to a mode that works.

const assert = require('assert');

const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Mobile Safari/537.36';
const SESSION = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const URL_FOR_SESSION = `/audio/stream?session=${SESSION}`;

// --- the browser, in as much detail as this code touches ---------------------

// Every element the code under test asks for, in creation order, so a test can
// see whether the direct path built one.
let elements = [];
let fetches = [];
// What the next GET of the stream URL answers. Replaced per test.
let respond = () => ({ ok: true, status: 200, body: emptyBody() });

function emptyBody() {
    return { getReader: () => ({ read: () => new Promise(() => {}) }) };
}

function fakeElement() {
    const el = {
        tagName: 'AUDIO', src: '', volume: 1, currentTime: 0, error: null,
        style: {}, parentNode: null, listeners: {},
        setAttribute() {},
        addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
        removeEventListener(type, fn) {
            el.listeners[type] = (el.listeners[type] || []).filter((f) => f !== fn);
        },
        play: () => Promise.resolve(),
        load() {},
    };
    elements.push(el);
    return el;
}

// A MediaSource that opens on the next turn of the loop, which is what Chrome
// does. The sourceopen listener is attached after the constructor returns, so
// firing it synchronously would be a test that could never fail the way the
// real thing does.
function installMediaSource({ addSourceBufferThrows = false } = {}) {
    class FakeMediaSource {
        constructor() {
            this.readyState = 'closed';
            this.listeners = {};
            queueMicrotask(() => {
                this.readyState = 'open';
                (this.listeners.sourceopen || []).forEach((fn) => fn());
            });
        }

        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }

        addSourceBuffer() {
            if (addSourceBufferThrows) throw new Error('unsupported configuration');
            return { mode: '', updating: false, buffered: { length: 0 }, addEventListener() {}, removeEventListener() {} };
        }

        endOfStream() {}
    }
    FakeMediaSource.isTypeSupported = () => true;
    globalThis.MediaSource = FakeMediaSource;
}

function installBrowser() {
    elements = [];
    fetches = [];
    globalThis.navigator = { userAgent: CHROME_ANDROID, mediaSession: {} };
    globalThis.document = {
        createElement: fakeElement,
        body: {
            appendChild(el) { el.parentNode = globalThis.document.body; },
            removeChild(el) { el.parentNode = null; },
        },
    };
    globalThis.URL.createObjectURL = () => 'blob:fake';
    globalThis.URL.revokeObjectURL = () => {};
    globalThis.fetch = (url, opts = {}) => {
        // The controller warms the lock-screen artwork on enable. Answered so
        // the test output is not three "artwork: HTTP 404" lines deep, and kept
        // out of `fetches`, which is about the stream URL.
        if (String(url).startsWith('/images/')) {
            return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob([])) });
        }
        fetches.push({ url, method: opts.method || 'GET' });
        if (opts.method === 'DELETE') return Promise.resolve({ ok: true, status: 204 });
        return Promise.resolve(respond());
    };
    installMediaSource();
}

installBrowser();

const { HttpAudioStream, MediaSessionController } = require('./.build/mediastream.cjs');

let pass = 0;
const queue = [];
const t = (name, fn) => queue.push([name, fn]);

// --- a refusal is not a reason to try the other path -------------------------

t('a refused stream does not fall back to the direct path', async () => {
    installBrowser();
    respond = () => ({
        ok: false,
        status: 409,
        text: () => Promise.resolve('Lock-screen audio is not available in IQ modes\n'),
    });

    const stream = new HttpAudioStream(SESSION);
    let failure = null;
    await stream.start().catch((err) => { failure = err; });

    assert.ok(failure, 'start() resolved on a refusal');
    assert.strictEqual(failure.refusedStatus, 409);
    // The server's own words, trimmed — this is what the panel shows, and
    // "HTTP 409" would tell the operator nothing about what to do.
    assert.strictEqual(failure.message, 'Lock-screen audio is not available in IQ modes');
    // The direct path sets mode to 'direct' before it does anything else.
    assert.strictEqual(stream.mode, 'mse');
    // One GET. A fallback would have made the element fetch the same URL again.
    assert.deepStrictEqual(fetches.map((f) => f.method), ['GET']);
    assert.ok(elements.every((el) => el.src !== URL_FOR_SESSION), 'an element was pointed at the refused URL');
    assert.ok(elements.every((el) => el.parentNode === null), 'an element was left in the document');
});

t('an MSE-specific failure still falls back to the direct path', async () => {
    installBrowser();
    installMediaSource({ addSourceBufferThrows: true });
    respond = () => ({ ok: true, status: 200, body: emptyBody() });

    const stream = new HttpAudioStream(SESSION);
    await stream.start();

    assert.strictEqual(stream.mode, 'direct');
    assert.strictEqual(stream.el.src, URL_FOR_SESSION);
    stream.stop();
});

t('a refusal reaches the panel through the controller', async () => {
    installBrowser();
    respond = () => ({ ok: false, status: 404, text: () => Promise.resolve('No active audio session') });

    const ctl = newController();
    ctl.running = true;
    await ctl.setEnabled(true);

    assert.strictEqual(ctl.status.error, 'No active audio session');
    assert.strictEqual(ctl.stream, null);
    clearRetry(ctl);
});

// --- the retry budget ---------------------------------------------------------

function newController() {
    const ctl = new MediaSessionController({
        player: {
            on: () => () => {},
            armFlowing() {},
            setExternalPlayback() {},
            setAnchorWanted: () => Promise.resolve(),
            setSinkId: () => Promise.resolve(),
        },
        sessionId: () => SESSION,
        step() {},
        setMuted() {},
        disable() {},
        position: () => null,
        onStatus() {},
    });
    // Forced rather than detected: which anchor a browser is given is decided
    // elsewhere and tested in mediasession.test.js.
    ctl.override = 'stream';
    return ctl;
}

function clearRetry(ctl) {
    clearTimeout(ctl.retryTimer);
    ctl.retryTimer = null;
}

t('a mode change gives a dead stream anchor its retries back', () => {
    installBrowser();
    const ctl = newController();
    ctl.enabled = true;
    ctl.running = true;
    ctl.stream = null;
    ctl.update({ mode: 'usb' });
    clearRetry(ctl);

    // Spent, as it would be after the five attempts made while the receiver sat
    // in an IQ mode the endpoint refuses.
    ctl.retries = 5;
    ctl.error = 'Lock-screen stream stopped. Turn it off and on to retry.';

    ctl.update({ mode: 'am' });

    // Reset to zero and then spent once by the attempt this schedules.
    assert.strictEqual(ctl.retries, 1);
    assert.ok(ctl.retryTimer, 'no retry was scheduled');
    assert.strictEqual(ctl.error, '');
    clearRetry(ctl);
});

t('tuning inside one mode does not reschedule anything', () => {
    installBrowser();
    const ctl = newController();
    ctl.enabled = true;
    ctl.running = true;
    ctl.stream = null;
    ctl.update({ mode: 'usb' });
    clearRetry(ctl);

    ctl.retries = 5;
    ctl.update({ frequency: 7_100_000 });
    ctl.update({ mode: 'usb', frequency: 7_200_000 });

    assert.strictEqual(ctl.retries, 5);
    assert.strictEqual(ctl.retryTimer, null);
});

t('a mode change does not disturb a stream that is playing', () => {
    installBrowser();
    const ctl = newController();
    ctl.enabled = true;
    ctl.running = true;
    ctl.stream = { playing: true, mode: 'mse' };
    ctl.update({ mode: 'usb' });
    ctl.retries = 2;

    ctl.update({ mode: 'am' });

    assert.strictEqual(ctl.retries, 2);
    assert.strictEqual(ctl.retryTimer, null);
});

(async () => {
    for (const [name, fn] of queue) {
        try {
            await fn();
            console.log('ok    ' + name);
            pass++;
        } catch (e) {
            console.log('FAIL  ' + name + '\n      ' + (e && e.stack ? e.stack : e));
            process.exitCode = 1;
        }
    }
    console.log(`\n${pass}/${queue.length} media stream tests passed`);
})();
