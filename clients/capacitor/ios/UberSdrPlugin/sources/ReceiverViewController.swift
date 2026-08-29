import Foundation
import UIKit
import WebKit
import AVFoundation
import MediaPlayer

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
    /// The web view's bottom, held so a keyboard can shorten it. See viewDidLoad.
    private var webBottom: NSLayoutConstraint?
    private let product: String
    private let password: String?
    /// What the OS has already decided about notifications: "granted",
    /// "denied" or "default", which is the vocabulary receiver.js reads.
    private let notificationState: String
    /// "shared" or "receiver": whose settings this receiver reads and writes.
    /// Decided in the chooser and handed over with the receiver, because the
    /// page must be seeded before its first script runs and there is no asking
    /// anything by then.
    private let prefsScope: String?

    /// Raised when this screen goes away, whichever way it went — v2's own
    /// power button, or the operator swiping back. `api.js` listens for it.
    var onClosed: (() -> Void)?

    private var webView: WKWebView!
    private var host: HostChannel?

    init(instanceId: String, label: String, proxy: LocalProxy, product: String,
         password: String?, notificationState: String, prefsScope: String?) {
        self.prefsScope = prefsScope
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
        // navigator.vibrate, which WebKit does not implement. Added after the
        // host shim because it posts through it. v2 feature-tests for the
        // function (lib/haptics.js), so providing it is the whole of turning
        // haptics on — the mode and per-scope settings in the Haptics panel
        // then work exactly as they do everywhere else.
        controller.addUserScript(WKUserScript(source: Self.vibrateShim,
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true))
        // Somewhere to find the audio graph again after the system has stopped
        // it. Not a debugging aid: see resumeAudio.
        controller.addUserScript(WKUserScript(source: Self.audioHandle,
                                              injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true))
        // What stops the ring switch silencing the receiver. Installed before
        // the handle, which is what starts it. See silentAnchor.
        controller.addUserScript(WKUserScript(source: Self.silentAnchor,
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
        //
        // ...except while a keyboard is up, which is what `webBottom` is held
        // for. A WKWebView is not resized for the keyboard — the keys are drawn
        // over the page and the field being typed into can be under them, which
        // on a handset is most of them: the Multipad's frequency box, the
        // callsign lookup, the bookmark search. WebKit pans its visual viewport
        // to reveal the input, which works on a page that scrolls and does
        // nothing for this one, because the interface is exactly one window
        // tall and scrolls inside itself.
        //
        // So the web view is shortened instead, by exactly the height the
        // keyboard covers, and the page lays out in what is left — the same
        // answer Android reaches by applying the IME inset (SystemBars.java),
        // and for the same reason: it needs nothing from the page, so every
        // field in every panel is dealt with at once.
        webBottom = webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webBottom!,
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])

        for name in [UIResponder.keyboardWillChangeFrameNotification,
                     UIResponder.keyboardWillHideNotification] {
            NotificationCenter.default.addObserver(
                self, selector: #selector(keyboardChanged(_:)), name: name, object: nil)
        }
        // ...and again once the keyboard has finished arriving or leaving.
        // WebKit reveals the focused field by scrolling its own scroll view, and
        // does it after its own layout rather than with ours — so the correction
        // has to happen at the end as well as during. See unscroll.
        for name in [UIResponder.keyboardDidShowNotification,
                     UIResponder.keyboardDidHideNotification,
                     UIResponder.keyboardDidChangeFrameNotification] {
            NotificationCenter.default.addObserver(
                self, selector: #selector(keyboardSettled), name: name, object: nil)
        }

        host = HostChannel(webView: webView, instanceId: instanceId, label: label,
                           prefsScope: prefsScope)
        host?.onTransport = { [weak self] action in
            DispatchQueue.main.async { self?.transport(action) }
        }
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

        // Coming back to the app, and coming back from an interruption, are the
        // two moments audio has to be picked up again. See resumeAudio.
        NotificationCenter.default.addObserver(
            self, selector: #selector(appBecameActive),
            name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(audioInterrupted(_:)),
            name: AVAudioSession.interruptionNotification, object: nil)
        // The app's own session, which an interruption or another app can leave
        // somewhere else — a category change is posted here, as a route change
        // with that reason. Not the ring switch: that is the page's session and
        // is not this process's to set. See silentAnchor.
        NotificationCenter.default.addObserver(
            self, selector: #selector(routeChanged(_:)),
            name: AVAudioSession.routeChangeNotification, object: nil)
        // Every session, engine and converter in the process becomes invalid at
        // once, and an app is expected to rebuild rather than carry on. Nothing
        // here did, and what was left was a receiver playing into a graph that
        // no longer existed.
        NotificationCenter.default.addObserver(
            self, selector: #selector(mediaServicesReset),
            name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        // Started *before* the app suspends, which is the whole trick — see
        // startBackgroundAudio.
        NotificationCenter.default.addObserver(
            self, selector: #selector(appWillResignActive),
            name: UIApplication.willResignActiveNotification, object: nil)
        // And again once actually backgrounded, in case the first attempt was
        // made before the page had a session to hand over. Harmless when it was
        // not: startBackgroundAudio answers 'already' and does nothing.
        NotificationCenter.default.addObserver(
            self, selector: #selector(appWillResignActive),
            name: UIApplication.didEnterBackgroundNotification, object: nil)

        // Where a saved file goes on this platform: to the operator, through
        // the share sheet, to be put in Files or sent on. There is nowhere else
        // for it to go — an app cannot write into the user's documents on their
        // behalf, and a file left in this app's container is a file nobody can
        // reach. See LocalProxy.receiveSave, which is what a v2 export reaches.
        proxy.onSaveFile = { [weak self] url in
            guard let self = self else { return }
            let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            // Required on iPad, where a sheet with nothing to point at is a
            // crash rather than a layout problem. The middle of the view is
            // where the file conceptually came from — the page — and is the
            // least surprising place for it to grow out of.
            share.popoverPresentationController?.sourceView = self.view
            share.popoverPresentationController?.sourceRect = CGRect(
                x: self.view.bounds.midX, y: self.view.bounds.midY, width: 0, height: 0)
            share.popoverPresentationController?.permittedArrowDirections = []
            // The file is in a directory of its own under tmp; it goes when the
            // sheet is done with it, whether or not anything was chosen. iOS
            // clears tmp on its own eventually, but "eventually" for a 100 MB
            // recording somebody cancelled out of is not good enough.
            share.completionWithItemsHandler = { _, _, _, _ in
                try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
            }
            self.present(share, animated: true)
        }

        if let url = URL(string: proxy.origin + "/v2/") {
            webView.load(URLRequest(url: url))
        }

        startAudioWatch()

        #if DEBUG
        // The background path, exercised in the foreground.
        //
        // What it is for is a simulator: process suspension is not modelled
        // there, so backgrounding proves nothing, while everything *else* that
        // can go wrong on this path — no session id to hand over, a refused
        // stream, a container we cannot parse, an Opus packet the system
        // decoder rejects — fails the same way on both. See build-mac.sh
        // --bgtest, which reads the log this writes.
        if ProcessInfo.processInfo.environment["UBERSDR_BGTEST"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
                guard let self = self else { return }
                NSLog("[UberSDR audio] bgtest: session id %@",
                      self.proxy.audioSessionId ?? "(none captured)")
                self.startBackgroundAudio()
                // Twice, twenty seconds apart: the difference is the rate, and
                // 48000 a second is the only right answer.
                for tick in [10.0, 30.0] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + tick) { [weak self] in
                        guard let self = self else { return }
                        NSLog("[UberSDR audio] bgtest: %d frames after %.0fs",
                              self.backgroundAudio.framesPlayed, tick)
                    }
                }
            }
        }
        #endif
    }

    private let backgroundAudio = BackgroundAudio()
    /// See startAudioWatch. Held so close() can stop it.
    private var audioWatch: Timer?
    /// Whether the one-line description of the session has been logged for this
    /// receiver — see PlaybackSession.describe.
    private var describedAudio = false

    /// Shorten the page to whatever the keyboard leaves, and put it back after.
    ///
    /// Two coordinate spaces meet here and getting them wrong is silent. The
    /// notification's frame is in *screen* coordinates; the view's bounds are
    /// its own. Converting screen → window → view is the only route that holds
    /// on an iPad, where the app's window need not fill the screen at all —
    /// Split View, Slide Over, Stage Manager — so a comparison against the
    /// screen answers "not covered" for a keyboard that is plainly covering the
    /// page. Full screen on a phone it makes no difference, which is exactly
    /// why the wrong version looked like it worked.
    ///
    /// A will-hide notification gives a frame below the bottom of everything,
    /// so the same arithmetic answers zero and no special case is needed.
    ///
    /// Animated with the curve and duration the keyboard published: the page
    /// shrinking a beat after the keys have arrived is more noticeable than the
    /// shrink itself.
    @objc private func keyboardChanged(_ note: Notification) {
        guard let webBottom = webBottom,
              let window = view.window,
              let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
        else { return }

        let inWindow = window.convert(frame, from: nil)
        let inView = view.convert(inWindow, from: window)
        let covered = max(0, view.bounds.maxY - inView.minY)
        let wanted = -covered

        guard abs(webBottom.constant - wanted) > 0.5 else { return }
        webBottom.constant = wanted

        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0.25
        let curve = (note.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? UInt) ?? 0
        UIView.animate(withDuration: duration,
                       delay: 0,
                       options: UIView.AnimationOptions(rawValue: curve << 16),
                       animations: { self.view.layoutIfNeeded() },
                       completion: { _ in self.unscroll() })
    }

    @objc private func keyboardSettled() { unscroll() }

    /// Put back whatever WebKit scrolled to reveal the field.
    ///
    /// WKWebView reveals a focused input by scrolling its own scroll view, and
    /// it does that whether or not the page needs it — this interface is
    /// exactly one window tall, so there is nothing to scroll and the offset it
    /// leaves is pure damage: the panel sits higher than it was, and stays
    /// there after the keyboard has gone because nothing scrolls it back.
    ///
    /// Reset rather than prevented. The switch that would stop it is private
    /// API and an app that used it could not be shipped; the offset is public
    /// and belongs at zero on a page that does not scroll.
    private func unscroll() {
        let scroll = webView.scrollView
        guard scroll.contentOffset.y != 0 || scroll.contentOffset.x != 0 else { return }
        scroll.setContentOffset(.zero, animated: false)
    }

    @objc private func appWillResignActive() {
        // Claimed here, on the way out, and not from the background.
        //
        // The session has to be taken back *before* the app stops being active,
        // because taking it is an interruption of somebody and only a
        // foreground app is allowed to interrupt. Asked from the background the
        // activation is refused outright — `CannotInterruptOthers` — and what
        // is left is the stream decoding at full rate into a stopped engine:
        // silence, with every part of it apparently working.
        //
        // The somebody is this app's own WebView. The silent anchor exists to
        // make WebKit classify the page as media rather than Web Audio, which
        // is what stops the ring switch silencing it — and a media page takes a
        // *non-mixable* session, so WebKit interrupts this process the moment
        // the page starts playing and the silent engine has been stopped ever
        // since. The two fixes want the same session, and this is where they
        // are ordered: the page has it while the app is in front, and the app
        // takes it back on the way out, which is exactly when the page is about
        // to stop being able to use it anyway.
        guard UIApplication.shared.applicationState == .active else {
            startBackgroundAudio()
            return
        }
        // And taken only once the page has let go of it. Claiming alone is not
        // enough: the page still holds a running AudioContext and the anchor
        // element, and the `audio` background mode is exactly what lets WebKit
        // carry on playing a media element once the app is down. So it
        // re-activates its own session on the way into the background, half a
        // second after this claim, and interrupts the app at the one moment the
        // app is no longer allowed to answer.
        releasePageAudio { [weak self] in
            guard let self = self else { return }
            PlaybackSession.begin()
            // Before the stream's node is attached, so a replaced engine costs
            // nothing to reattach.
            PlaybackSession.recover()
            self.startBackgroundAudio()
        }
    }

    /// Have the page put its audio down, so the app can pick the session up.
    ///
    /// The anchor is paused and every live context suspended. Both are restored
    /// by resumeAudio on the way back — the contexts by the resume loop, the
    /// anchor by `__ubersdrKeepAudible` — so this is a handover and not a stop.
    ///
    /// Answered on the main thread, and answered *once*: the claim that follows
    /// must not be skipped because the page was slow or the WebView was gone, so
    /// a fallback fires it anyway. Half a second is longer than the round trip
    /// and shorter than the window `willResignActive` leaves.
    private func releasePageAudio(_ done: @escaping () -> Void) {
        var answered = false
        let once = {
            guard !answered else { return }
            answered = true
            done()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: once)

        guard let webView = webView else { once(); return }
        webView.callAsyncJavaScript("""
        var el = document.querySelector('audio[data-ubersdr-anchor]');
        if (el) { try { el.pause(); } catch (e) {} }
        var live = (window.__ubersdrAudioContexts || []).filter(function(c) {
          return c.state === 'running';
        });
        for (var i = 0; i < live.length; i++) {
          try { await live[i].suspend(); } catch (e) {}
        }
        return live.length;
        """, arguments: [:], in: nil, in: .page) { _ in once() }
    }

    @objc private func appBecameActive() {
        stopBackgroundAudio()
        resumeAudio()
    }

    /// Keep playing with the app in the background.
    ///
    /// The audio moves out of the WebView and into the app — see
    /// BackgroundAudio, which explains why it has to. Started on
    /// `willResignActive` and again on `didEnterBackground`, because the first
    /// of those can arrive before the page has a session id to hand over and
    /// the second cannot; starting twice does nothing.
    private func startBackgroundAudio() {
        guard let session = proxy.audioSessionId, !session.isEmpty else { return }
        backgroundAudio.start(origin: proxy.origin, sessionId: session)
    }

    /// Give the audio back to the page.
    private func stopBackgroundAudio() {
        guard backgroundAudio.isRunning else { return }
        backgroundAudio.stop(origin: proxy.origin, sessionId: proxy.audioSessionId ?? "")
    }

    /// A phone call, Siri, another app taking the session — anything that
    /// stopped the audio rather than the app being left.
    @objc private func audioInterrupted(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        // `.began` needs nothing, and not for the reason it used to: the
        // thought was that the system has already stopped the audio and what
        // matters is being ready when it ends. What matters is not being
        // interrupted in the first place — see appWillResignActive — because
        // there is no answer from here. iOS refuses `setActive` to a
        // backgrounded app holding a non-mixable category whatever else is or
        // is not playing, which was measured: three attempts on a ladder, all
        // refused with `CannotInterruptOthers`, while `isOtherAudioPlaying`
        // said no. Recovery is not available; only prevention is.
        guard type == .ended else { return }
        resumeAudio()
    }

    /// The route changed — which is also how a *category* change arrives.
    @objc private func routeChanged(_ note: Notification) {
        PlaybackSession.reassert()
    }

    /// The audio system was reset under everything.
    ///
    /// The session and the silent engine are rebuilt, the page's contexts are
    /// resumed, and any background stream is started again rather than resumed:
    /// its converter and its player node went with the media server, and what
    /// replaces them cannot be built until the stream's header arrives. A beat
    /// later, because the hand-back unwinds on the stream's own queue.
    @objc private func mediaServicesReset() {
        PlaybackSession.describe("media services reset")
        let wasBackground = backgroundAudio.isRunning
        stopBackgroundAudio()
        PlaybackSession.rebuild()
        resumeAudio()
        guard wasBackground else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.startBackgroundAudio()
        }
    }

    /// Play and pause from the lock screen, answered by the host.
    ///
    /// Only while the app is not in front. In the foreground the page owns the
    /// audio and its own handler — play/pause as mute — is the right one, and
    /// the forward in HostChannel has already sent it there. In the background
    /// the page is suspended and the native stream is what is playing, so the
    /// stream is what has to stop and start.
    ///
    /// Stopped rather than held: this is a live receiver, and a paused one has
    /// nothing to catch up on. Stopping hands the audio back the way coming
    /// into the foreground does, and play asks for it again.
    private func transport(_ action: String) {
        let wantsPlay: Bool
        switch action {
        case "play": wantsPlay = true
        case "pause": wantsPlay = false
        case "toggle": wantsPlay = !backgroundAudio.isRunning
        default: return
        }
        MPNowPlayingInfoCenter.default().playbackState = wantsPlay ? .playing : .paused
        guard UIApplication.shared.applicationState != .active else { return }
        if wantsPlay {
            // The session may have been let go with the audio — see
            // appWillResignActive, which is the only other place this is
            // claimed. Nothing is holding it now, so this is allowed from the
            // background where the reclaim ladder's attempts are not.
            PlaybackSession.begin()
            PlaybackSession.recover()
            startBackgroundAudio()
        } else {
            stopBackgroundAudio()
        }
    }

    /// Put the background stream back on a graph that has been replaced.
    ///
    /// Started again rather than reattached: its player node and converter are
    /// built from the stream's header, which has gone past. The beat is for the
    /// hand-back, which unwinds on the stream's own queue.
    private func restartBackgroundStream() {
        guard backgroundAudio.isRunning else { return }
        stopBackgroundAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            // Not if the app came back in the meantime: the restart is for a
            // stream that is still the only thing playing, and starting one in
            // the foreground would take the audio off the page that has just
            // been handed it back.
            guard UIApplication.shared.applicationState != .active else { return }
            self?.startBackgroundAudio()
        }
    }

    /// Is the audio session still ours, while there is audio to lose?
    ///
    /// `routeChangeNotification` is the right hook for a category change and
    /// not a complete one: it is posted when the new category moves the *route*,
    /// and a page being moved from playback to ambient need not move anything at
    /// all. So the category is looked at on a timer as well.
    ///
    /// It costs a property read. Where nothing has gone wrong the category is
    /// already `.playback` and `reassert` returns having touched nothing, so
    /// this cannot thrash the session on the devices that work — only on one
    /// that is already silent.
    private func startAudioWatch() {
        guard audioWatch == nil else { return }
        let timer = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            // Not before the audio socket is up: until then there is nothing
            // playing, nothing to reclaim the session for, and no reason to
            // argue with whatever category WebKit has chosen.
            guard let id = self.proxy.audioSessionId, !id.isEmpty else { return }
            if !self.describedAudio {
                self.describedAudio = true
                PlaybackSession.describe("audio started")
                self.describeAnchor()
            }
            PlaybackSession.reassert()
        }
        RunLoop.main.add(timer, forMode: .common)
        audioWatch = timer
    }

    /// Whether the page is holding a media element for WebKit to classify.
    ///
    /// The part of the ring switch that can be checked without one. A simulator
    /// enforces no category and has no switch, so the fix itself cannot be seen
    /// there — but its mechanism can: the element either exists and is playing,
    /// unmuted and above zero, or the page is Web Audio alone and back to being
    /// ambient. Written to the same log build-mac.sh --bgtest reads.
    private func describeAnchor() {
        webView?.evaluateJavaScript("""
        (function(){
          var el = document.querySelector('audio[data-ubersdr-anchor]');
          if (!el) return 'missing';
          return (el.paused ? 'paused' : 'playing')
            + ' volume=' + el.volume + ' muted=' + el.muted
            + ' readyState=' + el.readyState;
        })();
        """) { value, _ in
            NSLog("[UberSDR audio] silent anchor: %@", (value as? String) ?? "(no answer)")
        }
    }

    /// Restart a graph that says it is running and is not.
    ///
    /// The state flags are no help here. An AudioContext interrupted with the
    /// app in the background comes back reporting `running` while its renderer
    /// is gone, so the resume loop below finds nothing to resume and the page
    /// stays silent with every flag healthy. What tells the truth is
    /// `currentTime`, which stops advancing.
    ///
    /// So the graph is timed rather than asked, and a context that has not
    /// moved is suspended and resumed — the pair, not a bare `resume()`, which
    /// a context that believes it is running treats as nothing to do.
    private func unstallGraph() {
        webView?.callAsyncJavaScript("""
        var live = (window.__ubersdrAudioContexts || []).filter(function(c) {
          return c.state !== 'closed';
        });
        if (!live.length) return '';
        function stamp() { return live.map(function(c) { return c.currentTime; }); }
        var before = stamp();
        await new Promise(function(r) { setTimeout(r, 1500); });
        var after = stamp();
        var kicked = 0, stuck = 0;
        for (var i = 0; i < live.length; i++) {
          var ctx = live[i];
          if (after[i] > before[i]) continue;
          try {
            await ctx.suspend();
            await ctx.resume();
          } catch (e) { stuck++; continue; }
          await new Promise(function(r) { setTimeout(r, 800); });
          if (ctx.currentTime > after[i]) { kicked++; } else { stuck++; }
        }
        if (!kicked && !stuck) return '';
        return 'restarted ' + kicked + ', still stalled ' + stuck;
        """, arguments: [:], in: nil, in: .page) { result in
            // Silent when there was nothing to do, which is the ordinary case.
            // A graph that had to be restarted is worth a line: it means the
            // system stopped rendering the page's audio without saying so.
            guard case .success(let value) = result,
                  let what = value as? String, !what.isEmpty else { return }
            NSLog("[UberSDR audio] stalled graph: %@", what)
        }
    }

    /// Start the audio again after the system has stopped it.
    ///
    /// Two halves, and both are needed. The **audio session** may have been
    /// deactivated by an interruption, so it is claimed again — without that, a
    /// resumed graph plays into nothing. And the **AudioContext** is left
    /// suspended when the content process is thawed, which is the part that
    /// makes this a host job at all: a page cannot notice that it was frozen,
    /// so it never calls resume(), and audio that stopped when you switched
    /// apps never comes back. Stopping and restarting the receiver was the only
    /// way out, which is a poor thing to have to know.
    private func resumeAudio() {
        PlaybackSession.begin()
        // A replaced engine orphans the background stream — see
        // PlaybackSession.recover. Started again rather than reattached: the
        // player node is built from the stream's header, which has gone past.
        // Only reached from the background, because the foreground path hands
        // the audio back before it gets here.
        if PlaybackSession.recover() { restartBackgroundStream() }
        webView?.evaluateJavaScript("""
        (function(){
          try { window.__ubersdrKeepAudible(); } catch(e) {}
          var list = window.__ubersdrAudioContexts || [];
          var resumed = 0;
          for (var i = 0; i < list.length; i++) {
            try {
              if (list[i].state === 'suspended' || list[i].state === 'interrupted') {
                list[i].resume();
                resumed++;
              }
            } catch(e) {}
          }
          return resumed;
        })();
        """) { [weak self] _, _ in
            // After the states have been dealt with, because this is about the
            // ones the states do not describe.
            self?.unstallGraph()
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
        tidyForScreenshot()
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
        audioWatch?.invalidate()
        audioWatch = nil
        // Before the proxy goes: the hand-back is sent through it.
        stopBackgroundAudio()
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
    ///   * `chat: false`. Apple's Guideline 1.2 requires moderation, reporting
    ///     and blocking for user-generated content; the chat belongs to
    ///     whichever receiver you are on and this app cannot offer any of that
    ///     for it, so the panel is not drawn here.
    ///
    ///     This was once the one deliberate difference from Android. It is not
    ///     any more: the Android client sets the same flag to the same value,
    ///     because Google Play asks for the same things and the reason neither
    ///     client can offer them was never about which store it was — it is
    ///     that the channel belongs to somebody else's receiver. See
    ///     ReceiverActivity.seedScript.
    private func seedScript() -> String {
        var js = "(function(){try{window.ubersdrDesktop={"
        js += "upstreamOrigin:\(quote(proxy.upstreamOriginForPage)),"
        // autoStart, as on Android: the start overlay does not appear in either
        // app, and a receiver opened from the chooser is already the gesture.
        //
        // This comment used to say the opposite — that WebKit refuses to resume
        // an AudioContext outside a user gesture, so the overlay had to stay and
        // its button had to be the gesture. That is the rule in Safari and it is
        // not the rule here: `mediaTypesRequiringUserActionForPlayback = []` on
        // the configuration lifts it for this WebView, and receivers have been
        // opening straight into audio ever since. The prose survived a change
        // the code had already made, which is worth naming rather than deleting
        // — the next person to read it will otherwise wonder which is true.
        //
        // One consequence, and it belongs here rather than in v2: the overlay's
        // second start button (the simple layout — see lib/shellPref.js) can
        // never be reached in these apps, because the overlay is never drawn.
        // That choice lives in the chooser's settings page and in the Display
        // panel instead.
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
        js += "chat:false,"
        // Panels this client does not want, whatever the receiver offers — see
        // static/v2/src/lib/hostPanels.js. Hiding one more is a name in the
        // list below and nothing else: no change to v2, no new flag, and the
        // Android client has the same list for the same reason.
        js += "hidePanels:\(Self.hiddenPanels)"
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
        js += "try{var s=\(HostChannel.prefsLiteral(scope: prefsScope, instanceId: instanceId));"
        js += "window.ubersdrDesktop.prefsSeeded=!!s;"
        js += "if(s){for(var k in s){try{localStorage.setItem(k,s[k]);}catch(e){}}}"
        js += "}catch(e){}"
        js += "})();"
        return js
    }

    /// Keeps a reference to every AudioContext the page makes.
    ///
    /// A page has no way to enumerate its own audio contexts, and this host
    /// needs to reach them: iOS suspends a WKWebView's content process when the
    /// app leaves the foreground, which suspends the graph with it, and nothing
    /// resumes it on the way back. v2 cannot be expected to handle that — a page
    /// in a browser is never suspended like this — so the host does it, and
    /// this is how it finds what to resume.
    /// What stops the ring switch silencing the receiver.
    ///
    /// The page's audio is not this app's. It is rendered in the WebContent
    /// process, which has an `AVAudioSession` of its own — sessions are
    /// per-process — and WebKit chooses *that* session's category from what the
    /// page is playing. A page whose only audio is an AudioContext is read as
    /// Web Audio and given the `ambient` category, which is the one category
    /// the ring switch silences.
    ///
    /// Nothing this process does to its own session reaches that one, which is
    /// why claiming `.playback` here never fixed it and why the reassertion in
    /// PlaybackSession never saw anything to reclaim: the session it inspects
    /// is not the session refusing the audio. It presented as the app's own
    /// audio being fine — background playback is this process, and audible with
    /// the switch on silent — while the page in front of you was mute.
    ///
    /// What WebKit does read is what kind of media the page holds. A media
    /// element that *could* produce audio moves the page off ambient, and
    /// "could" is a question about the element — an audio track, not muted,
    /// volume above zero — and not about the samples. So this plays a second of
    /// digital silence on a loop, built in the page rather than carried as a
    /// data URI, and the receiver's own audio becomes audible alongside it.
    ///
    /// Started with the first AudioContext rather than at load, so opening a
    /// receiver does not interrupt whatever the phone was already playing
    /// before the receiver has anything of its own to say. Paused while the
    /// page is hidden, so that WebKit's session does not sit alongside this
    /// process's own during the background handover — see BackgroundAudio,
    /// which is what plays from there.
    private static let silentAnchor = """
    (function(){
      if (window.__ubersdrKeepAudible) return;
      var el = null;

      // A WAV of silence. 16-bit, so silence really is zeroes and the whole
      // body is the buffer's own.
      function silence(seconds) {
        var rate = 8000, bytes = rate * seconds * 2;
        var buf = new ArrayBuffer(44 + bytes), view = new DataView(buf);
        function tag(at, s) {
          for (var i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
        }
        tag(0, 'RIFF');  view.setUint32(4, 36 + bytes, true);
        tag(8, 'WAVE');
        tag(12, 'fmt '); view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);        // PCM
        view.setUint16(22, 1, true);        // mono
        view.setUint32(24, rate, true);
        view.setUint32(28, rate * 2, true); // bytes per second
        view.setUint16(32, 2, true);        // block align
        view.setUint16(34, 16, true);       // bits
        tag(36, 'data'); view.setUint32(40, bytes, true);
        return new Blob([buf], { type: 'audio/wav' });
      }

      window.__ubersdrKeepAudible = function() {
        try {
          if (!el) {
            var parent = document.body || document.documentElement;
            if (!parent) return;
            el = document.createElement('audio');
            // Without this iOS takes the audio fullscreen rather than playing
            // it where it is, which a hidden element cannot do.
            el.setAttribute('playsinline', '');
            el.setAttribute('data-ubersdr-anchor', '');
            el.loop = true;
            el.muted = false;
            el.volume = 1;
            el.style.display = 'none';
            el.src = URL.createObjectURL(silence(1));
            parent.appendChild(el);
          }
          if (document.hidden) return;
          var started = el.play();
          if (started && started.catch) started.catch(function(){});
        } catch (e) {}
      };

      // Handed back while the page is not in front. Done from in here rather
      // than from the host because the host's message may not be delivered
      // before the content process is frozen, and this one runs on the way out.
      document.addEventListener('visibilitychange', function() {
        if (!el) return;
        if (document.hidden) { try { el.pause(); } catch (e) {} }
        else window.__ubersdrKeepAudible();
      });
    })();
    """

    private static let audioHandle = """
    (function(){
      try {
        var Native = window.AudioContext || window.webkitAudioContext;
        if (!Native || window.__ubersdrAudioContexts) return;
        window.__ubersdrAudioContexts = [];
        var Wrapped = function() {
          var ctx = new Native(...arguments);
          try { window.__ubersdrAudioContexts.push(ctx); } catch(e) {}
          // The page now has audio to lose to the ring switch — see
          // silentAnchor.
          try { window.__ubersdrKeepAudible(); } catch(e) {}
          return ctx;
        };
        Wrapped.prototype = Native.prototype;
        window.AudioContext = Wrapped;
        window.webkitAudioContext = Wrapped;
      } catch(e) {}
    })();
    """

    /// `navigator.vibrate` in terms of the host channel.
    ///
    /// Returns true as the real one does: v2 does not read the answer, but a
    /// shim that reports failure invites a caller to conclude the feature is
    /// missing when it is not.
    /// Panels hidden on this platform — ids from static/v2/src/panels/registry.jsx.
    ///
    /// All three are controls for hardware attached to *this* machine, and a
    /// phone is not that machine. Shortcuts is a list of keyboard bindings on a
    /// device with no keyboard; Radio control drives a transceiver over
    /// hamlib/rigctl, and SDR control a local SDR — both of which reach the
    /// operator's shack over a serial port or a daemon this app cannot see.
    /// Shown here they would be panels that can only fail.
    ///
    /// Chat is not in the list: it is switched off by its own flag above,
    /// because "this client has no chat" is a statement about what the client
    /// *can do*, where this list is what it would rather not show.
    private static let hiddenPanels = #"["shortcuts","radiocontrol","sdrcontrol"]"#

    private static let vibrateShim = """
    (function(){
      try {
        if (typeof navigator.vibrate === 'function') return;
        navigator.vibrate = function(pattern) {
          try {
            var list = Array.isArray(pattern) ? pattern : [pattern];
            window.ubersdrHost.postMessage(JSON.stringify({
              type: 'vibrate',
              pattern: list.map(function(n){ return Number(n) || 0; })
            }));
          } catch(e) {}
          return true;
        };
      } catch(e) {}
    })();
    """

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

    /// Somebody else's website goes to Safari, not into this WebView.
    ///
    /// The Links and Share menus are full of them — Reddit, the ARRL, a
    /// WhatsApp share, a QRZ lookup — and until this they opened inside the
    /// receiver, replacing it. That is wrong twice over: the receiver is
    /// running, with audio and a session, and a page that has navigated away
    /// from it has stopped it; and a website inside a radio app has none of the
    /// things a browser has for getting back out of one.
    ///
    /// Two origins stay in: the loopback proxy, which is the receiver itself,
    /// and the instance's own host, because v1's popups — the callsign lookup,
    /// the map, the CW graph — are opened by absolute URL and belong to the
    /// receiver as much as anything served through the proxy does.
    /// Three answers, not two, and the third is the one that is easy to miss.
    ///
    ///   * The page's own content — about:blank is how a page closes itself,
    ///     data: and blob: are things it made — stays where it is.
    ///   * http(s) to the loopback proxy or to the instance is the receiver.
    ///   * **Everything else goes to the system**, and that includes schemes
    ///     that are not http at all. `mailto:` is the one that proves it: the
    ///     Share menu offers email (lib/share.js), a WebView cannot load a
    ///     mailto: URL, and "not http, so leave it alone" means the button does
    ///     nothing at all and says nothing about why. `tel:`, `sms:` and the
    ///     messenger schemes are the same shape of problem.
    private func isReceiverOwn(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return true }
        if ["about", "data", "blob", "file"].contains(scheme) { return true }
        guard scheme == "http" || scheme == "https" else { return false }
        guard let host = url.host?.lowercased() else { return false }
        if host == "127.0.0.1" || host == "localhost" { return true }
        if let upstream = URL(string: proxy.upstreamOriginForPage)?.host?.lowercased() {
            return host == upstream
        }
        return false
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, !isReceiverOwn(url) else {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
        UIApplication.shared.open(url)
    }

    /// The receiver is reached over loopback, so a certificate question here is
    /// not one the operator should ever see: the proxy made the TLS decision
    /// upstream, where the per-receiver trust flag lives. Anything else is a
    /// page that has left the origin it belongs to.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
                 withError error: Error) {
        NSLog("[UberSDR] receiver failed to load: %@", error.localizedDescription)
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

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("[UberSDR page] failed %@", error.localizedDescription)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        NSLog("[UberSDR page] content process terminated")
    }

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

    /// A new window, which this app does not have.
    ///
    /// Everything in the Links menu opens with `window.open` — the external
    /// ones directly, the receiver's own pages through a sized popup (see
    /// LinksMenu.jsx) — and so do the Share menu, the callsign lookup and the
    /// start overlay's Statistics link. None of them arrive at decidePolicyFor,
    /// so this is the second half of the same policy.
    ///
    /// All of it goes to the browser, including the receiver's own pages, and
    /// that last part is the correction. Loading them in place looked right —
    /// they belong to the receiver as much as v2 does — but a phone has no
    /// second window and no browser chrome, so it replaced the receiver with a
    /// page having no way back to it: the interface, the audio and the session
    /// gone, for a link somebody expected to open beside what they were
    /// listening to. `window.open` means "somewhere else", and out here the
    /// only somewhere else is the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard navigationAction.targetFrame == nil,
              let url = navigationAction.request.url else { return nil }
        UIApplication.shared.open(outsideURL(url))
        return nil
    }

    /// The same page, addressed the way something outside this app can reach it.
    ///
    /// v2's own pages are relative, so a popup resolves against the page's
    /// origin — which is the loopback proxy, on a port that means nothing once
    /// the receiver is closed and nothing at all to another device. The
    /// instance's own origin is the address of the same page.
    private func outsideURL(_ url: URL) -> URL {
        guard let host = url.host?.lowercased(), host == "127.0.0.1" || host == "localhost",
              var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let upstream = URLComponents(string: proxy.upstreamOriginForPage),
              upstream.host != nil else { return url }
        parts.scheme = upstream.scheme
        parts.host = upstream.host
        parts.port = upstream.port
        return parts.url ?? url
    }
}
