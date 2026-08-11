// The multi-monitor's local origin.
//
// It exists so the page has an origin at all — Hamlib's wasm cannot be fetched
// from file://, and the instance directory will not answer `Origin: null`. So
// the cases worth pinning are the ones that would send it back to those
// failures without looking like a failure: a wasm served as the wrong type is
// refused by the browser rather than by this, and a path that escapes the
// served directory is a local page reading the rest of the disk.

const assert = require('assert');
const path = require('path');
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
