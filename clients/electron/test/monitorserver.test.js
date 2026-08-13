// The multi-monitor's local origin.
//
// It exists so the page has an origin at all — Hamlib's wasm cannot be fetched
// from file://, and the instance directory will not answer `Origin: null`. So
// the cases worth pinning are the ones that would send it back to those
// failures without looking like a failure: a wasm served as the wrong type is
// refused by the browser rather than by this, and a path that escapes the
// served directory is a local page reading the rest of the disk.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { MonitorServer } = require('../monitorserver.js');

let pass = 0;
const results = [];
const t = (name, fn) => results.push([name, fn]);

t('the page and its libraries are served with the types a browser needs', async (origin) => {
    const cases = [
        ['/', 'text/html'],
        ['/index.html', 'text/html'],
        ['/multi_monitor.js', 'text/javascript'],
        ['/vendor/leaflet.css', 'text/css'],
    ];
    for (const [url, type] of cases) {
        const res = await fetch(origin + url);
        assert.strictEqual(res.status, 200, url);
        assert.ok(res.headers.get('content-type').startsWith(type), `${url} -> ${res.headers.get('content-type')}`);
    }
});

// The reason the whole file exists. WebAssembly.instantiateStreaming refuses
// anything that is not application/wasm, and proxy.js's table — which this one
// was copied from — has no entry for it, so the default would be
// application/octet-stream and rig sync would fail in a way that looks like a
// missing file.
t('hamlib.wasm is served as application/wasm', async (origin) => {
    const res = await fetch(origin + '/hamlib/hamlib.wasm');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/wasm');
});

t('a missing file is a 404, not a crash', async (origin) => {
    assert.strictEqual((await fetch(origin + '/nope.js')).status, 404);
});

t('a directory is not a file', async (origin) => {
    assert.strictEqual((await fetch(origin + '/vendor')).status, 404);
});

// Escaping the served directory would make a local page a reader of the whole
// disk. Checked after resolution rather than before, so the spelling does not
// matter — encoded or not, traversal lands outside and is refused.
t('nothing outside the directory is reachable, however it is spelt', async (origin) => {
    for (const url of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json',
        '/vendor/../../package.json', '/./../../main.js']) {
        const res = await fetch(origin + url);
        assert.ok(res.status === 403 || res.status === 404, `${url} -> ${res.status}`);
    }
});

t('a malformed escape is a bad request rather than a 500', async (origin) => {
    assert.strictEqual((await fetch(origin + '/%zz')).status, 400);
});

// Nothing here is writable, so nothing but reads is answered.
t('only GET and HEAD are answered', async (origin) => {
    const res = await fetch(origin + '/index.html', { method: 'POST' });
    assert.strictEqual(res.status, 405);
    assert.strictEqual(res.headers.get('allow'), 'GET, HEAD');
});

t('HEAD gives the headers and no body', async (origin) => {
    const res = await fetch(origin + '/index.html', { method: 'HEAD' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), '');
});

// Bound on the loopback address: this serves the application's own files and
// has no business being reachable from the network.
t('it binds loopback only', async (origin) => {
    assert.ok(origin.startsWith('http://127.0.0.1:'), origin);
});

// The page asks for /api/instances and /api/myip with no host, because upstream
// it is served by the collector and they are same-origin. Serving the directory
// without proxying those is a page that loads and then does nothing at all,
// which is exactly how it failed the first time.
//
// Routing only — no assertion about the answer, so this does not need the
// network. Offline the proxy returns 502; what matters is that it is not the
// static handler's 404.
t('/api/ is proxied, not served from disk', async (origin) => {
    for (const url of ['/api/myip', '/api/instances?conditions=true&online_only=false']) {
        const res = await fetch(origin + url);
        assert.notStrictEqual(res.status, 404, `${url} fell through to the static handler`);
    }
});

// shared_session.js writes with POST and DELETE. Those are the collector's to
// answer or refuse, so the method check must not stand in front of them.
t('the method restriction does not apply to /api/', async (origin) => {
    const res = await fetch(origin + '/api/shared-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
    });
    assert.notStrictEqual(res.status, 405, 'the static method check swallowed an API write');
});

// ── /connection ───────────────────────────────────────────────────────────────
// The page registers its session with each instance before opening audio, and
// from this origin that POST is preflighted and refused by nearly every
// instance there is. Proxied here instead; monitorserver.js has the detail.
// Getting this wrong is not subtle — no tile connects at all — but it fails
// identically to an instance being down, which is how it went unnoticed once.

/** A stand-in instance that records the one request it is sent. */
function stubInstance() {
    const seen = {};
    const server = http.createServer((req, res) => {
        seen.method = req.method;
        seen.url = req.url;
        seen.userAgent = req.headers['user-agent'];
        seen.contentType = req.headers['content-type'];
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            seen.body = body;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"allowed":true,"max_session_time":0}');
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ seen, server, origin: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

t('a session registration reaches the instance and the answer comes back', async (origin) => {
    const inst = await stubInstance();
    try {
        const res = await fetch(`${origin}/connection?base=${encodeURIComponent(inst.origin)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'Chromium/1.2.3' },
            body: '{"user_session_id":"11111111-2222-4333-8444-555555555555"}',
        });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(await res.json(), { allowed: true, max_session_time: 0 });
        assert.strictEqual(inst.seen.method, 'POST');
        assert.strictEqual(inst.seen.url, '/connection');
        assert.strictEqual(inst.seen.contentType, 'application/json');
        assert.ok(inst.seen.body.includes('11111111-2222-4333-8444-555555555555'), inst.seen.body);
        // Same client the websocket will arrive as, not this proxy's own.
        assert.strictEqual(inst.seen.userAgent, 'Chromium/1.2.3');
    } finally {
        inst.server.close();
    }
});

// The path asked for upstream is fixed, so a local process that finds this port
// gets one endpoint on one host rather than a way to reach anything.
t('only /connection is ever requested upstream', async (origin) => {
    const inst = await stubInstance();
    try {
        await fetch(`${origin}/connection?base=${encodeURIComponent(inst.origin + '/admin/kick')}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        assert.strictEqual(inst.seen.url, '/connection');
    } finally {
        inst.server.close();
    }
});

t('/connection is a POST route, and not served from disk', async (origin) => {
    const res = await fetch(origin + '/connection');
    assert.strictEqual(res.status, 405);
    assert.strictEqual(res.headers.get('allow'), 'POST');
});

t('a registration with nowhere to go is refused, not proxied', async (origin) => {
    for (const url of ['/connection', '/connection?base=', '/connection?base=file:///etc/passwd',
        '/connection?base=not-a-url']) {
        const res = await fetch(origin + url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        assert.strictEqual(res.status, 400, `${url} -> ${res.status}`);
        assert.strictEqual((await res.json()).allowed, false);
    }
});

t('an oversized body is refused rather than forwarded', async (origin) => {
    const inst = await stubInstance();
    try {
        const res = await fetch(`${origin}/connection?base=${encodeURIComponent(inst.origin)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'x'.repeat(5000),
        });
        assert.strictEqual(res.status, 413);
        assert.strictEqual(inst.seen.method, undefined, 'it went upstream anyway');
    } finally {
        inst.server.close();
    }
});

t('an unreachable instance is a gateway error the page can show', async (origin) => {
    // Port 1 on loopback: nothing listens there, and the connection is refused
    // rather than left hanging.
    const res = await fetch(`${origin}/connection?base=${encodeURIComponent('http://127.0.0.1:1')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
    });
    assert.strictEqual(res.status, 502);
    assert.strictEqual((await res.json()).allowed, false);
});

// The other half of the same fix: minimal-radio.js is one of the files kept
// verbatim against upstream, so what points it at the proxy is a shim in
// index.html. Run here rather than in a browser, against a stubbed fetch.
t('the page shim sends /connection to the proxy and leaves everything else alone', () => {
    const markup = fs.readFileSync(path.join(__dirname, '..', 'monitor', 'index.html'), 'utf8');
    const shim = markup.match(/<script>\s*\(\(\) => \{[\s\S]*?\}\)\(\);\s*<\/script>/);
    assert.ok(shim, 'the /connection shim is no longer in index.html');

    const calls = [];
    const sandbox = {
        location: { href: 'http://127.0.0.1:49500/', origin: 'http://127.0.0.1:49500' },
        URL,
        window: { fetch: (input, init) => { calls.push([String(input), init]); } },
    };
    sandbox.window.location = sandbox.location;
    vm.createContext(sandbox);
    vm.runInContext(shim[0].replace(/<\/?script>/g, ''), sandbox);

    sandbox.window.fetch('https://sdr.example.org/connection', { method: 'POST', body: '{}' });
    assert.strictEqual(calls[0][0],
        '/connection?base=' + encodeURIComponent('https://sdr.example.org'));
    assert.strictEqual(calls[0][1].method, 'POST', 'the init was dropped');

    // A port and a scheme are part of which instance this is, so they have to
    // survive into `base` — two instances on one host differ only by port.
    sandbox.window.fetch('http://192.168.1.5:8073/connection', {});
    assert.strictEqual(calls[1][0],
        '/connection?base=' + encodeURIComponent('http://192.168.1.5:8073'));

    // Same-origin calls are the proxy's own and must not be rewritten again,
    // and the directory API is somebody else's route entirely.
    sandbox.window.fetch('/connection?base=https%3A%2F%2Fsdr.example.org', {});
    assert.strictEqual(calls[2][0], '/connection?base=https%3A%2F%2Fsdr.example.org');
    sandbox.window.fetch('/api/instances');
    assert.strictEqual(calls[3][0], '/api/instances');
    sandbox.window.fetch('https://sdr.example.org/status');
    assert.strictEqual(calls[4][0], 'https://sdr.example.org/status');
});

t('stopping frees it, and starting again works', async (_origin, server) => {
    server.stop();
    assert.strictEqual(server.origin, null);
    const again = await server.start();
    assert.ok(again.startsWith('http://127.0.0.1:'));
    assert.strictEqual((await fetch(again + '/index.html')).status, 200);
});

(async () => {
    for (const [name, fn] of results) {
        const server = new MonitorServer(path.join(__dirname, '..', 'monitor'));
        const origin = await server.start();
        try {
            await fn(origin, server);
            console.log('ok    ' + name);
            pass++;
        } catch (e) {
            console.log('FAIL  ' + name + '\n      ' + e.message);
            process.exitCode = 1;
        }
        server.stop();
    }
    console.log(`\n${pass} passed`);
})();
