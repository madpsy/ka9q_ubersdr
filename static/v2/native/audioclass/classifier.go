// classifier.go — what the page asks of the model: the receiver's audio
// streamed in at its own rate, and now and then a verdict on the last few
// seconds of it.
//
// The window is 5 s rather than airsplice's 10. Measured on airsplice's SSB
// recordings with mn05: 5 s windows agreed with the recording's label 98.6% of
// the time against 100% for 10 s, and the two that did not were each the last
// window of a recording; 3 s fell to 90% and 2 s to 84%, the misses being the
// pauses between words. False voice on FT8 was 1-2% at every length. The cost
// per second of audio is the same at any length, so 5 s halves the wait for no
// extra CPU. The page decides the window; this file only bounds it.
package main

import (
	"math"
	"time"
)

const (
	// maxWindowSec is the most audio kept: the longest window a caller may
	// ask for. Ten seconds is airsplice's window and the model's training clip
	// length; nothing the page does asks for more.
	maxWindowSec = 10
	// minWindowSec is the shortest window worth running the model on.
	minWindowSec = 1
	// silentRMS: a window quieter than this is not classified at all. About
	// -80 dBFS — far below any receiver's noise, so it only catches the
	// digital silence of a closed squelch or a muted stream, where the model
	// would spend its time telling us it heard nothing.
	silentRMS = 1e-4
)

// stream is the classifier's state between calls: the resampler for the
// current stream rate and the most recent audio at the model's 32 kHz.
type stream struct {
	model *eatModel
	rate  int
	rs    *streamResampler
	buf   []float32 // the newest audio at eatRate, oldest first
}

// reset starts over at a new stream rate, dropping everything held. The page
// calls it on every retune and mode change, so a verdict never spans two
// signals.
func (s *stream) reset(rate int) {
	s.rate = rate
	s.rs = nil
	if rate > 0 {
		s.rs = newStreamResampler(rate, eatRate)
	}
	s.buf = s.buf[:0]
}

// push adds audio at the current stream rate.
func (s *stream) push(x []float32) {
	if s.rs == nil || len(x) == 0 {
		return
	}
	s.buf = append(s.buf, s.rs.push(x)...)
	// Trimmed in steps rather than on every push, so the copy runs once per
	// ten seconds of audio rather than once per packet.
	keep := maxWindowSec * eatRate
	if len(s.buf) > 2*keep {
		s.buf = append(s.buf[:0], s.buf[len(s.buf)-keep:]...)
	}
}

// buffered is how many seconds of audio are held.
func (s *stream) buffered() float64 {
	return float64(len(s.buf)) / eatRate
}

// tagScore is one AudioSet label and the model's probability for it.
type tagScore struct {
	Label string  `json:"label"`
	Score float64 `json:"score"`
}

// windowResult is one verdict, as the page receives it.
type windowResult struct {
	// Label is voice, music or noise; or silent when the window held no
	// audio worth classifying and the model was not run.
	Label string `json:"label"`
	// Confidence is the winning group's probability (for noise, the larger
	// of the noise tags' and one minus the best of voice and music).
	Confidence float64 `json:"confidence"`
	// Tags are the strongest radio-relevant labels among the model's top
	// five, strongest first: "Speech", "Radio", "Static" and the like.
	Tags []tagScore `json:"tags"`
	// Seconds is the length of audio classified; Millis what it cost.
	Seconds float64 `json:"seconds"`
	Millis  float64 `json:"ms"`
}

// classify runs the model over the last `sec` seconds. ok is false when less
// than that is held: the caller asks again later.
func (s *stream) classify(sec float64) (res windowResult, ok bool) {
	sec = math.Max(minWindowSec, math.Min(maxWindowSec, sec))
	n := int(sec * eatRate)
	if s.model == nil || len(s.buf) < n {
		return res, false
	}
	return classifyWindow(s.model, s.buf[len(s.buf)-n:]), true
}

// classifyWindow is one verdict on x, which is at eatRate.
func classifyWindow(m *eatModel, x []float32) windowResult {
	res := windowResult{Seconds: float64(len(x)) / eatRate, Tags: []tagScore{}}
	var sum float64
	for _, v := range x {
		sum += float64(v) * float64(v)
	}
	if len(x) == 0 || math.Sqrt(sum/float64(len(x))) < silentRMS {
		res.Label = "silent"
		return res
	}
	t0 := time.Now()
	label, conf, tags := eatWindowVerdict(m.predict(eatMelSpec(x)))
	res.Millis = float64(time.Since(t0).Microseconds()) / 1000
	res.Label = label
	res.Confidence = math.Round(conf*1000) / 1000
	for _, t := range tags {
		if radioTag(t.label) {
			res.Tags = append(res.Tags, tagScore{t.label, math.Round(float64(t.score)*1000) / 1000})
		}
	}
	return res
}
