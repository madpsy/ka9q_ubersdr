import Foundation
import Network

/// `_ubersdr._tcp` on the local network.
///
/// The one piece of the platform half that is a rewrite rather than a port.
/// `Mdns.java` sends its own DNS-SD query from an ephemeral port — a "legacy
/// unicast" query (RFC 6762 §6.7) — which on Android buys it freedom from
/// `MulticastLock`, `CHANGE_WIFI_MULTICAST_STATE` and NsdManager's lifecycle.
///
/// None of that transfers. On iOS a raw multicast socket needs the
/// `com.apple.developer.networking.multicast` entitlement, which is granted by
/// written application to Apple and reviewed per app. `NWBrowser` needs no
/// entitlement at all: it asks mDNSResponder, which is already listening, and
/// the only thing required is honesty in Info.plist — `NSBonjourServices`
/// naming the service type and `NSLocalNetworkUsageDescription` explaining why.
/// The system then asks the operator once, which is the prompt the privacy
/// policy describes.
///
/// So this is shorter than the Android version and does more: mDNSResponder
/// resolves the addresses too, where `Mdns.java` parses its own answers.
enum Mdns {

    struct Found {
        var name: String
        var host: String
        var port: Int
        var payload: [String: Any] { ["name": name, "host": host, "port": port] }
    }

    /// One browse, for as long as the caller asked, then whatever was found.
    ///
    /// Shaped as one shot rather than a subscription because that is what the
    /// chooser's LAN tab is: it browses when it is opened and when the refresh
    /// is tapped. A continuous browse would be a socket held open behind a tab
    /// nobody is looking at.
    static func browse(timeoutMs: Int, completion: @escaping ([Found]) -> Void) {
        let params = NWParameters()
        params.includePeerToPeer = false

        let browser = NWBrowser(for: .bonjour(type: "_ubersdr._tcp", domain: nil),
                                using: params)
        let queue = DispatchQueue(label: "org.ubersdr.mdns")

        // Guarded by `queue`: the timeout and the browser's own callbacks race
        // otherwise, and finishing twice would resolve the plugin call twice.
        var results: [String: Found] = [:]
        var pending = 0
        var done = false

        func finish() {
            guard !done else { return }
            done = true
            browser.cancel()
            let found = results.values.sorted { $0.name.lowercased() < $1.name.lowercased() }
            DispatchQueue.main.async { completion(found) }
        }

        browser.browseResultsChangedHandler = { seen, _ in
            for result in seen {
                guard case let .service(name, type, domain, _) = result.endpoint else { continue }
                pending += 1
                // A browse gives names, not addresses. NWConnection is what
                // turns one into the other: mDNSResponder resolves the SRV and
                // A records while the connection is being set up, and
                // `currentPath` carries the endpoint it settled on.
                resolve(name: name, type: type, domain: domain, queue: queue) { found in
                    if let found = found { results[found.name] = found }
                    pending -= 1
                    // Everything the browse offered has an address: stop early
                    // rather than sitting out the rest of the timeout.
                    if pending == 0 && !seen.isEmpty { finish() }
                }
            }
        }

        browser.stateUpdateHandler = { state in
            switch state {
            case .failed:
                // No Wi-Fi, or the operator refused the local-network prompt.
                // An empty list is the honest answer and the LAN tab already
                // has a "nothing found" state; a rejected call would be an
                // error dialog for a permission the app can carry on without.
                finish()
            case .cancelled:
                break
            default:
                break
            }
        }

        browser.start(queue: queue)
        queue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { finish() }
    }

    /// One service name to a host and port.
    private static func resolve(name: String, type: String, domain: String,
                                queue: DispatchQueue,
                                completion: @escaping (Found?) -> Void) {
        let endpoint = NWEndpoint.service(name: name, type: type, domain: domain, interface: nil)
        let params = NWParameters.tcp
        params.includePeerToPeer = false
        // IPv4 only, deliberately, and for the same reason the Android client
        // and clients/tui are: a LAN receiver reachable only by a link-local
        // IPv6 address needs a zone id the client would have to guess, so an
        // instance advertising nothing else is skipped rather than listed
        // unreachable.
        if let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
            ip.version = .v4
        }

        let connection = NWConnection(to: endpoint, using: params)
        var answered = false

        func answer(_ found: Found?) {
            guard !answered else { return }
            answered = true
            connection.cancel()
            completion(found)
        }

        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                guard let remote = connection.currentPath?.remoteEndpoint,
                      case let .hostPort(host, port) = remote else {
                    answer(nil)
                    return
                }
                answer(Found(name: name, host: address(of: host), port: Int(port.rawValue)))
            case .failed, .cancelled:
                answer(nil)
            default:
                break
            }
        }
        connection.start(queue: queue)
        // A receiver that advertises itself and then does not answer is not one
        // the chooser can offer, so this is short on purpose.
        queue.asyncAfter(deadline: .now() + .seconds(3)) { answer(nil) }
    }

    /// The dotted quad, without the interface suffix `NWEndpoint.Host` prints.
    private static func address(of host: NWEndpoint.Host) -> String {
        switch host {
        case .ipv4(let v4):
            return "\(v4)".split(separator: "%").first.map(String.init) ?? "\(v4)"
        case .ipv6(let v6):
            return "\(v6)".split(separator: "%").first.map(String.init) ?? "\(v6)"
        case .name(let name, _):
            return name
        @unknown default:
            return "\(host)"
        }
    }
}
