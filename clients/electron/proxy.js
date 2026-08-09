'use strict';

// Per-instance localhost reverse proxy.
//
// The v2 frontend is same-origin by construction: relative fetches, websocket
// URLs built from location.host, root-absolute assets served by the instance.
// Rather than threading a base URL through it, each connected instance gets a
// server on 127.0.0.1:<port> that serves the bundled v2 artifacts for /v2/*
// and forwards everything else — /api, the websockets, the SSE streams, the
// shared root assets (/opus-decoder.min.js, worklets, leaflet, ...) and the
// v1 pages the legacy popups open — to the instance. The bundle then runs
// unmodified, and localStorage/cookies are per-instance for free because each
// instance's local port is a distinct origin.
//
// The local port is stable per instance (stored with it) for the same reason:
// settings live in localStorage keyed by origin.

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

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
    '.md': 'text/plain; charset=utf-8',
};

class InstanceProxy {
    /**
     * @param {object} opts
     * @param {string} opts.host        upstream host
     * @param {number} opts.port        upstream port
     * @param {boolean} opts.tls        upstream uses TLS
     * @param {boolean} opts.insecureTLS accept self-signed upstream certificates
     * @param {string|null} opts.uiDir  staged v2 artifacts (ui/v2); null = no builtin UI
     * @param {boolean} opts.builtin    serve the bundled UI for /v2/* (else proxy it too)
     * @param {number} opts.localPort   port to bind on 127.0.0.1
     */
    constructor(opts) {
        this.host = opts.host;
        this.port = opts.port;
        this.tls = !!opts.tls;
        this.insecureTLS = !!opts.insecureTLS;
        this.uiDir = opts.uiDir || null;
        this.builtin = !!opts.builtin && !!this.uiDir;
        this.localPort = opts.localPort;

        const defaultPort = this.tls ? 443 : 80;
        this.hostHeader = this.port === defaultPort ? this.host : `${this.host}:${this.port}`;
        this.upstreamOrigin = `${this.tls ? 'https' : 'http'}://${this.hostHeader}`;
        // servername must be omitted for IP literals or TLS setup fails
        this.servername = this.tls && net.isIP(this.host) === 0 ? this.host : undefined;

        this.agent = this.tls
            ? new https.Agent({ keepAlive: true, maxSockets: 32 })
            : new http.Agent({ keepAlive: true, maxSockets: 32 });

        this.server = null;
        this.localOrigin = null;
    }

    setBuiltin(on) {
        this.builtin = !!on && !!this.uiDir;
    }

    start() {
        this.server = http.createServer((req, res) => this.handle(req, res));
        this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
        // SSE responses stream forever; never time a request out server-side.
        this.server.requestTimeout = 0;
        this.server.headersTimeout = 30000;

        return new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(this.localPort, '127.0.0.1', () => {
                this.localPort = this.server.address().port;
                this.localOrigin = `http://127.0.0.1:${this.localPort}`;
                resolve(this.localPort);
            });
        });
    }

    stop() {
        if (!this.server) return;
        this.server.close();
        // close(): stops accepting, but live websockets/SSE hold it open —
        // drop them so the port frees immediately.
        this.server.closeAllConnections?.();
        this.server = null;
        this.agent.destroy();
    }

    handle(req, res) {
        const pathname = req.url.split('?')[0];

        // The service worker exists to make the browser PWA installable; a
        // desktop app has no use for it and a worker cached from one UI mode
        // could confuse the other. index.html registers it with a catch, so a
        // 404 here degrades to a console warning.
        if (pathname === '/sw.js') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('no service worker in the desktop client');
            return;
        }

        if (this.builtin && (pathname === '/v2' || pathname.startsWith('/v2/'))) {
            if (pathname === '/v2') {
                res.writeHead(302, { Location: '/v2/' });
                res.end();
                return;
            }
            if (this.serveStatic(pathname, res)) return;
            // not part of the staged bundle (e.g. /v2/README.md) — fall through
        }

        this.proxyRequest(req, res);
    }

    serveStatic(pathname, res) {
        let rel = decodeURIComponent(pathname.slice('/v2/'.length));
        if (rel === '') rel = 'index.html';
        const file = path.normalize(path.join(this.uiDir, rel));
        if (!file.startsWith(this.uiDir + path.sep) && file !== path.join(this.uiDir, 'index.html')) {
            return false;
        }
        let stat;
        try {
            stat = fs.statSync(file);
        } catch {
            return false;
        }
        if (!stat.isFile()) return false;

        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Content-Length': stat.size,
            // index must never be stale across app updates; the hashed-free
            // dist files change with it, so keep everything revalidating.
            'Cache-Control': 'no-cache',
        });
        fs.createReadStream(file).pipe(res);
        return true;
    }

    proxyRequest(req, res) {
        const headers = { ...req.headers };
        headers.host = this.hostHeader;
        if (headers.origin) headers.origin = this.upstreamOrigin;
        delete headers.connection;
        delete headers['proxy-connection'];
        delete headers['keep-alive'];

        const mod = this.tls ? https : http;
        const preq = mod.request({
            host: this.host,
            port: this.port,
            path: req.url,
            method: req.method,
            headers,
            agent: this.agent,
            servername: this.servername,
            rejectUnauthorized: !this.insecureTLS,
        }, (pres) => {
            const outHeaders = { ...pres.headers };
            // Redirects to the upstream's own origin must stay inside the
            // proxy or the window ends up genuinely cross-origin.
            if (outHeaders.location && outHeaders.location.startsWith(this.upstreamOrigin)) {
                outHeaders.location = outHeaders.location.slice(this.upstreamOrigin.length) || '/';
            }
            res.writeHead(pres.statusCode, outHeaders);
            pres.pipe(res);
        });

        preq.on('error', (err) => {
            if (res.headersSent) {
                res.destroy();
                return;
            }
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`upstream ${this.upstreamOrigin} unreachable: ${err.code || err.message}`);
        });
        req.on('aborted', () => preq.destroy());
        req.pipe(preq);
    }

    upgrade(req, socket, head) {
        const connect = () => {
            // Rebuild the handshake from rawHeaders so casing and ordering
            // survive; only Host and Origin change. Connection/Upgrade must
            // pass through untouched — they are the handshake.
            const lines = [`${req.method} ${req.url} HTTP/1.1`];
            for (let i = 0; i < req.rawHeaders.length; i += 2) {
                const key = req.rawHeaders[i];
                let value = req.rawHeaders[i + 1];
                const lower = key.toLowerCase();
                if (lower === 'host') value = this.hostHeader;
                else if (lower === 'origin') value = this.upstreamOrigin;
                lines.push(`${key}: ${value}`);
            }
            upstream.write(lines.join('\r\n') + '\r\n\r\n');
            if (head && head.length) upstream.write(head);
            // Audio frames are small and latency-sensitive.
            socket.setNoDelay(true);
            upstream.setNoDelay(true);
            socket.pipe(upstream);
            upstream.pipe(socket);
        };

        const upstream = this.tls
            ? tls.connect({
                host: this.host,
                port: this.port,
                servername: this.servername,
                rejectUnauthorized: !this.insecureTLS,
            }, connect)
            : net.connect({ host: this.host, port: this.port }, connect);

        const drop = () => {
            socket.destroy();
            upstream.destroy();
        };
        upstream.on('error', drop);
        socket.on('error', drop);
        upstream.on('close', () => socket.destroy());
        socket.on('close', () => upstream.destroy());
    }
}

module.exports = { InstanceProxy };
