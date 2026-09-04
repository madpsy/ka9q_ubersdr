package main

import (
	"encoding/binary"
	"fmt"
	"math"
	"os"
	"testing"
)

// Replay a captured IQ stream through a fresh encoder and watch the coding
// cost, the predictor's taps and the residual magnitude together.
func TestZZReplay(t *testing.T) {
	path := os.Getenv("REPLAY")
	if path == "" {
		t.Skip("set REPLAY")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	samples := make([]int16, len(data)/2)
	for i := range samples {
		samples[i] = int16(binary.LittleEndian.Uint16(data[2*i:]))
	}
	if v := os.Getenv("LEAK"); v != "" {
		var k int
		fmt.Sscan(v, &k)
		zzLeak = uint(k)
	}
	const fs = 384000
	const per = 698 // samples per packet, as the server sends
	enc := NewPCMv4StreamEncoder()
	raw := make([]byte, per*2)

	var bytesAcc, n int64
	var esc int64
	sec := 0
	for off := 0; off+per <= len(samples); off += per {
		for i := 0; i < per; i++ {
			binary.BigEndian.PutUint16(raw[2*i:], uint16(samples[off+i]))
		}
		out, err := enc.EncodePacket(raw, 0, fs, 2, -30, -60)
		if err != nil {
			t.Fatal(err)
		}
		bytesAcc += int64(len(out))
		if len(out) > per*2 {
			esc++
		}
		n += per
		if n >= fs*2*5 {
			sec += 5
			// Peek at the predictor's taps.
			st := enc.codec.cx[0]
			var maxAbs, sumAbs int64
			for _, w := range append(append([]int64{}, st.wr...), st.wi...) {
				if w < 0 {
					w = -w
				}
				sumAbs += w
				if w > maxAbs {
					maxAbs = w
				}
			}
			t.Logf("t=%3ds  %6.2f bits/sample  escapes=%4d  tap max=%8.3f mean=%7.3f (Q16 units of 1.0)",
				sec, float64(bytesAcc)*8/float64(n), esc,
				float64(maxAbs)/65536, float64(sumAbs)/32/65536)
			bytesAcc, n, esc = 0, 0, 0
		}
	}
	_ = math.Abs
}
