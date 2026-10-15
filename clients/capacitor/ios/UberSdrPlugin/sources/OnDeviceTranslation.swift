import Foundation
#if canImport(Translation)
import Translation
#endif

/// Translating transcribed lines on the device, for v2's Whisper extension in
/// local mode — `window.ubersdrDesktop.translate` (see src/hostspeech.js).
///
/// Apple's Translation framework, and only the part of it that needs no
/// interface. Since iOS 18 a `TranslationSession` could only be had from a
/// SwiftUI `.translationTask`, attached to a view on screen, and it may then
/// show its own download sheet; neither belongs in a receiver page that never
/// asked for a view. iOS 26 added `TranslationSession(installedSource:target:)`
/// for "contexts where there's no UI" — it translates between languages that
/// are already installed and throws rather than asks for the rest. That is
/// exactly the contract the page wants, so that is the floor: below iOS 26 the
/// `translateHost` flag is not set and the page has no translator here, which
/// is the same answer it had before this existed.
///
/// The framework is weak-linked (see the podspec): it does not exist at all on
/// the iOS 15 to 17 devices this app still installs on.
final class OnDeviceTranslation {

    /// The `translateHost` flag.
    static func offered() -> Bool {
        #if canImport(Translation)
        if #available(iOS 26.0, *) { return true }
        #endif
        return false
    }

    private let send: (String) -> Void
    /// Sessions by language pair, kept because opening one loads a model and
    /// the page translates line by line. Main thread only. `AnyObject` so the
    /// property itself needs no availability.
    private var sessions: [String: AnyObject] = [:]

    init(send: @escaping (String) -> Void) {
        self.send = send
    }

    /// 'available' — installed, translates now; 'downloadable' — supported,
    /// but the languages are not on the device yet, and getting them is the
    /// person's to do in Settings (this never offers the download sheet);
    /// 'unavailable' — not a pair Apple translates, or not this OS.
    func availability(id: Int, source: String, target: String) {
        #if canImport(Translation)
        if #available(iOS 26.0, *) {
            Task {
                let status = await LanguageAvailability().status(from: Locale.Language(identifier: source),
                                                                 to: Locale.Language(identifier: target))
                self.reply("translate-availability", ["id": id, "status": Self.word(status)])
            }
            return
        }
        #endif
        reply("translate-availability", ["id": id, "status": "unavailable"])
    }

    func translate(id: Int, text: String, source: String, target: String) {
        #if canImport(Translation)
        if #available(iOS 26.0, *) {
            let key = "\(source)>\(target)"
            Task { @MainActor in
                let session: TranslationSession
                if let held = self.sessions[key] as? TranslationSession {
                    session = held
                } else {
                    session = TranslationSession(installedSource: Locale.Language(identifier: source),
                                                 target: Locale.Language(identifier: target))
                    self.sessions[key] = session
                }
                do {
                    let response = try await session.translate(text)
                    self.reply("translate-result", ["id": id, "text": response.targetText])
                } catch {
                    // Not reused: a session that has failed may have been
                    // cancelled, and the next line should get a fresh one.
                    self.sessions[key] = nil
                    let reason = await Self.reason(error, source: source, target: target)
                    self.reply("translate-result", ["id": id, "error": reason])
                }
            }
            return
        }
        #endif
        reply("translate-result", ["id": id, "error": "translation needs iOS 26 or later"])
    }

    func close() {
        DispatchQueue.main.async { self.sessions.removeAll() }
    }

    #if canImport(Translation)
    @available(iOS 26.0, *)
    private static func word(_ status: LanguageAvailability.Status) -> String {
        switch status {
        case .installed: return "available"
        case .supported: return "downloadable"
        case .unsupported: return "unavailable"
        @unknown default: return "unavailable"
        }
    }

    /// Why a line could not be translated, in words the page can show beside
    /// it ("Translation isn't working (<this>), so lines are shown as spoken").
    /// The framework's own errors are written for developers; the usual cause
    /// — languages not downloaded — is checked for and said plainly.
    @available(iOS 26.0, *)
    private static func reason(_ error: Error, source: String, target: String) async -> String {
        let status = await LanguageAvailability().status(from: Locale.Language(identifier: source),
                                                         to: Locale.Language(identifier: target))
        switch status {
        case .supported:
            return "the languages aren't downloaded on this device — add them under Settings › Apps › Translate"
        case .unsupported:
            return "this language pair is not supported"
        default:
            return error.localizedDescription
        }
    }
    #endif

    private func reply(_ prefix: String, _ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        send("\(prefix):\(json)")
    }
}
