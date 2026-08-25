package olivia

import (
	"compress/gzip"
	"encoding/json"
	"io"
	"math"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The vectors in testdata were generated once by driving Pawel Jalocha's
// MFSK_Modulator, MFSK_Receiver and the primitives around them — the code
// fldigi carries in src/include/jalocha — and writing down what they produced.
// The generator lives in the commit that added this file; nothing here reads
// fldigi, and these tests must keep passing on a machine that has never had it.
//
// What is checked, in the order the signal meets it:
//
//   - the Gray mapping and the Hadamard transform, over the whole byte range
//     and over three deliberately awkward vectors, because both are part of the
//     code rather than of the implementation
//   - the synchroniser's integrating low-pass, whose stage ordering is easy to
//     get subtly wrong and impossible to notice afterwards
//   - the geometry every mode works out to, including the clamps that fire when
//     a wide mode is tuned too low
//   - and then the whole thing end to end: real Olivia audio in, the text that
//     was transmitted out.
//
// The FFT is checked against a naive DFT instead, since it is this port's own
// code rather than something that has to match the transmitter.

type vectors struct {
	BinaryCode []int `json:"binary_code"`
	GrayCode   []int `json:"gray_code"`
	FHT        []struct {
		In  []float64 `json:"in"`
		Out []float64 `json:"out"`
	} `json:"fht"`
	LowPass3 struct {
		Weight   float64   `json:"weight"`
		Feedback float64   `json:"feedback"`
		In       []float64 `json:"in"`
		Out      []float64 `json:"out"`
	} `json:"lowpass3"`
	Geometry []struct {
		Tones        int     `json:"tones"`
		BandwidthIn  int     `json:"bandwidth_in"`
		Bandwidth    int     `json:"bandwidth"`
		CenterHz     float64 `json:"center_hz"`
		SymbolLen    int     `json:"symbol_len"`
		SymbolSepar  int     `json:"symbol_separ"`
		FirstCarrier int     `json:"first_carrier"`
		SyncMargin   int     `json:"sync_margin"`
		Baud         float64 `json:"baud"`
		BlockPeriod  float64 `json:"block_period"`
	} `json:"geometry"`
	Audio []struct {
		Name             string  `json:"name"`
		File             string  `json:"file"`
		Tones            int     `json:"tones"`
		Bandwidth        int     `json:"bandwidth"`
		CenterHz         float64 `json:"center_hz"`
		SampleRate       int     `json:"sample_rate"`
		Format           string  `json:"format"`
		Samples          int     `json:"samples"`
		Sent             string  `json:"sent"`
		ReferenceDecoded string  `json:"reference_decoded"`
	} `json:"audio"`
}

func loadVectors(t *testing.T) *vectors {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "vectors.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	v := &vectors{}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	return v
}

// loadPCM reads one gzipped 8-bit vector and widens it to the int16 the
// decoder is fed in production. The vectors are stored at 8 bits purely for
// size; see the generator's note on why that costs the decoder nothing.
func loadPCM(t *testing.T, name string) []int16 {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", name+".gz"))
	if err != nil {
		t.Fatalf("open %s: %v", name, err)
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatalf("gunzip %s: %v", name, err)
	}
	defer zr.Close()
	raw, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	pcm := make([]int16, len(raw))
	for i, b := range raw {
		pcm[i] = int16(int8(b)) << 8
	}
	return pcm
}

func TestGrayCodeMatchesReference(t *testing.T) {
	v := loadVectors(t)
	if len(v.BinaryCode) != 256 || len(v.GrayCode) != 256 {
		t.Fatalf("expected 256 entries, got %d/%d", len(v.BinaryCode), len(v.GrayCode))
	}
	for i := 0; i < 256; i++ {
		if got := int(binaryCode(uint8(i))); got != v.BinaryCode[i] {
			t.Errorf("binaryCode(%d) = %d, reference %d", i, got, v.BinaryCode[i])
		}
		if got := int(grayCode(uint8(i))); got != v.GrayCode[i] {
			t.Errorf("grayCode(%d) = %d, reference %d", i, got, v.GrayCode[i])
		}
	}
	// The two must also be inverses, which the reference never states but the
	// demodulator relies on.
	for i := 0; i < 256; i++ {
		if got := binaryCode(grayCode(uint8(i))); int(got) != i {
			t.Fatalf("binaryCode(grayCode(%d)) = %d", i, got)
		}
	}
}

func TestFHTMatchesReference(t *testing.T) {
	v := loadVectors(t)
	if len(v.FHT) == 0 {
		t.Fatal("no FHT vectors")
	}
	for i, c := range v.FHT {
		data := append([]float64(nil), c.In...)
		fht(data, len(data))
		for j := range data {
			if math.Abs(data[j]-c.Out[j]) > 1e-9 {
				t.Fatalf("vector %d element %d: got %.17g, reference %.17g",
					i, j, data[j], c.Out[j])
			}
		}
	}
}

func TestLowPass3MatchesReference(t *testing.T) {
	v := loadVectors(t)
	lp := v.LowPass3
	if len(lp.In) == 0 {
		t.Fatal("no lowpass3 vector")
	}
	out1 := make([]float64, 1)
	out2 := make([]float64, 1)
	out := make([]float64, 1)
	for i, in := range lp.In {
		lowPass3(out1, out2, out, 0, in, lp.Weight, lp.Feedback)
		if math.Abs(out[0]-lp.Out[i]) > 1e-12 {
			t.Fatalf("step %d: got %.17g, reference %.17g", i, out[0], lp.Out[i])
		}
	}
}

func TestGeometryMatchesReference(t *testing.T) {
	v := loadVectors(t)
	if len(v.Geometry) == 0 {
		t.Fatal("no geometry vectors")
	}
	for _, g := range v.Geometry {
		cfg := DefaultConfig()
		cfg.Tones = g.Tones
		cfg.Bandwidth = g.BandwidthIn
		cfg.CenterFrequency = g.CenterHz
		d, err := New(cfg, 12000)
		if err != nil {
			t.Fatalf("%d/%d @ %.0f Hz: %v", g.Tones, g.BandwidthIn, g.CenterHz, err)
		}
		got := d.Geometry()
		label := func() string {
			return strings.TrimSpace(strings.Join([]string{
				"mode", itoa(g.Tones) + "/" + itoa(g.BandwidthIn),
				"@", ftoa(g.CenterHz), "Hz",
			}, " "))
		}
		if got.Bandwidth != g.Bandwidth {
			t.Errorf("%s: bandwidth %d, reference %d", label(), got.Bandwidth, g.Bandwidth)
		}
		if got.SymbolLen != g.SymbolLen {
			t.Errorf("%s: symbolLen %d, reference %d", label(), got.SymbolLen, g.SymbolLen)
		}
		if got.SymbolSepar != g.SymbolSepar {
			t.Errorf("%s: symbolSepar %d, reference %d", label(), got.SymbolSepar, g.SymbolSepar)
		}
		if got.FirstCarrier != g.FirstCarrier {
			t.Errorf("%s: firstCarrier %d, reference %d", label(), got.FirstCarrier, g.FirstCarrier)
		}
		// The clamp that fires when the tone block is tuned so low it runs into
		// DC; the reference reports it back through SyncMargin and so do we.
		if got.SyncMargin != g.SyncMargin {
			t.Errorf("%s: syncMargin %d, reference %d", label(), got.SyncMargin, g.SyncMargin)
		}
		if math.Abs(got.BaudRate-g.Baud) > 1e-9 {
			t.Errorf("%s: baud %.10g, reference %.10g", label(), got.BaudRate, g.Baud)
		}
		if math.Abs(got.BlockPeriod-g.BlockPeriod) > 1e-9 {
			t.Errorf("%s: blockPeriod %.10g, reference %.10g", label(), got.BlockPeriod, g.BlockPeriod)
		}
	}
}

// TestDecodeMatchesReference is the one that matters: real Olivia audio,
// generated by the reference transmitter, decoded by this port.
//
// The assertion is containment rather than equality, because that is honestly
// what Olivia does. It has no preamble, so the synchroniser is hunting across
// every block phase and frequency offset while the transmission is already
// running, and it prints whatever the winning candidate holds — which for the
// first block or two is noise that happened to clear the threshold. The
// reference does exactly the same on these vectors: its own decode of
// olivia_16_500 is "CSCCQ DE M0ABC K[\t", and the recorded reference output is
// kept alongside so the comparison can be seen rather than taken on trust.
func TestDecodeMatchesReference(t *testing.T) {
	v := loadVectors(t)
	if len(v.Audio) == 0 {
		t.Fatal("no audio vectors")
	}
	for _, c := range v.Audio {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			pcm := loadPCM(t, c.File)
			if len(pcm) != c.Samples {
				t.Fatalf("expected %d samples, got %d", c.Samples, len(pcm))
			}

			cfg := DefaultConfig()
			cfg.Tones = c.Tones
			cfg.Bandwidth = c.Bandwidth
			cfg.CenterFrequency = c.CenterHz
			// The reference generated these at its own default squelch.
			cfg.SyncThreshold = 3.2

			d, err := New(cfg, c.SampleRate)
			if err != nil {
				t.Fatalf("new decoder: %v", err)
			}
			var sb strings.Builder
			d.OnChar = func(r rune) { sb.WriteRune(r) }

			// In production the audio arrives in packets, not one slab, and the
			// resampler and symbol buffer have to survive the boundaries. Feed
			// it in uneven chunks so a bug there cannot hide.
			for off := 0; off < len(pcm); {
				n := 997
				if off+n > len(pcm) {
					n = len(pcm) - off
				}
				d.Feed(pcm[off : off+n])
				off += n
			}

			// The transmission ends inside the recording, so the last blocks
			// are still in the sync pipe; drain them the way the reference's
			// own Flush does before reading the result.
			d.Flush()

			got := sb.String()
			if !strings.Contains(got, c.Sent) {
				t.Fatalf("decode did not contain the transmitted text\n"+
					"  sent:      %q\n  decoded:   %q\n  reference: %q",
					c.Sent, got, c.ReferenceDecoded)
			}
			if st := d.Status(); !st.Synced {
				t.Errorf("decoder reported no sync after decoding %q", c.Sent)
			}
		})
	}
}

// A decoder fed nothing but noise must stay quiet. This is what the squelch is
// for, and it is the failure mode a threshold that is slightly too low
// produces: a console that slowly fills with plausible-looking rubbish.
func TestNoiseDoesNotPrint(t *testing.T) {
	cfg := DefaultConfig()
	d, err := New(cfg, 12000)
	if err != nil {
		t.Fatalf("new decoder: %v", err)
	}
	var n int
	d.OnChar = func(rune) { n++ }

	rng := rand.New(rand.NewSource(1))
	pcm := make([]int16, 12000)
	for sec := 0; sec < 30; sec++ {
		for i := range pcm {
			pcm[i] = int16(rng.NormFloat64() * 3000)
		}
		d.Feed(pcm)
	}
	// Not zero — the reference leaks the occasional block at any threshold, and
	// claiming otherwise would make this test a lie that fails on a new seed.
	// A handful of characters in thirty seconds is the noise floor; a stream is
	// a broken squelch.
	if n > 20 {
		t.Errorf("30 s of noise produced %d characters at threshold %.1f; "+
			"expected a handful at most", n, cfg.SyncThreshold)
	}
	t.Logf("30 s of noise produced %d characters", n)
}

// The defaults are inherited rather than invented, and three references
// disagree about some of them, so they are pinned here with their provenance.
// Anything that moves one of these should have to say why in a diff.
func TestDefaultsMatchTheReferences(t *testing.T) {
	cfg := DefaultConfig()

	// fldigi's, from configuration.h: OLIVIASMARGIN 8, OLIVIASINTEG 4,
	// OLIVIA8BIT true. The last is easy to get wrong by reading olivia.cxx's
	// unescape() and assuming the feature is off — it is the config default
	// that decides, and it is on.
	if cfg.SyncMargin != 8 {
		t.Errorf("SyncMargin = %d, fldigi's OLIVIASMARGIN is 8", cfg.SyncMargin)
	}
	if cfg.SyncIntegLen != 4 {
		t.Errorf("SyncIntegLen = %d, fldigi's OLIVIASINTEG is 4", cfg.SyncIntegLen)
	}
	if !cfg.EightBit {
		t.Error("EightBit is off; fldigi's OLIVIA8BIT defaults on")
	}
	if cfg.Reverse || cfg.Contestia {
		t.Error("Reverse and Contestia must default off")
	}

	// PhantomSDR-Plus's, which measured pure noise leaking blocks at about 3.1
	// and set the default just above the reference's 3.0 floor.
	if cfg.SyncThreshold != 4.0 {
		t.Errorf("SyncThreshold = %.2f, expected 4.0", cfg.SyncThreshold)
	}
	if cfg.CenterFrequency != 1000 {
		t.Errorf("CenterFrequency = %.0f, expected 1000", cfg.CenterFrequency)
	}

	// The one with no default to inherit: fldigi opens on 8/500, PhantomSDR on
	// 8/250, sdr-j on 32/1000. 8/250 is chosen because it is what the published
	// calling frequencies use, so the panel's frequency menu and its mode menu
	// agree out of the box.
	if cfg.Tones != 8 || cfg.Bandwidth != 250 {
		t.Errorf("default mode is %d/%d, expected 8/250 to match the calling frequencies",
			cfg.Tones, cfg.Bandwidth)
	}

	// And it has to be a mode the panel actually offers.
	found := false
	for _, m := range Modes {
		if m.Tones == cfg.Tones && m.Bandwidth == cfg.Bandwidth {
			found = true
			if !m.Standard {
				t.Error("the default mode should be one of the three standard ones")
			}
		}
	}
	if !found {
		t.Errorf("default mode %d/%d is not in Modes", cfg.Tones, cfg.Bandwidth)
	}

	// It must also build at its own default centre without the frequency search
	// clamping — the coarse-bin modes do clamp, and opening on one would ship a
	// decoder that only works if you are already tuned exactly right.
	d, err := New(DefaultConfig(), 12000)
	if err != nil {
		t.Fatalf("the default configuration does not build: %v", err)
	}
	if g := d.Geometry(); g.SyncMargin != cfg.SyncMargin {
		t.Errorf("the default mode clamps its search to %d bins of %d", g.SyncMargin, cfg.SyncMargin)
	}
}

// fldigi's quick-change menu, which is what the operator at the other end is
// picking from. Same eighteen, same order.
func TestModesMatchFldigiQuickChange(t *testing.T) {
	want := [][2]int{
		{4, 125}, {4, 250}, {4, 500}, {4, 1000}, {4, 2000},
		{8, 125}, {8, 250}, {8, 500}, {8, 1000}, {8, 2000},
		{16, 500}, {16, 1000}, {16, 2000},
		{32, 1000}, {32, 2000},
		{64, 500}, {64, 1000}, {64, 2000},
	}
	if len(Modes) != len(want) {
		t.Fatalf("offering %d modes, fldigi offers %d", len(Modes), len(want))
	}
	for i, w := range want {
		if Modes[i].Tones != w[0] || Modes[i].Bandwidth != w[1] {
			t.Errorf("mode %d is %d/%d, fldigi has %d/%d",
				i, Modes[i].Tones, Modes[i].Bandwidth, w[0], w[1])
		}
	}
}

func TestSyncThresholdClamps(t *testing.T) {
	d, err := New(DefaultConfig(), 12000)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ in, want float64 }{
		{0, SyncThresholdMin},
		{2.9, SyncThresholdMin},
		{5, 5},
		{99, SyncThresholdMax},
		{math.NaN(), SyncThresholdDefault},
	} {
		if got := d.SetSyncThreshold(c.in); got != c.want {
			t.Errorf("SetSyncThreshold(%v) = %v, want %v", c.in, got, c.want)
		}
		if got := d.SyncThreshold(); got != c.want {
			t.Errorf("SyncThreshold() after %v = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestRejectsModeThatDoesNotFit(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Tones = 64
	cfg.Bandwidth = 2000
	cfg.CenterFrequency = 3000 // tone block would run past the internal Nyquist bin
	if _, err := New(cfg, 12000); err == nil {
		t.Fatal("expected a mode that does not fit the passband to be refused")
	}
}

func itoa(v int) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func ftoa(v float64) string {
	b, _ := json.Marshal(v)
	return string(b)
}
