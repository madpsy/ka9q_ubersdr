package org.ubersdr.mobile;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.security.cert.CertPathValidatorException;
import java.security.cert.CertificateExpiredException;
import java.security.cert.X509Certificate;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLException;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * One GET, returning JSON text — the whole HTTP surface this client needs
 * before a receiver is open.
 *
 * <p>This is the native half of clients/electron/discovery.js's {@code getJson},
 * and it exists for the same two reasons that one does not use Node's fetch: a
 * LAN receiver often has a self-signed certificate, which has to be refusable
 * by default and acceptable per receiver on an explicit click; and the caller is
 * not same-origin with any of these hosts, so from the WebView every one of
 * these would be a cross-origin request against a server whose CORS is an
 * operator setting that defaults off.
 *
 * <p>Failures are returned rather than thrown, classified into a code the
 * chooser can act on. The one that matters is {@code certError}: it is what
 * turns "this did not work" into an offer to trust the receiver anyway.
 */
final class Http {

    /** What came back, or why nothing did. */
    static final class Result {
        boolean ok;
        int status;
        String body;
        String code;
        String error;
        boolean certError;

        static Result success(int status, String body) {
            Result r = new Result();
            r.ok = true;
            r.status = status;
            r.body = body;
            return r;
        }

        static Result failure(String code, String error, boolean certError, int status) {
            Result r = new Result();
            r.ok = false;
            r.code = code;
            r.error = error;
            r.certError = certError;
            r.status = status;
            return r;
        }
    }

    // A response big enough to be a mistake. /api/instances with conditions is
    // a few hundred kilobytes; nothing this asks for is megabytes, and a socket
    // that keeps producing them should not be able to take the app down.
    private static final int MAX_BODY = 16 * 1024 * 1024;

    private Http() {}

    static Result getJson(String host, int port, boolean tls, boolean insecureTLS,
                          String path, int timeoutMs, String userAgent) {
        HttpURLConnection conn = null;
        try {
            // Bracketed for an IPv6 literal, which is otherwise unparseable as
            // an authority — the host:port colon and the address's own collide.
            String authority = host.indexOf(':') >= 0 ? "[" + host + "]" : host;
            URL url = new URL((tls ? "https://" : "http://") + authority + ":" + port + path);
            conn = (HttpURLConnection) url.openConnection();

            if (insecureTLS && conn instanceof HttpsURLConnection) {
                HttpsURLConnection https = (HttpsURLConnection) conn;
                https.setSSLSocketFactory(insecureFactory());
                // Scoped to this one connection: the receiver the operator
                // clicked "trust" for, and nothing else in the app.
                https.setHostnameVerifier((hostname, session) -> true);
            }

            conn.setRequestMethod("GET");
            conn.setRequestProperty("User-Agent", userAgent);
            conn.setRequestProperty("Accept", "application/json");
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            // Not followed, matching the desktop client, whose http.request does
            // not follow them either. It is not pedantry: a probe that followed
            // a redirect would report a row saying `tls: false, port: 80` for a
            // receiver actually served over https, and every address built from
            // that row afterwards — the saved entry, the window, the share link
            // — would be built from the address that did not answer.
            conn.setInstanceFollowRedirects(false);

            int status = conn.getResponseCode();
            if (status != 200) {
                drain(conn.getErrorStream());
                return Result.failure("HTTP_" + status, "HTTP " + status, false, status);
            }
            return Result.success(status, read(conn.getInputStream()));
        } catch (SocketTimeoutException e) {
            return Result.failure("ETIMEDOUT", "timeout", false, 0);
        } catch (UnknownHostException e) {
            return Result.failure("ENOTFOUND", "no such host", false, 0);
        } catch (ConnectException e) {
            return Result.failure("ECONNREFUSED", message(e, "connection refused"), false, 0);
        } catch (SSLPeerUnverifiedException e) {
            // The certificate is valid and is not this host's.
            return Result.failure("ERR_TLS_CERT_ALTNAME_INVALID", message(e, "certificate is for another host"), true, 0);
        } catch (SSLHandshakeException e) {
            return classifyHandshake(e);
        } catch (SSLException e) {
            return Result.failure("ERR_TLS_FAILED", message(e, "TLS failed"), true, 0);
        } catch (IOException e) {
            return Result.failure("EFAILED", message(e, "request failed"), false, 0);
        } catch (RuntimeException e) {
            // A malformed host from a directory row, most likely. Reported the
            // same way as anything else that did not answer.
            return Result.failure("EFAILED", message(e, "request failed"), false, 0);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * Which kind of certificate problem, in the vocabulary the desktop client
     * already uses (Node's OpenSSL codes), so the chooser shows the same words
     * on both. The distinction is cosmetic — every branch here is offered the
     * same "trust this receiver anyway" — but "certificate has expired" and
     * "self-signed certificate" are different things to be told.
     */
    private static Result classifyHandshake(SSLHandshakeException e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof CertificateExpiredException) {
                return Result.failure("CERT_HAS_EXPIRED", "certificate has expired", true, 0);
            }
            if (t instanceof CertPathValidatorException) {
                return Result.failure("DEPTH_ZERO_SELF_SIGNED_CERT", "certificate is not trusted", true, 0);
            }
        }
        return Result.failure("UNABLE_TO_VERIFY_LEAF_SIGNATURE", message(e, "certificate could not be verified"), true, 0);
    }

    private static String message(Throwable e, String fallback) {
        String m = e.getMessage();
        return m == null || m.isEmpty() ? fallback : m;
    }

    private static String read(InputStream in) throws IOException {
        if (in == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        int n;
        int total = 0;
        while ((n = in.read(buf)) > 0) {
            total += n;
            if (total > MAX_BODY) throw new IOException("response too large");
            out.write(buf, 0, n);
        }
        in.close();
        return out.toString("UTF-8");
    }

    private static void drain(InputStream in) {
        if (in == null) return;
        try {
            byte[] buf = new byte[4096];
            while (in.read(buf) > 0) { /* to the end, so the socket can be reused */ }
        } catch (IOException ignored) {
            // Draining is an optimisation; the response is already decided.
        } finally {
            try { in.close(); } catch (IOException ignored) { }
        }
    }

    /**
     * A socket factory that accepts any certificate.
     *
     * <p>Built per call and applied to one connection, never installed as a
     * default: the operator asked to trust one receiver, and a factory left on
     * {@code HttpsURLConnection.setDefaultSSLSocketFactory} would quietly trust
     * everything the app talks to afterwards, including the directory.
     */
    private static javax.net.ssl.SSLSocketFactory insecureFactory() throws IOException {
        try {
            TrustManager[] trustAll = new TrustManager[]{
                new X509TrustManager() {
                    @Override public void checkClientTrusted(X509Certificate[] chain, String authType) { }
                    @Override public void checkServerTrusted(X509Certificate[] chain, String authType) { }
                    @Override public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                }
            };
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, trustAll, new java.security.SecureRandom());
            return ctx.getSocketFactory();
        } catch (java.security.GeneralSecurityException e) {
            throw new IOException("cannot build an insecure TLS context", e);
        }
    }
}
