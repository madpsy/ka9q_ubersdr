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
/// Two recognisers stand behind it:
///
///   * **SFSpeechRecognizer**, everything else in this file. On every iOS, and
///     tried first even on iOS 26, because it is the quicker of the two to put
///     words on the screen: on an iPad Air M4 its interim text kept visibly
///     closer to the broadcast than SpeechTranscriber's did. Its catch is that
///     it runs on Siri's and Dictation's engine, and with Siri off it fails
///     every task with kLSRErrorDomain 201 "Siri and Dictation are disabled",
///     even with Dictation on.
///   * **iOS 26 and later: SpeechAnalyzer with a SpeechTranscriber**, in
///     OnDeviceSpeechAnalyzer.swift. On the device by design, its models
///     managed by AssetInventory rather than by the keyboard's Dictation
///     languages, and independent of the Siri and Dictation switches. It takes
///     over a session whose SFSpeechRecognizer task fails with 201 — mid-
///     session, without the page seeing a seam (see `handOver`) — and from
///     then on, for as long as the app runs, every session starts on it
///     directly. It also takes a session from the start when the chosen
///     language is one SFSpeechRecognizer cannot do on the device.
///
/// Before iOS 26, or on hardware whose SpeechTranscriber says it is not
/// available, there is only SFSpeechRecognizer, and a 201 is reported to the
/// page with the Siri-and-Dictation sentence, as it always was.
///
/// Three rules this is built around, and each one is a promise the page makes
/// to the person using it:
///
///   * **Never the network.** `requiresOnDeviceRecognition` on every request,
///     and a language that cannot be recognised on the device is refused at
///     start rather than quietly sent to Apple's servers. The user chose "on
///     this device", and the receiver's audio is not this app's to send.
///     (SpeechTranscriber has no server mode at all. What it may fetch is its
///     own model, from Apple, once — the audio still never leaves.)
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
    ///
    /// On iOS 26 with SpeechTranscriber the second condition is only that the
    /// hardware can run it: a language that is supported but not yet on the
    /// device is downloaded by Start (see OnDeviceSpeechAnalyzer), so a device
    /// with nothing installed is still one that can transcribe.
    static func offered() -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .denied, .restricted: return false
        default: break
        }
        if usesAnalyzer { return true }
        return candidates().contains { onDevice($0) != nil }
    }

    /// Whether this device takes the SpeechAnalyzer path. `isAvailable` is a
    /// synchronous hardware check, which matters here: offered() runs while
    /// the document-start script is being written.
    static var usesAnalyzer: Bool {
        if #available(iOS 26.0, *) { return SpeechTranscriber.isAvailable }
        return false
    }

    /// The BCP-47 tags recognisable on the device now, hyphenated as the page
    /// writes them ('en-GB', not 'en_GB').
    static func languages() -> [String] {
        SFSpeechRecognizer.supportedLocales()
            .filter { onDevice($0) != nil }
            .map { tag($0.identifier) }
            .sorted()
    }

    static func tag(_ identifier: String) -> String {
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

    /// The SpeechAnalyzer engine, on a device that has one; messages for a
    /// session it owns go to it instead of to the code below. Typed by the
    /// protocol because a stored property cannot be marked iOS 26-only.
    private let analyzer: SpeechEngine?
    /// The session the analyzer owns, if any — handed to it at start or
    /// mid-session. Read and written on `queue`, which is why every message
    /// from the page hops onto it before deciding where it goes: the order of
    /// the page's pushes, resets and stop is then kept across a handover.
    private var delegated: Int?
    /// The language of the session in hand, for a handover.
    private var lang = ""

    /// Set once an SFSpeechRecognizer task has failed with 201 on a device
    /// that has the analyzer, and never cleared: Siri is off, and trying
    /// SFSpeechRecognizer at every Start would only cost each session its
    /// first second. For the life of the process, not saved: someone who
    /// turns Siri on gets the quicker engine back at the next launch. Shared
    /// by every receiver window, hence the lock.
    private static var siriOff: Bool {
        get { siriOffLock.lock(); defer { siriOffLock.unlock() }; return _siriOff }
        set { siriOffLock.lock(); _siriOff = newValue; siriOffLock.unlock() }
    }
    private static var _siriOff = false
    private static let siriOffLock = NSLock()

    init(send: @escaping (String) -> Void) {
        self.send = send
        if #available(iOS 26.0, *), Self.usesAnalyzer {
            analyzer = OnDeviceSpeechAnalyzer(send: send)
        } else {
            analyzer = nil
        }
    }

    // MARK: - From the page

    func languages() {
        if let analyzer = analyzer { return analyzer.languages() }
        queue.async {
            self.reply("stt-languages", Self.languages())
        }
    }

    /// On a device with the analyzer, a session starts there directly once
    /// Siri is known to be off, or when SFSpeechRecognizer has no on-device
    /// model for the language (the page's list is the analyzer's, the wider
    /// one, so it can offer such a language). Otherwise SFSpeechRecognizer
    /// first, as the quicker — and handOver if it turns out Siri is off.
    func start(session id: Int, lang: String, sampleRate: Int) {
        queue.async {
            self.teardown()
            if let old = self.delegated {
                self.delegated = nil
                self.analyzer?.stop(session: old)
            }
            if let analyzer = self.analyzer, Self.siriOff || Self.recognizer(for: lang) == nil {
                self.delegated = id
                analyzer.start(session: id, lang: lang, sampleRate: sampleRate)
                return
            }
            self.session = id
            self.lang = lang
            guard sampleRate == Self.rate else {
                self.failStart(id, code: "start-failed",
                               message: "the app takes 16 kHz audio, and was offered \(sampleRate) Hz")
                return
            }
            Self.authorise(on: self.queue) { granted in
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
            if self.delegated == id { self.analyzer?.push(session: id, base64: base64); return }
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
            if self.delegated == id { self.analyzer?.reset(session: id); return }
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
            if self.delegated == id {
                self.delegated = nil
                self.analyzer?.stop(session: id)
                return
            }
            guard self.session == id else { return }
            self.teardown()
        }
    }

    /// The receiver is closing, whatever the page last said.
    func stopAll() {
        queue.async {
            self.teardown()
            self.delegated = nil
            self.analyzer?.stopAll()
        }
    }

    // MARK: - Tasks

    /// Speech-recognition permission, asked for at the first Start; `done`
    /// runs on `queue`. Shared with the SpeechAnalyzer engine — see its
    /// start() for why that path asks too.
    static func authorise(on queue: DispatchQueue, _ done: @escaping (Bool) -> Void) {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized:
            done(true)
        case .notDetermined:
            // The system prompt, from the Start press that asked for it. Its
            // answer arrives on a queue of the framework's choosing.
            DispatchQueue.main.async {
                SFSpeechRecognizer.requestAuthorization { status in
                    queue.async { done(status == .authorized) }
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
        if Self.isSiriOff(error), handOver() { return }
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

    /// Siri is off: kLSRErrorDomain 201, "Siri and Dictation are disabled".
    private static func isSiriOff(_ error: NSError) -> Bool {
        error.domain == "kLSRErrorDomain" && error.code == 201
    }

    /// Move the session in hand to the SpeechAnalyzer engine after a 201,
    /// saying nothing to the page about it. False where there is no analyzer
    /// to move it to (before iOS 26), and the 201 is then reported as before.
    ///
    /// The page has already been told the session started — stt-started goes
    /// out as soon as the first task exists, and a 201 only arrives after —
    /// so the analyzer takes it in its continuing mode: same session id, no
    /// second stt-started, and a failure from here on reported as the session
    /// ending (stt-error then stt-end) rather than as a failed start, which
    /// the page would by now ignore. Whatever the dead task had heard has gone
    /// to the page already (taskEvent settles it before calling failed). From
    /// here `delegated` routes the page's messages to the analyzer, on this
    /// queue and so in order; pushes that arrive while it is still loading its
    /// model are held there and fed to it once it can listen.
    private func handOver() -> Bool {
        guard let analyzer = analyzer, let id = session else { return false }
        NSLog("[UberSDR stt] Siri is off; session %d continues on SpeechAnalyzer", id)
        Self.siriOff = true
        let lang = self.lang
        teardown()
        delegated = id
        analyzer.continueSession(id, lang: lang, sampleRate: Self.rate)
        return true
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
                // It means what it says, both halves: SFSpeechRecognizer runs
                // on Siri's and Dictation's engine, and an iPad with Dictation
                // on but Siri off failed every task with it. (iOS 26 does not
                // come here — handOver moves the session to SpeechTranscriber,
                // which needs neither switch.) iOS's own words go in brackets
                // for whoever has to work out which.
                return ("dictation-off",
                        "iOS needs Siri and Dictation turned on for on-device recognition (\(error.localizedDescription)). Turn on Siri under Settings › Apple Intelligence & Siri, and Dictation under Settings › General › Keyboard, then press Start again.")
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

/// What HostChannel's speech-to-text messages need from an engine: the public
/// face of OnDeviceSpeech, so that the iOS 26 engine can stand in for the code
/// in that class without HostChannel knowing which one it has.
protocol SpeechEngine: AnyObject {
    func languages()
    func start(session id: Int, lang: String, sampleRate: Int)
    func push(session id: Int, base64: String)
    func reset(session id: Int)
    func stop(session id: Int)
    func stopAll()
    /// Take over a session the page already believes started: start(), but
    /// without announcing it — see OnDeviceSpeech.handOver.
    func continueSession(_ id: Int, lang: String, sampleRate: Int)
}
