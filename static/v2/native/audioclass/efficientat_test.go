// Ported from ubersdr_airsplice's efficientat_test.go: the same .pt reader
// checks, the same NightDX fold, and the same comparison against an
// independent PyTorch run on the official weights (testdata/
// efficientat_golden.json), so this copy of the network is pinned to the
// reference rather than to airsplice. The SIMD-versus-Go test is gone with the
// SIMD; the stream tests at the bottom are this copy's own.
package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

// testdata/tiny_state_dict.pt was written by torch.save from a known state
// dict (see the values below), including an integer num_batches_tracked.
func TestReadPtStateDict(t *testing.T) {
	pt, err := os.ReadFile("testdata/tiny_state_dict.pt")
	if err != nil {
		t.Fatal(err)
	}
	sd, err := readPtStateDict(pt)
	if err != nil {
		t.Fatal(err)
	}
	w := sd["layer.weight"]
	if len(w.Shape) != 2 || w.Shape[0] != 2 || w.Shape[1] != 3 {
		t.Fatalf("layer.weight shape %v", w.Shape)
	}
	for i, v := range w.Data { // arange(6)/4 - 0.5
		if v != float32(i)/4-0.5 {
			t.Fatalf("layer.weight[%d] = %v", i, v)
		}
	}
	if b := sd["layer.bias"].Data; len(b) != 2 || b[0] != 1.5 || b[1] != -2.25 {
		t.Fatalf("layer.bias %v", b)
	}
	if s := sd["scalar"]; len(s.Shape) != 0 || len(s.Data) != 1 || s.Data[0] != 3 {
		t.Fatalf("scalar %+v", s)
	}
	big := sd["big.weight"]
	if big.numel() != 300 || big.Data[0] != -1 || big.Data[299] != 1 {
		t.Fatalf("big.weight %v ... %v", big.Data[0], big.Data[299])
	}
	if _, ok := sd["bn.num_batches_tracked"]; ok {
		t.Fatal("an integer tensor was returned as float")
	}
}

// Every byte of the weights file comes off the network: corruption must be an
// error, never a panic.
func TestReadPtRejectsCorruption(t *testing.T) {
	zr, err := zip.OpenReader("testdata/tiny_state_dict.pt")
	if err != nil {
		t.Fatal(err)
	}
	entries := map[string][]byte{}
	var names []string
	for _, f := range zr.File {
		b, _ := readZipFile(f)
		entries[f.Name] = b
		names = append(names, f.Name)
	}
	zr.Close()
	r := rand.New(rand.NewSource(1))
	write := func(mutate func(name string, b []byte) []byte) []byte {
		var buf bytes.Buffer
		zw := zip.NewWriter(&buf)
		for _, n := range names {
			w, _ := zw.CreateHeader(&zip.FileHeader{Name: n, Method: zip.Store})
			_, _ = w.Write(mutate(n, append([]byte(nil), entries[n]...)))
		}
		zw.Close()
		return buf.Bytes()
	}
	for i := 0; i < 400; i++ {
		p := write(func(name string, b []byte) []byte {
			if filepath.Base(name) != "data.pkl" || len(b) == 0 {
				return b
			}
			if i%4 == 0 {
				return b[:r.Intn(len(b))] // truncated
			}
			for k := 0; k < 3; k++ {
				b[r.Intn(len(b))] = byte(r.Intn(256))
			}
			return b
		})
		_, _ = readPtStateDict(p) // must not panic
	}
	if _, err := readPtStateDict([]byte("definitely not a zip")); err == nil {
		t.Fatal("garbage accepted")
	}
}

func TestMakeDivisible(t *testing.T) {
	for _, c := range []struct {
		v    float64
		want int
	}{{8, 8}, {36, 40}, {640, 640}, {1280, 1280}, {2560, 2560}, {120, 120}, {4, 8}, {60, 64}} {
		if got := makeDivisible(c.v, 8); got != c.want {
			t.Errorf("makeDivisible(%v) = %d, want %d", c.v, got, c.want)
		}
	}
}

func probsWith(vals map[string]float32) []float32 {
	labels := audiosetLabelNames()
	p := make([]float32, len(labels))
	for i, l := range labels {
		if v, ok := vals[l]; ok {
			p[i] = v
		} else {
			p[i] = 0.001
		}
	}
	return p
}

// NightDX's fold of AudioSet labels into voice / music / noise.
func TestEATWindowVerdict(t *testing.T) {
	if n := len(audiosetLabelNames()); n != 527 {
		t.Fatalf("%d AudioSet labels", n)
	}
	cases := []struct {
		probs map[string]float32
		want  string
	}{
		{map[string]float32{"Speech": 0.9, "Radio": 0.6}, "voice"},
		{map[string]float32{"Music": 0.8, "Guitar": 0.3}, "music"},
		{map[string]float32{"Speech": 0.3, "Music": 0.5}, "music"},
		{map[string]float32{"Speech": 0.08, "Music": 0.05}, "noise"},                    // neither reaches 0.12
		{map[string]float32{"Static": 0.6, "White noise": 0.5, "Speech": 0.3}, "noise"}, // noise > 1.5x voice
		{map[string]float32{"Hum": 0.9, "Speech": 0.4}, "voice"},                        // hum rides on the programme
	}
	for _, c := range cases {
		if got, _, _ := eatWindowVerdict(probsWith(c.probs)); got != c.want {
			t.Errorf("%v: %s, want %s", c.probs, got, c.want)
		}
	}
	if !radioTag("Male speech, man speaking") || !radioTag("Mains hum") || radioTag("Vehicle") || radioTag("Insect") {
		t.Error("radio tag filter")
	}
}

// committedWeights is the mn05 file the page is served, committed beside the
// module (static/v2/audioclass/).
const committedWeights = "../../audioclass/mn05_as_mAP_443.pt"

// eatModelFile is where a model's .pt file is: mn05 is committed, so it is
// always there; mn10 and mn20 only when AUDIOCLASS_EAT_MODELS names a
// directory holding them (they are 20 and 72 MB and the page does not use
// them).
func eatModelFile(name string) string {
	if dir := os.Getenv("AUDIOCLASS_EAT_MODELS"); dir != "" {
		return filepath.Join(dir, eatFiles[name])
	}
	if name == "mn05" {
		return committedWeights
	}
	return ""
}

// eatGoldenInput reproduces the input the golden outputs were computed from:
// the synthetic signals of analysis_test.go at 16 kHz, stored as a 16-bit WAV,
// resampled to 32 kHz, the first 10 s, stored as a 16-bit WAV again. A WAV
// round trip is floatToInt16 (x32767) on the way out and /32768 on the way in.
func eatGoldenInput(t *testing.T, name string) []float32 {
	var x []float32
	switch name {
	case "chords":
		x = chords(goldenRate, 20)
	case "noise":
		x = whiteNoise(goldenRate*20, 0.1, 1)
	}
	wavRoundTrip := func(v []float32) {
		for i, s := range v {
			v[i] = float32(floatToInt16(s)) / 32768
		}
	}
	wavRoundTrip(x)
	y := resample(x, goldenRate, eatRate)[:10*eatRate]
	wavRoundTrip(y)
	return y
}

// Golden outputs from an independent PyTorch implementation (torch.stft,
// torchaudio's Kaldi mel banks, F.conv2d / batch_norm / linear) on the
// official weights: testdata/efficientat_golden.json.
func TestEfficientATMatchesReference(t *testing.T) {
	raw, err := os.ReadFile("testdata/efficientat_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden map[string]json.RawMessage
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	for _, sig := range []string{"chords", "noise"} {
		spec := eatMelSpec(eatGoldenInput(t, sig))
		var shape []int
		var sum float64
		_ = json.Unmarshal(golden[sig+"/mel_shape"], &shape)
		_ = json.Unmarshal(golden[sig+"/mel_sum"], &sum)
		if spec.h != shape[0] || spec.w != shape[1] {
			t.Fatalf("%s mel %dx%d, reference %v", sig, spec.h, spec.w, shape)
		}
		var got float64
		for _, v := range spec.d {
			got += float64(v)
		}
		if math.Abs(got-sum) > 1e-4*math.Abs(sum)+0.1 {
			t.Errorf("%s mel sum %.3f, reference %.3f", sig, got, sum)
		}
		for _, name := range []string{"mn05", "mn10", "mn20"} {
			file := eatModelFile(name)
			if file == "" {
				continue
			}
			pt, err := os.ReadFile(file)
			if err != nil {
				t.Logf("%s: %v (skipped)", name, err)
				continue
			}
			m, err := loadEfficientAT(pt, name, eatWidths[name], 1)
			if err != nil {
				t.Fatal(err)
			}
			probs := m.predict(spec)
			var top [][2]float64
			_ = json.Unmarshal(golden[sig+"/"+name], &top)
			for _, e := range top {
				i, want := int(e[0]), e[1]
				// 5e-4: on amd64 the outputs agree to ~1e-5; on arm64 Go fuses
				// multiply-adds even in plain Go code, and the deepest model
				// (mn20) carries that to ~2e-4 on white noise. An error in the
				// port moves outputs by far more than this.
				if d := math.Abs(float64(probs[i]) - want); d > 5e-4 {
					t.Errorf("%s %s class %d (%s): %.6f, reference %.6f", sig, name, i, audiosetLabelNames()[i], probs[i], want)
				}
			}
		}
	}
}

// eatFiles are the official release file names, as airsplice pins them.
var eatFiles = map[string]string{
	"mn05": "mn05_as_mAP_443.pt",
	"mn10": "mn10_as_mAP_471.pt",
	"mn20": "mn20_as_mAP_478.pt",
}

// goldenRate is the rate airsplice analysed at, which the golden inputs were
// generated at before being resampled to the model's 32 kHz.
const goldenRate = 16000

// From airsplice's analysis_test.go and whisper.go: the synthetic signals the
// golden outputs were computed from, and the WAV round trip they went through.
func whiteNoise(n int, amp float64, seed int64) []float32 {
	r := rand.New(rand.NewSource(seed))
	x := make([]float32, n)
	for i := range x {
		x[i] = float32(amp * r.NormFloat64())
	}
	return x
}

// chords: sustained harmonic notes, changing every second — steady spectra.
func chords(rate int, secs float64) []float32 {
	notes := []float64{220, 261.6, 329.6, 392}
	n := int(float64(rate) * secs)
	x := make([]float32, n)
	for i := range x {
		tt := float64(i) / float64(rate)
		f0 := notes[int(tt)%len(notes)]
		var v float64
		for h := 1; h <= 6; h++ {
			v += math.Sin(2*math.Pi*f0*float64(h)*tt) / float64(h)
		}
		x[i] = float32(0.2 * v)
	}
	return x
}

func floatToInt16(v float32) int16 {
	x := v * 32767
	if x > 32767 {
		return 32767
	}
	if x < -32768 {
		return -32768
	}
	return int16(x)
}

// ── the stream the page drives ──────────────────────────────────────────────

// Audio pushed at the stream's rate comes out at the model's, and the ring
// keeps the newest maxWindowSec of it however much is pushed.
func TestStreamResamplesAndBounds(t *testing.T) {
	var s stream
	s.reset(12000)
	for i := 0; i < 300; i++ { // 30 s in 100 ms packets
		s.push(make([]float32, 1200))
	}
	if got := s.buffered(); got < maxWindowSec || got > 2*maxWindowSec+0.1 {
		t.Fatalf("buffered %.2f s after 30 s pushed", got)
	}
	// A retune drops everything: no verdict may span two signals.
	s.reset(24000)
	if s.buffered() != 0 {
		t.Fatalf("buffered %.2f s after reset", s.buffered())
	}
	s.push(make([]float32, 24000))
	// One second in at 24 kHz is 32000 samples out, less the filter's
	// half-length still waiting on input that has not arrived.
	if got := len(s.buf); got < 31000 || got > eatRate {
		t.Fatalf("%d samples at 32 kHz from one second at 24 kHz", got)
	}
}

// Too little audio is "ask again", and with no model nothing is claimed.
func TestStreamClassifyNeedsAudioAndModel(t *testing.T) {
	var s stream
	s.reset(12000)
	s.push(make([]float32, 12000*6))
	if _, ok := s.classify(5); ok {
		t.Fatal("classified without a model")
	}
	s.model = &eatModel{}
	if _, ok := s.classify(maxWindowSec); ok {
		t.Fatal("classified 10 s from 6 s of audio")
	}
}

// A closed squelch is digital silence: the model is not run for it, so a
// zero-valued model (which would panic in predict) is never reached.
func TestClassifyWindowSilenceSkipsModel(t *testing.T) {
	res := classifyWindow(&eatModel{}, make([]float32, 5*eatRate))
	if res.Label != "silent" || res.Millis != 0 {
		t.Fatalf("%+v", res)
	}
}

// The committed weights are the published file, byte for byte.
func TestCommittedWeightsArePinned(t *testing.T) {
	pt, err := os.ReadFile(committedWeights)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(pt)
	if len(pt) != 5878097 || hex.EncodeToString(sum[:]) != "97f00bb717ce957dbdf60c26d4de8b161dd7c2593fbe6424859fad7e5569fd7f" {
		t.Fatalf("%s: %d bytes, SHA-256 %x — not EfficientAT's v0.0.1 mn05_as_mAP_443.pt", committedWeights, len(pt), sum)
	}
}
