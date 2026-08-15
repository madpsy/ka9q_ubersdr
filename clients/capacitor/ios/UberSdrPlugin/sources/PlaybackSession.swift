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
    static func attach(_ node: AVAudioPlayerNode, format: AVAudioFormat) -> Bool {
        guard let engine = engine else { return false }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        if !engine.isRunning { try? engine.start() }
        return true
    }

    static func detach(_ node: AVAudioPlayerNode) {
        guard let engine = engine else { return }
        engine.disconnectNodeOutput(node)
        engine.detach(node)
    }

    /// Restart it after the system has taken the audio away — an interruption
    /// that ended, or the media server resetting under everything.
    static func recover() {
        guard engine != nil || player != nil else { return }
        if engine?.isRunning == false {
            stopSilentEngine()
            startSilentEngine()
        } else {
            player?.play()
        }
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
