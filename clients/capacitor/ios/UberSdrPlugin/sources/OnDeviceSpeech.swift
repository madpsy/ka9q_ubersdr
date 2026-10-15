import Foundation
import Speech
import AVFoundation

/// Speech-to-text on the device, for v2's Whisper extension in local mode.
///
/// The page transcribes the *receiver's* audio, not the microphone: it taps its
/// own audio graph before the volume and the mute, resamples to 16 kHz mono
/// PCM16 and pushes it here about ten times a second (see
/// static/v2/src/extensions/whisper/engines/host.js for the contract, and
/// src/hostspeech.js for the messages that carry it). A WKWebView has no Web
/// Speech recogniser of its own, so without this there is no local mode on an
/// iPhone at all.
///
/// Three rules this is built around, and each one is a promise the page makes
/// to the person using it:
///
///   * **Never the network.** `requiresOnDeviceRecognition` on every request,
///     and a language that cannot be recognised on the device is refused at
///     start rather than quietly sent to Apple's servers. The user chose "on
///     this device", and the receiver's audio is not this app's to send.
///   * **Never the microphone, and never the audio session.** The audio
///     arrives as buffers, so there is no AVAudioEngine input, no category
///     change and nothing for BackgroundAudio or PlaybackSession to notice.
///   * **Never a loop of errors.** A recogniser that ends by itself is started
///     again quietly; one that fails at once, repeatedly, gives up and says so.
///
/// Everything below runs on one serial queue: the pushes, the recogniser's
/// callbacks (which arrive on a queue of the framework's choosing and are
/// hopped across), the timers. That is the whole of the locking.
final class OnDeviceSpeech {

    // MARK: - Whether to offer it

    /// Whether the page should be told there is a recogniser — the `sttHost`
    /// flag, decided at document start (ReceiverViewController.seedScript).
    ///
    /// Two conditions, both cheap. Permission not already refused: a person who
    /// has said no in Settings would otherwise be offered a source that can
    /// only fail. `.notDetermined` still counts — the prompt is shown at the
    /// first Start, which is when somebody has asked for it. And at least one
    /// language the device can recognise *without the network*: the dictation
    /// models are per language and arrive with the keyboard languages, so a
    /// device can have none.
    ///
    /// The device's own languages are tried first, so the usual answer comes
    /// from the first recogniser made rather than from walking the whole list.
    static func offered() -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .denied, .restricted: return false
        default: break
        }
        return candidates().contains { onDevice($0) != nil }
    }

    /// The BCP-47 tags recognisable on the device now, hyphenated as the page
    /// writes them ('en-GB', not 'en_GB').
    static func languages() -> [String] {
        SFSpeechRecognizer.supportedLocales()
            .filter { onDevice($0) != nil }
            .map { tag($0.identifier) }
            .sorted()
    }

    private static func tag(_ identifier: String) -> String {
        identifier.replacingOccurrences(of: "_", with: "-")
    }

    private static func onDevice(_ locale: Locale) -> SFSpeechRecognizer? {
        guard let recognizer = SFSpeechRecognizer(locale: locale),
              recognizer.supportsOnDeviceRecognition else { return nil }
        return recognizer
    }

    private static func candidates() -> [Locale] {
        let preferred = Set(Locale.preferredLanguages.map { tag($0).lowercased() })
        let all = Array(SFSpeechRecognizer.supportedLocales())
        let mine = all.filter { preferred.contains(tag($0.identifier).lowercased()) }
        let rest = all.filter { !preferred.contains(tag($0.identifier).lowercased()) }
        return mine + rest
    }

    /// The recogniser for a tag from `languages()`, or nil if the device cannot
    /// do that one locally. Matched against the supported list first, so 'en-GB'
    /// finds the locale iOS calls en_GB rather than relying on Locale to agree.
    private static func recognizer(for lang: String) -> SFSpeechRecognizer? {
        let want = tag(lang).lowercased()
        let locale = SFSpeechRecognizer.supportedLocales()
            .first { tag($0.identifier).lowercased() == want } ?? Locale(identifier: lang)
        return onDevice(locale)
    }

    // MARK: - State

    /// One recognition task: one request, its task, and what it has heard.
    private final class Utterance {
        let id: Int
        let request: SFSpeechAudioBufferRecognitionRequest
        var task: SFSpeechRecognitionTask?
        /// The hypothesis so far — the interim the page is showing.
        var text = ""
        var heard = false
        let began = DispatchTime.now()
        var samples = 0
        /// Audio since the hypothesis last changed: how a pause is told apart
        /// from speech, without a second voice detector.
        var samplesSinceChange = 0
        var settleTimer: DispatchWorkItem?

        init(id: Int, request: SFSpeechAudioBufferRecognitionRequest) {
            self.id = id
            self.request = request
        }
    }

    private let queue = DispatchQueue(label: "org.ubersdr.stt", qos: .userInitiated)
    private let send: (String) -> Void
    private let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(OnDeviceSpeech.rate),
                                       channels: 1, interleaved: false)!

    private static let rate = 16000

    /// The page's session, while there is one. Every reply carries it, and a
    /// message naming any other is ignored.
    private var session: Int?
    private var recognizer: SFSpeechRecognizer?
    private var serial = 0
    /// The task taking audio now.
    private var current: Utterance?
    /// The task before it, told its audio is over and expected to report its
    /// final text shortly. See endUtterance.
    private var finishing: Utterance?
    /// The newest interim of `current`, held back while `finishing` has not
    /// settled — the page reads "final" as settling the line it is showing, so
    /// the next line's words must not reach it first.
    private var heldInterim: String?
    /// Consecutive tasks that failed without hearing anything.
    private var strikes = 0

    // A pause long enough to call the line finished. A broadcast rarely stops
    // dead, so this is measured as "the hypothesis has not changed" rather
    // than as silence, which a receiver seldom produces.
    private static let pauseSamples = rate * 2
    // The longest one task is allowed to run. On-device tasks do end by
    // themselves, but not on any schedule Apple documents, and a task fed
    // several minutes of continuous audio grows slower and its interim text
    // longer than the page can usefully show as one line.
    private static let maxSamples = rate * 30
    // How long a finishing task gets to report before its last interim is
    // taken as the line instead.
    private static let settleSeconds = 2.5
    // A task that fails within this long of starting, having heard nothing,
    // counts as a strike; this many in a row and it gives up.
    private static let quickFailureSeconds = 1.5
    private static let maxStrikes = 5

    init(send: @escaping (String) -> Void) {
        self.send = send
    }

    // MARK: - From the page

    func languages() {
        queue.async {
            self.reply("stt-languages", Self.languages())
        }
    }

    func start(session id: Int, lang: String, sampleRate: Int) {
        queue.async {
            self.teardown()
            self.session = id
            guard sampleRate == Self.rate else {
                self.failStart(id, code: "start-failed",
                               message: "the app takes 16 kHz audio, and was offered \(sampleRate) Hz")
                return
            }
            self.authorise { granted in
                guard self.session == id else { return }
                guard granted else {
                    self.failStart(id, code: "not-allowed",
                                   message: "Speech recognition is turned off for UberSDR in Settings.")
                    return
                }
                guard let recognizer = Self.recognizer(for: lang) else {
                    self.failStart(id, code: "language-not-supported",
                                   message: "\(lang) can't be recognised on this device.")
                    return
                }
                // .unspecified, not .dictation: with the dictation hint and
                // requiresOnDeviceRecognition, iOS fails every task with
                // kLSRErrorDomain 201 "Siri and Dictation are disabled" even
                // with Dictation switched on (an iPad did exactly that; Apple
                // forum threads 690736 and 691271 report the same). The hint
                // only tunes the language model towards dictated prose, which
                // broadcast and amateur speech is not anyway.
                recognizer.defaultTaskHint = .unspecified
                self.recognizer = recognizer
                self.strikes = 0
                self.beginUtterance()
                guard self.current != nil else {
                    self.failStart(id, code: "start-failed", message: "the recogniser would not start")
                    return
                }
                self.reply("stt-started", ["session": id])
            }
        }
    }

    /// One push: base64 of little-endian Int16 at 16 kHz, mono.
    ///
    /// Decoded here, off the main thread, and appended as Float32 — the format
    /// a microphone tap hands a request, and so the one the framework is
    /// certain to take. Audio that arrives between tasks (a quick failure's
    /// back-off) is dropped: there is nothing to hear it, and holding it would
    /// only put the recogniser further behind the receiver.
    func push(session id: Int, base64: String) {
        queue.async {
            guard self.session == id, let u = self.current,
                  let data = Data(base64Encoded: base64), data.count >= 2 else { return }
            let frames = data.count / 2
            guard let buffer = AVAudioPCMBuffer(pcmFormat: self.format,
                                                frameCapacity: AVAudioFrameCount(frames)),
                  let out = buffer.floatChannelData?[0] else { return }
            buffer.frameLength = AVAudioFrameCount(frames)
            data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                for i in 0..<frames {
                    let bits = UInt16(raw[i * 2]) | (UInt16(raw[i * 2 + 1]) << 8)
                    out[i] = Float(Int16(bitPattern: bits)) / 32768
                }
            }
            u.request.append(buffer)
            u.samples += frames
            if !u.text.isEmpty { u.samplesSinceChange += frames }
            if (!u.text.isEmpty && u.samplesSinceChange >= Self.pauseSamples) || u.samples >= Self.maxSamples {
                self.endUtterance()
            }
        }
    }

    /// The receiver has been retuned: forget the line in progress, unreported,
    /// and carry on. Includes one still finishing — it is speech from the
    /// frequency the operator has just left.
    func reset(session id: Int) {
        queue.async {
            guard self.session == id else { return }
            self.discard(self.finishing)
            self.finishing = nil
            self.heldInterim = nil
            self.discard(self.current)
            self.current = nil
            self.beginUtterance()
        }
    }

    func stop(session id: Int) {
        queue.async {
            guard self.session == id else { return }
            self.teardown()
        }
    }

    /// The receiver is closing, whatever the page last said.
    func stopAll() {
        queue.async { self.teardown() }
    }

    // MARK: - Tasks

    private func authorise(_ done: @escaping (Bool) -> Void) {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            done(true)
        case .notDetermined:
            // The system prompt, from the Start press that asked for it. Its
            // answer arrives on a queue of the framework's choosing.
            DispatchQueue.main.async {
                SFSpeechRecognizer.requestAuthorization { status in
                    self.queue.async { done(status == .authorized) }
                }
            }
        default:
            done(false)
        }
    }

    private func beginUtterance() {
        guard let recognizer = recognizer, session != nil else { return }
        serial += 1
        let id = serial
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.taskHint = .unspecified  // see start(): .dictation trips error 201
        if #available(iOS 16.0, *) {
            // A transcript is read rather than parsed, and a line with its
            // full stops reads very much better than one without.
            request.addsPunctuation = true
        }
        let u = Utterance(id: id, request: request)
        current = u
        // The result handler does not run on the recogniser's `queue` (its
        // documentation says so), so it is brought onto this one — with the
        // values taken out first, since the result object is not this
        // queue's to share.
        u.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal ?? false
            self?.queue.async { self?.taskEvent(id, text: text, isFinal: isFinal, error: error) }
        }
    }

    private func taskEvent(_ id: Int, text: String?, isFinal: Bool, error: Error?) {
        guard session != nil else { return }

        if let f = finishing, f.id == id {
            if let text = text { f.text = text }
            if isFinal || error != nil { settle(f) }
            return
        }
        // A task that was reset, replaced or stopped: nothing it says now is
        // about what the page is showing.
        guard let u = current, u.id == id else { return }

        if let text = text {
            u.heard = true
            strikes = 0
            if !isFinal && text != u.text {
                // The recogniser has started the line over without saying so
                // — a long hypothesis replaced by a short, unrelated one. The
                // words it dropped were heard, so they are settled rather than
                // lost.
                if Self.restarted(from: u.text, to: text) { finalLine(u.text) }
                u.text = text
                u.samplesSinceChange = 0
                interim(text)
            }
            if isFinal { u.text = text }
        }

        if isFinal {
            current = nil
            finalLine(u.text)
            beginUtterance()
            return
        }
        if let error = error {
            current = nil
            if !u.text.isEmpty { finalLine(u.text) }
            failed(u, error as NSError)
        }
    }

    /// End the line on our own say-so — a pause, or the length cap — and carry
    /// straight on with a fresh task, so no audio waits for the old one.
    ///
    /// The old task is told its audio is over and left to report: its final
    /// text is usually the interim tidied up, with the punctuation settled. It
    /// becomes `finishing`, and the new task's interim is held until it has.
    private func endUtterance() {
        guard let u = current else { return }
        if let f = finishing { settle(f) }
        current = nil
        finishing = u
        u.request.endAudio()
        // `u` weakly: the item is kept in `u.settleTimer`, and a work item
        // holds its closure for as long as the item lives — cancelled or run —
        // so a strong capture would keep every finished line, with its request
        // and task, alive until the process exits. While it is `finishing`
        // this class holds it, which is all the timer needs.
        let timer = DispatchWorkItem { [weak self, weak u] in
            guard let self = self, let u = u, self.finishing === u else { return }
            self.settle(u)
        }
        u.settleTimer = timer
        queue.asyncAfter(deadline: .now() + Self.settleSeconds, execute: timer)
        beginUtterance()
    }

    /// The finishing line is done — reported, timed out, or overtaken — so its
    /// text goes to the page as final and whatever the next line has been
    /// saying meanwhile follows it.
    private func settle(_ f: Utterance) {
        guard finishing === f else { return }
        finishing = nil
        f.settleTimer?.cancel()
        f.settleTimer = nil
        f.task?.cancel()
        if !f.text.isEmpty { result(f.text, final: true) }
        if let held = heldInterim {
            heldInterim = nil
            result(held, final: false)
        }
    }

    private func discard(_ u: Utterance?) {
        guard let u = u else { return }
        u.settleTimer?.cancel()
        u.settleTimer = nil
        u.task?.cancel()
    }

    private func interim(_ text: String) {
        if finishing != nil {
            heldInterim = text
            return
        }
        result(text, final: false)
    }

    private func finalLine(_ text: String) {
        if let f = finishing { settle(f) }
        heldInterim = nil
        guard !text.isEmpty else { return }
        result(text, final: true)
    }

    /// A task ended with an error. Most are not worth a word: "no speech
    /// detected" after a quiet spell, a request cancelled, the recognition
    /// service restarting. So a task is started again quietly — at once if the
    /// last one had been working, after a growing pause if it died at birth —
    /// and only a run of failures, or an error that no retry can fix, reaches
    /// the page.
    private func failed(_ u: Utterance, _ error: NSError) {
        NSLog("[UberSDR stt] task %d ended: %@ %d %@", u.id, error.domain, error.code,
              error.localizedDescription)
        if let fatal = Self.fatal(error) {
            end(code: fatal.code, message: fatal.message)
            return
        }
        let ran = Double(DispatchTime.now().uptimeNanoseconds - u.began.uptimeNanoseconds) / 1e9
        let quick = !u.heard && ran < Self.quickFailureSeconds
        if !quick {
            beginUtterance()
            return
        }
        strikes += 1
        if strikes >= Self.maxStrikes {
            // 'keeps-stopping' is the page's own word for this, and it has a
            // sentence for it; the detail is in the device log above.
            end(code: "keeps-stopping", message: error.localizedDescription)
            return
        }
        let delay = min(0.25 * pow(2, Double(strikes - 1)), 4)
        let id = session
        queue.asyncAfter(deadline: .now() + delay) {
            guard self.session == id, self.session != nil, self.current == nil else { return }
            self.beginUtterance()
        }
    }

    /// Errors that a retry cannot fix, as the page's codes.
    ///
    /// The Speech framework's errors on the device come from private domains
    /// whose codes Apple does not document, so this names only the ones whose
    /// meaning is unmistakable, and checks the one thing that can be asked
    /// directly — whether permission has since been withdrawn. Anything else
    /// is retried, and the strike count above catches what never recovers.
    private static func fatal(_ error: NSError) -> (code: String, message: String)? {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .denied, .restricted:
            return ("not-allowed", "Speech recognition is turned off for UberSDR in Settings.")
        default:
            break
        }
        if error.domain == "kLSRErrorDomain" {
            switch error.code {
            case 201:
                // "Siri and Dictation are disabled". A code the page does not
                // know, so this sentence is the one it shows.
                //
                // iOS also reports it with Dictation on — for the dictation
                // task hint (avoided in start()) and, per developer reports,
                // while the dictation language is still downloading — so the
                // message names both, and carries iOS's own words in brackets
                // for whoever has to work out which.
                return ("dictation-off",
                        "iOS says dictation is unavailable (\(error.localizedDescription)). Check Settings › General › Keyboard: Enable Dictation is on and the English dictation language has finished downloading, then press Start again.")
            case 102:
                // "Failed to access assets": the language's on-device model is
                // not there after all.
                return ("language-not-supported", error.localizedDescription)
            default:
                break
            }
        }
        return nil
    }

    /// A short, unrelated hypothesis replacing a long one. Deliberately strict —
    /// recognisers revise their opening words all the time, and treating a
    /// revision as a new line would settle half-sentences.
    private static func restarted(from old: String, to new: String) -> Bool {
        guard old.count >= 12, new.count < old.count / 2 else { return false }
        let head = String(new.lowercased().prefix(8))
        return !old.lowercased().hasPrefix(head)
    }

    private func failStart(_ id: Int, code: String, message: String) {
        reply("stt-start-failed", ["session": id, "code": code, "message": message])
        teardown()
    }

    private func end(code: String, message: String) {
        guard let id = session else { return }
        reply("stt-error", ["session": id, "code": code, "message": message,
                            "fatal": true, "retryable": false])
        reply("stt-end", ["session": id])
        teardown()
    }

    /// Everything stops, and nothing already queued will speak for it: the
    /// session is cleared first, and every event checks it.
    private func teardown() {
        session = nil
        discard(finishing)
        finishing = nil
        discard(current)
        current = nil
        heldInterim = nil
        recognizer = nil
        strikes = 0
    }

    // MARK: - To the page

    private func result(_ text: String, final: Bool) {
        guard let id = session else { return }
        reply("stt-result", ["session": id, "text": text, "final": final])
    }

    private func reply(_ prefix: String, _ payload: Any) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        send("\(prefix):\(json)")
    }
}
