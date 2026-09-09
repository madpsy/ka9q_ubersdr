package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/opus"
)

// Audio packets are a variable-length header followed by the Opus payload; see
// audioheader.go for the layout and audioHeaderDecoder for the reader.
//
// The noise field is a power over the demodulator passband, so power minus
// noise is an SNR in dB. Protocol version 2 sent radiod's noise density N0 in
// dBFS/Hz instead, which came out as S/N0 in dB·Hz — about 34 dB above the true
// SNR on a 2.65 kHz filter, and a different amount on every other filter width,
// which is why a squelch set on SSB gated wrongly on CW.

// opusOutputRate is what the decoder produces, and the rate the whole output
// path runs at. Opus always reconstructs at 48 kHz regardless of the rate the
// encoder was fed, so the source rate in the header describes the radio
// channel, not the PCM we get back.
//
// The lossless path carries the channel's own samples instead, at 12 or 24 kHz,
// and resample.go brings those up to this rate so everything downstream — the
// mixer, the sound device, the stdout stream and its WAV header — is unchanged
// by the choice of format.
const opusOutputRate = 48000

// AudioFormat is the wire format asked for at connect.
//
// It is a request rather than a guarantee. The server picks the format per
// packet and can answer either one with the other: a session that asked for
// Opus gets lossless PCM on IQ modes and from a server built without libopus,
// and one that asked for lossless gets exactly what it asked for, since that
// path needs nothing of the server but the samples it already has. Both are
// decoded here, so the request only decides what arrives in the ordinary case.
type AudioFormat int

const (
	// FormatOpus is the default: about 5 kB/s, at the cost of a lossy codec.
	FormatOpus AudioFormat = iota

	// FormatLossless is the predictive codec of protocol version 4, which
	// reconstructs the demodulator's own samples bit for bit. It costs about
	// twice the bandwidth and nothing in CPU worth measuring: on one receiver,
	// a quiet 40 m LSB channel ran 11.1 kB/s against Opus's 5.5, and a busy
	// 20 m one 11.9 against 5.8.
	FormatLossless
)

// wireName is what the server calls this format in the query string. The
// lossless one is still named for the zstd wrapper that versions 1 to 3 put
// around it; from version 4 the wire form is the predictive codec instead,
// which is where its bandwidth went.
func (f AudioFormat) wireName() string {
	if f == FormatLossless {
		return "pcm-zstd"
	}
	return "opus"
}

func (f AudioFormat) String() string {
	if f == FormatLossless {
		return "lossless"
	}
	return "Opus"
}

// AudioPacket is one packet of decoded audio, exactly as the receiver sent it:
// at the radio channel's own sample rate, and interleaved when it carries more
// than one channel.
//
// Nothing is converted here. The demodulated modes arrive at 12 or 24 kHz in
// one channel and the IQ modes at 12 to 384 kHz in two, and which of those the
// sinks want differs — the sound device runs at one fixed rate, while a capture
// or a decoder reading stdout wants the samples the receiver actually sent. So
// the conversion belongs to the sink that needs it (audioout.go), not here.
type AudioPacket struct {
	// Samples is interleaved when Channels is more than one: I, Q, I, Q for the
	// IQ modes.
	Samples  []int16
	Rate     int
	Channels int
}

// Frames is how many sample instants the packet carries, which is what its
// duration is measured in — half the sample count on a stereo IQ packet.
func (p AudioPacket) Frames() int {
	if p.Channels < 2 {
		return len(p.Samples)
	}
	return len(p.Samples) / p.Channels
}

// silenceCeiling is the peak sample amplitude below which a decoded frame
// counts as silence. Roughly -78 dBFS: far above what a gated frame decodes to
// and far below any real audio.
const silenceCeiling = 4

// DSPState is the server's own account of the DSP insert, from a dsp_status
// message. The server is authoritative: it may refuse a filter when the insert
// is at its user limit, so the display follows this rather than what was asked
// for.
type DSPState struct {
	Enabled bool
	Filter  string
}

// Signal is one reading from an audio packet's header.
type Signal struct {
	Power float32 // baseband power over the passband, dBFS
	Noise float32 // noise power over the same passband, dBFS

	// SourceRate is the radio channel's sample rate, which changes with mode.
	// It is reported for display only: the audio reaches the output at 48 kHz
	// either way, reconstructed there by Opus or resampled there from the
	// channel's own rate.
	SourceRate int
	Channels   int

	// Lossless reports which format this reading came off, since the server
	// chooses that per packet rather than once per session.
	Lossless bool
}

// SNR is the difference the meter shows in SNR mode: a signal-to-noise ratio
// in dB, both halves being powers over the same passband. It is only meaningful
// when both were reported.
func (s Signal) SNR() float32 { return s.Power - s.Noise }

func (s Signal) Valid() bool      { return isReportedLevel(s.Power) }
func (s Signal) NoiseValid() bool { return isReportedLevel(s.Noise) }

// isReportedLevel rejects the sentinels the server and clients use for "no
// reading": -999 in the Python client, and the infinities that appear before
// the first packet or on a silent channel.
func isReportedLevel(v float32) bool {
	f := float64(v)
	return !math.IsInf(f, 0) && !math.IsNaN(f) && f > -998
}

// AudioClient streams demodulated audio over its own WebSocket, sharing the
// spectrum session's UUID so the server treats both as one user session.
type AudioClient struct {
	host      string
	tls       bool
	password  string
	sessionID string

	mu        sync.RWMutex
	conn      *websocket.Conn
	connected bool

	// Current tuning, echoed back into reconnects so a dropped socket resumes
	// where the user left off.
	freq   float64
	mode   string
	bwLow  int
	bwHigh int

	// Rate limited like the spectrum socket; the server rejects faster.
	cmdMu       sync.Mutex
	lastCommand time.Time

	// Desired DSP insert, re-applied on reconnect so it survives a dropped
	// socket like the tuning does.
	dspFilter string

	// Squelch threshold in dB of SNR; 0 means off. Sent on connect as well as
	// on change, so it survives a reconnect.
	squelch int

	// minMargin is the reduced-depth IQ request in dB, or 0 for a lossless IQ
	// stream. It has no effect on the demodulated modes, which the server never
	// quantises. Sent on connect and pushed live on change.
	minMargin int

	// sentMargin is the wire value the server currently holds, so a margin that
	// has not effectively changed is not re-sent. The effective value depends on
	// the mode as well as the setting — it is nothing at all on a demodulated
	// channel — so switching into an IQ mode is what makes a margin set earlier
	// take effect, and switching out of one withdraws it.
	sentMargin int

	// format is what to ask the server for, and restarting marks that the live
	// socket was closed to change it. The format is negotiated in the query
	// string, so changing it means a new socket rather than a command.
	format     AudioFormat
	restarting bool

	PCM     chan AudioPacket // decoded audio, at the rate the receiver sent it
	Level   chan Signal      // baseband power and noise density, for the meter
	DSP     chan DSPState
	Silence chan bool // true when a decoded frame carried only silence
	Status  chan string
}

func NewAudioClient(host string, useTLS bool, password, sessionID string) *AudioClient {
	// Opening defaults come from the mode table; the UI overrides them with
	// SetTuning before the socket is used.
	usb, _ := lookupMode("usb")
	return &AudioClient{
		host:      host,
		tls:       useTLS,
		password:  password,
		sessionID: sessionID,
		mode:      usb.Name,
		bwLow:     usb.Low,
		bwHigh:    usb.High,
		// Generous buffering: the player drains this, and a brief render stall
		// should not cost audio.
		PCM:     make(chan AudioPacket, 64),
		Level:   make(chan Signal, 8),
		DSP:     make(chan DSPState, 4),
		Silence: make(chan bool, 16),
		Status:  make(chan string, 8),
	}
}

// SetFormat chooses the wire format, reconnecting when a session is already
// running.
//
// The format is settled in the query string at connect, so changing it needs a
// new socket — there is no command for it. That is cheap enough to put on a
// key: the session UUID is unchanged, so the server keeps the same radiod
// channel and the same seat, and the gap is one dial and one handshake.
func (a *AudioClient) SetFormat(f AudioFormat) {
	a.mu.Lock()
	if a.format == f {
		a.mu.Unlock()
		return
	}
	a.format = f
	conn := a.conn
	if conn != nil {
		a.restarting = true
	}
	a.mu.Unlock()

	// Closing the socket is what ends the read loop in session; Run then dials
	// again and picks up the format just stored.
	if conn != nil {
		conn.Close()
	}
}

// Format reports the wire format currently being asked for.
func (a *AudioClient) Format() AudioFormat {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.format
}

// takeRestart reports whether the session that just ended was closed to change
// format, clearing the flag as it does.
func (a *AudioClient) takeRestart() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	r := a.restarting
	a.restarting = false
	return r
}

// SetTuning records the parameters to open with. Call before Run.
func (a *AudioClient) SetTuning(freq float64, mode string, low, high int) {
	a.mu.Lock()
	a.freq, a.mode, a.bwLow, a.bwHigh = freq, mode, low, high
	a.mu.Unlock()
}

func (a *AudioClient) scheme(secure, plain string) string {
	if a.tls {
		return secure
	}
	return plain
}

// Run connects and streams until ctx is cancelled, reconnecting on drop.
func (a *AudioClient) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := a.session(ctx)
		if ctx.Err() != nil {
			return
		}

		// A format change closes the socket deliberately, so it is neither a
		// failure to report nor a reason to wait: the whole point of the
		// reconnect is that the audio comes straight back in the other format.
		if a.takeRestart() {
			backoff = time.Second
			continue
		}

		if err != nil {
			a.report(fmt.Sprintf("audio disconnected: %v", err))
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 15*time.Second {
			backoff *= 2
		}
	}
}

func (a *AudioClient) session(ctx context.Context) error {
	a.mu.RLock()
	freq, mode, low, high := a.freq, a.mode, a.bwLow, a.bwHigh
	format := a.format
	a.mu.RUnlock()

	q := url.Values{}
	q.Set("user_session_id", a.sessionID)
	q.Set("format", format.wireName())
	q.Set("version", fmt.Sprintf("%d", audioProtocolVersion))
	if a.password != "" {
		q.Set("password", a.password)
	}
	if freq > 0 {
		q.Set("frequency", fmt.Sprintf("%d", int64(freq)))
	}
	if mode != "" {
		q.Set("mode", mode)
	}
	// The wide IQ modes keep the radiod preset's bandwidth: the server skips the
	// filter command for them entirely, so sending edges would be asking for a
	// filter inside the preset's own passband — which comes back as a capture
	// missing the top and bottom of its band with nothing to say why.
	if !isWideIQMode(mode) {
		q.Set("bandwidthLow", fmt.Sprintf("%d", low))
		q.Set("bandwidthHigh", fmt.Sprintf("%d", high))
	}
	a.mu.RLock()
	sq := a.squelch
	margin := a.minMargin
	a.mu.RUnlock()
	q.Set("min_snr", fmt.Sprintf("%g", squelchToWire(sq)))
	// Reduced-depth IQ. Absent means the lossless path, which is what every
	// demodulated mode gets and what an IQ session asking for 0 gets.
	wire := marginToWire(mode, margin)
	if wire > 0 {
		q.Set("min_margin", fmt.Sprintf("%d", wire))
	}
	// The query string is the baseline the server now holds, so nothing needs
	// re-sending until it moves.
	a.mu.Lock()
	a.sentMargin = wire
	a.mu.Unlock()

	wsURL := fmt.Sprintf("%s://%s/ws?%s", a.scheme("wss", "ws"), a.host, q.Encode())

	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 15 * time.Second
	dialer.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	dialer.NetDialContext = dialFunc()

	conn, resp, err := dialer.DialContext(ctx, wsURL, http.Header{
		"User-Agent": []string{userAgent},
	})
	if err != nil {
		if resp != nil {
			return fmt.Errorf("%w (HTTP %d)", err, resp.StatusCode)
		}
		return err
	}

	a.mu.Lock()
	a.conn = conn
	a.connected = true
	a.mu.Unlock()
	a.report("audio connected")

	// Restore the DSP insert: the server starts each session with none.
	if filter := a.dspFilter; filter != "" {
		a.sendDSP(conn, filter)
	}

	defer func() {
		a.mu.Lock()
		a.connected = false
		a.conn = nil
		a.mu.Unlock()
		conn.Close()
	}()

	go func() {
		<-ctx.Done()
		conn.Close()
	}()

	// Every reader here carries inter-frame state — each codec its own, each
	// header what the server has stopped repeating — so they live for the whole
	// session and are discarded when the socket drops.
	dec := newAudioDecoders(format)

	for {
		conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}

		switch msgType {
		case websocket.BinaryMessage:
			if err := a.handleAudio(data, dec); err != nil {
				return err
			}
		case websocket.TextMessage:
			a.handleText(data)
		}
	}
}

// audioDecoders is one session's decode state, for both formats.
//
// Both are built whatever was asked for, because the server decides the format
// per packet and either shape can arrive: the state each carries is a few
// kilobytes, and building one lazily on the first frame that needs it would
// only move the same allocation onto the receive path.
type audioDecoders struct {
	// asked is what the session requested, so a stream that turns out to be the
	// other format can be reported once rather than on every packet.
	asked AudioFormat
	told  bool

	// The Opus reader: its header decoder, the codec, and a scratch buffer
	// sized well above any frame, reused because the decoder writes into it.
	opusHdr *audioHeaderDecoder
	opus    *opus.Decoder
	scratch []int16

	// The lossless reader. What comes out of it is the channel's own samples at
	// the channel's own rate; converting them for the sound device is the
	// output's job, not this one's.
	pcm *pcmStreamDecoder

	// synced marks that at least one lossless packet has decoded, which is what
	// separates a stream not yet started from one that has gone wrong; see
	// handleLossless.
	synced bool
}

func newAudioDecoders(asked AudioFormat) *audioDecoders {
	decoder := opus.NewDecoder()
	return &audioDecoders{
		asked:   asked,
		opusHdr: newAudioHeaderDecoder(),
		opus:    &decoder,
		scratch: make([]int16, opusOutputRate), // one second, far above any frame
		pcm:     newPCMStreamDecoder(),
	}
}

// handleAudio decodes one binary frame. It returns an error only for a stream
// this client cannot read at all, which drops the socket and reconnects — as
// distinct from a frame it merely failed on, which is dropped in place.
func (a *AudioClient) handleAudio(data []byte, d *audioDecoders) error {
	// Which shape this is has to come from the frame rather than from what was
	// negotiated: the server picks the format per packet, so a session that
	// asked for Opus receives lossless PCM on IQ modes and from a server built
	// without libopus, and both are read here.
	//
	// The magic is four bytes, which is not decoration. An Opus frame begins
	// with a header whose leading bytes are near enough uniform, so the width of
	// the magic is a false-positive rate — and each false positive is a frame of
	// audio played as metadata, which is an audible click.
	if magic, lossless := frameIsLossless(data); lossless {
		// Version 4 has no zstd anywhere, so a zstd frame is not a frame this
		// client misread: it is a server older than 0.1.63, which clamps the
		// requested version to 1-3 and answers with version 1 rather than
		// refusing it outright.
		if magic == zstdMagic {
			return fmt.Errorf("server does not support audio protocol version %d (needs UberSDR 0.1.63 or later)", audioProtocolVersion)
		}
		return a.handleLossless(data, d)
	}
	return a.handleOpus(data, d)
}

// handleOpus decodes one Opus frame.
func (a *AudioClient) handleOpus(data []byte, d *audioDecoders) error {
	// Asking for lossless and being given Opus means the server declined the
	// format rather than the request failing, which is worth saying once: the
	// audio is fine, it is simply not what was asked for.
	if d.asked == FormatLossless && !d.told {
		d.told = true
		a.report("server is sending Opus rather than lossless audio")
	}

	// The header is framing rather than payload: one that will not parse means
	// the frames are not the shape this client reads, which reconnecting at
	// least reports rather than silently dropping every frame.
	h, off, err := d.opusHdr.decode(data)
	if err != nil {
		return err
	}

	// The header describes the radio channel, not the PCM we get back. The
	// channel's sample rate changes with mode — 12 kHz for the sideband and CW
	// modes, 24 kHz for AM and FM — but Opus always reconstructs at 48 kHz, so
	// what comes out of the decoder is at the output rate whatever the header
	// says. Verified against a live receiver across every mode: a 20 ms frame
	// decodes to 960 samples either way.
	//
	// The channel count does matter: a stereo stream decodes to interleaved
	// pairs, and treating that as mono would halve the duration and play back
	// at double speed.
	channels := h.Channels
	if channels < 1 {
		channels = 1
	}

	a.reportLevel(h.Power, h.Noise, h.SourceRate, channels, false)

	pcm := d.scratch
	n, err := d.opus.DecodeToInt16(data[off:], pcm)
	if err != nil {
		// A single bad frame is not fatal — Opus is resilient and the next
		// frame usually recovers, so drop this one rather than tearing the
		// stream down.
		a.report("audio decode: " + err.Error())
		return nil
	}
	if n <= 0 {
		return nil
	}

	// n counts samples per channel; the decoder writes n*channels values into
	// the scratch buffer, which the next frame overwrites — so this copies.
	samples := make([]int16, n*channels)
	copy(samples, pcm[:n*channels])
	a.deliver(AudioPacket{Samples: samples, Rate: opusOutputRate, Channels: channels})
	return nil
}

// handleLossless decodes one version 4 lossless packet.
//
// Every packet reaching this client MUST be decoded, even one that is then
// dropped for being late. The predictor is backward adaptive — its taps are
// derived from samples already decoded — so a packet that never reaches the
// codec leaves this side's filters where the server's no longer are, and every
// packet after it decodes as noise. Dropping the RESULT when the player is
// behind costs 20 ms of audio; dropping the decode would cost the rest of the
// session.
func (a *AudioClient) handleLossless(data []byte, d *audioDecoders) error {
	if d.asked == FormatOpus && !d.told && !a.iqMode() {
		d.told = true
		// Worth saying on a demodulated mode, where it means the receiver has
		// no Opus encoder and the stream is costing more than the session asked
		// for. Not on an IQ mode, where lossless is the only thing there is:
		// there is no Opus encoder for RF, and saying so on every IQ session
		// would be noise.
		a.report("server is sending lossless audio rather than Opus")
	}

	h, samples, err := d.pcm.decode(data)
	if err != nil {
		// Once the stream has started, a failure here is not recoverable in
		// place: the predictor's state is now behind the server's, so every
		// packet after it would decode to noise. Dropping the socket
		// resynchronises both ends, which is what the reconnect is for.
		if d.synced {
			return err
		}
		// Before it has started, the only failure available is a packet that
		// arrived ahead of the resynchronisation point describing it — nothing
		// has said what the sample rate is yet. The server sends one on its
		// first packet and every five seconds after, so waiting costs a moment
		// where reconnecting would only start the same wait again.
		return nil
	}
	d.synced = true

	channels := h.Channels
	if channels < 1 {
		channels = 1
	}

	a.reportLevel(h.Power, h.Noise, h.SourceRate, channels, true)
	a.deliver(AudioPacket{Samples: samples, Rate: h.SourceRate, Channels: channels})
	return nil
}

// reportLevel offers one packet's signal reading to the meter, dropping it when
// the meter is behind — the next packet is 20 ms away and carries a fresh one.
func (a *AudioClient) reportLevel(power, noise float32, rate, channels int, lossless bool) {
	// Both halves of the report: the meter shows either the absolute level or
	// the difference between them.
	if !isReportedLevel(power) {
		return
	}
	select {
	case a.Level <- Signal{Power: power, Noise: noise, SourceRate: rate, Channels: channels, Lossless: lossless}:
	default:
	}
}

// deliver hands one packet to the player and tells the UI whether it was
// silent.
func (a *AudioClient) deliver(pkt AudioPacket) {
	out := pkt.Samples
	if len(out) == 0 {
		return
	}

	// A closed gate arrives as a packet of silence rather than as missing
	// packets, so silence here is the server telling us it squelched. Reading
	// it from the audio avoids reimplementing the server's hang timer and
	// hysteresis, which would drift out of step with it.
	//
	// The test is a threshold rather than exact zero because of the Opus path:
	// the server zeroes the PCM *before* encoding and the codec is lossy, so a
	// gated frame decodes to near-silence instead. Measured against a live
	// receiver, gated frames peak at 1 while open audio peaks in the thousands,
	// so the margin either side of this threshold is enormous. On the lossless
	// path a gated packet is exactly zero and the same test is simply exact.
	silent := true
	for _, v := range out {
		if v > silenceCeiling || v < -silenceCeiling {
			silent = false
			break
		}
	}
	select {
	case a.Silence <- silent:
	default:
	}

	select {
	case a.PCM <- pkt:
	default:
		// The player is behind. Dropping the oldest keeps latency bounded
		// instead of letting a backlog build.
		select {
		case <-a.PCM:
		default:
		}
		select {
		case a.PCM <- pkt:
		default:
		}
	}
}

func (a *AudioClient) handleText(data []byte) {
	var msg struct {
		Type  string `json:"type"`
		Error string `json:"error"`
		Info  struct {
			Enabled bool   `json:"enabled"`
			Filter  string `json:"filter"`
		} `json:"info"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}

	switch msg.Type {
	case "error":
		if msg.Error != "" {
			a.report("audio: " + msg.Error)
		}
	case "dsp_status":
		select {
		case a.DSP <- DSPState{Enabled: msg.Info.Enabled, Filter: msg.Info.Filter}:
		default:
		}
	}
}

// squelchDisabled is the value the server reads as "gate off". Zero is a
// perfectly valid SNR threshold, so a separate sentinel is needed; the web UI
// uses the same one.
const squelchDisabled = -999.0

// squelchToWire converts the user-facing threshold, where 0 means off, into the
// value the server expects.
func squelchToWire(threshold int) float64 {
	if threshold <= 0 {
		return squelchDisabled
	}
	return float64(threshold)
}

// The reduced-depth IQ range the server honours, from lossyMinMarginDB and
// lossyMaxMarginDB in the server's pcm_lossy.go.
//
// The request is a MARGIN, not a bit depth: how far under the band's own noise
// floor the quantisation floor must stay. A depth means something different on
// every band — measured by the server's own author, ten bits left 50 dB of
// headroom on a dead 6 m band and 9 dB on medium wave — so a margin is what
// lets one number mean the same thing wherever the receiver is pointed.
//
// Below 15 dB the added floor starts to lift the noise floor a listener can
// actually see; above 60 dB the request buys almost nothing, and anyone wanting
// less than that wants the lossless stream instead, which is what 0 asks for.
// The server clamps rather than refusing, but asking for something it will not
// honour is still worth refusing here, where there is somewhere to say so.
const (
	marginMin = 15
	marginMax = 60

	// marginDefault is what an IQ session asks for when nobody says otherwise.
	// The floor of the range: the cheapest stream whose quantisation stays
	// under what the receiver's own readings can resolve.
	marginDefault = 15
)

// marginToWire is what to send for a mode, which is nothing at all unless this
// is an IQ mode with a margin set. The reduced-depth path exists only for IQ —
// the server never quantises a demodulated channel — so sending it elsewhere
// would ask for something that cannot happen.
func marginToWire(mode string, margin int) int {
	if !isIQMode(mode) || margin < marginMin {
		return 0
	}
	if margin > marginMax {
		return marginMax
	}
	return margin
}

// SetMinMargin sets the reduced-depth IQ margin in dB, or 0 for lossless IQ.
//
// No reconnect: the depth is chosen per packet and the shift travels in the
// packet, so a new margin takes effect on the next one. Crossing between lossy
// and lossless changes the profile, which the decoder rebuilds itself.
func (a *AudioClient) SetMinMargin(dB int) {
	a.mu.Lock()
	a.minMargin = dB
	a.mu.Unlock()
	a.syncMargin()
}

// syncMargin sends the margin the current mode implies, if the server is not
// already holding it.
//
// It is called on a mode change as well as on a margin change, because the two
// together decide the wire value: a margin set while listening to USB means
// nothing until an IQ mode is selected, and must then be applied without the
// user setting it again. Comparing against what was last sent is what keeps
// that off the wire on every dial step, since retuning goes through here too.
func (a *AudioClient) syncMargin() {
	a.mu.Lock()
	want := marginToWire(a.mode, a.minMargin)
	conn := a.conn
	ok := a.connected
	if !ok || conn == nil || want == a.sentMargin {
		a.mu.Unlock()
		return // applied on the next connect via the query string
	}
	a.sentMargin = want
	a.mu.Unlock()

	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteJSON(map[string]interface{}{
		"type":       "set_min_margin",
		"min_margin": want,
	}); err != nil {
		a.report(fmt.Sprintf("margin command failed: %v", err))
	}
}

// iqMode reports whether the session is tuned to a quadrature mode.
func (a *AudioClient) iqMode() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return isIQMode(a.mode)
}

// MinMargin reports the reduced-depth IQ margin currently asked for.
func (a *AudioClient) MinMargin() int {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.minMargin
}

// SetSquelch sets the SNR gate. A threshold of 0 disables it.
func (a *AudioClient) SetSquelch(threshold int) {
	a.mu.Lock()
	a.squelch = threshold
	conn := a.conn
	ok := a.connected
	a.mu.Unlock()

	if !ok || conn == nil {
		return // applied on the next connect via the query string
	}
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteJSON(map[string]interface{}{
		"type":    "set_audio_gate",
		"min_snr": squelchToWire(threshold),
	}); err != nil {
		a.report(fmt.Sprintf("squelch command failed: %v", err))
	}
}

// SetDSP enables a server-side DSP insert, or disables it when filter is empty.
func (a *AudioClient) SetDSP(filter string) {
	a.mu.Lock()
	a.dspFilter = filter
	conn := a.conn
	ok := a.connected
	a.mu.Unlock()

	if !ok || conn == nil {
		return // applied on the next connect
	}
	a.sendDSP(conn, filter)
}

func (a *AudioClient) sendDSP(conn *websocket.Conn, filter string) {
	cmd := map[string]interface{}{"type": "set_dsp", "enabled": filter != ""}
	if filter != "" {
		cmd["filter"] = filter
	}
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteJSON(cmd); err != nil {
		a.report(fmt.Sprintf("DSP command failed: %v", err))
	}
}

// Tune retunes the existing channel in place, including across a change of
// channel sample rate. The server reuses the same radiod channel and rebuilds
// its Opus encoder when the rate changes, so no reconnect is needed.
func (a *AudioClient) Tune(freq float64, mode string, low, high int) {
	a.mu.Lock()
	a.freq, a.mode, a.bwLow, a.bwHigh = freq, mode, low, high
	conn := a.conn
	ok := a.connected
	a.mu.Unlock()

	if !ok || conn == nil {
		return // the new values are stored; the next connect will use them
	}

	// Same 10/s budget the spectrum socket uses. Commands are absolute, so a
	// dropped one is superseded by whatever the user does next.
	a.cmdMu.Lock()
	if !a.lastCommand.IsZero() && time.Since(a.lastCommand) < minCommandDelay {
		a.cmdMu.Unlock()
		return
	}
	a.lastCommand = time.Now()
	a.cmdMu.Unlock()

	cmd := map[string]interface{}{
		"type":          "tune",
		"frequency":     int64(freq + 0.5),
		"mode":          mode,
		"bandwidthLow":  low,
		"bandwidthHigh": high,
	}
	// The server keeps the radiod preset's bandwidth for the wide IQ modes and
	// ignores what a tune carries; leaving the edges out says the same thing
	// without asking for something that will not happen.
	if isWideIQMode(mode) {
		delete(cmd, "bandwidthLow")
		delete(cmd, "bandwidthHigh")
	}

	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := conn.WriteJSON(cmd); err != nil {
		a.report(fmt.Sprintf("tune failed: %v", err))
	}

	// A move into or out of an IQ mode changes what the margin means, so the
	// server is told here rather than leaving it holding the last mode's value.
	a.syncMargin()
}

func (a *AudioClient) Connected() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.connected
}

func (a *AudioClient) report(msg string) {
	select {
	case a.Status <- msg:
	default:
	}
}
