package sstv

import (
	"math"
	"math/rand"
	"testing"
	"time"
)

// tone is one stretch of a transmission: a frequency held for a time.
type tone struct {
	hz  float64
	sec float64
}

// fskIDTones is an FSK ID as QSSTV's sendFSKID and MMSSTV's OutputFSKID send
// it: 300 ms of 1500 Hz, 100 ms of 2100 Hz, a 1900 Hz start bit, then 0x2A,
// the callsign (each character minus 0x20), 0x01 and the XOR of the
// callsign's symbols — six 22 ms bits each, low bit first, 1900 Hz a 1 and
// 2100 Hz a 0 — and 100 ms of 1900 Hz after.
func fskIDTones(call string, late float64) []tone {
	t := []tone{{1500, 0.3 + late}, {2100, 0.1}, {1900, 0.022}}
	sym := func(v byte) {
		for b := 0; b < 6; b++ {
			hz := 2100.0
			if v>>b&1 == 1 {
				hz = 1900
			}
			t = append(t, tone{hz, 0.022})
		}
	}
	sym(0x2a)
	var x byte
	for i := 0; i < len(call); i++ {
		v := call[i] - 0x20
		x ^= v
		sym(v)
	}
	sym(0x01)
	sym(x & 0x3f)
	return append(t, tone{1900, 0.1})
}

// robot36Tones is a Robot 36 transmission, VIS header and all, whose picture
// is a plain grey: what the FSK ID after it is found from is the timing.
func robot36Tones() []tone {
	t := []tone{{1900, 0.3}, {1200, 0.01}, {1900, 0.3}, {1200, 0.03}}
	const vis = 0x08
	parity := 0
	for b := 0; b < 7; b++ {
		bit := vis >> b & 1
		parity ^= bit
		hz := 1300.0
		if bit == 1 {
			hz = 1100
		}
		t = append(t, tone{hz, 0.03})
	}
	hz := 1300.0
	if parity == 1 {
		hz = 1100
	}
	t = append(t, tone{hz, 0.03}, tone{1200, 0.03})
	for y := 0; y < 240; y++ {
		t = append(t, tone{1200, 9e-3}, tone{1900, 141e-3})
	}
	return t
}

// synthTones renders tones at rate, phase-continuous, after `lead` seconds of
// silence and with `tail` seconds of silence after; with noise of the given
// SNR (in 3 kHz) over all of it when snrDb is not NaN.
func synthTones(tones []tone, rate, lead, tail, snrDb float64, seed int64) []int16 {
	total := lead + tail
	for _, s := range tones {
		total += s.sec
	}
	n := int(total * rate)
	out := make([]float64, n)
	const amp = 0.5
	seg, end, ph := -1, lead, 0.0
	hz := 0.0
	for k := 0; k < n; k++ {
		tt := float64(k) / rate
		for tt >= end && seg < len(tones) {
			seg++
			if seg < len(tones) {
				hz = tones[seg].hz
				end += tones[seg].sec
			} else {
				end = math.Inf(1)
			}
		}
		if seg >= 0 && seg < len(tones) {
			ph += 2 * math.Pi * hz / rate
			out[k] = amp * math.Sin(ph)
		}
	}
	if !math.IsNaN(snrDb) {
		sigma := math.Sqrt(amp * amp / 2 / math.Pow(10, snrDb/10) * (rate / 2 / 3000))
		r := rand.New(rand.NewSource(seed))
		for k := range out {
			out[k] += sigma * r.NormFloat64()
		}
	}
	pcm := make([]int16, n)
	for k, v := range out {
		pcm[k] = int16(math.Max(-32767, math.Min(32767, v*32767)))
	}
	return pcm
}

// decodeCallsign runs pcm through the decoder as the extension does — in
// packets, while it decodes — and returns the callsign it sends, if any.
func decodeCallsign(t *testing.T, pcm []int16, rate float64) string {
	return decodeCallsignPaced(t, pcm, rate, 0)
}

// decodeCallsignPaced is decodeCallsign with the packets sent `pace` times
// faster than real time, as a receiver sends them (1); 0 for all at once.
func decodeCallsignPaced(t *testing.T, pcm []int16, rate, pace float64) string {
	t.Helper()
	d := NewSSTVDecoder(rate, DefaultSSTVConfig())
	audio := make(chan AudioSample, len(pcm)/240+2)
	results := make(chan []byte, 4096)
	if err := d.Start(audio, results); err != nil {
		t.Fatal(err)
	}
	defer d.Stop()
	for o := 0; o < len(pcm); o += 240 {
		e := o + 240
		if e > len(pcm) {
			e = len(pcm)
		}
		audio <- AudioSample{PCMData: pcm[o:e]}
		if pace > 0 {
			time.Sleep(time.Duration(float64(e-o) / rate / pace * float64(time.Second)))
		}
	}
	// The ID comes within a few seconds of the picture's end, if at all.
	deadline := time.After(120 * time.Second)
	for {
		select {
		case msg := <-results:
			if len(msg) >= 2 && msg[0] == MsgTypeFSKID {
				return string(msg[2 : 2+int(msg[1])])
			}
			if len(msg) >= 1 && msg[0] == MsgTypeComplete {
				deadline = time.After(10 * time.Second)
			}
		case <-deadline:
			return ""
		}
	}
}

// fskIDBadChecksum is fskIDTones with the checksum wrong: noise matching the
// header, as far as the decoder can tell.
func fskIDBadChecksum(call string) []tone {
	t := fskIDTones(call, 0)
	// The checksum is the six bits before the closing 100 ms; flip its lowest.
	i := len(t) - 7
	if t[i].hz == 1900 {
		t[i].hz = 2100
	} else {
		t[i].hz = 1900
	}
	return t
}

func TestFSKIDAfterPicture(t *testing.T) {
	const rate = 12000.0
	for _, c := range []struct {
		late, snr float64
	}{{0, math.NaN()}, {0.007, math.NaN()}, {0.015, 10}} {
		tones := append(robot36Tones(), fskIDTones("M9PSY", c.late)...)
		pcm := synthTones(tones, rate, 0.5, 4, c.snr, 1)
		if got := decodeCallsign(t, pcm, rate); got != "M9PSY" {
			t.Errorf("ID %.0f ms late, SNR %v dB: got %q, want M9PSY", c.late*1000, c.snr, got)
		}
	}
}

func TestFSKIDNeedsChecksum(t *testing.T) {
	const rate = 12000.0
	pcm := synthTones(append(robot36Tones(), fskIDBadChecksum("M9PSY")...), rate, 0.5, 4, math.NaN(), 1)
	if got := decodeCallsign(t, pcm, rate); got != "" {
		t.Errorf("wrong checksum: got %q, want nothing", got)
	}
}

func TestFSKIDLongCallsign(t *testing.T) {
	const rate = 12000.0
	const call = "M9PSY/MM/QRP1234"
	pcm := synthTones(append(robot36Tones(), fskIDTones(call, 0)...), rate, 0.5, 4, math.NaN(), 1)
	if got := decodeCallsign(t, pcm, rate); got != call {
		t.Errorf("got %q, want %q", got, call)
	}
}
