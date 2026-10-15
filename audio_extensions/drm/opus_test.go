package drm

import (
	"math"
	"testing"
)

// TestDRMEncoderUsesCELT pins DRM's Opus encoder to the listener path's
// settings: every packet must be CELT-coded, which the configuration number
// in the top five bits of its first (TOC) byte shows -- 0-11 SILK, 12-15
// hybrid, 16-31 CELT. VoIP mode, or audio mode left on the automatic
// bitrate, codes the same audio with SILK at two to four times the CPU.
func TestDRMEncoderUsesCELT(t *testing.T) {
	for _, bitrate := range []int{24000, 48000} {
		d, err := NewDRMDecoder(DRMConfig{OutputSampleRate: 12000, OpusBitrate: bitrate, OpusComplexity: 5})
		if err != nil {
			t.Fatal(err)
		}
		frame := make([]int16, opusFrameSamples)
		buf := make([]byte, 4000)
		for n := 0; n < 100; n++ {
			// A chord with a slow tremolo, music rather than speech.
			for i := range frame {
				s := float64(n*len(frame)+i) / 12000
				v := 0.3*math.Sin(2*math.Pi*220*s) + 0.2*math.Sin(2*math.Pi*554*s) +
					0.15*math.Sin(2*math.Pi*1318*s)*math.Sin(2*math.Pi*3*s)
				frame[i] = int16(v * 12000)
			}
			if _, err := d.opusEncoder.Encode(frame, buf); err != nil {
				t.Fatal(err)
			}
			if cfg := buf[0] >> 3; cfg < 16 {
				t.Fatalf("at %d bps: frame %d coded with configuration %d, not CELT", bitrate, n, cfg)
			}
		}
	}
}

// The main package's audio.opus settings reach the decoder, and an unset
// GlobalConfig falls back to the same defaults main applies.
func TestDRMOpusSettingsFromGlobalConfig(t *testing.T) {
	prev := GlobalConfig
	defer func() { GlobalConfig = prev; activeUserCount = 0 }()
	p := AudioExtensionParams{SampleRate: 12000, Channels: 2, BitsPerSample: 16}

	for _, tc := range []struct {
		gc           *GlobalConfigProvider
		bitrate, cpx int
	}{
		{nil, defaultOpusBitrate, defaultOpusComplexity},
		{&GlobalConfigProvider{OpusBitrate: 24000, OpusComplexity: 8}, 24000, 8},
	} {
		GlobalConfig = tc.gc
		e, err := NewDRMExtension(p, nil)
		if err != nil {
			t.Fatal(err)
		}
		dec := e.decoder
		if dec.config.OpusBitrate != tc.bitrate || dec.config.OpusComplexity != tc.cpx {
			t.Errorf("GlobalConfig %+v: got bitrate %d complexity %d, want %d %d",
				tc.gc, dec.config.OpusBitrate, dec.config.OpusComplexity, tc.bitrate, tc.cpx)
		}
		if br, _ := dec.opusEncoder.Bitrate(); br != tc.bitrate {
			t.Errorf("encoder bitrate %d, want %d", br, tc.bitrate)
		}
		_ = e.Stop()
	}
}
