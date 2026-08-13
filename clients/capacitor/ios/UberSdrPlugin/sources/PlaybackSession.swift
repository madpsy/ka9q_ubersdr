import Foundation
import AVFoundation

/// What lets a receiver keep playing with the screen off.
///
/// The iOS counterpart of `PlaybackService.java`, and much smaller than it,
/// because the two platforms put the difficulty in different places. On Android
/// the process becomes cacheable the moment the Activity stops being visible
/// and is then frozen — audio, spectrum and session with it — so a foreground
/// service of type `mediaPlayback` exists to say otherwise, and it carries the
/// notification and the lock-screen session with it. On iOS the audio session
/// *is* the claim: a `playback` category plus the `audio` background mode in
/// Info.plist is what keeps the app running while it is making noise.
///
/// The lock-screen controls are a separate thing here and are not this file's
/// (see MediaControls), which is the same split v2 itself makes: the metadata
/// is the page's, the transport is the host's.
///
/// ## The part that is not settled
///
/// iOS suspends a WKWebView's *content process* when the app backgrounds, and
/// v2's normal audio path decodes in JavaScript off a WebSocket. An audio
/// session alone does not keep JavaScript running, so a page backgrounded
/// mid-listen may well go quiet where Android's does not. The way out is v2's
/// own `/audio/stream` (see media/httpStream.js and audio_http_stream.go): a
/// real media resource, which iOS keeps playing, and which the server routes to
/// *instead of* the WebSocket rather than in addition. Whether the page can
/// switch to it on backgrounding, or whether this side should play it natively,
/// is the open question — and needs a device to answer, because the simulator
/// does not model process suspension.
enum PlaybackSession {

    /// Claimed before the page starts, released when the receiver closes.
    ///
    /// `.playback` rather than `.ambient` because this is the thing the
    /// operator is listening to: it plays when the ringer switch is silent, and
    /// it does not duck for other apps' sounds.
    static func begin() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            // A receiver that plays only while the app is in front is worth
            // more than one that refuses to open, so this is reported and not
            // raised.
            NSLog("[UberSDR] could not claim the audio session: %@", error.localizedDescription)
        }
    }

    static func end() {
        do {
            // Told to yield rather than merely deactivated: without this, other
            // apps that were ducked stay ducked until something else claims the
            // session.
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            NSLog("[UberSDR] could not release the audio session: %@", error.localizedDescription)
        }
    }
}
