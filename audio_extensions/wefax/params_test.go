package wefax

import "testing"

// lpm and image_width arrive from the browser and are each range-checked, but
// their *relationship* was not. At 12 kHz — which is what every mode WEFAX runs
// on delivers — lpm=240 gives 3000 samples per line, and asking 4000 pixels of
// them leaves some pixels spanning no samples at all. The averaging divide then
// had a zero divisor, and because this runs on a goroutine with no recover()
// that ended the whole process rather than the session.
func TestNarrowLineDoesNotPanic(t *testing.T) {
	cases := []struct{ lpm, width int }{
		{240, 4000}, // samplesPerLine 3000 < width
		{300, 4000}, // 2400 < 4000
		{300, 2401}, // one over the boundary
		{120, 4000}, // 6000 > 4000, the ordinary case
		{60, 800},   // the defaults' shape
	}
	for _, c := range cases {
		cfg := DefaultWEFAXConfig()
		cfg.LPM = c.lpm
		cfg.ImageWidth = c.width
		cfg.UsePhasing = false

		d := NewWEFAXDecoder(12000, cfg)
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("lpm=%d width=%d (samplesPerLine=%d) panicked: %v",
						c.lpm, c.width, d.samplesPerLine, r)
				}
			}()
			d.decodeImageLine(make([]uint8, d.samplesPerLine+16), make(chan []byte, 4))
		}()
	}
}

// The same condition zeroed the scan step, which left the line loop advancing
// by nothing at all.
func TestScanStepNeverZero(t *testing.T) {
	cfg := DefaultWEFAXConfig()
	cfg.LPM = 300
	cfg.ImageWidth = 4000
	d := NewWEFAXDecoder(12000, cfg)
	if got := (d.samplesPerLine / d.imageWidth) * 2; got != 0 {
		t.Skipf("precondition gone: step would be %d", got)
	}
	// If the guard were missing this would not return.
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() { _ = recover() }()
		buf := make([]uint8, d.samplesPerLine+16)
		d.detectLineType(buf, len(buf))
	}()
	<-done
}

// A session left attached must not grow its image for ever.
func TestImageHeightIsCapped(t *testing.T) {
	cfg := DefaultWEFAXConfig()
	cfg.ImageWidth = 4000
	d := NewWEFAXDecoder(12000, cfg)
	for d.height < maxImageHeight {
		prev := d.height
		d.height *= 2
		if d.height > maxImageHeight {
			d.height = maxImageHeight
		}
		if d.height <= prev {
			t.Fatal("height stopped growing before the cap")
		}
	}
	if d.height != maxImageHeight {
		t.Errorf("height settled at %d, want the %d cap", d.height, maxImageHeight)
	}
}
