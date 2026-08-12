package org.ubersdr.mobile;

import android.content.res.AssetManager;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * The receiver's loopback reverse proxy — a port of clients/electron/proxy.js.
 *
 * <p>The v2 frontend is same-origin by construction: relative fetches, websocket
 * URLs built from location.host, root-absolute assets served by the instance.
 * Rather than threading a base URL through it, the receiver gets a server on
 * 127.0.0.1 that serves the bundled v2 artifacts for /v2/* and forwards
 * everything else — /api, the websockets, the SSE streams, the shared root
 * assets (/opus-decoder.min.js, the worklets, leaflet, the fonts) and the v1
 * pages the legacy popups open — to the instance. The bundle then runs
 * unmodified.
 *
 * <p>This is what makes the app <em>bundled</em> rather than a wrapper, and on
 * Android it is the only arrangement that works. Serving the bundle from the
 * app's own origin and calling the instance across it would need CORS, which is
 * an operator setting that defaults off; EventSource, which nothing can proxy
 * natively for a page; and cleartext websockets from an https origin, which is
 * mixed content. Same-origin has none of those problems because none of them
 * are problems the desktop client has either.
 *
 * <p>The local port is stable per instance (assigned by the store) for the
 * reason it is there: settings live in localStorage keyed by origin, so a
 * receiver that came up on a different port each launch would come up with its
 * settings reset.
 *
 * <p>Two deliberate simplifications against the original, both invisible from
 * the page. Upstream connections are not pooled — every request opens one and
 * closes it, where proxy.js keeps an agent with 32 sockets — and responses are
 * relayed to the client with {@code Connection: close}. The cost is a TLS
 * handshake per request against a remote instance on first load; the benefit is
 * that the response body needs no interpretation at all, so SSE, chunked
 * encoding and everything else pass through as bytes.
 */
final class LocalProxy {

    private static final String TAG = "UberSDR";

    private final String host;
    private final int port;
    private final boolean tls;
    private final boolean insecureTLS;
    private final AssetManager assets;
    private final String hostHeader;
    private final String upstreamOrigin;

    private ServerSocket server;
    private int localPort;
    private volatile boolean running;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    LocalProxy(String host, int port, boolean tls, boolean insecureTLS, AssetManager assets) {
        this.host = host;
        this.port = port;
        this.tls = tls;
        this.insecureTLS = insecureTLS;
        this.assets = assets;
        int defaultPort = tls ? 443 : 80;
        String authority = host.indexOf(':') >= 0 ? "[" + host + "]" : host;
        this.hostHeader = port == defaultPort ? authority : authority + ":" + port;
        this.upstreamOrigin = (tls ? "https://" : "http://") + hostHeader;
    }

    /**
     * Binds, and returns the port actually bound.
     *
     * <p>The requested port is the instance's stored one. Losing it is better
     * than not connecting, so a port already taken falls back to an ephemeral
     * one — the caller stores what comes back, exactly as the desktop client
     * does on EADDRINUSE.
     */
    int start(int preferredPort) throws IOException {
        try {
            server = new ServerSocket(preferredPort, 50, InetAddress.getByName("127.0.0.1"));
        } catch (IOException e) {
            server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        }
        localPort = server.getLocalPort();
        running = true;
        pool.execute(this::accept);
        return localPort;
    }

    int localPort() {
        return localPort;
    }

    String origin() {
        return "http://127.0.0.1:" + localPort;
    }

    String upstreamOrigin() {
        return upstreamOrigin;
    }

    void stop() {
        running = false;
        try {
            if (server != null) server.close();
        } catch (IOException ignored) {
            // Closing to unblock accept(); the loop is already on its way out.
        }
        pool.shutdownNow();
    }

    private void accept() {
        while (running) {
            try {
                Socket client = server.accept();
                pool.execute(() -> {
                    try {
                        handle(client);
                    } catch (IOException e) {
                        // A page that navigated away mid-request. Normal.
                    } finally {
                        closeQuietly(client);
                    }
                });
            } catch (IOException e) {
                if (running) Log.w(TAG, "proxy accept failed", e);
                return;
            }
        }
    }

    // --- one request ---------------------------------------------------------

    private void handle(Socket client) throws IOException {
        client.setTcpNoDelay(true);
        InputStream in = client.getInputStream();
        OutputStream out = client.getOutputStream();

        String requestLine = readLine(in);
        if (requestLine == null || requestLine.isEmpty()) return;
        List<String> headers = new ArrayList<>();
        String line;
        while ((line = readLine(in)) != null && !line.isEmpty()) headers.add(line);

        String target = requestTarget(requestLine);
        String path = target.split("\\?", 2)[0];

        if (isUpgrade(headers)) {
            upgrade(client, requestLine, headers, in);
            return;
        }

        // The service worker exists to make the browser PWA installable. A
        // bundled app has no use for it, and one registered against this origin
        // would outlive the receiver it was registered for — the port is stable
        // per instance, so the next launch of that receiver would inherit it.
        // index.html registers it with a catch, so a 404 is a console warning.
        if ("/sw.js".equals(path)) {
            writeSimple(out, 404, "text/plain; charset=utf-8", "no service worker in the bundled client".getBytes("UTF-8"));
            return;
        }

        if (path.equals("/v2") ) {
            writeRedirect(out, "/v2/");
            return;
        }
        if (path.startsWith("/v2/") && serveStatic(path, out)) return;

        proxyRequest(requestLine, headers, in, out);
    }

    // --- the bundled UI ------------------------------------------------------

    private boolean serveStatic(String path, OutputStream out) throws IOException {
        String rel = path.substring("/v2/".length());
        if (rel.isEmpty()) rel = "index.html";
        // No traversal out of the staged tree. Assets have no symlinks and no
        // parent to escape to, but the path came off the wire.
        if (rel.contains("..")) return false;

        byte[] body;
        try {
            // `cap sync` copies www/ into assets/public/, so the staged bundle
            // that build.sh puts in www/v2/ is read from here.
            body = readAsset("public/v2/" + rel);
        } catch (IOException e) {
            // Not part of the staged bundle (/v2/README.md, say) — fall through
            // to the instance, which may have it.
            return false;
        }
        writeResponse(out, 200, mime(rel), body, "Cache-Control: no-cache");
        return true;
    }

    private byte[] readAsset(String name) throws IOException {
        try (InputStream in = assets.open(name)) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream(Math.max(in.available(), 8192));
            byte[] chunk = new byte[32 * 1024];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            return buf.toByteArray();
        }
    }

    private static String mime(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html")) return "text/html; charset=utf-8";
        if (lower.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (lower.endsWith(".css")) return "text/css; charset=utf-8";
        if (lower.endsWith(".json") || lower.endsWith(".map")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".ico")) return "image/x-icon";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".md")) return "text/plain; charset=utf-8";
        return "application/octet-stream";
    }

    // --- everything else -----------------------------------------------------

    private void proxyRequest(String requestLine, List<String> headers, InputStream clientIn, OutputStream clientOut)
            throws IOException {
        Socket upstream = connectUpstream();
        try {
            OutputStream up = upstream.getOutputStream();
            StringBuilder sb = new StringBuilder(requestLine).append("\r\n");
            long contentLength = -1;
            boolean chunked = false;
            for (String header : headers) {
                String lower = header.toLowerCase(Locale.ROOT);
                if (lower.startsWith("host:")) continue;
                if (lower.startsWith("origin:")) continue;
                if (lower.startsWith("connection:")) continue;
                if (lower.startsWith("proxy-connection:")) continue;
                if (lower.startsWith("keep-alive:")) continue;
                if (lower.startsWith("accept-encoding:")) continue;
                if (lower.startsWith("content-length:")) {
                    try { contentLength = Long.parseLong(header.substring(15).trim()); } catch (NumberFormatException ignored) { }
                }
                if (lower.startsWith("transfer-encoding:") && lower.contains("chunked")) chunked = true;
                sb.append(header).append("\r\n");
            }
            sb.append("Host: ").append(hostHeader).append("\r\n");
            // The page believes it is same-origin with the receiver, so its
            // Origin is the loopback one. Rewritten rather than dropped: an
            // instance that checks it should see the address it serves.
            if (hasHeader(headers, "origin")) sb.append("Origin: ").append(upstreamOrigin).append("\r\n");
            sb.append("Connection: close\r\n\r\n");
            up.write(sb.toString().getBytes("ISO-8859-1"));

            if (chunked) copy(clientIn, up, -1);
            else if (contentLength > 0) copy(clientIn, up, contentLength);
            up.flush();

            relayResponse(upstream.getInputStream(), clientOut);
        } catch (IOException e) {
            // Nothing has been written yet if the failure was in connecting, so
            // the page gets a status rather than a dropped socket — the same
            // 502 proxy.js answers with, and for the same reason: a receiver
            // that is not there should say so in the window.
            writeSimple(clientOut, 502,
                    "text/plain; charset=utf-8",
                    ("upstream " + upstreamOrigin + " unreachable: " + e.getMessage()).getBytes("UTF-8"));
        } finally {
            closeQuietly(upstream);
        }
    }

    /**
     * Status line and headers parsed only far enough to rewrite Location, then
     * bytes.
     *
     * <p>A redirect to the instance's own origin has to stay inside the proxy or
     * the window ends up genuinely cross-origin — at which point the page is
     * talking to the receiver from an origin the bundle was not served from,
     * and every same-origin assumption it makes stops being true at once.
     */
    private void relayResponse(InputStream upstreamIn, OutputStream clientOut) throws IOException {
        String statusLine = readLine(upstreamIn);
        if (statusLine == null) throw new IOException("upstream closed before responding");
        StringBuilder sb = new StringBuilder(statusLine).append("\r\n");
        String line;
        while ((line = readLine(upstreamIn)) != null && !line.isEmpty()) {
            String lower = line.toLowerCase(Locale.ROOT);
            if (lower.startsWith("location:")) {
                String value = line.substring(9).trim();
                if (value.startsWith(upstreamOrigin)) {
                    String rest = value.substring(upstreamOrigin.length());
                    line = "Location: " + (rest.isEmpty() ? "/" : rest);
                }
            } else if (lower.startsWith("connection:") || lower.startsWith("keep-alive:")) {
                continue;
            }
            sb.append(line).append("\r\n");
        }
        sb.append("Connection: close\r\n\r\n");
        clientOut.write(sb.toString().getBytes("ISO-8859-1"));
        clientOut.flush();
        // To EOF, flushing as it goes: this is the SSE path as much as the
        // JSON one, and a stream that is buffered until it ends is a stream
        // that never arrives.
        copy(upstreamIn, clientOut, -1);
    }

    // --- websockets ----------------------------------------------------------

    /**
     * Audio, spectrum, the dxcluster feed and the chat.
     *
     * <p>Nothing here speaks the protocol: the handshake is rebuilt with Host
     * and Origin changed and everything else — Connection, Upgrade, the key,
     * the subprotocols — passed through untouched, and after it the two sockets
     * are spliced. A proxy that parsed frames could get them wrong; one that
     * copies bytes cannot.
     */
    private void upgrade(Socket client, String requestLine, List<String> headers, InputStream clientIn) {
        Socket upstream = null;
        try {
            upstream = connectUpstream();
            upstream.setTcpNoDelay(true);
            StringBuilder sb = new StringBuilder(requestLine).append("\r\n");
            for (String header : headers) {
                String lower = header.toLowerCase(Locale.ROOT);
                if (lower.startsWith("host:")) continue;
                if (lower.startsWith("origin:")) continue;
                sb.append(header).append("\r\n");
            }
            sb.append("Host: ").append(hostHeader).append("\r\n");
            if (hasHeader(headers, "origin")) sb.append("Origin: ").append(upstreamOrigin).append("\r\n");
            sb.append("\r\n");
            upstream.getOutputStream().write(sb.toString().getBytes("ISO-8859-1"));
            upstream.getOutputStream().flush();

            final Socket up = upstream;
            // Audio frames are small and latency-sensitive, so neither
            // direction may sit in a buffer waiting for company.
            Thread down = new Thread(() -> {
                try { copy(up.getInputStream(), client.getOutputStream(), -1); }
                catch (IOException ignored) { }
                finally { closeQuietly(client); closeQuietly(up); }
            }, "ws-down");
            down.start();
            copy(clientIn, upstream.getOutputStream(), -1);
        } catch (IOException e) {
            // How a websocket normally ends, from this side: the other
            // direction saw its end close first and shut both sockets, and this
            // thread's blocked read threw. Only a failure worth the word is
            // logged as one — the audio and spectrum sockets close on every
            // retune and pause, and a warning per close is a log nobody reads.
            if (upstream == null || !upstream.isClosed()) Log.w(TAG, "websocket upgrade failed", e);
            else Log.d(TAG, "websocket closed: " + e.getMessage());
        } finally {
            closeQuietly(upstream);
            closeQuietly(client);
        }
    }

    private Socket connectUpstream() throws IOException {
        if (!tls) {
            Socket s = new Socket();
            s.connect(new java.net.InetSocketAddress(host, port), 15000);
            s.setTcpNoDelay(true);
            return s;
        }
        SSLSocketFactory factory = insecureTLS ? insecureFactory() : (SSLSocketFactory) SSLSocketFactory.getDefault();
        SSLSocket s = (SSLSocket) factory.createSocket();
        s.connect(new java.net.InetSocketAddress(host, port), 15000);
        s.setTcpNoDelay(true);
        // SNI, without which a shared host answers with the wrong certificate
        // or the wrong site. Omitted for an IP literal, where it is invalid.
        if (!isIpLiteral(host)) {
            try {
                javax.net.ssl.SSLParameters params = s.getSSLParameters();
                params.setServerNames(java.util.Collections.singletonList(new javax.net.ssl.SNIHostName(host)));
                s.setSSLParameters(params);
            } catch (IllegalArgumentException ignored) {
                // A hostname SNI will not accept; the handshake can still work.
            }
        }
        s.startHandshake();
        if (!insecureTLS) {
            javax.net.ssl.HostnameVerifier verifier = javax.net.ssl.HttpsURLConnection.getDefaultHostnameVerifier();
            if (!verifier.verify(host, s.getSession())) {
                closeQuietly(s);
                throw new IOException("certificate is for another host");
            }
        }
        return s;
    }

    private static boolean isIpLiteral(String host) {
        return host.indexOf(':') >= 0 || host.matches("^[0-9.]+$");
    }

    private static SSLSocketFactory insecureFactory() throws IOException {
        try {
            TrustManager[] trustAll = new TrustManager[]{
                new X509TrustManager() {
                    @Override public void checkClientTrusted(java.security.cert.X509Certificate[] c, String a) { }
                    @Override public void checkServerTrusted(java.security.cert.X509Certificate[] c, String a) { }
                    @Override public java.security.cert.X509Certificate[] getAcceptedIssuers() {
                        return new java.security.cert.X509Certificate[0];
                    }
                }
            };
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, trustAll, new java.security.SecureRandom());
            return ctx.getSocketFactory();
        } catch (java.security.GeneralSecurityException e) {
            throw new IOException("cannot build an insecure TLS context", e);
        }
    }

    // --- wire helpers --------------------------------------------------------

    /** A CRLF line, or null at EOF. Byte at a time: headers are small, and the body must not be over-read. */
    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream(128);
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') buf.write(c);
            if (buf.size() > 16 * 1024) throw new IOException("header line too long");
        }
        if (c == -1 && buf.size() == 0) return null;
        return buf.toString("ISO-8859-1");
    }

    private static void copy(InputStream in, OutputStream out, long limit) throws IOException {
        byte[] buf = new byte[32 * 1024];
        long left = limit;
        int n;
        while (limit < 0 || left > 0) {
            int want = limit < 0 ? buf.length : (int) Math.min(buf.length, left);
            n = in.read(buf, 0, want);
            if (n < 0) break;
            out.write(buf, 0, n);
            out.flush();
            if (limit >= 0) left -= n;
        }
    }

    private static String requestTarget(String requestLine) {
        String[] parts = requestLine.split(" ");
        return parts.length > 1 ? parts[1] : "/";
    }

    private static boolean hasHeader(List<String> headers, String name) {
        String prefix = name.toLowerCase(Locale.ROOT) + ":";
        for (String h : headers) {
            if (h.toLowerCase(Locale.ROOT).startsWith(prefix)) return true;
        }
        return false;
    }

    private static boolean isUpgrade(List<String> headers) {
        for (String h : headers) {
            String lower = h.toLowerCase(Locale.ROOT);
            if (lower.startsWith("upgrade:") && lower.contains("websocket")) return true;
        }
        return false;
    }

    private static void writeResponse(OutputStream out, int status, String contentType, byte[] body, String extra)
            throws IOException {
        StringBuilder sb = new StringBuilder("HTTP/1.1 ").append(status).append(' ').append(reason(status)).append("\r\n");
        sb.append("Content-Type: ").append(contentType).append("\r\n");
        sb.append("Content-Length: ").append(body.length).append("\r\n");
        if (extra != null) sb.append(extra).append("\r\n");
        sb.append("Connection: close\r\n\r\n");
        out.write(sb.toString().getBytes("ISO-8859-1"));
        out.write(body);
        out.flush();
    }

    private static void writeSimple(OutputStream out, int status, String contentType, byte[] body) throws IOException {
        writeResponse(out, status, contentType, body, null);
    }

    private static void writeRedirect(OutputStream out, String location) throws IOException {
        String head = "HTTP/1.1 302 Found\r\nLocation: " + location + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes("ISO-8859-1"));
        out.flush();
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 302: return "Found";
            case 404: return "Not Found";
            case 502: return "Bad Gateway";
            default: return "OK";
        }
    }

    private static void closeQuietly(Socket s) {
        if (s == null) return;
        try { s.close(); } catch (IOException ignored) { }
    }
}
