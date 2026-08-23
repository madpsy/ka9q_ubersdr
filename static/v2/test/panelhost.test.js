// A custom panel's connection to the receiver.
//
// The port is the whole security boundary: the frame has an opaque origin and
// can do nothing except send messages down this channel. So what matters is what
// the parent does with what arrives — and that a panel really can drive the
// receiver through it, because a boundary nothing can cross is not a feature.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

globalThis.location = { origin: 'https://rx.example' };

const {
    attachPanel, detachPanel, setPanelDeps, resetPanelHosts, fetchForPanel,
    publishToPanels, themeToPanels, attachedPanelIds,
    buildSrcdoc, themeDeclarations, startPanelRuntime, writeKey, readAll,
} = require('./.build/panelhost.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};
const ta = async (name, fn) => {
    try { await fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- a MessageChannel, as far as either side uses one ------------------------

function makeChannel() {
    const mk = () => ({
        _handlers: [],
        onmessage: null,
        other: null,
        started: false,
        closed: false,
        start() { this.started = true; },
        close() { this.closed = true; },
        addEventListener(type, fn) { if (type === 'message') this._handlers.push(fn); },
        postMessage(data, transfer) {
            const to = this.other;
            if (!to || to.closed) return;
            // The transfer list is carried, because a port handed down a port is
            // exactly what the audio and spectrum handovers do — a mock that
            // dropped it would pass while the real thing delivered nothing.
            const ports = Array.isArray(transfer) ? transfer : [];
            // Asynchronous, as a real port is: a test that passed only because
            // both ends ran in one tick would not be testing the real thing.
            queueMicrotask(() => {
                if (to.onmessage) to.onmessage({ data, ports });
                for (const fn of to._handlers) fn({ data, ports });
            });
        },
    });
    const port1 = mk();
    const port2 = mk();
    port1.other = port2;
    port2.other = port1;
    return { port1, port2 };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// --- the deps a panel host answers from --------------------------------------

function fakeDeps(over = {}) {
    return {
        describe: () => ({
            app: 'ubersdr', ui: 'v2',
            receiver: { id: 'rx-1', callsign: 'M9PSY' },
            capabilities: ['tune'], topics: ['tuning'], commands: ['tune'],
        }),
        snapshot: (topic) => (topic === 'tuning' ? { frequency: 14074000, mode: 'usb' } : null),
        command: (name, args) => ({ ran: name, args }),
        run: (fn) => ({ dispatched: fn }),
        ...over,
    };
}

// --- sdr.fetch ---------------------------------------------------------------

(async () => {
    await ta('sdr.fetch reaches only this receiver\'s /api/ endpoints', async () => {
        // The one deviation from "a custom panel may do anything a built-in panel
        // may do". The parent performs the request, so it carries the operator's
        // session — and the operator may well be signed into admin in this very
        // browser.
        //
        // Stated positively, and that is the point. This began as a denylist of
        // `/admin`, which was wrong twice: it named the wrong set of privileged
        // prefixes, and it compared the wrong string.
        const refused = [
            // The admin API itself.
            '/admin', '/admin/', '/admin/widgets/enabled', '/admin/config?x=1',

            // Percent-encoded, which is the bypass a denylist could not see:
            // URL.pathname keeps the encoding as written, while Go's router
            // decodes each segment before matching — so this misses a
            // startsWith('/admin/') test and still arrives at the admin handler.
            '/%61dmin/config', '/%61dmin/widgets/enabled', '/ad%6din/config',
            '/admin%2fconfig', '/%2fadmin/config',

            // Prefixes that are behind the same admin session but are not
            // /admin. /terminal/ proxies to the shell container, whose exec API
            // takes no authentication of its own: reaching it is command
            // execution on the receiver's host.
            '/terminal/api/exec', '/terminal/', '/gpsdo/json', '/addon/anything',

            // Climbing out of /api/ afterwards, encoded or not.
            '/api/../admin/config', '/api/%2e%2e/admin/config', '/api/v2/../../admin/config',

            // And anything that is simply not the API.
            '/', '/index.html', '/v2/dist/v2.js',
        ];
        for (const path of refused) {
            const res = await fetchForPanel(path);
            assert.strictEqual(res.ok, false, path + ' was allowed');
        }
    });

    await ta('sdr.fetch still allows what a panel legitimately needs', async () => {
        const saved = globalThis.fetch;
        const asked = [];
        globalThis.fetch = async (url) => {
            asked.push(url);
            return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '[]' };
        };
        try {
            for (const path of [
                '/api/cty/countries',
                '/api/maidenhead/country?grid=IO91',
                // Encoding *within* a segment stays legal: a callsign with a
                // slash in it is a real thing to look up.
                '/api/lookup/M0ABC%2FP',
            ]) {
                const res = await fetchForPanel(path);
                assert.strictEqual(res.ok, true, path + ' was refused');
            }
            assert.strictEqual(asked.length, 3);
        } finally {
            globalThis.fetch = saved;
        }
    });

    await ta('sdr.fetch refuses another origin', async () => {
        // Not a restriction so much as a signpost: an opaque-origin frame can
        // call fetch() itself for anything that sends permissive CORS, and this
        // proxy exists for the one thing it cannot reach — this receiver.
        for (const url of ['https://elsewhere.example/x', '//elsewhere.example/x']) {
            const res = await fetchForPanel(url);
            assert.strictEqual(res.ok, false, url + ' was allowed');
        }
    });

    await ta('sdr.fetch passes an ordinary receiver request through', async () => {
        const saved = globalThis.fetch;
        let asked = null;
        globalThis.fetch = async (url, init) => {
            asked = { url, init };
            return {
                ok: true, status: 200,
                headers: { get: () => 'application/json' },
                text: async () => '{"ok":true}',
            };
        };
        try {
            const res = await fetchForPanel('/api/cty/countries');
            assert.strictEqual(res.ok, true);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body, '{"ok":true}');
            assert.strictEqual(asked.url, 'https://rx.example/api/cty/countries');
            assert.strictEqual(asked.init.credentials, 'same-origin',
                'a built-in panel is same-origin and carries the session; parity means this does too');
        } finally {
            globalThis.fetch = saved;
        }
    });

    await ta('a failed request is an answer, not a hang', async () => {
        const saved = globalThis.fetch;
        globalThis.fetch = async () => { throw new Error('offline'); };
        try {
            const res = await fetchForPanel('/api/cty/countries');
            assert.strictEqual(res.ok, false);
        } finally {
            globalThis.fetch = saved;
        }
    });

    // --- the host on the parent's end ----------------------------------------

    await ta('a panel gets an announce as soon as it is attached', async () => {
        resetPanelHosts();
        setPanelDeps(fakeDeps());
        const { port1, port2 } = makeChannel();
        const seen = [];
        port2.onmessage = ({ data }) => seen.push(data);

        attachPanel({ id: 'x:a', port: port1 });
        await settle();

        const announce = seen.map((d) => JSON.parse(d)).find((m) => m.type === 'announce');
        assert.ok(announce, 'no announce arrived');
        assert.strictEqual(announce.receiver.callsign, 'M9PSY');
        resetPanelHosts();
    });

    await ta('one panel cannot be reached through another panel', async () => {
        // A host each, rather than one host with many clients: there is no id a
        // panel could name that would put a message on somebody else's port.
        resetPanelHosts();
        setPanelDeps(fakeDeps());
        const a = makeChannel();
        const b = makeChannel();
        const toA = [];
        const toB = [];
        a.port2.onmessage = ({ data }) => toA.push(data);
        b.port2.onmessage = ({ data }) => toB.push(data);

        attachPanel({ id: 'x:a', port: a.port1 });
        attachPanel({ id: 'x:b', port: b.port1 });
        await settle();
        toA.length = 0;
        toB.length = 0;

        // A subscribes; B must hear nothing of it.
        a.port2.postMessage(JSON.stringify({
            v: 1, from: 'client', client: 'x:a', id: 1, type: 'subscribe', topics: ['tuning'],
        }));
        await settle();
        publishToPanels('tuning', { frequency: 7100000, mode: 'lsb' });
        await settle();

        assert.ok(toA.length > 0, 'the subscriber heard nothing');
        assert.strictEqual(toB.length, 0, 'the other panel was sent something');
        resetPanelHosts();
    });

    await ta('detaching a panel closes its port and stops its traffic', async () => {
        resetPanelHosts();
        setPanelDeps(fakeDeps());
        const { port1, port2 } = makeChannel();
        const seen = [];
        port2.onmessage = ({ data }) => seen.push(data);
        attachPanel({ id: 'x:a', port: port1 });
        await settle();

        detachPanel('x:a');
        assert.deepStrictEqual(attachedPanelIds(), []);
        assert.ok(port1.closed, 'the port was left open');

        seen.length = 0;
        publishToPanels('tuning', { frequency: 1 });
        await settle();
        assert.strictEqual(seen.length, 0, 'a detached panel is still being published to');
    });

    // --- the runtime, at the frame's end -------------------------------------

    function fakeFrame() {
        const scope = {
            _handlers: [],
            addEventListener(type, fn) { if (type === 'message') this._handlers.push(fn); },
            deliver(ev) { for (const fn of this._handlers) fn(ev); },
            __ubersdrPanel: { minimal: true },
        };
        // No `parent` by default: the runtime must not throw when there is
        // nothing to announce itself to.
        globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
        globalThis.document = { documentElement: { scrollHeight: 220 }, body: {} };
        globalThis.ResizeObserver = undefined;
        globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
        return scope;
    }

    await ta('the runtime waits for a port and only then is ready', async () => {
        resetPanelHosts();
        setPanelDeps(fakeDeps());
        const scope = fakeFrame();
        const api = startPanelRuntime(scope);

        let resolved = false;
        api.ready().then(() => { resolved = true; });
        await settle();
        assert.strictEqual(resolved, false, 'ready resolved before a port arrived');

        const { port1, port2 } = makeChannel();
        attachPanel({ id: 'x:a', port: port1, onHeight: () => {} });
        scope.deliver({ data: { 'ubersdr.panel-port': true }, ports: [port2] });

        const sdr = await api.ready();
        assert.ok(sdr, 'ready never resolved');
        assert.strictEqual(sdr.minimal, true, 'the panel was not told it is in its minimal view');
        resetPanelHosts();
    });

    await ta('the frame announces itself, so a cached remount is not a lost race', async () => {
        // The bug: toggling the minimal view rebuilds the document, and with the
        // runtime and body both cached the frame is created, parsed and loaded
        // before the parent's effect attaches its listener. The load event had
        // been and gone, the port was never sent, and the panel sat at its own
        // "Loading…" for ever.
        //
        // So the frame says hello as it parses. Here the runtime starts with no
        // parent listening at all — the hello goes into nothing — and the port
        // still arrives when the parent gets round to it.
        resetPanelHosts();
        setPanelDeps(fakeDeps());

        const posted = [];
        const scope = fakeFrame();
        scope.parent = { postMessage: (msg) => posted.push(msg) };

        const api = startPanelRuntime(scope);
        assert.ok(posted.some((m) => m && m['ubersdr.panel-hello'] === true),
            'the frame never announced itself, so a parent that missed `load` can never recover');

        const { port1, port2 } = makeChannel();
        attachPanel({ id: 'x:a', port: port1, onHeight: () => {} });
        scope.deliver({ data: { 'ubersdr.panel-port': true }, ports: [port2] });

        const sdr = await api.ready();
        assert.ok(sdr, 'the panel never became ready');
        resetPanelHosts();
    });

    await ta('a panel can drive the receiver through the port', async () => {
        // The round trip that matters: a panel calls a command, the parent's own
        // command implementation runs, and the answer comes back.
        resetPanelHosts();
        let ran = null;
        setPanelDeps(fakeDeps({ command: (name, args) => { ran = { name, args }; return { frequency: args.frequency }; } }));

        const scope = fakeFrame();
        const api = startPanelRuntime(scope);
        const { port1, port2 } = makeChannel();
        attachPanel({ id: 'x:a', port: port1, onHeight: () => {} });
        scope.deliver({ data: { 'ubersdr.panel-port': true }, ports: [port2] });

        const sdr = await api.ready();
        const out = await sdr.command('tune', { frequency: 14074000 });
        assert.deepStrictEqual(ran, { name: 'tune', args: { frequency: 14074000 } });
        assert.strictEqual(out.frequency, 14074000);
        resetPanelHosts();
    });

    await ta('a panel can identify the receiver it is on', async () => {
        // sdr.receiver read a property the client does not have, so it was null
        // for ever without ever looking broken — a panel keying anything by
        // receiver would have keyed it by nothing.
        resetPanelHosts();
        setPanelDeps(fakeDeps());
        const scope = fakeFrame();
        const api = startPanelRuntime(scope);
        const { port1, port2 } = makeChannel();
        attachPanel({ id: 'x:a', port: port1, onHeight: () => {} });
        scope.deliver({ data: { 'ubersdr.panel-port': true }, ports: [port2] });

        const sdr = await api.ready();
        assert.ok(sdr.receiver, 'sdr.receiver is null — the panel cannot tell which receiver it is on');
        assert.strictEqual(sdr.receiver.callsign, 'M9PSY');
        assert.strictEqual(sdr.receiver.id, 'rx-1');
        resetPanelHosts();
    });

    await ta('a panel can read a subscribed topic synchronously', async () => {
        resetPanelHosts();
        setPanelDeps(fakeDeps());
        const scope = fakeFrame();
        const api = startPanelRuntime(scope);
        const { port1, port2 } = makeChannel();
        attachPanel({ id: 'x:a', port: port1, onHeight: () => {} });
        scope.deliver({ data: { 'ubersdr.panel-port': true }, ports: [port2] });

        const sdr = await api.ready();
        await sdr.subscribe(['tuning']);
        assert.strictEqual(sdr.state('tuning').frequency, 14074000,
            'state() did not return the snapshot subscribe already delivered');
        resetPanelHosts();
    });

    await ta('a handler is given the current value, not only later changes', async () => {
        // The failure this prevents: the page API is a patch protocol, so a
        // topic that does not change after subscribing produces no message at
        // all. A panel that draws only from its handler then never draws — and
        // the first panel anybody wrote did exactly that, sitting on its own
        // "Loading…" for ever once the session had settled.
        resetPanelHosts();
        setPanelDeps(fakeDeps());
        const scope = fakeFrame();
        const api = startPanelRuntime(scope);
        const { port1, port2 } = makeChannel();
        attachPanel({ id: 'x:a', port: port1, onHeight: () => {} });
        scope.deliver({ data: { 'ubersdr.panel-port': true }, ports: [port2] });

        const sdr = await api.ready();
        const seen = [];
        sdr.on('tuning', (t) => seen.push(t));
        await sdr.subscribe(['tuning']);
        await settle();

        // Nothing has *changed* — no publish has happened at all — and the
        // handler must still have been given the opening value.
        assert.ok(seen.length > 0, 'the handler was never given the current value');
        assert.strictEqual(seen[0].frequency, 14074000);
        resetPanelHosts();
    });

    await ta('a handler registered after subscribing is given it too', async () => {
        resetPanelHosts();
        setPanelDeps(fakeDeps());
        const scope = fakeFrame();
        const api = startPanelRuntime(scope);
        const { port1, port2 } = makeChannel();
        attachPanel({ id: 'x:a', port: port1, onHeight: () => {} });
        scope.deliver({ data: { 'ubersdr.panel-port': true }, ports: [port2] });

        const sdr = await api.ready();
        await sdr.subscribe(['tuning']);
        const seen = [];
        sdr.on('tuning', (t) => seen.push(t));
        await settle();

        assert.ok(seen.length > 0, 'a late handler was never given the current value');
        resetPanelHosts();
    });

    await ta('a panel can see all four VFOs without retuning anything', async () => {
        // `tuning` carries the active VFO only. Until the `vfos` topic existed,
        // reading the other three meant switching to each in turn — which really
        // retunes the receiver, audibly, on a receiver other people are
        // listening to. So a panel showing four frequencies could not be built.
        resetPanelHosts();
        setPanelDeps(fakeDeps({
            snapshot: (topic) => (topic === 'vfos' ? {
                active: 'B',
                slots: [
                    { id: 'A', active: false, frequency: 7100000, mode: 'lsb' },
                    { id: 'B', active: true, frequency: 14074000, mode: 'usb' },
                    { id: 'C', active: false, frequency: null, mode: null },
                    { id: 'D', active: false, frequency: 3573000, mode: 'usb' },
                ],
            } : null),
        }));

        const scope = fakeFrame();
        const api = startPanelRuntime(scope);
        const { port1, port2 } = makeChannel();
        attachPanel({ id: 'x:a', port: port1, onHeight: () => {} });
        scope.deliver({ data: { 'ubersdr.panel-port': true }, ports: [port2] });

        const sdr = await api.ready();
        const vfos = await sdr.get('vfos');

        assert.strictEqual(vfos.slots.length, 4, 'four slots, always, so four rows can be laid out');
        assert.strictEqual(vfos.active, 'B');
        assert.strictEqual(vfos.slots[0].frequency, 7100000, 'an inactive VFO is readable');
        assert.strictEqual(vfos.slots[1].active, true);
        assert.strictEqual(vfos.slots[2].frequency, null, 'a never-used slot is null, not absent');
        resetPanelHosts();
    });

    await ta('audio and spectrum ports reach the frame, not the page window', async () => {
        // The bug: the page hands these ports to `window`, targeted at its own
        // origin. That is right for an extension, which shares both, and useless
        // for a panel — a sandboxed frame on an opaque origin. The command
        // answered `streaming: true` and the panel waited for a port that had
        // gone somewhere it could never see.
        resetPanelHosts();

        let deliverer = null;
        setPanelDeps(fakeDeps({
            command: (name, args, extra) => {
                if (name === 'spectrumdata' && args.action === 'start') {
                    deliverer = extra && extra.deliverPort;
                    return { streaming: true };
                }
                return { ran: name };
            },
        }));

        const scope = fakeFrame();
        const api = startPanelRuntime(scope);
        const { port1, port2 } = makeChannel();
        attachPanel({ id: 'x:a', port: port1, onHeight: () => {} });
        scope.deliver({ data: { 'ubersdr.panel-port': true }, ports: [port2] });
        const sdr = await api.ready();

        const frames = [];
        await sdr.onSpectrum((f) => frames.push(f), 4);
        assert.ok(typeof deliverer === 'function',
            'the command was not told where to put the port — it would go to the page window');

        // The page delivers, as BridgeHost would.
        const stream = makeChannel();
        deliverer({ 'ubersdr.spectrum-port': 'panel' }, stream.port2);
        await settle();
        stream.port1.postMessage({ binCount: 3, centerFreq: 14100000, timestamp: 7 });
        await settle();

        assert.strictEqual(frames.length, 1, 'the frame never reached the panel');
        assert.strictEqual(frames[0].centerFreq, 14100000);
        resetPanelHosts();
    });

    await ta('a stream that arrives before its handler is not lost', async () => {
        // The command resolves before the port is delivered, so a panel that
        // awaits it and *then* registers would miss the handover. Whichever
        // comes second finds the other waiting.
        resetPanelHosts();
        let deliverer = null;
        setPanelDeps(fakeDeps({
            command: (name, args, extra) => {
                if (name === 'audio') { deliverer = extra && extra.deliverPort; return { streaming: true }; }
                return { ran: name };
            },
        }));
        const scope = fakeFrame();
        const api = startPanelRuntime(scope);
        const { port1, port2 } = makeChannel();
        attachPanel({ id: 'x:a', port: port1, onHeight: () => {} });
        scope.deliver({ data: { 'ubersdr.panel-port': true }, ports: [port2] });
        const sdr = await api.ready();

        const heard = [];
        await sdr.onAudio((a) => heard.push(a));
        const stream = makeChannel();
        deliverer({ 'ubersdr.audio-port': 'panel' }, stream.port2);
        await settle();
        stream.port1.postMessage({ sampleRate: 12000, frames: 2 });
        await settle();
        assert.strictEqual(heard.length, 1);
        assert.strictEqual(heard[0].sampleRate, 12000, 'the rate follows the mode; a panel must read it');
        resetPanelHosts();
    });

    await ta('a panel hears a topic it subscribed to', async () => {
        resetPanelHosts();
        setPanelDeps(fakeDeps());
        const scope = fakeFrame();
        const api = startPanelRuntime(scope);
        const { port1, port2 } = makeChannel();
        attachPanel({ id: 'x:a', port: port1, onHeight: () => {} });
        scope.deliver({ data: { 'ubersdr.panel-port': true }, ports: [port2] });

        const sdr = await api.ready();
        const seen = [];
        sdr.on('tuning', (v) => seen.push(v));
        await sdr.subscribe(['tuning']);
        publishToPanels('tuning', { frequency: 7100000, mode: 'lsb' });
        await settle();

        assert.ok(seen.length, 'the panel heard nothing');
        assert.strictEqual(seen[seen.length - 1].frequency, 7100000);
        resetPanelHosts();
    });

    // The bug this catches: the spot feeds are started only when a host reports
    // that somebody wants them, and a panel host that never reported its edges
    // subscribed to a topic the page had not switched on. The panel's handler
    // was registered, the topic was live, and nothing was ever published to it —
    // a silence indistinguishable from a quiet band.
    await ta('a panel subscribing to a lazily acquired feed asks the page for it', async () => {
        resetPanelHosts();
        const demands = [];
        setPanelDeps(fakeDeps({ onDemand: (topic, wanted) => demands.push([topic, wanted]) }));
        const scope = fakeFrame();
        const api = startPanelRuntime(scope);
        const { port1, port2 } = makeChannel();
        attachPanel({ id: 'x:a', port: port1, onHeight: () => {} });
        scope.deliver({ data: { 'ubersdr.panel-port': true }, ports: [port2] });

        const sdr = await api.ready();
        await sdr.subscribe(['spots']);
        await settle();
        assert.deepStrictEqual(demands, [['spots', true]],
            'the page was never told a panel wants the spot feeds');

        detachPanel('x:a');
        await settle();
        assert.deepStrictEqual(demands[demands.length - 1], ['spots', false],
            'a panel that goes away must let the feeds stop');
        resetPanelHosts();
    });

    await ta('two panels wanting the same feed each report, so neither ends the other', async () => {
        resetPanelHosts();
        const demands = [];
        setPanelDeps(fakeDeps({ onDemand: (topic, wanted) => demands.push([topic, wanted]) }));
        const panels = [];
        for (const id of ['x:a', 'x:b']) {
            const scope = fakeFrame();
            const api = startPanelRuntime(scope);
            const { port1, port2 } = makeChannel();
            attachPanel({ id, port: port1, onHeight: () => {} });
            scope.deliver({ data: { 'ubersdr.panel-port': true }, ports: [port2] });
            const sdr = await api.ready();
            await sdr.subscribe(['spots']);
            panels.push(id);
        }
        await settle();
        // Both edges, not one: the page counts them, and a host that stayed
        // quiet because another had already asked would leave the survivor
        // holding a released feed.
        assert.deepStrictEqual(demands, [['spots', true], ['spots', true]]);

        detachPanel('x:a');
        await settle();
        assert.deepStrictEqual(demands, [['spots', true], ['spots', true], ['spots', false]]);
        detachPanel('x:b');
        await settle();
        assert.strictEqual(demands.length, 4);
        resetPanelHosts();
    });

    await ta('a palette change reaches an open panel', async () => {
        // A frame inherits none of the parent's custom properties, so without
        // this an open panel keeps the colours it was born with — and the zoom
        // buttons in its own header do nothing to its contents.
        resetPanelHosts();
        setPanelDeps(fakeDeps());
        const scope = fakeFrame();
        const applied = [];
        globalThis.document = {
            documentElement: {
                scrollHeight: 220,
                setAttribute: (name, value) => { if (name === 'style') applied.push(value); },
            },
            body: {},
        };
        const api = startPanelRuntime(scope);
        const { port1, port2 } = makeChannel();
        attachPanel({ id: 'x:a', port: port1, onHeight: () => {} });
        scope.deliver({ data: { 'ubersdr.panel-port': true }, ports: [port2] });
        await api.ready();

        themeToPanels('--fg:#000;--ui-scale:1.25;');
        await settle();

        assert.ok(applied.some((v) => v.includes('--ui-scale:1.25')),
            'the panel never applied the pushed palette: ' + JSON.stringify(applied));
        resetPanelHosts();
    });

    await ta('the panel reports the height it wants to be', async () => {
        // The parent cannot measure an opaque-origin document, so this is the
        // only way a panel gets the right size.
        resetPanelHosts();
        setPanelDeps(fakeDeps());
        const scope = fakeFrame();
        const api = startPanelRuntime(scope);
        const { port1, port2 } = makeChannel();
        const heights = [];
        attachPanel({ id: 'x:a', port: port1, onHeight: (px) => heights.push(px) });
        scope.deliver({ data: { 'ubersdr.panel-port': true }, ports: [port2] });

        const sdr = await api.ready();
        await settle();
        assert.ok(heights.includes(220), 'no initial height was reported: ' + heights.join(','));

        sdr.height(310);
        await settle();
        assert.strictEqual(heights[heights.length - 1], 310);

        // Unchanged heights are not resent — a ResizeObserver fires on every
        // layout, and a message per layout is a message per frame.
        const before = heights.length;
        sdr.height(310);
        await settle();
        assert.strictEqual(heights.length, before, 'an unchanged height was sent again');
        resetPanelHosts();
    });

    await ta('storage degrades to nothing rather than failing the panel', async () => {
        // No IndexedDB in node, which is exactly the private-mode case.
        assert.deepStrictEqual(await readAll('x:a'), {});
        assert.strictEqual(await writeKey('x:a', 'city', 'London'), 'storage is unavailable');
        // And a bad key is refused before storage is even consulted.
        assert.ok(await writeKey('x:a', '', 'x'));
    });

    // --- the document a panel runs in ----------------------------------------

    t('the assembled document carries the runtime before the panel', () => {
        const doc = buildSrcdoc({
            runtime: 'RUNTIME_HERE',
            body: '<div id="mine"></div><script type="module">ubersdr.ready()<\/script>',
            theme: '--fg:#fff;',
            minimal: true,
        });
        assert.ok(doc.indexOf('RUNTIME_HERE') < doc.indexOf('id="mine"'),
            'the panel would run before its own API existed');
        assert.ok(doc.includes('--fg:#fff;'), 'the theme did not reach the frame');
        assert.ok(doc.includes('"minimal":true'), 'the panel is not told about the minimal view');
        assert.ok(doc.startsWith('<!doctype html>'), 'not a document');
    });

    t('the frame is told the page\'s colour scheme, or it paints itself white', () => {
        // A frame inherits no CSS, so without a declared scheme it is a `light`
        // document — and a light document's *canvas* is painted white by the
        // browser. `background: transparent` on the body cannot help, because
        // the canvas underneath is what is painted. Every panel then sits on a
        // white slab in a dark receiver, however well its author used the theme
        // variables.
        const saved = globalThis.getComputedStyle;
        globalThis.getComputedStyle = () => ({
            getPropertyValue: (name) => ({
                'color-scheme': 'dark',
                '--text': '#e8eaed',
                '--ui-scale': '1.25',
            }[name] || ''),
        });
        globalThis.document = globalThis.document || {};
        globalThis.document.documentElement = globalThis.document.documentElement || {};
        try {
            const decls = themeDeclarations();
            assert.ok(/color-scheme:\s*dark/.test(decls),
                'the scheme is not carried into the frame: ' + decls);
            assert.ok(decls.includes('--text:#e8eaed'), 'colours are not carried: ' + decls);
            assert.ok(decls.includes('--ui-scale:1.25'), 'the zoom is not carried: ' + decls);
        } finally {
            globalThis.getComputedStyle = saved;
        }
    });

    t('every theme variable a panel is given actually exists', () => {
        // The list was invented once — `--fg`, `--bg-raised`, `--line`, none of
        // which are real names — and because a missing custom property resolves
        // to the author's fallback rather than to an error, every panel looked
        // correct on the dark theme and put near-white text on a light surface.
        // Nothing failed; it was just quietly wrong.
        const srcdoc = fs.readFileSync(path.join(__dirname, '..', 'src', 'panels', 'custom', 'srcdoc.js'), 'utf8');
        const listed = [...srcdoc.slice(srcdoc.indexOf('const THEME_VARS'), srcdoc.indexOf('];'))
            .matchAll(/'(--[a-z0-9-]+)'/g)].map((m) => m[1]);
        assert.ok(listed.length > 8, 'could not read the theme list');

        const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
        const root = styles.slice(styles.indexOf(':root {'), styles.indexOf('\n}', styles.indexOf(':root {')));
        const real = new Set([...root.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

        const invented = listed.filter((v) => !real.has(v));
        assert.deepStrictEqual(invented, [],
            'these are passed to panels but are not defined in :root, so they resolve to nothing');
    });

    t('the base stylesheet uses only variables panels are given', () => {
        const srcdoc = fs.readFileSync(path.join(__dirname, '..', 'src', 'panels', 'custom', 'srcdoc.js'), 'utf8');
        const listed = new Set([...srcdoc.slice(srcdoc.indexOf('const THEME_VARS'), srcdoc.indexOf('];'))
            .matchAll(/'(--[a-z0-9-]+)'/g)].map((m) => m[1]));
        const css = srcdoc.slice(srcdoc.indexOf('const BASE_CSS'));
        const used = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
        const orphan = [...new Set(used)].filter((v) => !listed.has(v));
        assert.deepStrictEqual(orphan, [],
            'the frame\'s own stylesheet references variables it is never sent');
    });

    t('the assembled document paints no background of its own', () => {
        const doc = buildSrcdoc({ runtime: '', body: '', theme: 'color-scheme:dark;', minimal: false });
        assert.ok(/html,body\{[^}]*background:transparent/.test(doc),
            'the root has no explicit transparent background, so the UA paints one');
        assert.ok(doc.includes('color-scheme:dark;'), 'the scheme did not reach the document');
    });

    console.log(`\n${pass} ok`);
})();
