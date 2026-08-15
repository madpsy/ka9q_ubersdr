import Foundation
import AVFoundation
import AudioToolbox

/// Playing the receiver from the app rather than from the page.
///
/// Everything else about audio on iOS is v2's: the WebSocket, the Opus decode,
/// the gate and the EQ and the notches, the scope, the recorder. That is worth
/// keeping and this does not touch it — in the foreground the page plays, as it
/// does everywhere else.
///
/// It cannot keep playing in the background, though, and not for want of an
/// audio session. Two separate rules apply once the app leaves the foreground:
///
///   * WebKit interrupts an AudioContext on backgrounding as a matter of
///     policy, whatever the host app has arranged with its audio session. From
///     the page's side this looks like `state: "interrupted"`, and it is not
///     something a page or a host can decline.
///   * The content process is throttled and then suspended, so the page cannot
///     react to any of this — it cannot even be *asked* to hand over, which is
///     why the earlier attempt at driving an `<audio>` element from JavaScript
///     on the way out never took hold.
///
/// So the audio has to come from this side of the WebView. `/audio/stream`
/// (audio_http_stream.go) is the same audio as a live WebM/Opus stream, and the
/// server routes packets *there instead of* the WebSocket while it is
/// connected — so this costs no extra bandwidth, takes no second session, and
/// needs nothing from the page, which by then is frozen anyway.
///
/// Three things make this much smaller than it sounds:
///
///   * **The container is ours.** buildWebMHeader/writeWebMCluster write a
///     fixed, minimal shape: a header, then one Cluster per Opus frame holding
///     a single SimpleBlock. Parsing that is a hundred lines, not a demuxer.
///   * **iOS decodes Opus itself.** `kAudioFormatOpus` is in the SDK and the
///     system decoder list, so there is no libopus here and nothing to vendor.
///   * **Rate changes are not a problem to solve.** Opus always decodes at
///     48 kHz whatever rate it was encoded from, so a mode change on the
///     receiver — 12 kHz to 24 kHz, mono to stereo — cannot change the format
///     coming out of here. The one thing that *can* change is the channel
///     count, and that arrives in the header before any audio does.
final class BackgroundAudio {

    /// How much decoded audio to hold before starting. The stream is live and
    /// the network is not, so starting on the first frame means starting into a
    /// stutter; a fifth of a second is what v2's own player primes for.
    private static let primeBuffers = 10          // × 20 ms

    private let queue = DispatchQueue(label: "org.ubersdr.background-audio")
    private var task: URLSessionDataTask?
    private var delegate: StreamDelegate?

    // Parser state.
    private var bytes: [UInt8] = []
    private var headerDone = false

    // Decoder state, which cannot be built until the header names the channel
    // count and hands over the OpusHead.
    private var converter: AudioConverterRef?
    private var outFormat: AVAudioFormat?
    private var channels = 1

    // What the converter's input callback hands over. Stable allocations rather
    // than locals: the callback is C and runs inside FillComplexBuffer, and
    // both of these have to outlive the Swift statement that set them.
    private var feed = UnsafeMutablePointer<UInt8>.allocate(capacity: 8192)
    private var feedDesc = UnsafeMutablePointer<AudioStreamPacketDescription>.allocate(capacity: 1)
    private var feedSize = 0
    private var feedTaken = true

    private var player: AVAudioPlayerNode?
    private var scheduled = 0
    private var playing = false

    /// Decoded frames, which is how build-mac.sh --bgtest tells audio from
    /// silence without listening to it.
    private(set) var framesPlayed = 0

    deinit {
        feed.deallocate()
        feedDesc.deallocate()
    }

    var isRunning: Bool { task != nil }

    /// Take over the audio. Safe to call twice — the second one does nothing,
    /// which matters because both `willResignActive` and `didEnterBackground`
    /// ask for this.
    func start(origin: String, sessionId: String) {
        guard task == nil else { return }
        guard !sessionId.isEmpty,
              let url = URL(string: "\(origin)/audio/stream?session=\(sessionId)") else { return }

        bytes = []
        headerDone = false
        scheduled = 0
        playing = false
        framesPlayed = 0

        let delegate = StreamDelegate { [weak self] data in
            self?.queue.async { self?.consume(data) }
        }
        self.delegate = delegate
        // Its own session, with a delegate, because the audio has to arrive as
        // it is produced: the completion-handler form of URLSession holds the
        // whole body, and a live stream has no whole.
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = .infinity
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        let task = session.dataTask(with: url)
        self.task = task
        task.resume()
    }

    /// Give the audio back to the page.
    ///
    /// Closing the connection is what tells the server to route to the
    /// WebSocket again — its handler clears the HTTP channel as it unwinds — and
    /// the DELETE says so explicitly rather than relying on when the socket is
    /// noticed. media/httpStream.js is emphatic about this for the same reason:
    /// a stream still held open by nobody is silence for the operator.
    func stop(origin: String, sessionId: String) {
        guard task != nil else { return }
        task?.cancel()
        task = nil
        delegate = nil

        queue.async { [weak self] in
            guard let self = self else { return }
            self.player?.stop()
            if let player = self.player {
                PlaybackSession.detach(player)
                self.player = nil
            }
            if let converter = self.converter {
                AudioConverterDispose(converter)
                self.converter = nil
            }
            self.bytes = []
            self.headerDone = false
        }

        guard !sessionId.isEmpty,
              let url = URL(string: "\(origin)/audio/stream?session=\(sessionId)") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        URLSession.shared.dataTask(with: request).resume()
    }

    // MARK: - The container

    private func consume(_ data: Data) {
        bytes.append(contentsOf: data)
        if !headerDone { readHeader() }
        guard headerDone else { return }
        readClusters()
    }

    /// The header, once: the OpusHead the decoder needs, and where the audio
    /// starts.
    ///
    /// It is found by looking for the magic rather than by walking the element
    /// tree. The tree is known and fixed, so walking it would be a longer way of
    /// arriving at the same nineteen bytes, and a way that breaks if a field is
    /// ever added ahead of them.
    private func readHeader() {
        guard let head = find([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], from: 0),  // "OpusHead"
              bytes.count >= head + 19 else { return }
        let cookie = Array(bytes[head ..< head + 19])
        channels = max(1, Int(cookie[9]))

        guard let cluster = find([0x1F, 0x43, 0xB6, 0x75], from: head + 19) else { return }
        guard buildDecoder(cookie: cookie) else {
            NSLog("[UberSDR audio] no Opus decoder for %d channel(s)", channels)
            return
        }
        bytes.removeFirst(cluster)
        headerDone = true
    }

    private func readClusters() {
        let clusterID: [UInt8] = [0x1F, 0x43, 0xB6, 0x75]
        while bytes.count > 4 {
            guard Array(bytes[0 ..< 4]) == clusterID else {
                // Nothing should desynchronise a stream we wrote ourselves, but
                // a resync costs one search and the alternative is silence.
                guard let next = find(clusterID, from: 1) else { bytes = []; return }
                bytes.removeFirst(next)
                continue
            }
            guard let size = vint(at: 4) else { return }
            let end = 4 + size.width + Int(size.value)
            guard bytes.count >= end else { return }
            readCluster(from: 4 + size.width, to: end)
            bytes.removeFirst(end)
        }
    }

    /// One cluster: a Timecode we do not need and a SimpleBlock we do.
    private func readCluster(from start: Int, to end: Int) {
        var i = start
        while i < end {
            guard let id = elementID(at: i, limit: end),
                  let size = vint(at: i + id.width),
                  case let payload = i + id.width + size.width,
                  case let next = payload + Int(size.value),
                  next <= end else { return }
            // SimpleBlock: track number (VINT), relative timecode (int16), one
            // flags byte, then the frame.
            if id.value == 0xA3, payload + 4 < next {
                decode(Array(bytes[(payload + 4) ..< next]))
            }
            i = next
        }
    }

    // MARK: - EBML

    private func find(_ needle: [UInt8], from: Int) -> Int? {
        guard bytes.count >= needle.count else { return nil }
        var i = max(0, from)
        let last = bytes.count - needle.count
        outer: while i <= last {
            for k in 0 ..< needle.count where bytes[i + k] != needle[k] { i += 1; continue outer }
            return i
        }
        return nil
    }

    /// A length, with its marker bit cleared.
    private func vint(at i: Int) -> (value: UInt64, width: Int)? {
        guard i < bytes.count else { return nil }
        let first = bytes[i]
        guard first != 0 else { return nil }
        var width = 1
        var mask: UInt8 = 0x80
        while mask != 0, first & mask == 0 { width += 1; mask >>= 1 }
        guard width <= 8, i + width <= bytes.count else { return nil }
        var value = UInt64(first & (mask &- 1))
        for k in 1 ..< width { value = (value << 8) | UInt64(bytes[i + k]) }
        return (value, width)
    }

    /// An element ID, marker bit and all — IDs are compared as written.
    private func elementID(at i: Int, limit: Int) -> (value: UInt32, width: Int)? {
        guard i < limit, i < bytes.count else { return nil }
        let first = bytes[i]
        guard first != 0 else { return nil }
        var width = 1
        var mask: UInt8 = 0x80
        while mask != 0, first & mask == 0 { width += 1; mask >>= 1 }
        guard width <= 4, i + width <= min(limit, bytes.count) else { return nil }
        var value: UInt32 = 0
        for k in 0 ..< width { value = (value << 8) | UInt32(bytes[i + k]) }
        return (value, width)
    }

    // MARK: - Decoding

    private func buildDecoder(cookie: [UInt8]) -> Bool {
        var input = AudioStreamBasicDescription(
            // 48 kHz whatever the receiver's rate is: that is Opus, not a
            // choice. `mFramesPerPacket` is the 20 ms the server sends.
            mSampleRate: 48000,
            mFormatID: kAudioFormatOpus,
            mFormatFlags: 0,
            mBytesPerPacket: 0,
            mFramesPerPacket: 960,
            mBytesPerFrame: 0,
            mChannelsPerFrame: UInt32(channels),
            mBitsPerChannel: 0,
            mReserved: 0)

        guard let outFormat = AVAudioFormat(standardFormatWithSampleRate: 48000,
                                            channels: AVAudioChannelCount(channels)) else { return false }
        var output = outFormat.streamDescription.pointee

        var converter: AudioConverterRef?
        guard AudioConverterNew(&input, &output, &converter) == noErr, let converter = converter else { return false }
        // The OpusHead is the decoder's magic cookie — pre-skip, gain and
        // channel mapping live in it, and Apple's decoder wants it before the
        // first packet rather than inferring anything.
        var cookie = cookie
        AudioConverterSetProperty(converter, kAudioConverterDecompressionMagicCookie,
                                  UInt32(cookie.count), &cookie)

        self.converter = converter
        self.outFormat = outFormat

        let player = AVAudioPlayerNode()
        guard PlaybackSession.attach(player, format: outFormat) else {
            AudioConverterDispose(converter)
            self.converter = nil
            return false
        }
        self.player = player
        return true
    }

    private func decode(_ packet: [UInt8]) {
        guard let converter = converter, let outFormat = outFormat, let player = player else { return }
        guard packet.count > 0, packet.count <= 8192 else { return }

        packet.withUnsafeBufferPointer { src in
            feed.update(from: src.baseAddress!, count: src.count)
        }
        feedSize = packet.count
        feedTaken = false

        // Room for the largest frame Opus can carry, which is what the system
        // decoder insists on: asked for exactly the 960 frames a 20 ms packet
        // holds, it refuses with paramErr before it has even looked at the
        // packet. So the buffer is sized for 120 ms and the *real* length comes
        // from the packet, not from the converter — see opusFrames.
        //
        // That is not merely tidier. Told to fill 5760 frames from a 960-frame
        // packet, the converter pads the rest, and taking its word for the
        // length meant scheduling six times as much audio as the receiver was
        // sending — five parts silence to one part signal, for ever.
        guard let pcm = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: 5760),
              let expected = Self.opusFrames(packet) else { return }
        // Opened up before the call, because a buffer's AudioBufferList
        // advertises `frameLength` bytes and not `frameCapacity` ones — and a
        // fresh buffer's length is zero. The converter reads that as no room at
        // all and answers paramErr without ever asking for a packet, which
        // looks exactly like a decoder that will not take the format.
        pcm.frameLength = pcm.frameCapacity
        // How much room there is, on the way in. What it holds on the way out
        // is not read: that is what opusFrames is for.
        var room: UInt32 = 5760
        let status = AudioConverterFillComplexBuffer(
            converter, Self.supply, Unmanaged.passUnretained(self).toOpaque(),
            &room, pcm.mutableAudioBufferList, nil)
        guard status == noErr || status == Self.outOfInput else {
            NSLog("[UberSDR audio] decode failed: %d", status)
            return
        }
        pcm.frameLength = min(expected, pcm.frameCapacity)
        framesPlayed += Int(pcm.frameLength)

        scheduled += 1
        player.scheduleBuffer(pcm) { [weak self] in
            guard let self = self else { return }
            self.queue.async { self.scheduled -= 1 }
        }
        if !playing, scheduled >= Self.primeBuffers {
            playing = true
            player.play()
        }
    }

    /// How much audio a packet holds, read from the packet.
    ///
    /// Opus says so in its first byte, which is the only reason this is worth
    /// doing here rather than trusting the decoder: the TOC gives the frame
    /// duration and how many frames are packed, and everything decodes at
    /// 48 kHz whatever it was encoded at. RFC 6716 §3.1.
    private static func opusFrames(_ packet: [UInt8]) -> UInt32? {
        guard let toc = packet.first else { return nil }
        let config = Int(toc >> 3)
        // Tenths of a millisecond, so 2.5 ms is an integer like the rest.
        let tenths: Int
        switch config {
        case 0 ... 11:  tenths = [100, 200, 400, 600][config % 4]        // SILK
        case 12 ... 15: tenths = [100, 200][config % 2]                  // hybrid
        default:        tenths = [25, 50, 100, 200][config % 4]          // CELT
        }
        let count: Int
        switch toc & 0x03 {
        case 0: count = 1
        case 1, 2: count = 2
        default:
            guard packet.count > 1 else { return nil }
            count = Int(packet[1] & 0x3F)
        }
        guard count > 0, count <= 48 else { return nil }
        // 48 samples per tenth of a millisecond, at Opus's fixed 48 kHz.
        return UInt32(count * tenths * 48 / 10)
    }

    /// What the converter is told when the packet it was given is used up.
    /// Anything non-zero will do; this one is not a real OSStatus, which keeps
    /// it from being confused with a decoder complaint.
    private static let outOfInput: OSStatus = 0x6E6F6474        // 'nodt'

    /// One packet, once, and then nothing.
    ///
    /// A C callback, so it takes `self` back out of the context pointer rather
    /// than capturing it — and reads only the fields set immediately before the
    /// call it runs inside, on the same queue.
    private static let supply: AudioConverterComplexInputDataProc = { _, packets, data, descriptions, context in
        let me = Unmanaged<BackgroundAudio>.fromOpaque(context!).takeUnretainedValue()
        if me.feedTaken {
            packets.pointee = 0
            return BackgroundAudio.outOfInput
        }
        me.feedTaken = true
        me.feedDesc.pointee = AudioStreamPacketDescription(
            mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(me.feedSize))
        packets.pointee = 1
        data.pointee.mNumberBuffers = 1
        data.pointee.mBuffers.mNumberChannels = UInt32(me.channels)
        data.pointee.mBuffers.mDataByteSize = UInt32(me.feedSize)
        data.pointee.mBuffers.mData = UnsafeMutableRawPointer(me.feed)
        descriptions?.pointee = me.feedDesc
        return noErr
    }

    /// The body, as it arrives.
    private final class StreamDelegate: NSObject, URLSessionDataDelegate {
        private let onData: (Data) -> Void
        init(onData: @escaping (Data) -> Void) { self.onData = onData }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            onData(data)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                        didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if code != 200 {
                NSLog("[UberSDR audio] background stream refused: HTTP %d", code)
            }
            completionHandler(.allow)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            if let error = error, (error as NSError).code != NSURLErrorCancelled {
                NSLog("[UberSDR audio] background stream ended: %@", error.localizedDescription)
            }
        }
    }
}
