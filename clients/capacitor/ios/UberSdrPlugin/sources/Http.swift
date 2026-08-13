import Foundation

/// One GET, one JSON document, and the certificate-error classification the
/// chooser's "trust this receiver anyway" is built on.
///
/// The iOS half of `Http.java`, and deliberately the same shape: failures are
/// *returned* rather than thrown, classified into a code the chooser can act
/// on. The one that matters is `certError` — it is what turns "could not
/// connect" into an offer to trust a self-signed receiver, and a receiver on
/// somebody's home network very often has exactly that.
///
/// Why every call goes through here rather than `fetch` in the page, which is
/// the same reason as on Android and holds twice over on iOS: these are all
/// cross-origin from the app's own origin, against servers whose CORS defaults
/// off (`main.go`, `config.Server.EnableCORS`), so a chooser that fetched
/// `/api/description` itself would fail against most of the receivers it exists
/// to find. And a WKWebView cannot be told to accept a self-signed certificate
/// for one host, which is the whole point of `insecureTLS`.
enum Http {

    struct Result {
        var ok: Bool
        var status: Int = 0
        var body: String = ""
        var code: String = ""
        var error: String = ""
        var certError: Bool = false

        var payload: [String: Any] {
            // The keys discovery.js reads. Kept identical to the Android
            // plugin's so that src/discovery.js needs no idea which platform
            // answered it.
            [
                "ok": ok, "status": status, "body": body,
                "code": code, "error": error, "certError": certError
            ]
        }
    }

    /// A body larger than this is a receiver that is not a receiver. The same
    /// ceiling the Android side uses.
    private static let maxBody = 16 * 1024 * 1024

    static func getJson(host: String, port: Int, tls: Bool, insecureTLS: Bool,
                        path: String, timeoutMs: Int, userAgent: String,
                        completion: @escaping (Result) -> Void) {

        var components = URLComponents()
        components.scheme = tls ? "https" : "http"
        components.host = host
        // The default port is left out of the URL rather than written into it,
        // and this is not cosmetic. URLSession derives the Host header from the
        // URL, so an explicit :443 produces `Host: example.org:443` — which a
        // name-based virtual host does not match, and the directory answers 404
        // to. Every other client omits it (curl, and Java's HttpURLConnection,
        // which is why the Android half never met this), so a receiver that
        // works everywhere else would have appeared broken only here.
        let isDefaultPort = (tls && port == 443) || (!tls && port == 80)
        if !isDefaultPort { components.port = port }
        // `path` arrives complete with its query (`/api/instances?conditions=true`),
        // because that is how the shared discovery layer builds it. Assigning it
        // to `path` alone would percent-encode the '?', so it is parsed out.
        if let q = path.firstIndex(of: "?") {
            components.percentEncodedPath = String(path[path.startIndex..<q])
            components.percentEncodedQuery = String(path[path.index(after: q)...])
        } else {
            components.percentEncodedPath = path
        }

        guard let url = components.url else {
            completion(Result(ok: false, code: "EBADURL", error: "bad url"))
            return
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = Double(timeoutMs) / 1000.0
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // A receiver that answers from a cache is a receiver whose free slots
        // and band conditions are wrong, which is most of what the chooser
        // draws.
        request.cachePolicy = .reloadIgnoringLocalCacheData

        // A session per call, because the delegate carries this call's answer to
        // the trust question and sessions outlive requests. Invalidated in the
        // completion so the delegate is released rather than retained forever.
        let delegate = TrustDelegate(insecureTLS: insecureTLS)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = Double(timeoutMs) / 1000.0
        config.httpCookieStorage = nil
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)

        let task = session.dataTask(with: request) { data, response, error in
            defer { session.finishTasksAndInvalidate() }

            if let error = error as NSError? {
                completion(classify(error, sawCertFailure: delegate.sawCertFailure))
                return
            }
            guard let http = response as? HTTPURLResponse else {
                completion(Result(ok: false, code: "EFAILED", error: "no response"))
                return
            }
            guard http.statusCode == 200 else {
                completion(Result(ok: false, status: http.statusCode,
                                  code: "HTTP_\(http.statusCode)",
                                  error: "HTTP \(http.statusCode)"))
                return
            }
            let bytes = data ?? Data()
            guard bytes.count <= maxBody else {
                completion(Result(ok: false, code: "ETOOBIG", error: "response too large"))
                return
            }
            completion(Result(ok: true, status: 200,
                              body: String(decoding: bytes, as: UTF8.self)))
        }
        task.resume()
    }

    /// URLError codes into the vocabulary the chooser already speaks.
    ///
    /// The names are Node's OpenSSL/libuv ones, because the desktop client
    /// produces those and the chooser — which is the same page in both clients —
    /// shows them. A code invented here would be a string no other client can
    /// produce and no message in the chooser knows about.
    private static func classify(_ error: NSError, sawCertFailure: Bool) -> Result {
        let certCodes: Set<Int> = [
            NSURLErrorServerCertificateUntrusted,
            NSURLErrorServerCertificateHasBadDate,
            NSURLErrorServerCertificateHasUnknownRoot,
            NSURLErrorServerCertificateNotYetValid,
            NSURLErrorSecureConnectionFailed,
            NSURLErrorClientCertificateRejected
        ]

        if sawCertFailure || certCodes.contains(error.code) {
            let code: String
            switch error.code {
            case NSURLErrorServerCertificateHasUnknownRoot,
                 NSURLErrorServerCertificateUntrusted:
                code = "DEPTH_ZERO_SELF_SIGNED_CERT"
            case NSURLErrorServerCertificateHasBadDate,
                 NSURLErrorServerCertificateNotYetValid:
                code = "CERT_HAS_EXPIRED"
            default:
                code = "ERR_TLS_CERT_ALTNAME_INVALID"
            }
            return Result(ok: false, code: code,
                          error: error.localizedDescription, certError: true)
        }

        let code: String
        switch error.code {
        case NSURLErrorTimedOut:              code = "ETIMEDOUT"
        case NSURLErrorCannotFindHost:        code = "ENOTFOUND"
        case NSURLErrorCannotConnectToHost:   code = "ECONNREFUSED"
        case NSURLErrorNetworkConnectionLost: code = "ECONNRESET"
        case NSURLErrorNotConnectedToInternet: code = "ENETUNREACH"
        default:                              code = "EFAILED"
        }
        return Result(ok: false, code: code, error: error.localizedDescription)
    }

    /// Per-receiver certificate trust, and nothing wider.
    ///
    /// `insecureTLS` is a decision the operator made about one receiver in the
    /// chooser, so it is scoped to one session serving one request. The tempting
    /// alternatives — a global ATS exception for TLS validation, or a shared
    /// session with this delegate — would silently extend that decision to every
    /// receiver, which is exactly what the per-entry flag exists to prevent.
    private final class TrustDelegate: NSObject, URLSessionDelegate {
        let insecureTLS: Bool
        /// Set when a challenge was refused, so `classify` can report a
        /// certificate failure even where URLSession reports only the generic
        /// "secure connection failed" that follows it.
        private(set) var sawCertFailure = false

        init(insecureTLS: Bool) {
            self.insecureTLS = insecureTLS
        }

        func urlSession(_ session: URLSession,
                        didReceive challenge: URLAuthenticationChallenge,
                        completionHandler: @escaping (URLSession.AuthChallengeDisposition,
                                                      URLCredential?) -> Void) {
            guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
                  let trust = challenge.protectionSpace.serverTrust else {
                completionHandler(.performDefaultHandling, nil)
                return
            }
            if insecureTLS {
                completionHandler(.useCredential, URLCredential(trust: trust))
                return
            }
            // Not "reject": let the system evaluate it, and only note that the
            // failure was a trust one so the chooser can offer the override.
            var err: CFError?
            if SecTrustEvaluateWithError(trust, &err) {
                completionHandler(.useCredential, URLCredential(trust: trust))
            } else {
                sawCertFailure = true
                completionHandler(.cancelAuthenticationChallenge, nil)
            }
        }
    }
}
