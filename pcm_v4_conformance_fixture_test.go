package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

// Generator for the conformance fixtures every client decoder is checked
// against: clients/*/testdata/pcmv4_stream.bin, pcmv4_scaled.bin and
// pcmv4_rice_edge.bin.
//
// These are the SERVER's encoder output, so anything that changes a coded byte
// -- the leak at predLeakShiftComplex did -- invalidates all of them at once.
// There was no generator in the tree when that happened and the streams had to
// be reconstructed from what the client tests assert about them; this exists so
// the next such change is a command rather than an archaeology exercise.
//
// Run it with:
//
//	GEN_FIXTURE=1 go test -run TestGenerateConformanceFixtures -v .
//
// It writes every copy of each fixture and prints the three hashes to paste
// into the client tests, which name them:
//
//	clients/hpsdr/test/run.sh        EXPECTED_SHA256, RICE_EDGE_SHA256, SCALED_SHA256
//	clients/soapy_driver/test/run.sh PCMV4_SHA256, PCMV4_RICE_EDGE_SHA256, PCMV4_SCALED_SHA256
//	clients/rtl_sdr/pcmv4_test.go    pcmv4ExpectedSHA, pcmv4ScaledSHA
//	clients/iq-recorder/pcmv4_test.go, clients/ubersdr-audio/pcmv4_test.go  pcmv4ExpectedSHA
//	clients/python/test_pcm_v4.py    EXPECTED_SHA
//
// The fixtures are committed rather than generated at test time on purpose: the
// point of them is that an INDEPENDENT implementation agrees with this one, and
// a client that regenerated its own input would only ever prove it agrees with
// itself.

// fixtureStart is where the fixtures' clocks begin. Any non-zero epoch would
// do; the client tests only require that timestamps are positive and never go
// backwards.
const fixtureStart = 1_700_000_000_000_000_000

// fixtureWriter accumulates packets in the layout every client's reader
// expects: "UV4F", a format byte, a uint32 packet count, then each packet as a
// uint32 length followed by that many bytes.
type fixtureWriter struct {
	packets [][]byte
}

func (w *fixtureWriter) add(pkt []byte) {
	c := make([]byte, len(pkt))
	copy(c, pkt)
	w.packets = append(w.packets, c)
}

func (w *fixtureWriter) bytes() []byte {
	out := []byte("UV4F")
	out = append(out, 0)
	out = binary.LittleEndian.AppendUint32(out, uint32(len(w.packets)))
	for _, p := range w.packets {
		out = binary.LittleEndian.AppendUint32(out, uint32(len(p)))
		out = append(out, p...)
	}
	return out
}

// fixtureDests are every copy of a given fixture name. A fixture that is not
// identical everywhere would let one client's decoder pass against an input no
// other client sees.
var fixtureDests = map[string][]string{
	"pcmv4_stream.bin": {
		"clients/hpsdr/test/testdata",
		"clients/soapy_driver/test/testdata",
		"clients/rtl_sdr/testdata",
		"clients/iq-recorder/testdata",
		"clients/ubersdr-audio/testdata",
		"clients/python/testdata",
	},
	"pcmv4_scaled.bin": {
		"clients/hpsdr/test/testdata",
		"clients/soapy_driver/test/testdata",
		"clients/rtl_sdr/testdata",
	},
	"pcmv4_rice_edge.bin": {
		"clients/hpsdr/test/testdata",
		"clients/soapy_driver/test/testdata",
	},
}

// fixtureSamples is the little-endian rendering of what the server's own
// decoder makes of a stream, which is what every client must reproduce.
func fixtureSamples(t *testing.T, packets [][]byte) []byte {
	t.Helper()
	dec := NewPCMv4StreamDecoder()
	var out []byte
	for i, pkt := range packets {
		_, samples, err := dec.DecodePacket(pkt)
		if err != nil {
			t.Fatalf("packet %d: the server cannot decode its own output: %v", i, err)
		}
		buf := make([]byte, 2*len(samples))
		for j, s := range samples {
			binary.LittleEndian.PutUint16(buf[2*j:], uint16(s))
		}
		out = append(out, buf...)
	}
	return out
}

func TestGenerateConformanceFixtures(t *testing.T) {
	if os.Getenv("GEN_FIXTURE") == "" {
		t.Skip("set GEN_FIXTURE=1 to regenerate the client conformance fixtures")
	}

	// The browser fixture has its own layout -- it interleaves each packet with
	// the samples it must decode to -- so it is written on its own rather than
	// through the loop below.
	writeBrowserFixture(t)
	writeCPUFixture(t)

	for _, f := range []struct {
		name  string
		build func(*testing.T) [][]byte
	}{
		{"pcmv4_stream.bin", buildStreamFixture},
		{"pcmv4_scaled.bin", buildScaledFixture},
		{"pcmv4_rice_edge.bin", buildRiceEdgeFixture},
	} {
		packets := f.build(t)
		w := &fixtureWriter{}
		for _, p := range packets {
			w.add(p)
		}
		blob := w.bytes()
		sum := sha256.Sum256(fixtureSamples(t, packets))

		for _, dir := range fixtureDests[f.name] {
			path := filepath.Join(dir, f.name)
			if err := os.WriteFile(path, blob, 0o644); err != nil {
				t.Fatalf("writing %s: %v", path, err)
			}
		}
		t.Logf("%-20s %d packets, %d bytes -> %s",
			f.name, len(packets), len(blob), hex.EncodeToString(sum[:]))
	}
}

// captureRun returns the first n packets of a capture as sample slices.
//
// The fixtures are built from real captured signal rather than generated tones
// for the reason testdata/pcm_predictive/README.md gives, and for one more that
// only appeared with the leak: a clean tone drives the audio cascade's taps to
// about 0.27, where real demodulated audio drives them past 1.7. Only the
// second exercises the leak at predLeakShiftReal at all, so a fixture made of
// tones would let a port that had left it out pass.
func captureRun(t *testing.T, name string, n int) [][]int16 {
	t.Helper()
	packets := loadTestCapture(t, name)
	if n > len(packets) {
		n = len(packets)
	}
	out := make([][]int16, n)
	for i := 0; i < n; i++ {
		out[i] = captureSamples(t, packets[i])
	}
	return out
}

// noiseBurst is a packet of full-scale white noise, which has nothing for a
// predictor to remove: the coded form comes out longer than the samples and the
// encoder sends them verbatim. It is how the fixtures reach the escape path,
// which no recording of ordinary traffic contains.
func noiseBurst(rng *rand.Rand, n int) []int16 {
	s := make([]int16, n)
	for i := range s {
		s[i] = int16(rng.Intn(65536) - 32768)
	}
	return s
}

// buildStreamFixture is the lossless stream. What it must contain is not a
// matter of taste: the client tests assert the exact sequence of (rate,
// channels) it passes through, that both predictor profiles appear, that at
// least one packet is silent and at least one takes the escape, and that a
// reader joining part-way recovers at a resynchronisation point.
func buildStreamFixture(t *testing.T) [][]byte {
	t.Helper()
	enc := NewPCMv4StreamEncoder()
	rng := rand.New(rand.NewSource(4))
	var out [][]byte
	ts := int64(fixtureStart)
	var step int64

	emit := func(samples []int16, rate, ch int) {
		raw := make([]byte, 2*len(samples))
		for i, s := range samples {
			binary.BigEndian.PutUint16(raw[2*i:], uint16(s))
		}
		pkt, err := enc.EncodePacket(raw, ts, rate, ch, -12.5, -70.25)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, append([]byte(nil), pkt...))
		if step > 0 {
			ts += step
			return
		}
		ts += int64(len(samples)) / int64(ch) * 1e9 / int64(rate)
	}

	// Phase one: demodulated 12 kHz audio, the real cascade, with a squelched
	// run in the middle that sends no body at all.
	for i, s := range captureRun(t, "usb-ft8-14074.bin", 120) {
		if i >= 60 && i < 66 {
			emit(make([]int16, len(s)), 12000, 1)
			continue
		}
		emit(s, 12000, 1)
	}

	// Phase two: the other audio rate, and the packet that forces the escape.
	for i, s := range captureRun(t, "am-14074.bin", 80) {
		if i == 40 {
			emit(noiseBurst(rng, len(s)), 24000, 1)
			continue
		}
		emit(s, 24000, 1)
	}

	// Phase three: 384 kHz interleaved I/Q, the complex predictor, on the band
	// whose carriers drove the drift this leak exists for. Some packets are
	// split in two so the sample count changes from packet to packet, which is
	// what makes the header's count necessary and what a decoder assuming a
	// fixed packet size would get away with everywhere else.
	//
	// The clock steps 400 ms a packet here rather than the 0.9 ms these carry:
	// a recording with gaps in it, which is also what puts a periodic
	// resynchronisation every thirteenth packet. A reader joining the stream
	// part-way needs one within a few packets to recover, and at the true rate a
	// continuous section this long would not have offered one at all.
	step = 400 * 1e6
	for i, s := range captureRun(t, "iq384-mw-carriers.bin", 120) {
		switch {
		case i == 60:
			emit(make([]int16, len(s)), 384000, 2)
		case i%7 == 3:
			// Split on a frame boundary; a complex profile consumes whole I/Q
			// frames and a half frame would desynchronise the predictor.
			half := (len(s) / 4) * 2
			emit(s[:half], 384000, 2)
			emit(s[half:], 384000, 2)
		default:
			emit(s, 384000, 2)
		}
	}
	return out
}

// buildScaledFixture is the reduced-depth mode. The client tests require every
// packet to be two-channel, both profiles to appear -- which means the margin
// has to go to lossless and back while the stream runs -- and the first packet
// to be a scaled resynchronisation point, since that is the one they truncate
// to check a missing shift byte is refused.
func buildScaledFixture(t *testing.T) [][]byte {
	t.Helper()
	cell := NewLossyMarginCell(20)
	enc := NewPCMv4StreamEncoderWithMarginCell(cell)
	rng := rand.New(rand.NewSource(7))
	var out [][]byte
	ts := int64(fixtureStart)
	const rate = 192000

	emit := func(samples []int16) {
		raw := make([]byte, 2*len(samples))
		for i, s := range samples {
			binary.BigEndian.PutUint16(raw[2*i:], uint16(s))
		}
		pkt, err := enc.EncodePacket(raw, ts, rate, 2, -8.0, -64.0)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, append([]byte(nil), pkt...))
		ts += int64(len(samples)) / 2 * 1e9 / rate
	}

	phase := 0.0
	iq := func(frames int, carrier, noise float64) []int16 {
		s := make([]int16, 2*frames)
		for j := 0; j < frames; j++ {
			s[2*j] = (clampSample(carrier*math.Cos(phase) + rng.NormFloat64()*noise))
			s[2*j+1] = (clampSample(carrier*math.Sin(phase) + rng.NormFloat64()*noise))
			phase += 2 * math.Pi * 17000 / rate
		}
		return s
	}

	// A margin the client moves while connected, which is what makes the shift
	// change from packet to packet rather than being a constant a decoder could
	// accidentally hard-code.
	for i := 0; i < 180; i++ {
		switch i {
		case 45:
			cell.Set(40)
		case 90:
			cell.Set(0) // lossless: the profile changes and the codec rebuilds
		case 135:
			cell.Set(15)
		}
		switch {
		case i == 60:
			emit(make([]int16, 2*360)) // silent: carries no shift byte either
		case i == 70:
			s := make([]int16, 2*360)
			for j := range s {
				s[j] = int16(rng.Intn(65536) - 32768)
			}
			emit(s) // escape, which in this profile still carries its shift
		default:
			emit(iq(360, 11000, 700))
		}
	}
	return out
}

// buildRiceEdgeFixture holds a codeword whose unary run is exactly 63 bits.
//
// Counted out of a full 64-bit accumulator that makes the decoder shift by 64,
// which Go defines as zero and C does not. The difference is silent: the
// accumulator keeps its bits, the packet decodes as noise, and the predictor
// adapts to the noise. It appears about once every quarter of a million packets
// on live IQ, so this searches for one rather than hoping a recording holds it.
func buildRiceEdgeFixture(t *testing.T) [][]byte {
	t.Helper()
	for seed := int64(0); seed < 4000; seed++ {
		if packets, ok := riceEdgeAttempt(seed); ok {
			t.Logf("rice edge: seed %d produced a 63-bit unary run", seed)
			return packets
		}
	}
	t.Fatal("no seed produced a 63-bit unary run; widen the search")
	return nil
}

// riceEdgeAttempt codes one short stream and reports whether any packet in it
// contains a quotient of exactly 63.
//
// The stream is quiet IQ with one sample driven to full scale: a large
// unpredicted value against a small k is what makes the unary run long, and
// tuning the outlier against the packet's own mean magnitude is what lands it
// on 63 exactly.
func riceEdgeAttempt(seed int64) ([][]byte, bool) {
	enc := NewPCMv4StreamEncoder()
	rng := rand.New(rand.NewSource(seed))
	var out [][]byte
	ts := int64(fixtureStart)
	const rate = 384000
	const frames = 240

	// One decoder for the whole stream: only a resynchronisation packet is
	// self-describing, so a fresh one per packet could not find the body at
	// all and the search would silently never match.
	hdr := NewPCMv4HeaderDecoder()

	found := false
	for i := 0; i < 40; i++ {
		s := make([]int16, 2*frames)
		for j := range s {
			s[j] = int16(rng.NormFloat64() * 40)
		}
		if i >= 20 {
			// One outlier, scaled by the attempt so successive seeds sweep the
			// ratio between it and the noise the packet's k is chosen from.
			amp := 300 + (seed%97)*300 + int64(i-20)*64
			if amp > 32767 {
				amp = 32767
			}
			s[2*(frames/2)] = int16(amp)
			s[2*(frames/2)+1] = int16(-amp)
		}
		raw := make([]byte, 2*len(s))
		for j, v := range s {
			binary.BigEndian.PutUint16(raw[2*j:], uint16(v))
		}
		pkt, err := enc.EncodePacket(raw, ts, rate, 2, -40, -90)
		if err != nil {
			return nil, false
		}
		out = append(out, append([]byte(nil), pkt...))
		ts += frames * 1e9 / rate
		if riceHasQuotient(hdr, pkt, 63) {
			found = true
		}
	}
	return out, found
}

// riceHasQuotient reports whether any residual in a packet's Rice body has the
// given unary quotient. It decodes the body with the server's own reader, so it
// asks the question in exactly the terms the encoder answered it.
func riceHasQuotient(hdr *PCMv4HeaderDecoder, pkt []byte, want uint32) bool {
	h, off, err := hdr.Decode(pkt)
	if err != nil || h.Silent || h.Escape || off >= len(pkt) {
		return false
	}
	body := pkt[off:]
	if h.Profile == PredProfileIQScaled {
		body = body[1:]
	}
	if len(body) < 1 {
		return false
	}
	k := uint(body[0])
	if k > 30 {
		return false
	}
	res := make([]int32, h.SampleCount)
	if err := riceDecodeResiduals(body, res); err != nil {
		return false
	}
	for _, v := range res {
		if predZigzag(v)>>k == want {
			return true
		}
	}
	return false
}

// writeBrowserFixture rewrites static/v2/test/pcmv4.sample.bin, which the
// browser decoder is checked against by static/v2/test/pcmv4.test.js.
//
// Its layout is not the one the native clients read: each packet is followed
// immediately by the samples it must produce, as
//
//	[packet length u32][sample count u32][packet][expected samples int16 LE]
//
// which is what lets the JavaScript test name the packet AND the sample that
// first disagreed. pcmv4scaled.sample.bin beside it has the same shape and its
// own generator in pcm_lossy_fixture_test.go.
//
// What the stream has to contain is set by that test: over a thousand packets
// and over half a million samples, all three body modes, a profile change
// part-way through, a resynchronisation point somewhere between packets 41 and
// 400 so a decoder joining at 40 can be shown to recover, and both real signal
// quality readings and the -999 sentinel that means the receiver reported none.
func writeBrowserFixture(t *testing.T) {
	t.Helper()
	enc := NewPCMv4StreamEncoder()
	dec := NewPCMv4StreamDecoder()
	rng := rand.New(rand.NewSource(11))
	ts := int64(fixtureStart)

	var out []byte
	packets := 0
	samples := 0

	emit := func(s []int16, rate, ch int, power, noise float32) {
		raw := make([]byte, 2*len(s))
		for i, v := range s {
			binary.BigEndian.PutUint16(raw[2*i:], uint16(v))
		}
		pkt, err := enc.EncodePacket(raw, ts, rate, ch, power, noise)
		if err != nil {
			t.Fatal(err)
		}
		// Store what the SERVER's decoder makes of it, not the input. The two
		// are the same on this lossless path, and taking the decoder's word for
		// it means the fixture cannot claim a reconstruction the server itself
		// does not produce.
		_, got, err := dec.DecodePacket(pkt)
		if err != nil {
			t.Fatalf("the server cannot decode its own output: %v", err)
		}
		out = binary.LittleEndian.AppendUint32(out, uint32(len(pkt)))
		out = binary.LittleEndian.AppendUint32(out, uint32(len(got)))
		out = append(out, pkt...)
		for _, v := range got {
			out = binary.LittleEndian.AppendUint16(out, uint16(v))
		}
		ts += int64(len(s)) / int64(ch) * 1e9 / int64(rate)
		packets++
		samples += len(got)
	}

	// Every fourth packet carries no reading, which is what a receiver that has
	// not measured yet sends. The rest carry a power and noise that move, so a
	// decoder that latched the first pair would be caught.
	quality := func(i int) (float32, float32) {
		if i%4 == 3 {
			return -999, -999
		}
		return float32(-40 + math.Sin(float64(i)/50)*8), float32(-95 + math.Cos(float64(i)/70)*4)
	}

	// Demodulated audio at 12 kHz: 40 ms a packet, so the five-second
	// resynchronisation lands on packet 125 and a decoder joining at 40
	// recovers there. The silent run is a closed squelch and the noise burst
	// forces the escape.
	for i, s := range captureRun(t, "usb-ft8-14074.bin", 600) {
		p, n := quality(i)
		switch {
		case i >= 200 && i < 212:
			emit(make([]int16, len(s)), 12000, 1, p, n)
		case i == 250:
			emit(noiseBurst(rng, len(s)), 12000, 1, p, n)
		default:
			emit(s, 12000, 1, p, n)
		}
	}

	// Then interleaved I/Q, which changes the channel count and so rebuilds the
	// predictor into its complex form mid-stream -- the wire shape of a mode
	// change, and the only thing in the stream that exercises the other profile.
	for i, s := range captureRun(t, "iq384-mw-carriers.bin", 600) {
		p, n := quality(i)
		if i == 400 {
			emit(make([]int16, len(s)), 384000, 2, p, n)
			continue
		}
		emit(s, 384000, 2, p, n)
	}

	path := filepath.Join("static", "v2", "test", "pcmv4.sample.bin")
	if err := os.WriteFile(path, out, 0o644); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
	t.Logf("%-20s %d packets, %d samples, %d bytes", "pcmv4.sample.bin", packets, samples, len(out))
}

// writeCPUFixture rewrites static/v2/test/pcmcpu.sample.bin, which
// static/v2/test/pcmcpu.test.js uses to compare the two decoders' cost and,
// before timing anything, to check they return the same audio.
//
// Every packet is therefore stored twice, once in each format, from the same
// samples:
//
//	[v3 length u32][v4 length u32][sample count u32][stream id u32][v3][v4]
//
// It has to be regenerated alongside the others: the v4 half is this encoder's
// output and the test compares it against the v3 half sample for sample, so a
// stale v4 half fails as a decoder disagreement rather than as a stale fixture.
func writeCPUFixture(t *testing.T) {
	t.Helper()
	var out []byte
	packets := 0

	for id, c := range []struct {
		file    string
		rate    int
		ch      int
		packets int
	}{
		{"usb-ft8-14074.bin", 12000, 1, 600},
		{"am-14074.bin", 24000, 1, 600},
		{"iq12k-ft8-14074.bin", 12000, 2, 600},
	} {
		// A stream each, as a connection would: both encoders carry state
		// across packets, so they are created per stream and never reused.
		v3 := NewPCMBinaryEncoderWithVersion(true, 3)
		v4 := NewPCMv4StreamEncoder()
		ts := int64(fixtureStart)

		for _, s := range captureRun(t, c.file, c.packets) {
			raw := make([]byte, 2*len(s))
			for i, v := range s {
				binary.BigEndian.PutUint16(raw[2*i:], uint16(v))
			}
			a, err := v3.EncodePCMPacketWithSignalQuality(raw, ts, c.rate, c.ch, -30, -85, false)
			if err != nil {
				t.Fatal(err)
			}
			b, err := v4.EncodePacket(raw, ts, c.rate, c.ch, -30, -85)
			if err != nil {
				t.Fatal(err)
			}
			out = binary.LittleEndian.AppendUint32(out, uint32(len(a)))
			out = binary.LittleEndian.AppendUint32(out, uint32(len(b)))
			out = binary.LittleEndian.AppendUint32(out, uint32(len(s)))
			out = binary.LittleEndian.AppendUint32(out, uint32(id))
			out = append(out, a...)
			out = append(out, b...)
			ts += int64(len(s)) / int64(c.ch) * 1e9 / int64(c.rate)
			packets++
		}
	}

	path := filepath.Join("static", "v2", "test", "pcmcpu.sample.bin")
	if err := os.WriteFile(path, out, 0o644); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
	t.Logf("%-20s %d packets, %d bytes", "pcmcpu.sample.bin", packets, len(out))
}
