import Foundation
import UIKit
import WebKit
import AVFoundation
import MediaPlayer
import UserNotifications

/// Everything the page asks of its host, in one place.
///
/// `src/receiver.js` is staged into both clients and does not know which one it
/// is running in: it talks to `window.ubersdrHost.postMessage(json)` and listens
/// on `window.ubersdrHost.onmessage`. On Android that channel is
/// `WebViewCompat.addWebMessageListener`; here it is a
/// `WKScriptMessageHandler` plus a three-line shim in the document-start
/// script, because WebKit's own handler is spelled
/// `window.webkit.messageHandlers.<name>` and the shared file must not have to
/// care.
///
/// The protocol, page → host:
///
///   metadata / artwork    what the lock screen shows
///   running / stopped     whether there is anything to show it for
///   notice / notice-close / notice-permission
///                         v2's own notifications, in Notification Centre
///   speak / speak-cancel / voices
///                         spoken announcements, which a WKWebView cannot do
///   prefs                 the shared settings snapshot
///
/// and host → page, as strings: `action:<name>`, `notice-click:<tag>`,
/// `voices:<json>`, `notice-permission:granted|denied`.
final class HostChannel: NSObject, UNUserNotificationCenterDelegate {

    /// The name on both sides. Changing it changes src/receiver.js too.
    static let name = "ubersdrHost"

    /// Installed at document start so `window.ubersdrHost` exists before the
    /// page's first script — the same guarantee Android's listener gives.
    ///
    /// `onmessage` is left for receiver.js to assign; `deliver` calls it.
    static let shim = """
    (function(){
      try {
        window.ubersdrHost = {
          onmessage: null,
          postMessage: function(text){
            try { window.webkit.messageHandlers.\(name).postMessage(String(text)); } catch(e) {}
          }
        };
      } catch(e) {}
    })();
    """

    private weak var webView: WKWebView?
    private let instanceId: String
    private let receiverLabel: String

    /// Raised when the page says the receiver has stopped — v2's own power
    /// button, which is how you leave a receiver on a phone.
    var onStopped: (() -> Void)?

    private let speech = AVSpeechSynthesizer()
    private var nowPlaying: [String: Any] = [:]
    private var haveRemoteCommands = false

    init(webView: WKWebView, instanceId: String, label: String) {
        self.webView = webView
        self.instanceId = instanceId
        self.receiverLabel = label
        super.init()
        // Taps come back here rather than to the app delegate: a notification
        // this page raised belongs to this page, and its `onclick` is the
        // page's own.
        UNUserNotificationCenter.current().delegate = self
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Shown even while the app is in front.
    ///
    /// The Android client puts these in the shade whatever the app is doing,
    /// and the reason holds here: what v2 raises them for — your callsign in
    /// the chat, the recorder out of disk — is worth seeing while you are
    /// looking at a waterfall, not only while you are elsewhere.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler:
                                    @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    /// A tapped notification, back into the page's own handler.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        // Only if it belongs to the receiver that is open. A notification from
        // a receiver left earlier must not fire a handler in a page that is now
        // showing a different one.
        if let tag = info["tag"] as? String,
           (info["instance"] as? String) == instanceId {
            noticeTapped(tag: tag)
        }
        completionHandler()
    }

    // MARK: - Page → host

    func handle(_ raw: String) {
        guard let data = raw.data(using: .utf8),
              let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = message["type"] as? String else { return }

        switch type {
        case "running":       began()
        case "stopped":       ended()
        case "metadata":      metadata(message)
        case "artwork":       artwork(message)
        case "notice":        notice(message)
        case "notice-close":  closeNotice(message)
        case "notice-permission": askNotificationPermission()
        case "speak":         speak(message)
        case "speak-cancel":  speech.stopSpeaking(at: .immediate)
        case "voices":        sendVoices()
        case "prefs":         savePrefs(message)
        default:              break
        }
    }

    // MARK: - Host → page

    private func deliver(_ text: String) {
        let quoted = HostChannel.jsString(text)
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("""
            (function(){ try {
              if (window.ubersdrHost && typeof window.ubersdrHost.onmessage === 'function') {
                window.ubersdrHost.onmessage({ data: \(quoted) });
              }
            } catch(e) {} })();
            """)
        }
    }

    private static func jsString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let array = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(array.dropFirst().dropLast())
    }

    // MARK: - The lock screen

    /// None of what the lock screen says is composed here.
    ///
    /// v2 already builds a media session — the receiver as the title,
    /// frequency/mode/callsign as the artist, the bookmark or spot with its
    /// callsign lookup as the album, the operator's photo as the artwork — and
    /// installs handlers mapping next/previous to a tuning step or a bookmark
    /// hop, and play/pause to mute. In Safari all of that would reach the OS by
    /// itself; in a WKWebView `navigator.mediaSession` is simply absent, so
    /// receiver.js provides one and forwards what the page assigns. This turns
    /// that into a Now Playing entry and sends the buttons back.
    private func metadata(_ message: [String: Any]) {
        nowPlaying[MPMediaItemPropertyTitle] = message["title"] as? String ?? receiverLabel
        nowPlaying[MPMediaItemPropertyArtist] = message["artist"] as? String ?? ""
        nowPlaying[MPMediaItemPropertyAlbumTitle] = message["album"] as? String ?? ""
        // A live radio receiver has no duration and no position, and saying so
        // is what stops the lock screen drawing a scrubber that cannot work.
        nowPlaying[MPNowPlayingInfoPropertyIsLiveStream] = true
        nowPlaying[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlaying

        enableRemoteCommands(message["actions"] as? [String] ?? [])
    }

    /// The artwork arrives as a data: URL, already cropped or fitted by v2's own
    /// `lib/cardArt.js` — the same picture, prepared the same way, as the one
    /// the Android notification gets.
    private func artwork(_ message: [String: Any]) {
        guard let src = message["src"] as? String,
              let comma = src.firstIndex(of: ","),
              let data = Data(base64Encoded: String(src[src.index(after: comma)...])),
              let image = UIImage(data: data) else { return }

        nowPlaying[MPMediaItemPropertyArtwork] =
            MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlaying
    }

    private func began() {
        MPNowPlayingInfoCenter.default().playbackState = .playing
        // Asked here rather than when the receiver opens, which is the Android
        // client's reasoning exactly (ReceiverActivity, case "running"): this is
        // the moment the notification starts being the only way to stop audio
        // playing with the screen off, and it follows the operator having
        // pressed Connect. Never at launch — a permission dialog over the
        // chooser is a dialog in front of somebody who has not asked for
        // anything yet.
        //
        // Without this, iOS notifications simply never appear: the page's
        // Notification API is provided (receiver.js), the page raises notices,
        // and UNUserNotificationCenter drops every one of them unheard because
        // nothing ever requested authorisation.
        askNotificationPermissionOnce()
        if nowPlaying.isEmpty {
            // Something has to be there the moment audio starts, or the lock
            // screen shows an empty card until the page's first metadata.
            nowPlaying[MPMediaItemPropertyTitle] = receiverLabel
            nowPlaying[MPNowPlayingInfoPropertyIsLiveStream] = true
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nowPlaying
        }
    }

    private func ended() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        MPNowPlayingInfoCenter.default().playbackState = .stopped
        onStopped?()
    }

    /// Only the buttons the page actually handles are enabled, which is what
    /// stops the lock screen offering a skip that does nothing.
    private func enableRemoteCommands(_ actions: [String]) {
        let centre = MPRemoteCommandCenter.shared()
        let wanted = Set(actions)

        func wire(_ command: MPRemoteCommand, _ action: String) {
            command.isEnabled = wanted.contains(action)
            guard !haveRemoteCommands else { return }
            command.addTarget { [weak self] _ in
                self?.deliver("action:\(action)")
                return .success
            }
        }

        wire(centre.playCommand, "play")
        wire(centre.pauseCommand, "pause")
        wire(centre.togglePlayPauseCommand, "play")
        wire(centre.nextTrackCommand, "nexttrack")
        wire(centre.previousTrackCommand, "previoustrack")
        // Stop is the one control this client adds rather than forwards: with
        // the screen off, the lock screen is the only handle on the app.
        centre.stopCommand.isEnabled = true
        if !haveRemoteCommands {
            centre.stopCommand.addTarget { [weak self] _ in
                self?.ended()
                return .success
            }
        }
        haveRemoteCommands = true
    }

    // MARK: - Notifications

    /// v2 raises browser notifications for what is worth knowing while you are
    /// not looking — your callsign in the chat, voice activity, the rotator
    /// finishing, the recorder out of disk. A WKWebView has no Notification API
    /// at all, so receiver.js provides one and this puts what the page raises
    /// into Notification Centre. This needed no change to v2: its check is a
    /// plain feature test, and it simply starts answering yes.
    private func notice(_ message: [String: Any]) {
        let tag = message["tag"] as? String ?? UUID().uuidString
        let content = UNMutableNotificationContent()
        content.title = message["title"] as? String ?? receiverLabel
        content.body = message["body"] as? String ?? ""
        content.sound = (message["silent"] as? Bool ?? false) ? nil : .default
        content.userInfo = ["tag": tag, "instance": instanceId]

        // The page's tag replaces rather than stacks, which is the whole point
        // of a tag: an S-meter alert that fired eleven times is one line, not
        // eleven.
        let request = UNNotificationRequest(identifier: tag, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    private func closeNotice(_ message: [String: Any]) {
        guard let tag = message["tag"] as? String else { return }
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [tag])
    }

    /// `Notification.requestPermission()`, which on iOS is the system prompt.
    /// Asked for when the page asks and never at launch. The answer goes back
    /// the way every other host message does, which is what resolves the
    /// promise the page is holding.
    private func askNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, _ in
            self.deliver("notice-permission:\(granted ? "granted" : "denied")")
        }
    }

    /// The same request, without an answer to send and without asking twice.
    ///
    /// iOS only ever shows the prompt once per install — a second
    /// `requestAuthorization` after a refusal returns the refusal without
    /// showing anything — so this is safe to call on every `running`. It checks
    /// first anyway, so that a receiver reconnecting does not queue work behind
    /// a decision that has already been made.
    private func askNotificationPermissionOnce() {
        #if DEBUG
        // Not during a screenshot pass. The prompt appears the moment audio
        // starts, which is precisely when the receiver is being photographed,
        // and a store listing showing a permission dialog over the waterfall
        // is a listing of the dialog. The Android pass sidesteps the same
        // prompt by granting the permission with `pm grant`; there is no
        // simctl equivalent for notifications, so this declines to ask.
        if ProcessInfo.processInfo.environment["UBERSDR_SHOT_MODE"] != nil { return }
        #endif
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .notDetermined else { return }
            UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound]) { granted, _ in
                    // Told to the page as well: it has a Notifications panel
                    // whose state would otherwise disagree with the system's.
                    self.deliver("notice-permission:\(granted ? "granted" : "denied")")
                }
        }
    }

    /// A tapped notification, back into the page's own onclick.
    func noticeTapped(tag: String) {
        deliver("notice-click:\(tag)")
    }

    // MARK: - Speech

    /// v2 speaks the frequency, the mode and a looked-up callsign through the
    /// Web Speech API (static/v2/src/lib/announce.js). WKWebView implements none
    /// of it, so receiver.js provides the API and this is the engine behind it.
    private func speak(_ message: [String: Any]) {
        guard let text = message["text"] as? String, !text.isEmpty else { return }
        let utterance = AVSpeechUtterance(string: text)
        if let id = message["voice"] as? String, !id.isEmpty,
           let voice = AVSpeechSynthesisVoice(identifier: id) {
            utterance.voice = voice
        }
        // The Web Speech scale is 0.1–10 with 1 as normal; AVFoundation's is
        // 0–1 with about 0.5 as normal, so a rate handed straight over would
        // announce every frequency at a shout.
        let rate = Float(truncating: message["rate"] as? NSNumber ?? 1)
        utterance.rate = min(max(AVSpeechUtteranceDefaultSpeechRate * rate, 0), 1)
        utterance.volume = Float(min(max(Double(message["volume"] as? NSNumber ?? 1), 0), 1))
        speech.speak(utterance)
    }

    private func sendVoices() {
        let voices = AVSpeechSynthesisVoice.speechVoices().map { voice -> [String: Any] in
            [
                "id": voice.identifier,
                "name": voice.name,
                "lang": voice.language,
                "localService": true,
                "default": false
            ]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: voices),
              let json = String(data: data, encoding: .utf8) else { return }
        deliver("voices:\(json)")
    }

    // MARK: - Shared settings

    /// One arrangement of the interface, on every receiver.
    ///
    /// Each instance has its own loopback port, so its own origin, so its own
    /// localStorage — without this every receiver would open at the defaults.
    /// receiver.js reports what changed; the next receiver opened is seeded with
    /// it from the document-start script. The desktop client does the same
    /// (clients/electron/receiver-preload.js); the Android client is the one
    /// that has not caught up yet.
    private func savePrefs(_ message: [String: Any]) {
        guard let map = message["map"] as? [String: String] else { return }
        UserDefaults.standard.set(map, forKey: HostChannel.prefsKey)
    }

    static let prefsKey = "ubersdr.shared.prefs"

    /// The snapshot as a JSON object literal, for the seed script. `null` when
    /// there is none — the first receiver ever opened is the one that supplies
    /// it.
    static func prefsLiteral() -> String {
        guard let map = UserDefaults.standard.dictionary(forKey: prefsKey) as? [String: String],
              !map.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: map),
              let json = String(data: data, encoding: .utf8) else { return "null" }
        return json
    }
}
