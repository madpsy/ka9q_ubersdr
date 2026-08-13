'use strict';

// A local origin for the multi-monitor page.
//
// Every other local page in this client — the chooser, the serial picker — is
// loaded with `loadFile`, and that is right for them: they are documents, they
// fetch nothing, and file:// costs nothing. The monitor cannot be, for two
// reasons that both come down to it having no origin:
//
//   1. Hamlib. hamlib.js is an Emscripten module and fetches hamlib.wasm at run
//      time. `fetch()` is not allowed on file:// in Electron, and inside an
//      app.asar there is no real file to fall back to either — so rig sync
//      would fail with something that reads like a missing file rather than a
//      scheme restriction. This is the one that forces the issue.
//
//   2. CORS. The page asks instances.ubersdr.org for the instance list and the
//      caller's IP. A file:// page sends `Origin: null`, which no sensible
//      server allows. From http://127.0.0.1 it is an ordinary cross-origin
//      request that the directory already answers for the chooser.
//
// Not InstanceProxy. That is bound to one upstream receiver — host, port, TLS,
// a proxied websocket — and the monitor has no upstream: it talks to N
// instances directly, at their own public URLs, which is the whole reason the
// collector's client takes a base URL per connection. So this serves a
// directory and nothing else, and is about as much web server as that needs.

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const { API_USER_AGENT } = require('./useragent');

// The collector, which the page expects to be served by.
//
// Upstream it is: multi_monitor.js asks for `/api/instances` and `/api/myip`
// with no host, because there the page and the API are the same origin.
// shared_session.js does the same for `/api/shared-sessions`. Here they would
// be requests to this static server, which has no such thing.
//
// So they are proxied rather than rewritten. Rewriting means editing the
// verbatim files — the ones deliberately kept diffable against upstream — and
// would trade a same-origin call for a cross-origin one that the directory has
// no reason to allow. Proxying reproduces the arrangement the page was written
// for, and the CORS question never arises.
//
// Same host discovery.js already uses for the chooser's directory tab.
const API_HOST = 'https://instances.ubersdr.org';
const API_PREFIX = '/api/';

// The one call the page makes to an instance rather than to the directory, and
// the one that cannot be made from here directly.
//
// Before opening an audio socket, minimal-radio.js POSTs `/connection` to the
// instance to register its session UUID; the instance refuses `/ws` for a UUID
// that never did. That POST is JSON, so it is preflighted, and an instance only
// answers a preflight when its operator has set `enable_cors` or when the
// request comes from the collector's own hostname. A page on 127.0.0.1 is
// neither: the OPTIONS falls through to a handler that takes POST only, comes
// back 405, and the browser never sends the POST at all. Every tile then fails
// with "Invalid session" and retries every five seconds. At the time of writing
// 44 of the 45 instances in the directory report `cors_enabled: false`, so this
// is nearly all of them, not an edge case.
//
// Proxying it here is the same move `/api/` already makes, for the same reason,
// and it works against instances as they are rather than as they might be once
// operators upgrade. A `base` query parameter says which instance to ask; the
// page's fetch shim in index.html is what puts it there.
const CONNECTION_PATH = '/connection';

// A session registration is a few dozen bytes of JSON. The cap is not about
// this server's memory — it is so that a local process that finds this port
// cannot use it to push a large body at somebody else's receiver.
const CONNECTION_MAX_BODY = 4096;

// Same table as proxy.js, plus the one it has no reason to know about. A wasm
// file served as application/octet-stream is refused by
// WebAssembly.instantiateStreaming, which is exactly how hamlib arrives.
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.map': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.wasm': 'application/wasm',
};

class MonitorServer {
    /** @param {string} root directory to serve — clients/electron/monitor */
    constructor(root) {
        this.root = path.normalize(root);
        this.server = null;
        this.origin = null;
    }

    /** Resolves to the origin it bound to. Port 0: the OS picks a free one. */
    start() {
        if (this.origin) return Promise.resolve(this.origin);
        this.server = http.createServer((req, res) => this.handle(req, res));
        return new Promise((resolve, reject) => {
            this.server.once('error', reject);
            // 127.0.0.1, never 0.0.0.0 — this serves the app's own files and
            // has no business being reachable from the network.
            this.server.listen(0, '127.0.0.1', () => {
                this.origin = `http://127.0.0.1:${this.server.address().port}`;
                resolve(this.origin);
            });
        });
    }

    stop() {
        if (!this.server) return;
        this.server.close();
        this.server.closeAllConnections?.();
        this.server = null;
        this.origin = null;
    }

    handle(req, res) {
        const pathname = (req.url || '/').split('?')[0];

        // Before the method check: the shared-session API is written to with
        // POST and DELETE, and those are the collector's to answer, not ours to
        // refuse.
        if (pathname.startsWith(API_PREFIX)) {
            this.proxyApi(req, res);
            return;
        }

        // Also before the method check, and for the same reason: this one is a
        // POST. See CONNECTION_PATH.
        if (pathname === CONNECTION_PATH) {
            this.proxyConnection(req, res);
            return;
        }

        // GET and HEAD only. Nothing served from disk here is writable, and a
        // server that answers anything else is a larger thing to reason about
        // than one that does not.
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { Allow: 'GET, HEAD' });
            res.end();
            return;
        }

        let rel;
        try {
            rel = decodeURIComponent((req.url || '/').split('?')[0]);
        } catch {
            // A malformed percent-escape is a bad request, not a 500.
            res.writeHead(400);
            res.end();
            return;
        }
        if (rel === '/' || rel === '') rel = '/index.html';

        // Resolved and then checked, rather than checked and then resolved:
        // `..` and symlinks both only show up once the path is real. Nothing
        // outside the served directory is reachable however the URL is spelt.
        const file = path.normalize(path.join(this.root, rel));
        if (file !== this.root && !file.startsWith(this.root + path.sep)) {
            res.writeHead(403);
            res.end();
            return;
        }

        let stat;
        try {
            stat = fs.statSync(file);
        } catch {
            res.writeHead(404);
            res.end();
            return;
        }
        if (!stat.isFile()) {
            res.writeHead(404);
            res.end();
            return;
        }

        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Content-Length': stat.size,
            // Same reasoning as the proxy's staged UI: these files change with
            // the app, and nothing here is fingerprinted, so a cached copy from
            // the previous version is a bug waiting to be reported.
            'Cache-Control': 'no-cache',
        });
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(file).pipe(res);
    }

    /**
     * Passes an /api/ call through to the collector, method and body and all.
     *
     * Headers are rebuilt rather than forwarded. The incoming ones describe a
     * request to 127.0.0.1 — its host, its origin, its referer, whatever
     * cookies this origin has collected — and sending those upstream would at
     * best confuse it and at worst leak where the page is running from. What
     * the collector needs is the method, the path, the content type and a user
     * agent, which is the same one discovery.js identifies this client with.
     */
    proxyApi(req, res) {
        const upstream = new URL(req.url, API_HOST);
        const headers = {
            'User-Agent': API_USER_AGENT,
            Accept: req.headers.accept || 'application/json',
        };
        if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];

        const out = https.request({
            hostname: upstream.hostname,
            port: upstream.port || 443,
            path: upstream.pathname + upstream.search,
            method: req.method,
            headers,
        }, (up) => {
            // The status and the body as they came, minus anything about the
            // upstream connection. The page reads JSON and status codes.
            const pass = {};
            for (const name of ['content-type', 'cache-control']) {
                if (up.headers[name]) pass[name] = up.headers[name];
            }
            res.writeHead(up.statusCode || 502, pass);
            up.pipe(res);
        });

        // A directory that is unreachable is a gateway problem, and saying so
        // is what lets the page show "could not load instances" rather than
        // hanging on a socket that will never answer.
        out.setTimeout(15000, () => out.destroy(new Error('timeout')));
        out.on('error', () => {
            if (res.headersSent) { res.destroy(); return; }
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end('{"error":"the instance directory could not be reached"}');
        });

        req.pipe(out);
    }

    /**
     * Registers the page's session with one instance, on its behalf.
     *
     * `?base=https://host` names the instance; the path asked for upstream is
     * always `/connection`, never anything the caller supplies, so this is a
     * proxy to one endpoint rather than an open one. Only POST, only http and
     * https, and a body cap — see CONNECTION_MAX_BODY.
     *
     * The user agent is forwarded rather than replaced, which is the opposite
     * of what proxyApi does and deliberate: the instance records it against the
     * session, and moments later the same page opens a websocket to that
     * instance directly, carrying Chromium's own. Substituting one here would
     * make a single session look like two different clients in the operator's
     * session list.
     */
    proxyConnection(req, res) {
        const fail = (code, message) => {
            res.writeHead(code, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ allowed: false, reason: message }));
        };

        if (req.method !== 'POST') {
            res.writeHead(405, { Allow: 'POST' });
            res.end();
            return;
        }

        let base;
        try {
            base = new URL(new URL(req.url, 'http://127.0.0.1').searchParams.get('base') || '');
        } catch {
            fail(400, 'no instance to register with');
            return;
        }
        if (base.protocol !== 'https:' && base.protocol !== 'http:') {
            fail(400, 'instance URL is not http');
            return;
        }

        const length = Number(req.headers['content-length'] || 0);
        if (length > CONNECTION_MAX_BODY) {
            fail(413, 'session registration too large');
            return;
        }

        const transport = base.protocol === 'https:' ? https : http;
        const out = transport.request({
            hostname: base.hostname,
            port: base.port || (base.protocol === 'https:' ? 443 : 80),
            path: CONNECTION_PATH,
            method: 'POST',
            headers: {
                'User-Agent': req.headers['user-agent'] || API_USER_AGENT,
                'Content-Type': req.headers['content-type'] || 'application/json',
                Accept: 'application/json',
            },
        }, (up) => {
            const pass = {};
            if (up.headers['content-type']) pass['content-type'] = up.headers['content-type'];
            res.writeHead(up.statusCode || 502, pass);
            up.pipe(res);
        });

        // Instances go offline, and the page has a tile per instance waiting on
        // this. Ten seconds is long enough for a slow tunnel and short enough
        // that a dead one shows as an error rather than as a tile that never
        // resolves.
        out.setTimeout(10000, () => out.destroy(new Error('timeout')));
        out.on('error', () => {
            if (res.headersSent) { res.destroy(); return; }
            fail(502, 'the instance could not be reached');
        });

        // Anything past the cap is a caller that ignored the content-length it
        // declared, so stop rather than forward it.
        let seen = 0;
        req.on('data', (chunk) => {
            seen += chunk.length;
            if (seen > CONNECTION_MAX_BODY) { req.destroy(); out.destroy(); }
        });
        req.pipe(out);
    }
}

module.exports = { MonitorServer };
