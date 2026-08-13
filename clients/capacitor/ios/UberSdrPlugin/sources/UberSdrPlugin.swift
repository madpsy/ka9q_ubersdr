import Foundation
import Capacitor
import UserNotifications

/// The bridge the chooser talks to: `window.ubersdr` on this platform.
///
/// The iOS half of `UberSdrPlugin.java`, method for method, because the
/// JavaScript that calls it is the same JavaScript — `src/api.js` and
/// `src/discovery.js` are staged into both clients and neither knows which
/// platform answered. The contract is `src/native.js`:
///
///   getJson       one HTTP path for every call the discovery layer makes
///   mdnsBrowse    _ubersdr._tcp on the local network
///   secretSet / secretHas / secretClear
///                 the bypass password. There is no `secretGet` here, exactly
///                 as there is none on Android: the receiver reads it natively
///                 and the chooser never holds one.
///   openReceiver / closeReceiver / receiverState
///                 which receiver is open, if any
///
/// Registered by conforming to `CAPBridgedPlugin`, which Capacitor 7 discovers
/// through the Objective-C runtime — so a plugin living in a pod is found the
/// same way one in the app target would be, and this client's Swift can be
/// written without opening Xcode. See the podspec.
@objc(UberSdrPlugin)
public class UberSdrPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "UberSdrPlugin"
    public let jsName = "UberSdr"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getJson", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mdnsBrowse", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretHas", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secretClear", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openReceiver", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeReceiver", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "receiverState", returnType: CAPPluginReturnPromise)
    ]

    /// Which receiver is open, if any. Nil until `openReceiver`, and back to nil
    /// when the receiver's own power button finishes its screen.
    private var openInstanceId: String?

    /// The screen itself, held so `closeReceiver` has something to dismiss.
    private var receiver: ReceiverViewController?

    // MARK: - ubersdr://connect?uuid=…

    /// A receiver, named in a link, from anywhere the phone can follow one — a
    /// QR code beside a radio, a message, an instance's own page.
    ///
    /// Capacitor turns `application(_:open:options:)` into a notification, so
    /// this needs no AppDelegate edit — which matters, because AppDelegate.swift
    /// is in the App target and this client's Swift deliberately all lives in a
    /// pod. See the podspec.
    ///
    /// Raised with `retainUntilConsumed` for the same reason as on Android: a
    /// link that *started* the app arrives before src/deeplink.js is listening,
    /// and an event delivered to nobody is a receiver that never opens.
    override public func load() {
        NotificationCenter.default.addObserver(
            forName: .capacitorOpenURL, object: nil, queue: .main
        ) { [weak self] notification in
            guard let object = notification.object as? [String: Any],
                  let url = object["url"] as? URL else { return }
            self?.handle(url: url)
        }

        #if DEBUG
        // A link, without a link to tap.
        //
        // `simctl openurl` reaches the app only through SpringBoard's "Open
        // in UberSDR?" alert, and simctl has no way to answer it — so on a
        // simulator there is otherwise no path to a receiver that does not go
        // through a human finger. This takes the same URL from the launch
        // environment instead:
        //
        //   SIMCTL_CHILD_UBERSDR_OPEN='ubersdr://connect?uuid=…' \
        //     xcrun simctl launch booted org.ubersdr.mobile
        //
        // It is the *same* path a real link takes — deeplink.js cannot tell the
        // difference — so what it exercises is the real one. DEBUG only: a
        // release build has no way to be told where to connect at launch.
        if let raw = ProcessInfo.processInfo.environment["UBERSDR_OPEN"],
           let url = URL(string: raw) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                self?.handle(url: url)
            }
        }
        #endif
    }

    private func handle(url: URL) {
        // The scheme alone is registered, not scheme + host, so what a link
        // asks for is src/deeplink.js's to read and to refuse: a mistyped link
        // gets a sentence rather than the OS quietly offering the browser
        // instead, and a second kind of link later is a change to one file.
        guard url.scheme?.lowercased() == "ubersdr" else { return }
        notifyListeners("deepLink", data: ["url": url.absoluteString], retainUntilConsumed: true)
    }

    // MARK: - HTTP

    /// Resolves with a result rather than rejecting, even for a failure.
    ///
    /// That is not laziness about error handling, it is the contract
    /// `discovery.js` is written against: a receiver that is simply not there
    /// has to travel the bridge the same way as one that is, carrying `code`
    /// and `certError`, because `resolveTarget` reads those to decide whether to
    /// offer "trust this receiver anyway". A rejection would arrive as an
    /// exception with a string and none of that.
    @objc func getJson(_ call: CAPPluginCall) {
        guard let host = call.getString("host"), let path = call.getString("path") else {
            call.reject("host and path are required")
            return
        }
        Http.getJson(
            host: host,
            port: call.getInt("port") ?? 443,
            tls: call.getBool("tls") ?? false,
            insecureTLS: call.getBool("insecureTLS") ?? false,
            path: path,
            timeoutMs: call.getInt("timeoutMs") ?? 8000,
            userAgent: call.getString("userAgent") ?? "UberSDR-iOS"
        ) { result in
            call.resolve(result.payload)
        }
    }

    // MARK: - The local network

    @objc func mdnsBrowse(_ call: CAPPluginCall) {
        Mdns.browse(timeoutMs: call.getInt("timeoutMs") ?? 2500) { found in
            // `services`, and the name is not free to choose: discovery.js does
            // `const { services = [] } = await UberSdr.mdnsBrowse(...)`, so any
            // other key destructures to the default and the LAN tab shows
            // nothing at all — with no error, because an empty network is a
            // perfectly ordinary answer. The Android plugin returns the same
            // key for the same reason.
            call.resolve(["services": found.map { $0.payload }])
        }
    }

    // MARK: - The password

    @objc func secretSet(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let value = call.getString("value") else {
            call.reject("id and value are required")
            return
        }
        call.resolve(["ok": Secrets.set(id, value)])
    }

    @objc func secretHas(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("id is required")
            return
        }
        call.resolve(["has": Secrets.has(id)])
    }

    @objc func secretClear(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("id is required")
            return
        }
        call.resolve(["ok": Secrets.clear(id)])
    }

    // MARK: - The receiver

    /// Start this receiver's proxy and put its screen on top.
    ///
    /// Resolves with the port that was actually bound, which is not always the
    /// one that was asked for — see LocalProxy.start. api.js writes back
    /// whatever comes out, because that port is the receiver's origin and so
    /// where its settings live.
    @objc func openReceiver(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let host = call.getString("host") else {
            call.reject("id and host are required")
            return
        }
        let proxy = LocalProxy(host: host,
                               port: call.getInt("port") ?? 443,
                               tls: call.getBool("tls") ?? false,
                               insecureTLS: call.getBool("insecureTLS") ?? false)
        let bound: Int
        do {
            bound = try proxy.start(preferredPort: call.getInt("localPort") ?? 0)
        } catch {
            call.reject("could not start the local proxy: \(error.localizedDescription)")
            return
        }

        let label = call.getString("label") ?? ""
        let product = call.getString("product") ?? "UberSDR-iOS"
        // Read here rather than handed over the bridge: the JavaScript half of
        // this app has no call that returns a password, exactly as on Android.
        let password = Secrets.get(id)

        // What the OS has already decided about notifications, before the page
        // is built: the seed script has to carry it, and asking is async. The
        // Android client reads the same thing synchronously with
        // checkSelfPermission — see ReceiverActivity.notificationState.
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let state: String
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: state = "granted"
            case .denied:                                state = "denied"
            default:                                     state = "default"
            }

        DispatchQueue.main.async { [weak self] in
            guard let self = self,
                  let root = self.bridge?.viewController else {
                proxy.stop()
                call.reject("no view controller to present from")
                return
            }
            // A receiver open already. On Android the receiver is a singleTask
            // Activity and the platform sorts this out; here it would be a
            // modal presented over a modal, which UIKit refuses outright — so
            // the one that is up is stopped and dismissed first, and only then
            // is the new one presented. Reachable from a followed link while
            // listening, which is exactly what `ubersdr://` links are for.
            if let current = self.receiver {
                current.close()
                current.dismiss(animated: false)
                self.receiver = nil
            }

            let receiver = ReceiverViewController(instanceId: id, label: label,
                                                  proxy: proxy, product: product,
                                                  password: password,
                                                  notificationState: state)
            receiver.modalPresentationStyle = .fullScreen
            receiver.onClosed = { [weak self] in
                guard let self = self else { return }
                self.openInstanceId = nil
                PlaybackSession.end()
                // The chooser redraws its rows on this. See api.js.
                self.notifyListeners("receiverClosed", data: [:])
            }
            self.receiver = receiver
            self.openInstanceId = id

            // Claim the audio session before the page starts making noise, so
            // that playback continues when the screen locks. UIBackgroundModes
            // in Info.plist is the other half of this.
            PlaybackSession.begin()

            root.present(receiver, animated: true) {
                call.resolve(["localPort": bound])
            }
        }
        }
    }

    @objc func closeReceiver(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if let receiver = self.receiver {
                receiver.close()
                receiver.dismiss(animated: true)
                self.receiver = nil
            }
            self.openInstanceId = nil
            PlaybackSession.end()
            call.resolve()
        }
    }

    @objc func receiverState(_ call: CAPPluginCall) {
        // `id: null` is the shape api.js expects for "nothing is open" — it
        // destructures `{ id }` and compares it, so the key must be present.
        call.resolve(["id": openInstanceId as Any])
    }
}
