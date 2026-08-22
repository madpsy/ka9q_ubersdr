// A custom panel's connection to the receiver.
//
// The port is the whole security boundary: the frame has an opaque origin and
// can do nothing except send messages down this channel. So what matters is what
// the parent does with what arrives — and that a panel really can drive the
// receiver through it, because a boundary nothing can cross is not a feature.

const assert = require('assert');

globalThis.location = { origin: 'https://rx.example' };

const {
    attachPanel, detachPanel, setPanelDeps, resetPanelHosts, fetchForPanel,
    publishToPanels, attachedPanelIds,
    buildSrcdoc, startPanelRuntime, writeKey, readAll,
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
        postMessage(data) {
            const to = this.other;
            if (!to || to.closed) return;
            // Asynchronous, as a real port is: a test that passed only because
            // both ends ran in one tick would not be testing the real thing.
            queueMicrotask(() => {
                if (to.onmessage) to.onmessage({ data });
                for (const fn of to._handlers) fn({ data });
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
    await ta('sdr.fetch refuses admin endpoints', async () => {
        // The one deviation from "a custom panel may do anything a built-in panel
        // may do". The parent performs the request, so it carries the operator's
        // session — and the operator may well be signed into admin in this very
        // browser.
        for (const path of ['/admin', '/admin/', '/admin/widgets/enabled', '/admin/config?x=1']) {
            const res = await fetchForPanel(path);
            assert.strictEqual(res.ok, false, path + ' was allowed');
            assert.ok(/admin/.test(res.error), path + ' was refused for the wrong reason');
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

    await ta('sdr.fetch cannot be walked back to admin with traversal', async () => {
        for (const path of ['/api/../admin/widgets/enabled', '/api/v2/../../admin/config']) {
            const res = await fetchForPanel(path);
            assert.strictEqual(res.ok, false, path + ' resolved past the denial');
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

    console.log(`\n${pass} ok`);
})();
