package sstv

import (
	"math"
	"testing"
)

// PD modes send four channels per radio frame - Y(odd), R-Y, B-Y, Y(even) -
// covering two image lines, so a picture is NumLines/2 frames long. That must be
// driven by PDFormat, not by the image width: PD-50 and PD-90 are 320 px wide,
// the same as the Robot modes, and a width test silently excluded them.
func TestPDFrameTiming(t *testing.T) {
	for i := range ModeSpecs {
		m := &ModeSpecs[i]
		if !m.PDFormat {
			continue
		}
		// The frame must account for exactly sync + porch + four channels.
		want := m.SyncTime + m.PorchTime + 4*(m.PixelTime*float64(m.ImgWidth))
		if math.Abs(want-m.LineTime) > 1e-6 {
			t.Errorf("%s: sync+porch+4ch = %.6fs but LineTime = %.6fs",
				m.Name, want, m.LineTime)
		}
		if m.FrameLines() != 2 {
			t.Errorf("%s: FrameLines() = %d, want 2", m.Name, m.FrameLines())
		}
	}
}

// Every PD mode must be recognised, including the 320 px wide ones.
func TestPDFormatCoverage(t *testing.T) {
	want := map[string]bool{
		"PD-50": true, "PD-90": true, "PD-120": true, "PD-160": true,
		"PD-180": true, "PD-240": true, "PD-290": true,
	}
	for i := range ModeSpecs {
		m := &ModeSpecs[i]
		if want[m.Name] != m.PDFormat {
			t.Errorf("%s: PDFormat = %v, want %v", m.Name, m.PDFormat, want[m.Name])
		}
		delete(want, m.Name)
	}
	for name := range want {
		t.Errorf("%s missing from ModeSpecs", name)
	}
}

// Every mode must complete each image line exactly once during demodulation, so
// the whole picture is drawn as it arrives. PD modes emit channels 0-2 only, so
// the old "Channel >= numChans-1" test never fired for them and they drew
// nothing until the slant-correction redraw.
func TestEveryLineIsCompletedOnce(t *testing.T) {
	for i := range ModeSpecs {
		m := &ModeSpecs[i]
		if m.Unsupported || m.NumLines == 0 {
			continue
		}
		v := NewVideoDemodulator(m, 12000, 0, true)

		ends := make([]int, m.NumLines)
		for _, p := range v.GetPixelGrid(12000, 0) {
			if p.EndOfLine {
				ends[p.Y]++
			}
		}
		for y, n := range ends {
			if n != 1 {
				t.Errorf("%s: line %d marked EndOfLine %d times, want 1", m.Name, y, n)
				break
			}
		}
	}
}

// The end-of-line marker must land on the last write to that line, otherwise a
// line would be sent before its remaining channels had arrived.
func TestEndOfLineIsTheLastWrite(t *testing.T) {
	for i := range ModeSpecs {
		m := &ModeSpecs[i]
		if m.Unsupported || m.NumLines == 0 {
			continue
		}
		v := NewVideoDemodulator(m, 12000, 0, true)
		grid := v.GetPixelGrid(12000, 0)

		lastIdx := make(map[int]int)
		for idx, p := range grid {
			lastIdx[p.Y] = idx
		}
		for idx, p := range grid {
			if p.EndOfLine && lastIdx[p.Y] != idx {
				t.Errorf("%s: line %d marked at grid index %d, but last write is %d",
					m.Name, p.Y, idx, lastIdx[p.Y])
				break
			}
		}
	}
}
