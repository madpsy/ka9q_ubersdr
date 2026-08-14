import Foundation
import UIKit
import WebKit

/// One receiver: its loopback proxy, its WebView, and the script that runs
/// before the page's first.
///
/// The iOS half of `ReceiverActivity.java`. Deliberately not a Capacitor screen,
/// for the same reason it is not one there: the page is served from
/// `http://127.0.0.1:<port>`, which is not the app's origin, so the Capacitor
/// bridge is neither injected nor any use. What the page needs from its host is
/// a preload — and where Android has `WebViewCompat.addDocumentStartJavaScript`,
/// iOS has `WKUserScript` at `.atDocumentStart`, which is the same idea with a
/// better name and no availability check.
final class ReceiverViewController: UIViewController, WKNavigationDelegate, WKUIDelegate,
                                    WKScriptMessageHandler {

    private let instanceId: String
    private let label: String
    private let proxy: LocalProxy
    private let product: String
    private let password: String?
    /// What the OS has already decided about notifications: "granted",
    /// "denied" or "default", which is the vocabulary receiver.js reads.
    private let notificationState: String

    /// Raised when this screen goes away, whichever way it went — v2's own
    /// power button, or the operator swiping back. `api.js` listens for it.
    var onClosed: (() -> Void)?

    private var webView: WKWebView!
    private var host: HostChannel?

    init(instanceId: String, label: String, proxy: LocalProxy, product: String,
         password: String?, notificationState: String) {
        self.instanceId = instanceId
        self.label = label
        self.proxy = proxy
        self.product = product
        self.password = password
        self.notificationState = notificationState
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.043, green: 0.055, blue: 0.078, alpha: 1) // v2's own dark

        let config = WKWebViewConfiguration()

        // Autoplay, which is the whole of v2's start overlay.
        //
        // v2 shows that overlay for one browser rule — an AudioContext not
        // created from a user gesture is suspended — and a page cannot waive it
        // for itself, because in an ordinary browser it would start into
        // silence. So the host says whether the rule applies, and here it does
        // not: this is the iOS equivalent of the desktop client's
        // `autoplay-policy=no-user-gesture-required` and of Android's
        // setMediaPlaybackRequiresUserGesture(false). Somebody who picked a
        // receiver in the chooser has already said what the button asks.
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsInlineMediaPlayback = true
        // The audio session is this app's, so the page's audio can carry on
        // with the screen off — see PlaybackSession.
        config.allowsAirPlayForMediaPlayback = true

        let controller = WKUserContentController()
        // The channel src/receiver.js talks to. Installed before the seed
        // script so `window.ubersdrHost` exists no matter which runs first.
        controller.add(self, name: HostChannel.name)
        controller.addUserScript(WKUserScript(source: HostChannel.shim,
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true))
        #if DEBUG
        // The page's console, into the device log.
        //
        // A WKWebView has no console anybody can see without attaching Safari's
        // inspector to it, which is a GUI on a Mac and no use at all when the
        // app is being driven from another machine. The Android client mirrors
        // the page console into logcat for the same reason. DEBUG only: a
        // release build should not narrate itself.
        controller.addUserScript(WKUserScript(source: Self.audioProbe,
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true))
        controller.add(self, name: "console")
        controller.addUserScript(WKUserScript(source: Self.consoleBridge,
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: false))
        #endif
        controller.addUserScript(WKUserScript(source: seedScript(),
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true))
        if let bridge = receiverBridgeSource() {
            controller.addUserScript(WKUserScript(source: bridge,
                                                  injectionTime: .atDocumentStart,
                                                  forMainFrameOnly: true))
        }
        config.userContentController = controller

        // How this client names itself, per src/useragent.js which owns the
        // token. `applicationNameForUserAgent` *appends* to WebKit's own string,
        // which is exactly what is wanted and is why it is used in preference to
        // `customUserAgent`: the UI reads the rest of the string — announce.js
        // gates the spoken frequencies on `Safari/` or `Chrome/` being in there
        // — so replacing it wholesale with "UberSDR-iOS/0.2.0" would measurably
        // turn features off. It is also set before the WebView exists, where
        // reading `navigator.userAgent` back out of an unloaded WebView to
        // append to it is a race that quietly resolves to no token at all.
        config.applicationNameForUserAgent = product

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor

        view.addSubview(webView)
        // Inside the safe area at the top, full-bleed at the bottom.
        //
        // This is SystemBars.java's job on Android: keeping the page out from
        // under the status bar. Pinned to the top of the screen instead, v2's
        // own header sits behind the clock and the Dynamic Island — the
        // receiver's callsign and its power button are the two things most
        // likely to end up underneath. The bottom is left full-bleed on
        // purpose: the home indicator floats over the waterfall harmlessly,
        // and insetting there would leave a dark band under a panel that is
        // meant to reach the edge.
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])

        host = HostChannel(webView: webView, instanceId: instanceId, label: label)
        host?.onStopped = { [weak self] in
            // v2's own power button is the way back on a phone: there is no
            // window to close and no control was added to the interface to do
            // it. `stopped` is what receiver.js sends when the session it is
            // subscribed to goes from running to not.
            DispatchQueue.main.async {
                self?.close()
                self?.dismiss(animated: true)
            }
        }

        if let url = URL(string: proxy.origin + "/v2/") {
            webView.load(URLRequest(url: url))
        }
    }

    /// Keep the display awake while a receiver is on screen.
    ///
    /// The Android client adds `FLAG_KEEP_SCREEN_ON` for the same reason: a
    /// waterfall is something you watch, and a screen that dims out from under
    /// one after thirty seconds is the wrong default. It defers the idle timer
    /// only — the side button still locks the phone, and the audio session
    /// carries on from there.
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        UIApplication.shared.isIdleTimerDisabled = true
        DebugOrientation.apply()
        #if DEBUG
        // A tap on Start, without a finger.
        //
        // v2's start overlay is a user gesture by design — it exists to satisfy
        // the rule that an AudioContext outside one stays suspended. A
        // synthetic click is not that gesture as far as WebKit is concerned,
        // which is exactly what makes it a useful test: if audio runs after
        // this, the gesture requirement is not what is stopping it, and if it
        // does not, it is.
        if ProcessInfo.processInfo.environment["UBERSDR_AUTOTAP"] != nil {
            for delay in [8.0, 16.0] {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    self?.webView.evaluateJavaScript("""
                    (function(){
                      var b = document.querySelector('.start__go');
                      if (b) { b.click(); return 'clicked'; }
                      return 'no start button';
                    })();
                    """) { r, _ in NSLog("[UberSDR audio] autotap %@", String(describing: r)) }
                }
            }
        }
        tidyForScreenshot()
        // Sampled a few times: the graph is built when the session starts, not
        // when the page loads.
        for delay in [12.0, 25.0, 45.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.reportAudio()
            }
        }
        #endif
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || isMovingFromParent {
            close()
        }
    }

    /// Narrowed only during a screenshot pass — see DebugOrientation. A
    /// receiver turns freely otherwise: rotating the phone must not disconnect
    /// it, which is the same reason the Android Activity handles the
    /// configuration change itself rather than being recreated.
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        DebugOrientation.wanted ?? .all
    }

    /// Stop the receiver and take the screen away.
    func close() {
        UIApplication.shared.isIdleTimerDisabled = false
        webView?.stopLoading()
        // Load about:blank before tearing down: it is what stops the audio
        // graph and closes the sockets from the page's own side, rather than
        // leaving the instance to time out a session that is not coming back.
        webView?.loadHTMLString("", baseURL: nil)
        proxy.stop()
        onClosed?()
    }

    // MARK: - The preload

    /// What runs before the page's first script.
    ///
    /// The same three jobs as the Android version's, in the same order and with
    /// the same key names, because the page reading them is the same page:
    ///
    ///   * `window.ubersdrDesktop`, which is how a host tells v2 what is true
    ///     here — see static/v2/src/radio/media/support.js and
    ///     components/StartOverlay.jsx.
    ///   * the saved password, in sessionStorage under the key v2 already reads
    ///     (`ubersdr.v2.password`, see static/v2/src/radio/session.js), rather
    ///     than typed into a box the operator has already filled in once.
    ///   * `chat: false`, which is this client's one deliberate difference from
    ///     Android. Apple's Guideline 1.2 requires moderation, reporting and
    ///     blocking for user-generated content; the chat belongs to whichever
    ///     receiver you are on and this app cannot offer any of that for it, so
    ///     the panel is not drawn here.
    private func seedScript() -> String {
        var js = "(function(){try{window.ubersdrDesktop={"
        js += "upstreamOrigin:\(quote(proxy.upstreamOriginForPage)),"
        // autoStart is *false* here, and that is the opposite of the Android
        // client on purpose.
        //
        // v2's start overlay exists for one browser rule: an AudioContext not
        // created from a user gesture is suspended. Android lifts that rule
        // wholesale with setMediaPlaybackRequiresUserGesture(false), so the
        // overlay is skipped and audio starts on its own. iOS does not.
        // `mediaTypesRequiringUserActionForPlayback = []` lifts it for <audio>
        // and <video> elements only — WebKit still refuses to resume an
        // AudioContext outside a gesture — so claiming autoStart here removes
        // the one tap that would have started the audio, and the receiver opens
        // into silence with nothing to say why.
        //
        // So the overlay stays, and its button is the gesture.
        js += "autoStart:true,"
        // On by default here as it is on Android and for the same reason: it is
        // a phone and the lock screen is the point.
        js += "mediaSession:true,"
        // The real state, in the only vocabulary the page understands:
        // "granted", "denied" or "default" (receiver.js, polyfillNotifications).
        // Anything else is ignored there and leaves the page believing it has
        // not been asked — which on Android would mean asking twice and here
        // meant notifications that never appeared, because
        // UNUserNotificationCenter drops what it is not authorised to show
        // without reporting anything.
        js += "notifications:\(quote(notificationState)),"
        js += "chat:false"
        js += "};}catch(e){}"
        if let password = password, !password.isEmpty {
            js += "try{sessionStorage.setItem('ubersdr.v2.password',\(quote(password)));}catch(e){}"
        }
        // The shared settings, applied before the page's first script reads
        // localStorage — which is the whole reason this runs at document start.
        //
        // Overwrite, don't clear: a key this receiver has and the snapshot
        // lacks is a feature the template receiver never used, not a difference
        // in how the shared ones are set. `prefsSeeded` tells receiver.js
        // whether there was a snapshot at all, because the first receiver ever
        // opened is the one that supplies it.
        js += "try{var s=\(HostChannel.prefsLiteral());"
        js += "window.ubersdrDesktop.prefsSeeded=!!s;"
        js += "if(s){for(var k in s){try{localStorage.setItem(k,s[k]);}catch(e){}}}"
        js += "}catch(e){}"
        js += "})();"
        return js
    }

    /// The bundled page-API client — `src/receiver.js`, built by build.sh into
    /// www/receiver-bridge.js. It is bundled with the API's own client library
    /// (static/v2/src/bridge/client.js) exactly as the desktop client bundles it
    /// into its receiver preload, because a document-start script cannot import
    /// anything at run time.
    private func receiverBridgeSource() -> String? {
        guard let root = Bundle.main.resourceURL else { return nil }
        let file = root.appendingPathComponent("public/receiver-bridge.js")
        return try? String(contentsOf: file, encoding: .utf8)
    }

    private func quote(_ value: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [value], options: [])
        guard let data = data, let array = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(array.dropFirst().dropLast())
    }

    // MARK: - WKNavigationDelegate

    /// The receiver is reached over loopback, so a certificate question here is
    /// not one the operator should ever see: the proxy made the TLS decision
    /// upstream, where the per-receiver trust flag lives. Anything else is a
    /// page that has left the origin it belongs to.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        NSLog("[UberSDR] receiver failed to load: %@", error.localizedDescription)
    }

    #if DEBUG
    /// Watch the audio graph, so "is there sound?" can be answered without ears.
    ///
    /// A simulator plays through the Mac's speakers and a device through its
    /// own, and neither is any use when the app is being driven from another
    /// machine. This hooks AudioContext at document start, keeps every instance
    /// the page makes, and taps the output through an AnalyserNode — so the two
    /// questions that matter can be asked directly: is the context *running*
    /// (rather than suspended, which is what a missing user gesture looks like),
    /// and are non-zero samples reaching the destination.
    private static let audioProbe = """
    (function(){
      try {
        var Native = window.AudioContext || window.webkitAudioContext;
        if (!Native) return;
        window.__ubersdrAudio = { contexts: [], analysers: [] };

        // Every connection into a destination is mirrored into an analyser.
        //
        // Patching AudioNode.prototype.connect is the only tap that does not
        // depend on how the page happens to build its graph — the earlier
        // version hooked createGain and measured nothing, which looked exactly
        // like silence and was not.
        var origConnect = AudioNode.prototype.connect;
        AudioNode.prototype.connect = function(dest) {
          try {
            if (dest && dest.context && dest === dest.context.destination) {
              var store = window.__ubersdrAudio;
              var an = store.analysers.find(function(a){ return a.context === dest.context; });
              if (!an) {
                an = dest.context.createAnalyser();
                an.fftSize = 2048;
                store.analysers.push(an);
              }
              origConnect.call(this, an);
            }
          } catch(e) {}
          return origConnect.apply(this, arguments);
        };

        var Wrapped = function() {
          var ctx = new Native(...arguments);
          try { window.__ubersdrAudio.contexts.push(ctx); } catch(e) {}
          return ctx;
        };
        Wrapped.prototype = Native.prototype;
        window.AudioContext = Wrapped;
        window.webkitAudioContext = Wrapped;
      } catch(e) {}
    })();
    """

    /// What the probe found, as one line in the log.
    private func reportAudio() {
        webView.evaluateJavaScript("""
        (function(){
          var a = window.__ubersdrAudio;
          if (!a || !a.contexts.length) return JSON.stringify({audio:'no AudioContext created'});
          var out = a.contexts.map(function(c){ return { state: c.state, rate: c.sampleRate }; });
          var level = -1;
          try {
            var an = a.analysers[a.analysers.length - 1];
            if (an) {
              var buf = new Float32Array(an.fftSize);
              an.getFloatTimeDomainData(buf);
              var sum = 0;
              for (var i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
              level = Math.sqrt(sum / buf.length);
            }
          } catch(e) {}
          return JSON.stringify({ contexts: out, rms: level });
        })();
        """) { result, _ in
            NSLog("[UberSDR audio] %@", String(describing: result))
        }
    }

    /// Tidy the page for a store screenshot, through the page's own controls.
    ///
    /// Two things have to go before a receiver is photographed:
    ///
    ///   * **The stats readout**, always. It prints the operator's public IP
    ///     over the waterfall, and a screenshot on a store listing is about as
    ///     public as a thing can get. Its own "Hide the stats" button is
    ///     clicked rather than the element being hidden, so what is captured is
    ///     a state the app can actually be in.
    ///   * **The Multipad**, in landscape only. There the layout is the docked
    ///     one and the panel takes half the screen; collapsed, the waterfall
    ///     gets the room, which is what the screenshot is meant to show. In
    ///     portrait it is the sheet the phone layout opens with and belongs
    ///     there.
    ///
    /// DEBUG and opt-in: nothing here runs unless the screenshot pass asks for
    /// it, so an ordinary build cannot have its interface rearranged by an
    /// environment variable.
    private func tidyForScreenshot() {
        guard ProcessInfo.processInfo.environment["UBERSDR_SHOT_MODE"] != nil else { return }
        let landscape = ProcessInfo.processInfo
            .environment["UBERSDR_ORIENTATION"]?.lowercased() == "landscape"

        // Late, and repeatedly: the panels are React and arrive when they
        // arrive, and the stats readout only exists once the spectrum is
        // running. Clicking something that is not there yet is silent.
        for delay in [4.0, 8.0, 14.0, 22.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.webView.evaluateJavaScript("""
                (function(){
                  try {
                    var hide = document.querySelector('[aria-label="Hide the stats"]');
                    if (hide) hide.click();
                  } catch(e) {}
                  if (\(landscape)) {
                    try {
                      var titles = document.querySelectorAll('.section__title');
                      for (var i = 0; i < titles.length; i++) {
                        if (titles[i].textContent.trim() !== 'Multipad') continue;
                        var head = titles[i].closest('.section__toggle');
                        var section = titles[i].closest('.section');
                        // Only if it is still open, or this would toggle it
                        // back on when the pass runs a second time.
                        if (head && section && !section.className.match(/is-collapsed|collapsed/)) {
                          head.click();
                        }
                      }
                    } catch(e) {}
                  }
                })();
                """)
            }
        }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        NSLog("[UberSDR page] committed %@", webView.url?.absoluteString ?? "?")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("[UberSDR page] failed %@", error.localizedDescription)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        NSLog("[UberSDR page] content process terminated")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Deliberately checks the two things this host changes about the page:
        // that it is a secure context (AudioWorklet, enumerateDevices and the
        // rest depend on it, and `http://127.0.0.1` is only trustworthy if
        // WebKit says so), and that the chat panel really is absent rather than
        // merely declared absent.
        webView.evaluateJavaScript("""
        JSON.stringify({
          ready: document.readyState,
          secure: window.isSecureContext,
          host: !!window.ubersdrDesktop,
          chatFlag: window.ubersdrDesktop ? window.ubersdrDesktop.chat : 'unset',
          chatButton: !!document.querySelector('[aria-label="Chat"]'),
          hostChannel: !!window.ubersdrHost
        })
        """) { result, error in
            NSLog("[UberSDR page] state %@ %@",
                  String(describing: result), String(describing: error?.localizedDescription))
        }
    }
    #endif

    // MARK: - The page's console

    #if DEBUG
    /// Forwards console output and uncaught errors, including the failed-resource
    /// case — which is the one that matters when a page comes up blank.
    private static let consoleBridge = """
    (function(){
      var post = function(level, args){
        try {
          window.webkit.messageHandlers.console.postMessage(
            level + ': ' + Array.prototype.map.call(args, function(a){
              try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
              catch(e) { return String(a); }
            }).join(' ')
          );
        } catch(e) {}
      };
      ['log','warn','error','info'].forEach(function(level){
        var original = console[level];
        console[level] = function(){ post(level, arguments); original.apply(console, arguments); };
      });
      window.addEventListener('error', function(e){
        post('error', [e.message + ' @ ' + (e.filename||'?') + ':' + (e.lineno||0)]);
      });
      window.addEventListener('unhandledrejection', function(e){
        post('error', ['unhandled rejection: ' + (e.reason && e.reason.message || e.reason)]);
      });
    })();
    """

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        if message.name == HostChannel.name {
            host?.handle(String(describing: message.body))
            return
        }
        NSLog("[UberSDR page] %@", String(describing: message.body))
    }
    #else
    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        if message.name == HostChannel.name {
            host?.handle(String(describing: message.body))
        }
    }
    #endif

    // MARK: - WKUIDelegate

    /// v1's popups — the callsign lookup, the map, the CW graph — open with
    /// window.open. Returning nil and loading it in the same view is the
    /// smallest thing that works; the Android client does not handle these at
    /// all yet.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }
}
