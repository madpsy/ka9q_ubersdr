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
/// ## Staying alive in the background
///
/// Declaring the `audio` background mode is not a promise the system keeps for
/// nothing: it keeps the app running while the app is *making* audio, and stops
/// as soon as it is not. v2's audio is not the app's — it is made in the
/// WebView's content process, by JavaScript — so as far as the assertion is
/// concerned this app falls silent the moment it is backgrounded, whether or
/// not a receiver is playing.
///
/// The silent engine below is the app's own audio, and holds the process open.
/// It is only half the answer: what actually plays in the background is a media
/// element, because WebKit interrupts an AudioContext on backgrounding whatever
/// the app does. See ReceiverViewController.startBackgroundAudio.
///
enum PlaybackSession {

    // A silent engine, running for as long as a receiver is.
    //
    // Borrowed from VibeSDR (ios/VibeSDR/VibeSilentAudio.swift), which needs it
    // for the same reason and gets more out of it: that app is React Native and
    // decodes natively, so once the process is alive its audio simply carries
    // on. Here the engine only buys the *process*, and the handover in
    // ReceiverViewController supplies the audio.
    //
    // Buying the process is not nothing, though — it is what was missing. The
    // handover script has to run, and the DELETE that hands the stream back has
    // to be sent, and neither happens in a suspended app.
    //
    // The volume is deliberately not zero. iOS counts *audible* output, and a
    // muted engine is not audio as far as the assertion is concerned.
    //
    // It also outlives any one receiver's audio, which is what makes the
    // handover in BackgroundAudio possible at all: there is a moment between
    // the page being frozen and the first native packet arriving, and without
    // something playing across it the app is suspended inside that gap.
    private static var engine: AVAudioEngine?
    private static var player: AVAudioPlayerNode?
    private static var silence: AVAudioPCMBuffer?

    private static func startSilentEngine() {
        guard engine == nil else { return }
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)

        guard let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1) else { return }
        engine.connect(player, to: engine.mainMixerNode, format: format)
        // Quiet on the node and not on the mixer, because the mixer is shared:
        // BackgroundAudio hangs the real audio off the same engine, and an
        // engine turned down to a hundredth would take that with it.
        player.volume = 0.01

        if silence == nil {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 44100) else { return }
            buffer.frameLength = 44100
            silence = buffer
        }
        guard let silence = silence else { return }

        do {
            try engine.start()
            player.scheduleBuffer(silence, at: nil, options: .loops, completionHandler: nil)
            player.play()
            Self.engine = engine
            Self.player = player
        } catch {
            NSLog("[UberSDR] silent engine would not start: %@", error.localizedDescription)
        }
    }

    private static func stopSilentEngine() {
        player?.stop()
        engine?.stop()
        player = nil
        engine = nil
    }

    /// Hang something else off the same engine — see BackgroundAudio.
    ///
    /// Sharing the engine rather than starting a second one keeps the process
    /// assertion continuous: the silence and the audio hand over inside one
    /// graph instead of one stopping before the other has started.
    /// Both of these change the graph, and a graph is changed on one thread.
    ///
    /// The caller is BackgroundAudio, which runs on its own queue: the stream
    /// arrives there, the decode happens there, and attaching the node it feeds
    /// happened there too. That is a running engine being restructured from a
    /// thread that is not the one rendering it, and it does not fail where it is
    /// written — it fails later and elsewhere, inside AURemoteIO's teardown,
    /// as an abort with no line of ours in the stack.
    ///
    /// Marshalled rather than documented-as-forbidden: the call site has a good
    /// reason to be where it is (the format is not known until the stream's
    /// header arrives), and `sync` keeps it a plain function that returns
    /// whether the node is attached. Safe from that queue because nothing on
    /// the main thread ever waits on it.
    static func attach(_ node: AVAudioPlayerNode, format: AVAudioFormat) -> Bool {
        if Thread.isMainThread { return attachNow(node, format: format) }
        return DispatchQueue.main.sync { attachNow(node, format: format) }
    }

    private static func attachNow(_ node: AVAudioPlayerNode, format: AVAudioFormat) -> Bool {
        guard let engine = engine else { return false }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        if !engine.isRunning { try? engine.start() }
        return true
    }

    static func detach(_ node: AVAudioPlayerNode) {
        if Thread.isMainThread { detachNow(node); return }
        DispatchQueue.main.sync { detachNow(node) }
    }

    /// Only from the engine the node is actually in.
    ///
    /// Not defensive tidying: `recover` and `rebuild` both *replace* the
    /// engine, and a node attached to the one they discarded is still what the
    /// caller holds. `disconnectNodeOutput` raises on a node the engine has
    /// never seen, and a raised NSException in this process is an abort — which
    /// is what opening Control Centre and closing it again did, every time. The
    /// interruption that Control Centre ends restarts the engine, and the
    /// foreground hand-back then detached the background stream's node from its
    /// replacement.
    ///
    /// `node.engine` is a back-reference and goes nil with the engine it names,
    /// so this covers the discarded-engine case and the deallocated one alike.
    private static func detachNow(_ node: AVAudioPlayerNode) {
        guard let engine = engine, node.engine === engine else { return }
        engine.disconnectNodeOutput(node)
        engine.detach(node)
    }

    /// Restart it after the system has taken the audio away — an interruption
    /// that ended, or the media server resetting under everything.
    ///
    /// Answers whether the engine was *replaced* rather than merely restarted,
    /// which is the caller's problem and not this one's: a replacement is a new
    /// graph, and anything hung off the old one — BackgroundAudio's player node
    /// — is left playing into nothing. Silence with no error, which is exactly
    /// the failure `rebuild` exists for, arriving by a quieter road.
    @discardableResult
    static func recover() -> Bool {
        guard engine != nil || player != nil else { return false }
        if engine?.isRunning == false {
            stopSilentEngine()
            startSilentEngine()
            return true
        }
        player?.play()
        return false
    }

    /// Put the category back if something has moved it.
    ///
    /// This is *not* what fixed the ring switch, and the belief that it would
    /// is worth recording so that it is not arrived at twice. The reasoning was
    /// that WebKit sets the category for the page's own media and can leave it
    /// somewhere the ring switch silences. The first half is true and the
    /// second does not follow: audio sessions are per-process, and the page's
    /// audio is rendered in the WebContent process, so the category WebKit
    /// chooses is one this process can neither see nor set. Checking it here
    /// looks at the app's own session, which was `.playback` all along — which
    /// is why the reclaim never logged and the phone stayed mute.
    ///
    /// What actually moves the page off ambient is giving WebKit a media
    /// element to classify: see ReceiverViewController.silentAnchor.
    ///
    /// Kept because the app's session is still worth defending — an
    /// interruption or another app can leave it somewhere else, and the silent
    /// engine and BackgroundAudio both play into it. It costs a property read
    /// on a route change and on the audio watch's tick.
    ///
    /// Only from ambient, deliberately. `.playAndRecord` is WebKit capturing,
    /// and the one thing that captures here is the output picker asking for the
    /// microphone so that iOS will name the devices (lib/audioSinks.js,
    /// unlockDeviceLabels). Taking the category out from under that would break
    /// the names it was opened to reveal — and the ring switch is not a problem
    /// there anyway, because playAndRecord ignores it too.
    static func reassert() {
        let session = AVAudioSession.sharedInstance()
        guard session.category == .ambient || session.category == .soloAmbient else { return }
        NSLog("[UberSDR audio] session was %@ — reclaiming playback", session.category.rawValue)
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            NSLog("[UberSDR audio] could not reclaim the session: %@", error.localizedDescription)
        }
    }

    /// The audio system went away and came back.
    ///
    /// `mediaServicesWereReset` invalidates every session, engine and converter
    /// in the process at once, and Apple is explicit that an app has to rebuild
    /// rather than carry on. Nothing did: what was left was a receiver playing
    /// into a graph that no longer existed, which is silence with no error
    /// anywhere and no way out but closing the receiver.
    static func rebuild() {
        stopSilentEngine()
        begin()
    }

    /// What the session actually is, in one line.
    ///
    /// This is here because the failure it exists for was reported from a phone
    /// that is not on this desk, and its two plausible causes — an ambient
    /// category, or an AudioContext left interrupted — look identical from the
    /// outside. The category, the route and the volume tell them apart the next
    /// time it happens, which is worth more than picking one now.
    static func describe(_ when: String) {
        let session = AVAudioSession.sharedInstance()
        let outputs = session.currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: ",")
        NSLog("[UberSDR audio] %@: category=%@ mode=%@ route=%@ volume=%.2f others=%@",
              when, session.category.rawValue, session.mode.rawValue,
              outputs.isEmpty ? "(none)" : outputs, session.outputVolume,
              session.isOtherAudioPlaying ? "yes" : "no")
    }

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
            startSilentEngine()
        } catch {
            // A receiver that plays only while the app is in front is worth
            // more than one that refuses to open, so this is reported and not
            // raised.
            NSLog("[UberSDR] could not claim the audio session: %@", error.localizedDescription)
        }
    }

    static func end() {
        stopSilentEngine()
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
