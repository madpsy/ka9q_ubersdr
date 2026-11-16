// efficientat.go — the EfficientAT AudioSet tagger, in Go, for the browser.
//
// Copied from ubersdr_airsplice (efficientat.go), which runs the same model on
// recorded segments; the network, its preprocessing and the voice/music/noise
// rules are unchanged so a verdict here means what one there does. What is
// different is around it: the weights arrive as bytes (the page fetches the
// copy committed beside the module, static/v2/audioclass/), the
// convolutions run on plain Go loops (f32simd.go — Go cannot emit WebAssembly
// SIMD), and there is no file-based segment classifier, only classifyWindow
// over whatever the caller hands it.
//
// EfficientAT (github.com/fschmid56/EfficientAT, MIT, Copyright (c) 2022
// Florian Schmid) is a family of MobileNetV3 audio taggers trained on AudioSet
// by knowledge distillation from transformers. mn05, mn10 and mn20 are its
// width-0.5, 1.0 and 2.0 models (AudioSet mAP .443, .471, .478 as
// published), about 1.4, 4.9 and 18 million parameters. NightDX used the AST
// transformer (mAP .459); mn10 matches it at a fraction of the cost.
//
// The weights are the official .pt release files, read here directly
// (ptfile.go) — no conversion step and no Python. BatchNorm is folded into the
// convolutions at load time.
//
// What this reproduces, from EfficientAT's models/preprocess.py and
// models/mn/*.py at inference (model.eval()):
//
//   - preprocessing: 32 kHz mono; pre-emphasis y[n] = x[n+1] - 0.97 x[n];
//     |STFT|^2 with n_fft 1024, a symmetric 800-sample Hann window centred in
//     it, hop 320, centre padding by reflection; 128 Kaldi mel bands over
//     0-15 kHz; log(mel + 1e-5); then (x + 4.5) / 5.
//   - network: a 3x3 stride-2 conv; 15 inverted-residual blocks (1x1
//     expansion, depthwise kxk, channel squeeze-excitation with a sigmoid gate
//     where the table says so, 1x1 projection, residual when shapes allow); a
//     1x1 conv to 6x the last width; global average pooling; Linear, hardswish,
//     Linear to 527 AudioSet logits; sigmoid.
package main

import (
	_ "embed"
	"encoding/csv"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
)

// The AudioSet class labels, in model output order (AudioSet ontology, Google,
// CC BY 4.0; as shipped in EfficientAT's metadata/class_labels_indices.csv).
//
//go:embed audioset_labels.csv
var audiosetLabelsCSV string

var (
	audiosetLabelsOnce sync.Once
	audiosetLabels     []string
)

func audiosetLabelNames() []string {
	audiosetLabelsOnce.Do(func() {
		rows, err := csv.NewReader(strings.NewReader(audiosetLabelsCSV)).ReadAll()
		if err != nil {
			panic("audioset_labels.csv: " + err.Error())
		}
		for _, r := range rows[1:] {
			audiosetLabels = append(audiosetLabels, r[2])
		}
	})
	return audiosetLabels
}

// eatWidths are the models by name: EfficientAT's v0.0.1 release files
// mn05_as_mAP_443.pt, mn10_as_mAP_471.pt and mn20_as_mAP_478.pt. The page uses
// mn05; the others load the same way and are what the reference test checks.
var eatWidths = map[string]float64{"mn05": 0.5, "mn10": 1.0, "mn20": 2.0}

const (
	eatRate   = 32000
	eatNFFT   = 1024
	eatWin    = 800
	eatHop    = 320
	eatMels   = 128
	eatFMax   = 15000 // EfficientAT's default: sr/2 - fmax_aug_range/2
	eatBNEps  = 0.001
	eatWindow = 10.0 // seconds per classification window, as NightDX used
)

const (
	actNone = iota
	actReLU
	actHardswish
)

// eatConv is a convolution with BatchNorm folded in: out = act(W*x + b).
type eatConv struct {
	cout, cin, k, stride int
	depthwise            bool
	w, b                 []float32 // w: [cout][cin][k][k] (cin = 1 when depthwise)
	act                  int
}

type eatSE struct {
	c, sq          int
	w1, b1, w2, b2 []float32 // w1: [sq][c], w2: [c][sq]
}

type eatBlock struct {
	expand   *eatConv
	dw       eatConv
	se       *eatSE
	project  eatConv
	residual bool
}

type eatModel struct {
	name     string
	first    eatConv
	blocks   []eatBlock
	last     eatConv
	fc1W     []float32 // [hidden][lastC]
	fc1B     []float32
	fc2W     []float32 // [527][hidden]
	fc2B     []float32
	hidden   int
	nClasses int
	threads  int
}

// fmap is a C x H x W feature map (H = frequency, W = time), row-major.
type fmap struct {
	c, h, w int
	d       []float32
}

func makeDivisible(v float64, divisor int) int {
	nv := int(v+float64(divisor)/2) / divisor * divisor
	if nv < divisor {
		nv = divisor
	}
	if float64(nv) < 0.9*v {
		nv += divisor
	}
	return nv
}

// The MobileNetV3-Large table EfficientAT uses (models/mn/model.py):
// input channels, kernel, expanded, output, squeeze-excitation, hardswish, stride.
var eatTable = [][7]int{
	{16, 3, 16, 16, 0, 0, 1},
	{16, 3, 64, 24, 0, 0, 2},
	{24, 3, 72, 24, 0, 0, 1},
	{24, 5, 72, 40, 1, 0, 2},
	{40, 5, 120, 40, 1, 0, 1},
	{40, 5, 120, 40, 1, 0, 1},
	{40, 3, 240, 80, 0, 1, 2},
	{80, 3, 200, 80, 0, 1, 1},
	{80, 3, 184, 80, 0, 1, 1},
	{80, 3, 184, 80, 0, 1, 1},
	{80, 3, 480, 112, 1, 1, 1},
	{112, 3, 672, 112, 1, 1, 1},
	{112, 5, 672, 160, 1, 1, 2},
	{160, 5, 960, 160, 1, 1, 1},
	{160, 5, 960, 160, 1, 1, 1},
}

// loadEfficientAT reads a .pt state dict and builds the model, checking every
// tensor's shape against the architecture.
func loadEfficientAT(pt []byte, name string, width float64, threads int) (*eatModel, error) {
	sd, err := readPtStateDict(pt)
	if err != nil {
		return nil, err
	}
	get := func(key string, shape ...int) ([]float32, error) {
		t, ok := sd[key]
		if !ok {
			return nil, fmt.Errorf("efficientat: %s missing", key)
		}
		if len(t.Shape) != len(shape) {
			return nil, fmt.Errorf("efficientat: %s has shape %v, want %v", key, t.Shape, shape)
		}
		for i := range shape {
			if t.Shape[i] != shape[i] {
				return nil, fmt.Errorf("efficientat: %s has shape %v, want %v", key, t.Shape, shape)
			}
		}
		return t.Data, nil
	}
	// convBN loads <p>.0.weight and the BatchNorm <p>.1.* and folds them.
	convBN := func(p string, cout, cin, k, stride int, depthwise bool, act int) (eatConv, error) {
		c := eatConv{cout: cout, cin: cin, k: k, stride: stride, depthwise: depthwise, act: act}
		wcin := cin
		if depthwise {
			wcin = 1
		}
		w, err := get(p+".0.weight", cout, wcin, k, k)
		if err != nil {
			return c, err
		}
		g, err := get(p+".1.weight", cout)
		if err != nil {
			return c, err
		}
		beta, err := get(p+".1.bias", cout)
		if err != nil {
			return c, err
		}
		mean, err := get(p+".1.running_mean", cout)
		if err != nil {
			return c, err
		}
		vr, err := get(p+".1.running_var", cout)
		if err != nil {
			return c, err
		}
		per := wcin * k * k
		c.w = make([]float32, len(w))
		c.b = make([]float32, cout)
		for o := 0; o < cout; o++ {
			s := float64(g[o]) / math.Sqrt(float64(vr[o])+eatBNEps)
			for i := 0; i < per; i++ {
				c.w[o*per+i] = float32(float64(w[o*per+i]) * s)
			}
			c.b[o] = float32(float64(beta[o]) - float64(mean[o])*s)
		}
		return c, nil
	}

	m := &eatModel{name: name, threads: max(1, threads)}
	adj := func(c int) int { return makeDivisible(float64(c)*width, 8) }
	if m.first, err = convBN("features.0", adj(16), 1, 3, 2, false, actHardswish); err != nil {
		return nil, err
	}
	for i, row := range eatTable {
		in, k, exp, out := adj(row[0]), row[1], adj(row[2]), adj(row[3])
		act := actReLU
		if row[5] == 1 {
			act = actHardswish
		}
		p := fmt.Sprintf("features.%d.block.", i+1)
		j := 0
		var b eatBlock
		if exp != in {
			c, err := convBN(fmt.Sprintf("%s%d", p, j), exp, in, 1, 1, false, act)
			if err != nil {
				return nil, err
			}
			b.expand = &c
			j++
		}
		if b.dw, err = convBN(fmt.Sprintf("%s%d", p, j), exp, exp, k, row[6], true, act); err != nil {
			return nil, err
		}
		j++
		if row[4] == 1 {
			sq := makeDivisible(float64(exp/4), 8)
			se := &eatSE{c: exp, sq: sq}
			sp := fmt.Sprintf("%s%d.conc_se_layers.0.", p, j)
			if se.w1, err = get(sp+"fc1.weight", sq, exp); err != nil {
				return nil, err
			}
			if se.b1, err = get(sp+"fc1.bias", sq); err != nil {
				return nil, err
			}
			if se.w2, err = get(sp+"fc2.weight", exp, sq); err != nil {
				return nil, err
			}
			if se.b2, err = get(sp+"fc2.bias", exp); err != nil {
				return nil, err
			}
			b.se = se
			j++
		}
		if b.project, err = convBN(fmt.Sprintf("%s%d", p, j), out, exp, 1, 1, false, actNone); err != nil {
			return nil, err
		}
		b.residual = row[6] == 1 && in == out
		m.blocks = append(m.blocks, b)
	}
	lastIn := adj(eatTable[len(eatTable)-1][3])
	lastC := 6 * lastIn
	if m.last, err = convBN(fmt.Sprintf("features.%d", len(eatTable)+1), lastC, lastIn, 1, 1, false, actHardswish); err != nil {
		return nil, err
	}
	m.hidden = adj(1280)
	m.nClasses = len(audiosetLabelNames())
	if m.fc1W, err = get("classifier.2.weight", m.hidden, lastC); err != nil {
		return nil, err
	}
	if m.fc1B, err = get("classifier.2.bias", m.hidden); err != nil {
		return nil, err
	}
	if m.fc2W, err = get("classifier.5.weight", m.nClasses, m.hidden); err != nil {
		return nil, err
	}
	if m.fc2B, err = get("classifier.5.bias", m.nClasses); err != nil {
		return nil, err
	}
	return m, nil
}

// ── preprocessing ───────────────────────────────────────────────────────────

var (
	eatMelOnce   sync.Once
	eatMelStart  []int       // first FFT bin of each mel band
	eatMelWeight [][]float32 // its weights, from that bin
	eatWindowFn  []float64   // the 800-sample window centred in 1024
)

// eatMelBanks is torchaudio.compliance.kaldi.get_mel_banks(128, 1024, 32000,
// 0, 15000, vtln 100/-500, warp 1.0): triangles on the 1127*ln(1+f/700) scale,
// over the 512 FFT bins below Nyquist (EfficientAT pads bin 512 with zero).
func eatMelBanks() {
	eatMelOnce.Do(func() {
		mel := func(f float64) float64 { return 1127 * math.Log(1+f/700) }
		lo, hi := mel(0), mel(eatFMax)
		delta := (hi - lo) / (eatMels + 1)
		binW := float64(eatRate) / eatNFFT
		for m := 0; m < eatMels; m++ {
			left, centre, right := lo+float64(m)*delta, lo+float64(m+1)*delta, lo+float64(m+2)*delta
			full := make([]float32, eatNFFT/2)
			start, end := -1, -1
			for i := range full {
				f := mel(binW * float64(i))
				up := (f - left) / (centre - left)
				down := (right - f) / (right - centre)
				if v := math.Max(0, math.Min(up, down)); v > 0 {
					full[i] = float32(v)
					if start < 0 {
						start = i
					}
					end = i
				}
			}
			if start < 0 { // cannot happen at 128 bands over 0-15 kHz; keep a valid slice
				start, end = 0, 0
			}
			eatMelStart = append(eatMelStart, start)
			eatMelWeight = append(eatMelWeight, full[start:end+1])
		}
		eatWindowFn = make([]float64, eatNFFT)
		off := (eatNFFT - eatWin) / 2
		for n := 0; n < eatWin; n++ { // torch.hann_window(800, periodic=False)
			eatWindowFn[off+n] = 0.5 - 0.5*math.Cos(2*math.Pi*float64(n)/float64(eatWin-1))
		}
	})
}

// eatMelSpec turns 32 kHz audio into the model's 1 x 128 x T input.
func eatMelSpec(x []float32) fmap {
	eatMelBanks()
	if len(x) < 2 {
		return fmap{c: 1, h: eatMels}
	}
	pre := make([]float64, len(x)-1)
	for i := range pre {
		pre[i] = float64(x[i+1]) - 0.97*float64(x[i])
	}
	n := len(pre)
	pad := eatNFFT / 2
	at := func(i int) float64 { // reflection padding
		for i < 0 || i >= n {
			if i < 0 {
				i = -i
			}
			if i >= n {
				i = 2*(n-1) - i
			}
		}
		return pre[i]
	}
	frames := 1 + n/eatHop
	out := fmap{c: 1, h: eatMels, w: frames, d: make([]float32, eatMels*frames)}
	buf := make([]complex128, eatNFFT)
	pw := make([]float32, eatNFFT/2+1)
	for t := 0; t < frames; t++ {
		s := t*eatHop - pad
		for i := 0; i < eatNFFT; i++ {
			v := 0.0
			if w := eatWindowFn[i]; w != 0 {
				v = at(s+i) * w
			}
			buf[i] = complex(v, 0)
		}
		fftRadix2(buf)
		for k := range pw {
			re, im := real(buf[k]), imag(buf[k])
			pw[k] = float32(re*re + im*im)
		}
		for m := 0; m < eatMels; m++ {
			st := eatMelStart[m]
			e := float64(f32Dot(eatMelWeight[m], pw[st:]))
			out.d[m*frames+t] = float32((math.Log(e+1e-5) + 4.5) / 5)
		}
	}
	return out
}

// ── network ─────────────────────────────────────────────────────────────────

func activate(d []float32, act int) {
	switch act {
	case actReLU:
		for i, v := range d {
			if v < 0 {
				d[i] = 0
			}
		}
	case actHardswish:
		for i, v := range d {
			switch {
			case v <= -3:
				d[i] = 0
			case v < 3:
				d[i] = v * (v + 3) / 6
			}
		}
	}
}

func convOut(n, k, stride int) int { return (n+2*((k-1)/2)-k)/stride + 1 }

// parallel runs fn(lo, hi) over [0, n) in up to `threads` chunks.
func parallel(n, threads int, fn func(lo, hi int)) {
	if threads <= 1 || n < 2*threads {
		fn(0, n)
		return
	}
	var wg sync.WaitGroup
	step := (n + threads - 1) / threads
	for lo := 0; lo < n; lo += step {
		hi := min(lo+step, n)
		wg.Add(1)
		go func(lo, hi int) { defer wg.Done(); fn(lo, hi) }(lo, hi)
	}
	wg.Wait()
}

// pointwise is a 1x1 convolution: a [cout x cin] matrix times [cin x H*W],
// four input channels per SIMD pass.
func (m *eatModel) pointwise(in fmap, c *eatConv) fmap {
	p := in.h * in.w
	out := fmap{c: c.cout, h: in.h, w: in.w, d: make([]float32, c.cout*p)}
	parallel(c.cout, m.threads, func(lo, hi int) {
		var w4 [4]float32
		for o := lo; o < hi; o++ {
			dst := out.d[o*p : (o+1)*p]
			bv := c.b[o]
			for i := range dst {
				dst[i] = bv
			}
			wr := c.w[o*c.cin : (o+1)*c.cin]
			i := 0
			for ; i+4 <= c.cin; i += 4 {
				w4 = [4]float32{wr[i], wr[i+1], wr[i+2], wr[i+3]}
				f32Axpy4(dst, in.d[i*p:(i+1)*p], in.d[(i+1)*p:(i+2)*p], in.d[(i+2)*p:(i+3)*p], in.d[(i+3)*p:(i+4)*p], &w4)
			}
			for ; i < c.cin; i++ {
				f32Axpy(dst, in.d[i*p:(i+1)*p], wr[i])
			}
			activate(dst, c.act)
		}
	})
	return out
}

// depthwise is a per-channel kxk convolution with "same" padding. At stride 1
// each kernel tap is an axpy along a row of time; stride 2 runs plain loops.
func (m *eatModel) depthwise(in fmap, c *eatConv) fmap {
	k, s, pad := c.k, c.stride, (c.k-1)/2
	oh, ow := convOut(in.h, k, s), convOut(in.w, k, s)
	out := fmap{c: in.c, h: oh, w: ow, d: make([]float32, in.c*oh*ow)}
	parallel(in.c, m.threads, func(lo, hi int) {
		for ch := lo; ch < hi; ch++ {
			src := in.d[ch*in.h*in.w : (ch+1)*in.h*in.w]
			dst := out.d[ch*oh*ow : (ch+1)*oh*ow]
			wk := c.w[ch*k*k : (ch+1)*k*k]
			bv := c.b[ch]
			for i := range dst {
				dst[i] = bv
			}
			for kh := 0; kh < k; kh++ {
				for kw := 0; kw < k; kw++ {
					wv := wk[kh*k+kw]
					for oy := 0; oy < oh; oy++ {
						iy := oy*s + kh - pad
						if iy < 0 || iy >= in.h {
							continue
						}
						row := src[iy*in.w : (iy+1)*in.w]
						drow := dst[oy*ow : (oy+1)*ow]
						// ox range with ix = ox*s + kw - pad inside the row
						ox0 := 0
						if kw < pad {
							ox0 = (pad - kw + s - 1) / s
						}
						num := in.w - 1 - kw + pad // largest ix allowed is in.w-1
						if num < 0 {
							continue
						}
						ox1 := ow
						if lim := num / s; lim+1 < ox1 {
							ox1 = lim + 1
						}
						if ox1 <= ox0 {
							continue
						}
						if s == 1 {
							f32Axpy(drow[ox0:ox1], row[ox0+kw-pad:], wv)
						} else {
							for ox := ox0; ox < ox1; ox++ {
								drow[ox] += wv * row[ox*s+kw-pad]
							}
						}
					}
				}
			}
			activate(dst, c.act)
		}
	})
	return out
}

// firstConv is the 3x3 stride-2 convolution from the single mel channel.
func (m *eatModel) firstConv(in fmap) fmap {
	c := &m.first
	oh, ow := convOut(in.h, 3, 2), convOut(in.w, 3, 2)
	out := fmap{c: c.cout, h: oh, w: ow, d: make([]float32, c.cout*oh*ow)}
	parallel(c.cout, m.threads, func(lo, hi int) {
		for o := lo; o < hi; o++ {
			dst := out.d[o*oh*ow : (o+1)*oh*ow]
			wk := c.w[o*9 : (o+1)*9]
			for oy := 0; oy < oh; oy++ {
				for ox := 0; ox < ow; ox++ {
					acc := c.b[o]
					for kh := 0; kh < 3; kh++ {
						iy := oy*2 + kh - 1
						if iy < 0 || iy >= in.h {
							continue
						}
						for kw := 0; kw < 3; kw++ {
							ix := ox*2 + kw - 1
							if ix < 0 || ix >= in.w {
								continue
							}
							acc += wk[kh*3+kw] * in.d[iy*in.w+ix]
						}
					}
					dst[oy*ow+ox] = acc
				}
			}
			activate(dst, c.act)
		}
	})
	return out
}

func (se *eatSE) apply(x fmap) {
	p := x.h * x.w
	mean := make([]float32, se.c)
	for ch := 0; ch < se.c; ch++ {
		var s float64
		for _, v := range x.d[ch*p : (ch+1)*p] {
			s += float64(v)
		}
		mean[ch] = float32(s / float64(p))
	}
	h := make([]float32, se.sq)
	for i := range h {
		v := f32Dot(se.w1[i*se.c:(i+1)*se.c], mean) + se.b1[i]
		if v < 0 {
			v = 0
		}
		h[i] = v
	}
	for ch := 0; ch < se.c; ch++ {
		g := f32Dot(se.w2[ch*se.sq:(ch+1)*se.sq], h) + se.b2[ch]
		scale := float32(1 / (1 + math.Exp(-float64(g))))
		d := x.d[ch*p : (ch+1)*p]
		for i := range d {
			d[i] *= scale
		}
	}
}

// predict returns the 527 AudioSet class probabilities for a mel spectrogram.
func (m *eatModel) predict(spec fmap) []float32 {
	x := m.firstConv(spec)
	for bi := range m.blocks {
		b := &m.blocks[bi]
		in := x
		if b.expand != nil {
			x = m.pointwise(x, b.expand)
		}
		x = m.depthwise(x, &b.dw)
		if b.se != nil {
			b.se.apply(x)
		}
		x = m.pointwise(x, &b.project)
		if b.residual {
			for i := range x.d {
				x.d[i] += in.d[i]
			}
		}
	}
	x = m.pointwise(x, &m.last)
	p := x.h * x.w
	pooled := make([]float32, x.c)
	for ch := range pooled {
		var s float64
		for _, v := range x.d[ch*p : (ch+1)*p] {
			s += float64(v)
		}
		pooled[ch] = float32(s / float64(p))
	}
	h := make([]float32, m.hidden)
	for i := range h {
		h[i] = f32Dot(m.fc1W[i*x.c:(i+1)*x.c], pooled) + m.fc1B[i]
	}
	activate(h, actHardswish)
	out := make([]float32, m.nClasses)
	for i := range out {
		z := f32Dot(m.fc2W[i*m.hidden:(i+1)*m.hidden], h) + m.fc2B[i]
		out[i] = float32(1 / (1 + math.Exp(-float64(z))))
	}
	return out
}

// ── from AudioSet tags to voice / music / noise (NightDX classify.py) ─────────

var nightdxVoiceLabels = map[string]bool{
	"Speech": true, "Male speech, man speaking": true, "Female speech, woman speaking": true,
	"Child speech, kid speaking": true, "Conversation": true, "Narration, monologue": true,
	"Speech synthesizer": true, "Babbling": true, "Whispering": true, "Chant": true, "Mantra": true,
}

var nightdxMusicHints = []string{"music", "singing", "song", "guitar", "piano", "drum", "orchestra",
	"violin", "flute", "trumpet", "choir", "synthesizer", "jingle",
	"instrument", "bass", "beat", "hip hop", "pop", "rock", "jazz", "a capella",
	"sitar", "tabla", "accordion", "organ", "harmonica", "saxophone", "chord"}

// Hum and buzz are deliberately absent (NightDX): they ride on top of a
// programme, and a channel of nothing but hum is noise anyway because no
// speech or music is found.
var nightdxNoiseLabels = map[string]bool{
	"Static": true, "Noise": true, "White noise": true, "Pink noise": true, "Hiss": true,
	"Environmental noise": true, "Silence": true, "Radio": true, "Sine wave": true,
	"Electronic tuner": true, "Beep, bleep": true, "Rumble": true, "Distortion": true, "Tick": true, "Clicking": true,
}

func isMusicLabel(l string) bool {
	ll := strings.ToLower(l)
	for _, h := range nightdxMusicHints {
		if strings.Contains(ll, h) {
			return true
		}
	}
	return false
}

// radioTag keeps the labels that mean something for radio (NightDX
// radio_tags): noisy shortwave also triggers "Vehicle" or "Insect", the
// model's guess at the noise.
func radioTag(l string) bool {
	ll := strings.ToLower(l)
	if nightdxVoiceLabels[l] || nightdxNoiseLabels[l] || isMusicLabel(l) {
		return true
	}
	switch ll {
	case "speech", "music", "static", "hum", "mains hum", "radio":
		return true
	}
	return false
}

type eatScore struct {
	label string
	score float32
}

// eatWindowVerdict folds one window's probabilities as NightDX folds the AST
// model's: the best voice, music and noise label among the top 40.
func eatWindowVerdict(probs []float32) (string, float64, []eatScore) {
	labels := audiosetLabelNames()
	idx := make([]int, len(probs))
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(a, b int) bool { return probs[idx[a]] > probs[idx[b]] })
	top := idx
	if len(top) > 40 {
		top = top[:40]
	}
	var v, m, z float64
	for _, i := range top {
		l, p := labels[i], float64(probs[i])
		if nightdxVoiceLabels[l] && p > v {
			v = p
		}
		if isMusicLabel(l) && p > m {
			m = p
		}
		if nightdxNoiseLabels[l] && p > z {
			z = p
		}
	}
	tags := make([]eatScore, 0, 5)
	for _, i := range top[:min(5, len(top))] {
		tags = append(tags, eatScore{labels[i], probs[i]})
	}
	best := math.Max(v, m)
	switch {
	case best < eatMinScore || z > 1.5*best:
		return "noise", math.Max(z, 1-best), tags
	case v >= m:
		return "voice", v, tags
	default:
		return "music", m, tags
	}
}

// eatMinScore is NightDX's floor: neither voice nor music this likely means noise.
const eatMinScore = 0.12
