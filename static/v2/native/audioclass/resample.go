// resample.go — the windowed-sinc resampler, from ubersdr_airsplice
// (analysis_audio.go and analysis_stream.go), unchanged. The page hands the
// classifier audio at the stream's own rate (12 kHz on SSB, 24 kHz on AM and
// FM) and the model wants 32 kHz; resampling here rather than in the page keeps
// the browser on exactly the arithmetic the airsplice measurements were made
// with.
package main

import "math"

// resample converts x from one rate to another with a windowed-sinc filter
// (Blackman window, 16 zero crossings either side at the lower of the two
// Nyquist frequencies). Quality is ample for classification and speech
// recognition; it is not a mastering resampler. It is streamResampler fed
// everything at once.
func resample(x []float32, from, to int) []float32 {
	if from == to || len(x) == 0 {
		return x
	}
	r := newStreamResampler(from, to)
	out := r.push(x)
	return append(out, r.flush()...)
}

func sinc(x float64) float64 {
	if x == 0 {
		return 1
	}
	return math.Sin(math.Pi*x) / (math.Pi * x)
}

// blackman is the Blackman window over [-width, width], zero outside.
func blackman(t, width float64) float64 {
	if t <= -width || t >= width {
		return 0
	}
	u := (t + width) / (2 * width)
	return 0.42 - 0.5*math.Cos(2*math.Pi*u) + 0.08*math.Cos(4*math.Pi*u)
}

func gcd(a, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

// streamResampler is resample() fed in pieces: the same windowed-sinc filter,
// keeping the input history the next outputs need. Fed all at once and
// flushed, it produces exactly what resample() does.
type streamResampler struct {
	pass       bool
	up, down   int64
	half, taps int64
	table      [][]float32
	buf        []float32 // input from global index bufStart
	bufStart   int64
	inN, outN  int64
}

func newStreamResampler(from, to int) *streamResampler {
	if from == to {
		return &streamResampler{pass: true}
	}
	g := gcd(from, to)
	up, down := to/g, from/g
	r := math.Min(1, float64(to)/float64(from)) * 0.95
	const zeros = 16
	half := int(math.Ceil(zeros / r))
	taps := 2*half + 1
	table := make([][]float32, up)
	for p := 0; p < up; p++ {
		frac := float64(p) / float64(up)
		h := make([]float32, taps)
		var sum float64
		for k := 0; k < taps; k++ {
			t := float64(k-half) - frac
			v := r * sinc(r*t) * blackman(t, float64(half)+1)
			h[k] = float32(v)
			sum += v
		}
		for k := range h {
			h[k] = float32(float64(h[k]) / sum)
		}
		table[p] = h
	}
	return &streamResampler{up: int64(up), down: int64(down), half: int64(half), taps: int64(taps), table: table}
}

// push adds input and returns every output sample it completes.
func (s *streamResampler) push(x []float32) []float32 {
	if s.pass {
		return append([]float32(nil), x...)
	}
	s.buf = append(s.buf, x...)
	s.inN += int64(len(x))
	return s.emit(false)
}

// flush returns the outputs that need input past the end (taken as zero).
func (s *streamResampler) flush() []float32 {
	if s.pass {
		return nil
	}
	return s.emit(true)
}

func (s *streamResampler) emit(final bool) []float32 {
	var out []float32
	total := s.inN * s.up / s.down // outputs the whole input yields
	for s.outN < total {
		pos := s.outN * s.down
		base := pos / s.up
		if !final && base+s.half >= s.inN {
			break // needs input not yet seen
		}
		h := s.table[pos%s.up]
		start := base - s.half
		k0, k1 := int64(0), s.taps
		if start < 0 {
			k0 = -start
		}
		if start+s.taps > s.inN {
			k1 = s.inN - start
		}
		var v float32
		if k1 > k0 {
			i0 := start + k0 - s.bufStart
			v = f32Dot(h[k0:k1], s.buf[i0:i0+(k1-k0)])
		}
		out = append(out, v)
		s.outN++
	}
	// Drop input no future output reaches.
	next := (s.outN*s.down)/s.up - s.half
	if drop := next - s.bufStart; drop > 0 {
		drop = min(drop, int64(len(s.buf)))
		s.buf = append(s.buf[:0], s.buf[drop:]...)
		s.bufStart += drop
	}
	return out
}
