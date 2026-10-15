import Foundation
import Speech
import AVFoundation

/// Speech-to-text on the device with iOS 26's SpeechAnalyzer — OnDeviceSpeech's
/// engine wherever SpeechTranscriber is available. The page's half and the
/// three rules (never the network, never the microphone or the audio session,
/// never a loop of errors) are as OnDeviceSpeech describes; this file is only
/// the recogniser behind them.
///
/// Why a second engine rather than a fix to the first: SFSpeechRecognizer's
/// on-device path runs on Siri's and Dictation's engine, and fails every task
/// with kLSRErrorDomain 201 "Siri and Dictation are disabled" when either is
/// off — which is how an iPad with Dictation on and Siri off ended up with no
/// transcription at all. SpeechTranscriber is a different engine: on the device
/// by design, its models managed by AssetInventory and shared between apps,
/// and dependent on neither switch.
///
/// It is also a better fit for a receiver. SFSpeechRecognizer is built around
/// utterances — a task per sentence, ended by a pause — so OnDeviceSpeech has
/// to decide where lines end and restart tasks behind the page's back.
/// SpeechAnalyzer takes one unbroken stream for as long as it runs and decides
/// for itself where text is settled: a *volatile* result is its current guess
/// at the audio not yet settled, replaced by the next, and a *final* result is
/// a stretch it will not revise again. Those are exactly the page's
/// `final: false` and `final: true`, so one analysis serves a whole session,
/// across every pause, and the line-ending logic of the older engine is not
/// needed here.
///
/// As there, everything that touches state runs on one serial queue. The
/// framework's half is Swift concurrency — results arrive from an async
/// sequence, and preparing or finishing an analysis is awaited — so each Task
/// takes its values out and hops back onto the queue before looking at
/// anything, and every hop checks that the analysis it is about is still the
/// current one.
@available(iOS 26.0, *)
final class OnDeviceSpeechAnalyzer: SpeechEngine {

    // MARK: - Languages

    /// Every language SpeechTranscriber can do, installed or not, as BCP-47
    /// tags ('en-GB').
    ///
    /// Not only the installed ones, deliberately, although the page reads the
    /// list as "can recognise now". A language that is supported but not on
    /// the device is a download away, and Start does that download (see
    /// `install`). Leave it out and the page would never let it be chosen, so
    /// a device with no transcription model yet — and the system ships none —
    /// would show "no languages" with no way to get one. The cost is that the
    /// first Start in a new language can take a while, and if it takes longer
    /// than the page waits, it says the language is still downloading and to
    /// press Start again, which is true.
    static func languages() async -> [String] {
        let supported = await SpeechTranscriber.supportedLocales
        let installed = await SpeechTranscriber.installedLocales
        return Array(Set((supported + installed).map(bcp47))).sorted()
    }

    private static func bcp47(_ locale: Locale) -> String {
        OnDeviceSpeech.tag(locale.identifier(.bcp47))
    }

    /// The transcriber's own locale for a tag from `languages()`, or nil if it
    /// has none. Matched against its list first, so 'en-GB' finds the locale
    /// it calls en_GB; then its own idea of equivalence ('en' to en_US, say).
    private static func locale(for lang: String) async -> Locale? {
        let want = OnDeviceSpeech.tag(lang).lowercased()
        let supported = await SpeechTranscriber.supportedLocales
        if let exact = supported.first(where: {
            bcp47($0).lowercased() == want || OnDeviceSpeech.tag($0.identifier).lowercased() == want
        }) {
            return exact
        }
        return await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: lang))
    }

    /// The one configuration this uses. Volatile results are the page's
    /// interim line; without them nothing would show until a stretch was
    /// settled. No `.fastResults`: it trades accuracy for latency, and a line
    /// that appears a moment later but right is the better transcript. The
    /// asset install, the audio format and the analysis all derive from this,
    /// so it is made in one place.
    private static func transcriber(_ locale: Locale) -> SpeechTranscriber {
        SpeechTranscriber(locale: locale, transcriptionOptions: [],
                          reportingOptions: [.volatileResults], attributeOptions: [])
    }

    // MARK: - State

    /// One analysis: an analyzer, the stream feeding it, the task reading its
    /// results. Replaced whole on a retune — a finished analyzer cannot be
    /// started again.
    private final class Run {
        let id: Int
        let analyzer: SpeechAnalyzer
        let input: AsyncStream<AnalyzerInput>.Continuation
        var task: Task<Void, Never>?
        /// The volatile text the page is showing, if any.
        var text = ""
        var heard = false
        let began = DispatchTime.now()
        /// 16 kHz samples since the last final result while there was volatile
        /// text — see `maxUnsettledSamples`.
        var unsettled = 0
        var finalizing = false

        init(id: Int, analyzer: SpeechAnalyzer, input: AsyncStream<AnalyzerInput>.Continuation) {
            self.id = id
            self.analyzer = analyzer
            self.input = input
        }
    }

    private let queue = DispatchQueue(label: "org.ubersdr.stt.analyzer", qos: .userInitiated)
    private let send: (String) -> Void
    private static let rate = 16000
    /// What the page's pushes are decoded into.
    private let pushFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(rate),
                                           channels: 1, interleaved: false)!

    /// The page's session, while there is one. Every reply carries it, and a
    /// message naming any other is ignored.
    private var session: Int?
    /// Set from stt-start until stt-started or stt-start-failed has been sent.
    private var starting = false
    /// Counts starts, so a timer or an install finishing for an earlier start
    /// of the same session number cannot act on this one.
    private var attempt = 0
    private var locale: Locale?
    /// What the analyzer takes, and the converter to it — nil when the pushes
    /// are already in that format. One per session: the configuration does not
    /// change between analyses, and the converter's filter state carries over
    /// from push to push, which a resampler needs.
    private var format: AVAudioFormat?
    private var converter: AVAudioConverter?
    private var run: Run?
    private var serial = 0
    /// Consecutive analyses that failed without hearing anything.
    private var strikes = 0
    /// Model downloads in progress, by locale. They belong to no session: one
    /// that outlasts the page's patience carries on, and the next Start in that
    /// language waits for the same download rather than starting another.
    private var installs: [String: Task<Void, Error>] = [:]

    // How long a Start waits for a model download before saying the language
    // is still downloading. Under hostspeech.js's own 60 s deadline for a
    // start, so the page hears the reason rather than a timeout.
    private static let installWaitSeconds = 50.0
    // The longest the volatile text may run without being settled. The
    // transcriber settles text at pauses of its own choosing, and a broadcast
    // can talk for minutes without one; past this it is asked to settle what
    // it has, so the page's line stays a line.
    private static let maxUnsettledSamples = rate * 30
    // As in OnDeviceSpeech: an analysis that fails within this long, having
    // heard nothing, is a strike, and this many in a row is the end.
    private static let quickFailureSeconds = 1.5
    private static let maxStrikes = 5

    init(send: @escaping (String) -> Void) {
        self.send = send
    }

    // MARK: - From the page

    func languages() {
        Task {
            let list = await Self.languages()
            self.queue.async { self.reply("stt-languages", list) }
        }
    }

    /// Permission first, then the language, then its model, then an analysis —
    /// and only when the analyzer has accepted its input is the page told it
    /// has started.
    ///
    /// The speech-recognition permission is asked for here as well, although
    /// SpeechTranscriber may not strictly need it: Apple's documentation for
    /// it names no authorisation, and developer reports differ. Asking keeps
    /// the person's say over whether this app recognises speech at all — a
    /// "no" in Settings is honoured on either engine — and keeps this working
    /// if iOS turns out to require it.
    func start(session id: Int, lang: String, sampleRate: Int) {
        queue.async {
            self.teardown()
            self.session = id
            self.starting = true
            self.attempt += 1
            let attempt = self.attempt
            guard sampleRate == Self.rate else {
                self.failStart(id, code: "start-failed",
                               message: "the app takes 16 kHz audio, and was offered \(sampleRate) Hz")
                return
            }
            OnDeviceSpeech.authorise(on: self.queue) { granted in
                guard self.attempt == attempt, self.session == id else { return }
                guard granted else {
                    self.failStart(id, code: "not-allowed",
                                   message: "Speech recognition is turned off for UberSDR in Settings.")
                    return
                }
                Task {
                    let locale = await Self.locale(for: lang)
                    let status: AssetInventory.Status
                    if let locale = locale {
                        status = await AssetInventory.status(forModules: [Self.transcriber(locale)])
                    } else {
                        status = .unsupported
                    }
                    self.queue.async { self.located(attempt, lang: lang, locale: locale, status: status) }
                }
            }
        }
    }

    /// One push: base64 of little-endian Int16 at 16 kHz, mono.
    ///
    /// Decoded and converted here, on this queue rather than the main thread,
    /// then handed to the analysis's input stream. The stream buffers, so a
    /// push that arrives while a fresh analysis is still being started (after
    /// a retune) is kept, not lost. Audio before there is any analysis — while
    /// a model downloads — is dropped: holding it would only put the
    /// transcript minutes behind the receiver.
    func push(session id: Int, base64: String) {
        queue.async {
            guard self.session == id, let r = self.run, let format = self.format,
                  let data = Data(base64Encoded: base64), data.count >= 2 else { return }
            let frames = data.count / 2
            guard let pcm = AVAudioPCMBuffer(pcmFormat: self.pushFormat, frameCapacity: AVAudioFrameCount(frames)),
                  let out = pcm.floatChannelData?[0] else { return }
            pcm.frameLength = AVAudioFrameCount(frames)
            data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                for i in 0..<frames {
                    let bits = UInt16(raw[i * 2]) | (UInt16(raw[i * 2 + 1]) << 8)
                    out[i] = Float(Int16(bitPattern: bits)) / 32768
                }
            }
            guard let buffer = self.convert(pcm, to: format) else { return }
            r.input.yield(AnalyzerInput(buffer: buffer))

            if !r.text.isEmpty { r.unsettled += frames }
            if r.unsettled >= Self.maxUnsettledSamples && !r.finalizing {
                r.finalizing = true
                let analyzer = r.analyzer
                // Through the last audio it has consumed: whatever it was
                // still revising is settled and published as final.
                Task { try? await analyzer.finalize(through: nil) }
            }
        }
    }

    /// The receiver has been retuned: the analysis in progress is dropped,
    /// unreported — its volatile text is speech from the frequency just left —
    /// and a fresh one starts on the same model.
    func reset(session id: Int) {
        queue.async {
            guard self.session == id else { return }
            self.discard(self.run)
            self.run = nil
            // No locale yet means the start in hand has not reached its first
            // analysis (a model downloading, say) and will begin it itself.
            // With one, this replaces even an analysis not yet launched, and
            // the replacement's launch is what tells the page it started.
            guard self.locale != nil else { return }
            self.converter?.reset()
            self.begin()
        }
    }

    func stop(session id: Int) {
        queue.async {
            guard self.session == id else { return }
            self.teardown()
        }
    }

    func stopAll() {
        queue.async { self.teardown() }
    }

    // MARK: - Starting

    private func located(_ attempt: Int, lang: String, locale: Locale?, status: AssetInventory.Status) {
        guard self.attempt == attempt, starting, let id = session else { return }
        guard let locale = locale, status != .unsupported else {
            failStart(id, code: "language-not-supported",
                      message: "\(lang) can't be transcribed on this device.")
            return
        }
        if status == .installed {
            prepare(attempt, locale: locale)
            return
        }
        install(attempt, locale: locale)
    }

    /// Download the language's model, and start once it is in.
    ///
    /// AssetInventory does this without any UI, and reserves the locale for
    /// this app as part of it. The page is still "starting" meanwhile; if the
    /// download is not done by `installWaitSeconds`, the start fails with the
    /// page's own 'language-downloading', and the download carries on.
    private func install(_ attempt: Int, locale: Locale) {
        let key = Self.bcp47(locale)
        let task: Task<Void, Error>
        if let running = installs[key] {
            task = running
        } else {
            task = Task { try await Self.download(locale) }
            installs[key] = task
        }
        NSLog("[UberSDR stt] downloading the %@ transcription model", key)
        Task {
            var failure: Error?
            do { try await task.value } catch { failure = error }
            self.queue.async {
                self.installs[key] = nil
                guard self.attempt == attempt, self.starting, let id = self.session else { return }
                if let error = failure {
                    NSLog("[UberSDR stt] %@ model download failed: %@", key, String(describing: error))
                    let mapped = Self.describe(error)
                    self.failStart(id, code: mapped?.code ?? "start-failed",
                                   message: mapped?.message
                                       ?? "the \(Self.name(locale)) speech model didn't download (\(error.localizedDescription))")
                    return
                }
                self.prepare(attempt, locale: locale)
            }
        }
        queue.asyncAfter(deadline: .now() + Self.installWaitSeconds) {
            guard self.attempt == attempt, self.starting, self.format == nil, let id = self.session else { return }
            self.failStart(id, code: "language-downloading",
                           message: "The \(Self.name(locale)) speech model is still downloading. Press Start again when it has finished.")
        }
    }

    /// The download itself. An app may reserve only so many locales
    /// (AssetInventory.maximumReservedLocales); a request that would exceed it
    /// throws, and then the reservations this app holds for other languages
    /// are given back and it tries once more. Only one language is ever in use
    /// here, and a released model stays installed until the system decides to
    /// reclaim it, so this costs at most a re-download later.
    private static func download(_ locale: Locale) async throws {
        let modules: [any SpeechModule] = [transcriber(locale)]
        do {
            try await downloadOnce(modules)
        } catch let error as SFSpeechError where error.code == .tooManyAssetLocalesAllocated {
            let want = bcp47(locale)
            for held in await AssetInventory.reservedLocales where bcp47(held) != want {
                _ = await AssetInventory.release(reservedLocale: held)
            }
            try await downloadOnce(modules)
        }
    }

    private static func downloadOnce(_ modules: [any SpeechModule]) async throws {
        // nil when it is installed already — by now, or by another app.
        if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
            try await request.downloadAndInstall()
        }
    }

    /// The model is on the device: find the audio format it takes and begin.
    private func prepare(_ attempt: Int, locale: Locale) {
        Task {
            let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [Self.transcriber(locale)])
            self.queue.async {
                guard self.attempt == attempt, self.starting, let id = self.session else { return }
                guard let format = format else {
                    // Documented as "additional assets required": installed a
                    // moment ago and gone again, or never really there.
                    self.failStart(id, code: "language-not-supported",
                                   message: "The \(Self.name(locale)) speech model isn't on this device.")
                    return
                }
                if format != self.pushFormat {
                    guard let converter = AVAudioConverter(from: self.pushFormat, to: format) else {
                        self.failStart(id, code: "start-failed",
                                       message: "the app can't convert its audio to the recogniser's format (\(format))")
                        return
                    }
                    self.converter = converter
                }
                self.locale = locale
                self.format = format
                self.strikes = 0
                self.begin()
            }
        }
    }

    /// A fresh analysis, fed from a fresh stream. The analyzer is set going
    /// autonomously — `start(inputSequence:)` returns at once and consumes the
    /// stream as audio arrives — and its results are read until it finishes.
    private func begin() {
        guard session != nil, let locale = locale else { return }
        serial += 1
        let id = serial
        let transcriber = Self.transcriber(locale)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let (stream, input) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let r = Run(id: id, analyzer: analyzer, input: input)
        run = r
        r.task = Task { [weak self] in
            do {
                try await analyzer.start(inputSequence: stream)
            } catch {
                self?.queue.async { self?.launched(id, error) }
                return
            }
            self?.queue.async { self?.launched(id, nil) }
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    let isFinal = result.isFinal
                    self?.queue.async { self?.heard(id, text: text, isFinal: isFinal) }
                }
                self?.queue.async { self?.ended(id, nil) }
            } catch {
                self?.queue.async { self?.ended(id, error) }
            }
        }
    }

    private func launched(_ id: Int, _ error: Error?) {
        guard let sid = session, let r = run, r.id == id else { return }
        if let error = error {
            if starting {
                run = nil
                discard(r)
                NSLog("[UberSDR stt] analyzer would not start: %@", String(describing: error))
                let mapped = Self.describe(error)
                failStart(sid, code: mapped?.code ?? "start-failed",
                          message: mapped?.message ?? error.localizedDescription)
            } else {
                ended(id, error)
            }
            return
        }
        if starting {
            starting = false
            reply("stt-started", ["session": sid])
        }
    }

    // MARK: - Results

    /// A volatile result replaces the line in progress; a final one settles
    /// it, and the next volatile result starts the next line — which is the
    /// page's reading of `final` exactly.
    private func heard(_ id: Int, text raw: String, isFinal: Bool) {
        guard session != nil, let r = run, r.id == id else { return }
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        r.heard = true
        strikes = 0
        if isFinal {
            r.text = ""
            r.unsettled = 0
            r.finalizing = false
            if !text.isEmpty { result(text, final: true) }
            return
        }
        guard text != r.text else { return }
        r.text = text
        // An empty guess is nothing to show; the line it replaced is settled
        // or revised by whatever comes next.
        if !text.isEmpty { result(text, final: false) }
    }

    /// The analysis finished without being asked to — its results stream
    /// ended or threw. As in OnDeviceSpeech: what it had heard is settled, a
    /// fresh one starts quietly if it had been working, and only a run of
    /// quick failures, or an error no retry can fix, reaches the page.
    private func ended(_ id: Int, _ error: Error?) {
        guard session != nil, let r = run, r.id == id else { return }
        run = nil
        discard(r)
        if !r.text.isEmpty { result(r.text, final: true) }
        if let error = error {
            NSLog("[UberSDR stt] analysis %d ended: %@", id, String(describing: error))
            if let fatal = Self.describe(error) {
                end(code: fatal.code, message: fatal.message)
                return
            }
        }
        let ran = Double(DispatchTime.now().uptimeNanoseconds - r.began.uptimeNanoseconds) / 1e9
        if r.heard || ran >= Self.quickFailureSeconds {
            converter?.reset()
            begin()
            return
        }
        strikes += 1
        if strikes >= Self.maxStrikes {
            end(code: "keeps-stopping", message: error?.localizedDescription ?? "the recogniser keeps stopping")
            return
        }
        let delay = min(0.25 * pow(2, Double(strikes - 1)), 4)
        let sid = session
        queue.asyncAfter(deadline: .now() + delay) {
            guard self.session == sid, self.session != nil, self.run == nil, !self.starting else { return }
            self.converter?.reset()
            self.begin()
        }
    }

    // MARK: - Audio

    /// 16 kHz Float32 to the analyzer's format. SpeechAnalyzer does no
    /// conversion of its own — it keeps its time-codes sample-accurate by
    /// refusing to — so whatever bestAvailableAudioFormat named is what it
    /// gets. The converter is fed one buffer per call and told there is no
    /// more *for now*, not end of stream, so its resampler keeps its history
    /// across pushes and the joins are seamless.
    private func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard let converter = converter else { return buffer }
        let ratio = format.sampleRate / pushFormat.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var given = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if given {
                inputStatus.pointee = .noDataNow
                return nil
            }
            given = true
            inputStatus.pointee = .haveData
            return buffer
        }
        if status == .error {
            NSLog("[UberSDR stt] audio conversion failed: %@", error?.localizedDescription ?? "unknown")
            return nil
        }
        return out.frameLength > 0 ? out : nil
    }

    // MARK: - Errors

    /// Errors that a retry cannot fix, as the page's codes; nil for the rest.
    ///
    /// SpeechAnalyzer's are SFSpeechError, with codes Apple does document, so
    /// unlike the older engine this can name them. Permission withdrawn since
    /// the start is checked first, as there.
    private static func describe(_ error: Error) -> (code: String, message: String)? {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .denied, .restricted:
            return ("not-allowed", "Speech recognition is turned off for UberSDR in Settings.")
        default:
            break
        }
        guard let speech = error as? SFSpeechError else { return nil }
        switch speech.code {
        case .noModel, .assetLocaleNotAllocated, .cannotAllocateUnsupportedLocale:
            // The language's model is missing, or cannot be had for this app.
            return ("language-not-supported", error.localizedDescription)
        case .tooManyAssetLocalesAllocated:
            return ("start-failed",
                    "iOS won't let the app keep any more speech languages (\(error.localizedDescription))")
        case .insufficientResources:
            // A limit on simultaneous analyses across the device — most
            // likely another receiver window already transcribing. A code the
            // page does not know, so this sentence is the one it shows.
            return ("insufficient-resources",
                    "iOS is already running as many transcriptions as this device allows (\(error.localizedDescription)). Stop transcription in another receiver window, then press Start again.")
        default:
            return nil
        }
    }

    private static func name(_ locale: Locale) -> String {
        Locale.current.localizedString(forIdentifier: locale.identifier) ?? bcp47(locale)
    }

    // MARK: - Ending

    /// An analysis is over: its input stream closed, its task cancelled, and
    /// the analyzer told to stop now rather than finalise. Anything it was
    /// about to publish is dropped by the id check in `heard`.
    private func discard(_ r: Run?) {
        guard let r = r else { return }
        r.input.finish()
        r.task?.cancel()
        let analyzer = r.analyzer
        Task { await analyzer.cancelAndFinishNow() }
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
    /// session is cleared first, and every event checks it. A model download
    /// is left running — see `installs`.
    private func teardown() {
        session = nil
        starting = false
        discard(run)
        run = nil
        locale = nil
        format = nil
        converter = nil
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
