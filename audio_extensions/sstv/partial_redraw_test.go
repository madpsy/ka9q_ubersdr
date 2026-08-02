package sstv

import "testing"

// A transmission that fades part-way through must not have its blank tail
// repainted by the slant-correction redraw. On RGB/GBR modes those rows would
// come back black, which is harmless; on YUV modes an all-zero pixel converts to
// (0,132,0), so the blank tail would come back as a green block.
func TestRedrawStopsAtReceivedLines(t *testing.T) {
	const sampleRate = 12000.0

	for _, idx := range []uint8{6, 2, 8, 14} { // Scottie S2, Martin M2, Robot 72, PD-50
		m := GetModeByIndex(idx)
		if m == nil || m.Unsupported {
			t.Fatalf("mode index %d unavailable", idx)
		}

		v := NewVideoDemodulator(m, sampleRate, 0, true)

		// Simulate the demodulation loop stopping ~40% in: samples up to that
		// point are real, and every pixel whose time falls inside them counts as
		// a received line, exactly as Demodulate records it.
		length := int(m.LineTime * float64(m.NumLines) * sampleRate)
		if m.PDFormat { // PD modes
			length /= 2
		}
		v.storedLumWritten = length * 2 / 5
		for i := 0; i < v.storedLumWritten; i++ {
			v.storedLum[i] = 128
		}
		for _, p := range v.GetPixelGrid(sampleRate, 0) {
			if p.Time < v.storedLumWritten && p.Y+1 > v.linesReceived {
				v.linesReceived = p.Y + 1
			}
		}

		px, linesToSend := v.RedrawFromLuminance(sampleRate, 0)

		if linesToSend <= 0 || linesToSend >= m.NumLines {
			t.Errorf("%s: expected a partial line bound, got %d of %d",
				m.Name, linesToSend, m.NumLines)
			continue
		}

		// Nothing that will actually be sent may contain the all-zero artefact.
		bad := 0
		for y := 0; y < linesToSend; y++ {
			for x := 0; x < m.ImgWidth; x++ {
				o := (y*m.ImgWidth + x) * 3
				if px[o] == 0 && px[o+1] == 132 && px[o+2] == 0 {
					bad++
				}
			}
		}
		if bad > 0 {
			t.Errorf("%s: %d green (0,132,0) pixels inside the %d lines being sent",
				m.Name, bad, linesToSend)
		}
		t.Logf("%-11s enc=%d received=%d sending=%d of %d lines, no blank artefact in sent rows",
			m.Name, m.ColorEnc, v.linesReceived, linesToSend, m.NumLines)
	}
}

// A redraw must never read back the over-allocated tail of storedLum as if it
// held samples; the previous code fell back to storedLum[len-1], which is in
// that tail and so is always zero.
func TestRedrawIgnoresUnwrittenSamples(t *testing.T) {
	m := GetModeByIndex(6) // Scottie S2
	v := NewVideoDemodulator(m, 12000, 0, true)

	// Poison the unwritten region. If the redraw reads any of it, the poison
	// shows up in the output.
	for i := range v.storedLum {
		v.storedLum[i] = 200
	}
	v.storedLumWritten = 0
	v.linesReceived = m.NumLines

	px, _ := v.RedrawFromLuminance(12000, 0)
	for i, b := range px {
		if b != 0 {
			t.Fatalf("redraw read unwritten sample: px[%d]=%d, want 0", i, b)
		}
	}
}
