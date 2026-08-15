import Foundation
import Network

/// The receiver's loopback reverse proxy: the bundled `/v2/*` out of the app,
/// everything else to the instance.
///
/// A port of `LocalProxy.java`, which is itself a port of the desktop client's
/// `clients/electron/proxy.js`, and the reason this app is a client rather than
/// a wrapper around somebody's website. The v2 frontend is same-origin by
/// construction — relative `fetch()`, websocket URLs built from
/// `location.host`, root-absolute assets served by the instance — so the page
/// gets an origin where all of that is true: `http://127.0.0.1:<port>`, serving
/// the bundle for `/v2/*` and forwarding the rest.
///
/// On iOS the alternatives are blocked exactly as they are on Android. Serving
/// the bundle from the app's own origin and calling the instance across it
/// needs CORS, which is an operator setting that defaults off; three panels use
/// EventSource, which nothing can route natively for a page; and an
/// `https://localhost` origin cannot open a cleartext websocket to a LAN
/// receiver. Loopback has none of those problems, and `http://127.0.0.1` is a
/// secure context, so the page keeps AudioWorklet and everything else that
/// needs one.
///
/// The local port is stable per instance (assigned by the store) because
/// settings live in `localStorage` keyed by origin: a receiver coming up on a
/// different port each launch would come up with its settings reset.
///
/// ## One simplification, and what it buys
///
/// `LocalProxy.java` has separate paths for requests and for websocket
/// upgrades. Here there is one. After the request head is rewritten, the two
/// sockets are spliced in both directions for the life of the connection — so
/// request bodies, chunked encoding, SSE and websocket frames are all the same
/// thing: bytes nobody interprets. That is sound only because every response
/// carries `Connection: close`, so the client never reuses the connection for a
/// second request, which is the same trade the Android version makes and for
/// the same reason.
final class LocalProxy {

    private let host: String
    private let port: Int
    private let tls: Bool
    private let insecureTLS: Bool

    /// What upstream is told it is, and what a redirect back to it looks like.
    private let hostHeader: String
    private let upstreamOrigin: String

    private var listener: NWListener?
    private(set) var localPort: Int = 0

    /// The listener's own queue. Every *connection* gets its own serial queue
    /// instead — see `accept`.
    private let queue = DispatchQueue(label: "org.ubersdr.proxy")

    /// Where the staged v2 bundle lives inside the app. `cap sync` copies www/
    /// to App/public, so /v2/foo is public/v2/foo.
    private let webRoot: URL

    init(host: String, port: Int, tls: Bool, insecureTLS: Bool) {
        self.host = host
        self.port = port
        self.tls = tls
        self.insecureTLS = insecureTLS

        let bracketed = host.contains(":") ? "[\(host)]" : host
        let isDefault = (tls && port == 443) || (!tls && port == 80)
        self.hostHeader = isDefault ? bracketed : "\(bracketed):\(port)"
        self.upstreamOrigin = "\(tls ? "https" : "http")://\(self.hostHeader)"

        self.webRoot = Bundle.main.resourceURL?.appendingPathComponent("public")
            ?? Bundle.main.bundleURL
    }

    var origin: String { "http://127.0.0.1:\(localPort)" }

    /// The page's audio session id, seen in passing.
    ///
    /// `/audio/stream` is keyed by it, and the page keeps it in a module
    /// variable — not in storage, so it cannot be read from outside. It does
    /// however put it on the audio socket's query string
    /// (`radio/audio-connection.js`, `user_session_id`), and every request goes
    /// through here. So the proxy learns it by watching rather than by asking,
    /// which also means it is always the *current* one: a reconnect mints a new
    /// id and opens a new socket, and this sees that too.
    private(set) var audioSessionId: String?

    /// What the instance's own origin is, for the page to be told. v2 uses it
    /// for links that must leave the proxy — see `window.ubersdrDesktop`.
    var upstreamOriginForPage: String { upstreamOrigin }

    /// Binds the preferred port, or any free one if that is taken.
    ///
    /// Taking a different port is not a failure: it costs that receiver its
    /// stored settings once, where refusing to start would cost it the session.
    /// The caller writes back whatever came out — see api.js.
    func start(preferredPort: Int) throws -> Int {
        if let bound = try? bind(preferredPort), preferredPort > 0 {
            localPort = bound
            return bound
        }
        localPort = try bind(0)
        return localPort
    }

    private func bind(_ wanted: Int) throws -> Int {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        // Loopback only. This proxy speaks for a receiver with the operator's
        // saved password behind it; it has no business being reachable from the
        // network the phone happens to be on.
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback),
                                                 port: NWEndpoint.Port(rawValue: UInt16(wanted)) ?? .any)

        let listener = try NWListener(using: params)
        let ready = DispatchSemaphore(value: 0)
        var failure: Error?

        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.signal()
            case .failed(let error), .waiting(let error):
                failure = error
                ready.signal()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)

        if ready.wait(timeout: .now() + 5) == .timedOut {
            listener.cancel()
            throw ProxyError.bindTimedOut
        }
        if let failure = failure {
            listener.cancel()
            throw failure
        }
        guard let bound = listener.port?.rawValue else {
            listener.cancel()
            throw ProxyError.bindTimedOut
        }
        self.listener = listener
        return Int(bound)
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    enum ProxyError: Error {
        case bindTimedOut
        case upstreamClosed
    }

    // MARK: - One client connection

    private func accept(_ client: NWConnection) {
        // A serial queue per connection pair, and this is not a detail.
        //
        // Network.framework delivers a connection's events on the queue it is
        // given, and a *concurrent* queue therefore lets two receive callbacks
        // for the same connection run at once. Chunks then overtake one another
        // on the way to the other socket, and what arrives is a body with holes
        // in it — 8 kB of an 87 kB script, and no error anywhere to say so.
        let pairQueue = DispatchQueue(label: "org.ubersdr.proxy.conn")
        client.start(queue: pairQueue)
        let reader = StreamReader(connection: client)

        reader.readHead { [weak self] head in
            guard let self = self, let head = head else {
                client.cancel()
                return
            }
            #if DEBUG
            NSLog("[UberSDR proxy] %@", head.requestLine)
            #endif
            self.noteSessionId(head)
            if head.path.hasPrefix("/v2/") && !head.isUpgrade {
                self.serveBundled(head, to: client, reader: reader)
            } else {
                self.forward(head, from: client, reader: reader, on: pairQueue)
            }
        }
    }

    /// Watch for the audio socket's session id.
    private func noteSessionId(_ head: RequestHead) {
        guard head.isUpgrade else { return }
        let target = head.requestLine.split(separator: " ").dropFirst().first.map(String.init) ?? ""
        guard let query = target.split(separator: "?", maxSplits: 1).dropFirst().first else { return }
        for pair in query.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1)
            guard parts.count == 2, parts[0] == "user_session_id" else { continue }
            let value = String(parts[1]).removingPercentEncoding ?? String(parts[1])
            if !value.isEmpty { audioSessionId = value }
            return
        }
    }

    // MARK: - The bundle

    /// `/v2/*` out of the app, so the interface is the one that shipped with
    /// this build rather than 1.5 MB fetched over the air on every connect.
    private func serveBundled(_ head: RequestHead, to client: NWConnection, reader: StreamReader) {
        var rel = String(head.path.dropFirst("/v2/".count))
        // `/v2/` is the receiver's entry point and names a directory, not a
        // file. Without this the WebView's very first request answers 404 and
        // the receiver opens onto the word "not found".
        if rel.isEmpty || rel.hasSuffix("/") { rel += "index.html" }
        // No traversal out of the bundle. A page served from loopback is still
        // a page, and "../.." is still a string anybody can type.
        let safe = rel.split(separator: "/").filter { $0 != ".." && $0 != "." }.joined(separator: "/")
        let file = webRoot.appendingPathComponent("v2").appendingPathComponent(safe)

        guard let body = try? Data(contentsOf: file) else {
            send(status: "404 Not Found", body: Data("not found".utf8),
                 type: "text/plain", to: client, close: true)
            return
        }
        send(status: "200 OK", body: body, type: Self.mime(safe), to: client, close: true)
    }

    private func send(status: String, body: Data, type: String,
                      to client: NWConnection, close: Bool) {
        var head = "HTTP/1.1 \(status)\r\n"
        head += "Content-Type: \(type)\r\n"
        head += "Content-Length: \(body.count)\r\n"
        head += "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(body)
        // Sent as the final message rather than sent-then-cancelled.
        //
        // `cancel()` on the completion of a send tears the connection down
        // before the bytes have necessarily left it, which truncates anything
        // that does not fit in one buffer — v2.js is the better part of a
        // megabyte, so the page received a short read, refused to execute it,
        // and came up blank with nothing in the console to say why. Marking the
        // message final closes the stream in order, after the body.
        client.send(content: out, contentContext: .finalMessage, isComplete: true,
                    completion: .contentProcessed { _ in
            if close { client.cancel() }
        })
    }

    private static func mime(_ name: String) -> String {
        let lower = name.lowercased()
        if lower.hasSuffix(".html") { return "text/html; charset=utf-8" }
        if lower.hasSuffix(".js") || lower.hasSuffix(".mjs") { return "application/javascript; charset=utf-8" }
        if lower.hasSuffix(".css") { return "text/css; charset=utf-8" }
        if lower.hasSuffix(".json") { return "application/json; charset=utf-8" }
        if lower.hasSuffix(".svg") { return "image/svg+xml" }
        if lower.hasSuffix(".png") { return "image/png" }
        if lower.hasSuffix(".jpg") || lower.hasSuffix(".jpeg") { return "image/jpeg" }
        if lower.hasSuffix(".ico") { return "image/x-icon" }
        if lower.hasSuffix(".woff2") { return "font/woff2" }
        if lower.hasSuffix(".woff") { return "font/woff" }
        if lower.hasSuffix(".wasm") { return "application/wasm" }
        if lower.hasSuffix(".map") { return "application/json" }
        return "application/octet-stream"
    }

    // MARK: - Everything else

    /// Rewrite the head, open one upstream connection, then splice.
    private func forward(_ head: RequestHead, from client: NWConnection,
                         reader: StreamReader, on pairQueue: DispatchQueue) {
        let upstream = makeUpstream()

        upstream.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                upstream.stateUpdateHandler = nil
                upstream.send(content: self.rewrite(head), completion: .contentProcessed { _ in
                    // Client → upstream: whatever else the client has to say,
                    // which is a request body, or websocket frames, or nothing.
                    //
                    // `endsOther: false` matters. A client that has finished
                    // speaking has not finished listening: curl and WKWebView
                    // both half-close after sending a GET, and tearing the
                    // upstream connection down on that would cancel the
                    // response while it was still arriving.
                    reader.spliceRemaining(into: upstream, endsOther: false)
                    // Upstream → client, head rewritten and then bytes.
                    self.relay(from: upstream, to: client)
                })
            case .failed, .cancelled:
                self.send(status: "502 Bad Gateway", body: Data("upstream unreachable".utf8),
                          type: "text/plain", to: client, close: true)
                upstream.cancel()
            default:
                break
            }
        }
        // The same serial queue as its client, so the two halves of one request
        // cannot run concurrently with each other either.
        upstream.start(queue: pairQueue)
    }

    private func makeUpstream() -> NWConnection {
        let params: NWParameters
        if tls {
            let options = NWProtocolTLS.Options()
            if insecureTLS {
                // The operator's per-receiver "trust this one anyway", and
                // nothing wider — this connection, for this instance. The
                // chooser only offers it after Http.swift has classified a
                // certificate failure.
                sec_protocol_options_set_verify_block(
                    options.securityProtocolOptions,
                    { _, _, complete in complete(true) },
                    queue
                )
            }
            params = NWParameters(tls: options)
        } else {
            params = NWParameters.tcp
        }
        let endpoint = NWEndpoint.hostPort(host: NWEndpoint.Host(host),
                                           port: NWEndpoint.Port(rawValue: UInt16(port)) ?? 80)
        return NWConnection(to: endpoint, using: params)
    }

    /// The request head, with the two things that must change changed.
    ///
    /// Host, so a name-based virtual host on the instance answers; and Origin
    /// and Referer, which arrive naming the loopback origin and would otherwise
    /// tell the instance that a page on 127.0.0.1 is talking to it — which is
    /// exactly the sort of thing a CORS or websocket-origin check rejects.
    /// Everything else, including the websocket key and subprotocols, passes
    /// through untouched: a proxy that rewrote those could get them wrong.
    private func rewrite(_ head: RequestHead) -> Data {
        var out = head.requestLine + "\r\n"
        for line in head.headerLines {
            let lower = line.lowercased()
            if lower.hasPrefix("host:") { continue }
            if lower.hasPrefix("connection:") || lower.hasPrefix("keep-alive:") { continue }
            if lower.hasPrefix("origin:") {
                out += "Origin: \(upstreamOrigin)\r\n"
                continue
            }
            if lower.hasPrefix("referer:"), let range = line.range(of: "127.0.0.1:\(localPort)") {
                let rest = String(line[range.upperBound...])
                out += "Referer: \(upstreamOrigin)\(rest)\r\n"
                continue
            }
            out += line + "\r\n"
        }
        out += "Host: \(hostHeader)\r\n"
        // One request per connection, upstream and down. See the class note.
        out += head.isUpgrade ? "Connection: Upgrade\r\n\r\n" : "Connection: close\r\n\r\n"
        return Data(out.utf8)
    }

    /// Upstream's response: head rewritten where it must be, then bytes.
    private func relay(from upstream: NWConnection, to client: NWConnection) {
        let reader = StreamReader(connection: upstream)
        reader.readHead { [weak self] head in
            guard let self = self, let head = head else {
                client.cancel()
                upstream.cancel()
                return
            }
            var out = head.requestLine + "\r\n"
            // A 101 is passed through exactly as it came: adding
            // `Connection: close` to a switching-protocols response would tell
            // the page its websocket was over before its first frame.
            if head.status == 101 {
                for line in head.headerLines { out += line + "\r\n" }
                out += "\r\n"
            } else {
                for line in head.headerLines {
                    let lower = line.lowercased()
                    if lower.hasPrefix("connection:") || lower.hasPrefix("keep-alive:") { continue }
                    // A redirect to the instance's own origin has to come back
                    // as one to this proxy, or the page leaves the origin its
                    // settings and its websockets live on.
                    if lower.hasPrefix("location:") {
                        let value = line.dropFirst("location:".count).trimmingCharacters(in: .whitespaces)
                        if value.hasPrefix(self.upstreamOrigin) {
                            let rest = String(value.dropFirst(self.upstreamOrigin.count))
                            out += "Location: \(rest.isEmpty ? "/" : rest)\r\n"
                            continue
                        }
                    }
                    out += line + "\r\n"
                }
                out += "Connection: close\r\n\r\n"
            }

            client.send(content: Data(out.utf8), completion: .contentProcessed { _ in
                // To EOF, flushing as it goes: this is the SSE path as much as
                // the JSON one, and a stream buffered until it ends is a stream
                // that never arrives.
                reader.spliceRemaining(into: client)
            })
        }
    }
}

// MARK: - Reading a head, then getting out of the way

/// Enough HTTP to find the end of a head, and nothing more.
///
/// Deliberately not a parser: it finds the blank line, hands over the lines
/// above it, and then treats everything after as bytes. Whatever the body is —
/// chunked, an SSE stream that never ends, websocket frames — is somebody
/// else's protocol and is copied rather than understood.
private final class StreamReader {
    private let connection: NWConnection
    private var buffer = Data()

    init(connection: NWConnection) {
        self.connection = connection
    }

    func readHead(_ completion: @escaping (RequestHead?) -> Void) {
        // Strong, for the same reason as `pump` below: a reader nobody else is
        // holding must not evaporate between one receive and the next.
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
            if let data = data, !data.isEmpty { self.buffer.append(data) }

            if let terminator = self.buffer.range(of: Data("\r\n\r\n".utf8)) {
                let headData = self.buffer.subdata(in: self.buffer.startIndex..<terminator.lowerBound)
                self.buffer.removeSubrange(self.buffer.startIndex..<terminator.upperBound)
                completion(RequestHead(String(decoding: headData, as: UTF8.self)))
                return
            }
            if isComplete || error != nil {
                completion(nil)
                return
            }
            // A head bigger than this is not a head.
            if self.buffer.count > 256 * 1024 {
                completion(nil)
                return
            }
            self.readHead(completion)
        }
    }

    /// Everything after the head, forever, in one direction.
    ///
    /// Two rules make this correct, and getting either wrong looks like a page
    /// that half-loads rather than an error anybody can see:
    ///
    ///   * **Backpressure.** The next `receive` is issued only once the
    ///     previous chunk has actually been sent. Receiving in a loop and
    ///     firing sends off as they arrive queues unbounded work and reorders
    ///     nothing usefully — it just means the connection can be torn down
    ///     with sends still outstanding.
    ///   * **Order at the end.** A stream is finished by sending an empty
    ///     final message and cancelling in *its* completion. Cancelling as
    ///     soon as EOF is read discards whatever is still in flight, which
    ///     truncated an 87 kB script to 33 kB — and because the head had
    ///     already promised `Content-Length: 87592`, the page then waited
    ///     forever for bytes that were never coming, blocking every script
    ///     after it and rendering nothing at all.
    func spliceRemaining(into other: NWConnection, endsOther: Bool = true) {
        if !buffer.isEmpty {
            let pending = buffer
            buffer = Data()
            // Strong again, and for the same reason as `pump`: between this
            // send and its completion the closure that owned this reader has
            // already returned, so a weak capture is nil by the time the pump
            // would be armed — the body then stops at whatever arrived with
            // the head, which for a small response is all of it and for a
            // large one is the first few hundred bytes.
            other.send(content: pending, completion: .contentProcessed { _ in
                self.pump(into: other, endsOther: endsOther)
            })
            return
        }
        pump(into: other, endsOther: endsOther)
    }

    private func pump(into other: NWConnection, endsOther: Bool) {
        // `self` is captured strongly, and that is the whole of what keeps a
        // splice alive.
        //
        // Nothing else holds a reader once the closure that created it has
        // returned: the head has been dealt with and the connection object
        // knows nothing about this class. With `[weak self]` the reader is
        // therefore deallocated somewhere in the middle of the body, the next
        // receive callback finds nothing to resume, and the transfer stops —
        // silently, with no error and no EOF, leaving the client waiting on a
        // Content-Length that will never be satisfied. That is what truncated
        // an 87 kB script to 8 kB and left the page blank.
        //
        // The strong reference is a cycle only until the stream ends, which is
        // exactly the lifetime wanted: the last callback returns without
        // re-arming, and reader and connection are released together.
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
            let finished = isComplete || error != nil

            // Whatever arrived goes out first, and only then is anything else
            // decided — including the end of the stream.
            let afterSend: () -> Void = {
                if finished {
                    if endsOther {
                        other.send(content: nil, contentContext: .finalMessage, isComplete: true,
                                   completion: .contentProcessed { _ in other.cancel() })
                        self.connection.cancel()
                    }
                    // Otherwise just stop reading this direction and leave both
                    // connections alone: the other half is still in use.
                    return
                }
                self.pump(into: other, endsOther: endsOther)
            }

            if let data = data, !data.isEmpty {
                other.send(content: data, completion: .contentProcessed { sendError in
                    #if DEBUG
                    if let sendError = sendError {
                        NSLog("[UberSDR proxy] send failed: %@", String(describing: sendError))
                    }
                    #endif
                    afterSend()
                })
            } else {
                afterSend()
            }
        }
    }
}

/// A request line or status line, plus the header lines under it.
private struct RequestHead {
    let requestLine: String
    let headerLines: [String]

    init?(_ raw: String) {
        var lines = raw.components(separatedBy: "\r\n")
        guard !lines.isEmpty, !lines[0].isEmpty else { return nil }
        requestLine = lines.removeFirst()
        headerLines = lines.filter { !$0.isEmpty }
    }

    /// The path, without the query — routing only cares about the prefix.
    var path: String {
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return "/" }
        return String(parts[1].split(separator: "?", maxSplits: 1).first ?? "/")
    }

    /// Audio, spectrum, the DX cluster feed and the chat all arrive here.
    var isUpgrade: Bool {
        headerLines.contains { $0.lowercased().hasPrefix("upgrade:") }
    }

    /// For a response head rather than a request one.
    var status: Int {
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return 0 }
        return Int(parts[1]) ?? 0
    }
}
