package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

// Generator for the WebAssembly decoder's fixtures in
// static/v2/native/pcmv4/testdata/.
//
// The browser already has one server-made fixture, static/v2/test/
// pcmv4.sample.bin, and the WebAssembly decoder is checked against that too.
// It is not enough on its own for a port whose whole job is speed: it holds one
// audio capture and one IQ capture, while the cost and the corner cases of the
// complex kernel differ between a busy band, a band of strong carriers (long
// unary runs, the widest residuals any real signal produces) and an empty one,
// and the real cascade behaves differently on every demodulator. So this codes
// every capture in testdata/pcm_predictive through the SERVER's encoder, with
// the escape and silent bodies forced into each so that every profile meets
// all three body modes, plus a stream that changes profile twice part-way.
//
// The packets are the server's; nothing is hand-built. What is stored beside
// them is not the decoded audio -- that would double the size of a fixture set
// meant to stay small -- but a SHA-256 of what the server's own decoder makes
// of each stream, which the browser test reproduces from the JavaScript
// decoder's output. The WebAssembly decoder is then held to the JavaScript one
// bit for bit, Float32 plane against Float32 plane.
//
// Run it with:
//
//	GEN_WASM_FIXTURE=1 go test -short -run TestGenerateWasmFixtures -v .
//
// It skips otherwise, so it never runs in an ordinary test pass.

// wasmFixtureDir is where the fixtures are written, beside the decoder.
var wasmFixtureDir = filepath.Join("static", "v2", "native", "pcmv4", "testdata")

// wasmFixtureStream is one fixture file's entry in the manifest.
type wasmFixtureStream struct {
	File     string `json:"file"`
	Desc     string `json:"desc"`
	Profiles []int  `json:"profiles"`
	Packets  int    `json:"packets"`
	Samples  int    `json:"samples"`
	Rice     int    `json:"rice"`
	Escape   int    `json:"escape"`
	Silent   int    `json:"silent"`
	// ServerSHA256 is the hash of the server decoder's output for the whole
	// stream, as little-endian int16. A scaled stream's samples are the
	// server's lossyRestore, which saturates at full scale.
	ServerSHA256 string `json:"serverSha256"`
}

// wasmFixtureBuilder codes one stream through a single encoder, as one
// connection would, and keeps the server decoder's reading of it in step.
type wasmFixtureBuilder struct {
	t       *testing.T
	enc     *PCMv4StreamEncoder
	dec     *PCMv4StreamDecoder
	ts      int64
	w       fixtureWriter
	hash    []byte
	entry   wasmFixtureStream
	profile map[int]bool
	n       int
}

func newWasmFixtureBuilder(t *testing.T, file, desc string, enc *PCMv4StreamEncoder) *wasmFixtureBuilder {
	return &wasmFixtureBuilder{
		t:       t,
		enc:     enc,
		dec:     NewPCMv4StreamDecoder(),
		ts:      fixtureStart,
		entry:   wasmFixtureStream{File: file, Desc: desc},
		profile: map[int]bool{},
	}
}

// emit codes one packet. The quality readings move, and every fifth packet has
// none, so the header's quality field is both sent and left out and carries
// the -999 sentinel; the clock advances by the packet's true duration, so the
// 12 and 24 kHz streams cross the five-second resynchronisation several times.
func (b *wasmFixtureBuilder) emit(s []int16, rate, ch int) {
	b.t.Helper()
	raw := make([]byte, 2*len(s))
	for i, v := range s {
		binary.BigEndian.PutUint16(raw[2*i:], uint16(v))
	}
	power := float32(-40 + math.Sin(float64(b.n)/40)*9)
	noise := float32(-96 + math.Cos(float64(b.n)/60)*3)
	if b.n%5 == 4 {
		power, noise = -999, -999
	}
	pkt, err := b.enc.EncodePacket(raw, b.ts, rate, ch, power, noise)
	if err != nil {
		b.t.Fatal(err)
	}
	b.w.add(pkt)
	h, got, err := b.dec.DecodePacket(pkt)
	if err != nil {
		b.t.Fatalf("%s packet %d: the server cannot decode its own output: %v", b.entry.File, b.n, err)
	}
	for _, v := range got {
		b.hash = binary.LittleEndian.AppendUint16(b.hash, uint16(v))
	}
	b.profile[int(h.Profile)] = true
	switch {
	case h.Silent:
		b.entry.Silent++
	case h.Escape:
		b.entry.Escape++
	default:
		b.entry.Rice++
	}
	b.entry.Samples += len(got)
	b.ts += int64(len(s)) / int64(ch) * 1e9 / int64(rate)
	b.n++
}

func (b *wasmFixtureBuilder) finish() wasmFixtureStream {
	b.t.Helper()
	path := filepath.Join(wasmFixtureDir, b.entry.File)
	if err := os.WriteFile(path, b.w.bytes(), 0o644); err != nil {
		b.t.Fatalf("writing %s: %v", path, err)
	}
	sum := sha256.Sum256(b.hash)
	b.entry.ServerSHA256 = hex.EncodeToString(sum[:])
	b.entry.Packets = b.n
	for p := 0; p < 8; p++ {
		if b.profile[p] {
			b.entry.Profiles = append(b.entry.Profiles, p)
		}
	}
	b.t.Logf("%-22s %4d packets %7d samples  rice %4d escape %2d silent %2d  profiles %v",
		b.entry.File, b.entry.Packets, b.entry.Samples, b.entry.Rice, b.entry.Escape, b.entry.Silent, b.entry.Profiles)
	return b.entry
}

func TestGenerateWasmFixtures(t *testing.T) {
	if os.Getenv("GEN_WASM_FIXTURE") == "" {
		t.Skip("set GEN_WASM_FIXTURE=1 to regenerate static/v2/native/pcmv4/testdata")
	}
	if err := os.MkdirAll(wasmFixtureDir, 0o755); err != nil {
		t.Fatal(err)
	}
	rng := rand.New(rand.NewSource(1999))
	var manifest []wasmFixtureStream

	// One capture, coded losslessly, with a squelched run and a full-scale
	// noise packet -- the only way real traffic reaches the escape -- at fixed
	// places. split cuts every seventh packet in two on a frame boundary so the
	// header's sample count changes mid-stream, as it does on the wire.
	plain := func(file, capture, desc string, packets, rate, ch int, split bool) {
		b := newWasmFixtureBuilder(t, file, desc, NewPCMv4StreamEncoder())
		for i, s := range captureRun(t, capture, packets) {
			switch {
			case i >= packets/3 && i < packets/3+4:
				b.emit(make([]int16, len(s)), rate, ch)
			case i == packets/2 || i == packets/2+1:
				b.emit(noiseBurst(rng, len(s)), rate, ch)
			case split && i%7 == 3:
				half := (len(s) / 4) * 2
				b.emit(s[:half], rate, ch)
				b.emit(s[half:], rate, ch)
			default:
				b.emit(s, rate, ch)
			}
		}
		manifest = append(manifest, b.finish())
	}

	// Profile 0. iq12k is the IQ mode the browser actually offers; the three
	// 384 kHz captures are the throughput case and its extremes. They are cut
	// to 300 packets (a quarter of a second each) to keep the set small.
	plain("iq12k-ft8.v4", "iq12k-ft8-14074.bin", "iq 12 kHz, FT8 band", 600, 12000, 2, false)
	plain("iq384-ft8.v4", "iq384-ft8-14074.bin", "iq384, busy FT8 band", 300, 384000, 2, false)
	plain("iq384-mw-carriers.v4", "iq384-mw-carriers.bin", "iq384, medium-wave carriers: long unary runs; split packets", 300, 384000, 2, true)
	plain("iq384-quiet-band.v4", "iq384-quiet-band.bin", "iq384, empty band: nearly white", 300, 384000, 2, false)

	// Profile 1, every demodulator in the capture set.
	plain("usb-ft8.v4", "usb-ft8-14074.bin", "usb 12 kHz, FT8", 600, 12000, 1, true)
	plain("lsb-voice.v4", "lsb-voice-7150.bin", "lsb 12 kHz, voice", 600, 12000, 1, false)
	plain("cw.v4", "cw-14025.bin", "cwu 12 kHz, narrow tone", 600, 12000, 1, false)
	plain("am.v4", "am-14074.bin", "am 24 kHz", 600, 24000, 1, false)
	plain("nfm.v4", "nfm-14074.bin", "nfm 24 kHz, near full scale", 600, 24000, 1, false)

	// Profile 2, the reduced-depth mode, on real 384 kHz IQ. The margin moves
	// while the stream runs, so the shift changes from packet to packet, and
	// goes to zero and back, which switches the profile 2 -> 0 -> 2 and
	// rebuilds the predictor each time.
	{
		cell := NewLossyMarginCell(20)
		b := newWasmFixtureBuilder(t, "iq384-scaled.v4", "iq384 reduced depth; profile 2 -> 0 -> 2", NewPCMv4StreamEncoderWithMarginCell(cell))
		for i, s := range captureRun(t, "iq384-ft8-14074.bin", 300) {
			switch i {
			case 60:
				cell.Set(40)
			case 150:
				cell.Set(0)
			case 200:
				cell.Set(10)
			}
			switch i {
			case 40, 41, 42:
				b.emit(make([]int16, len(s)), 384000, 2)
			case 80, 170, 250:
				b.emit(noiseBurst(rng, len(s)), 384000, 2)
			default:
				b.emit(s, 384000, 2)
			}
		}
		manifest = append(manifest, b.finish())
	}

	// A mode change on the wire: audio, then IQ, then audio at the other rate.
	// The channel count changes each time, so the server rebuilds its predictor
	// and the decoder must follow the profile in the packet.
	{
		b := newWasmFixtureBuilder(t, "mixed-modes.v4", "usb -> iq12k -> am: profile 1 -> 0 -> 1", NewPCMv4StreamEncoder())
		for _, s := range captureRun(t, "lsb-voice-7150.bin", 150) {
			b.emit(s, 12000, 1)
		}
		for i, s := range captureRun(t, "iq12k-ft8-14074.bin", 150) {
			if i == 75 {
				b.emit(make([]int16, len(s)), 12000, 2)
				continue
			}
			b.emit(s, 12000, 2)
		}
		for _, s := range captureRun(t, "am-14074.bin", 150) {
			b.emit(s, 24000, 1)
		}
		manifest = append(manifest, b.finish())
	}

	js, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(wasmFixtureDir, "manifest.json")
	if err := os.WriteFile(path, append(js, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}
