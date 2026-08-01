package main

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestLiveAudio exercises the whole audio path: shared session, Opus decode,
// mixer and output device. Gated on UBERSDR_TEST_SERVER.
func TestLiveAudio(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("set UBERSDR_TEST_SERVER to run the live audio test")
	}
	host, secure := parseServer(target, false)

	// Spectrum and audio must share one session UUID.
	sp, err := NewClient(host, secure, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := sp.CheckConnection(); err != nil {
		t.Fatalf("/connection: %v", err)
	}
	t.Logf("session %s", sp.sessionID)

	devices, err := listDevices()
	if err != nil {
		t.Fatalf("device enumeration failed: %v", err)
	}
	t.Logf("%d output device(s):", len(devices))
	for _, d := range devices {
		star := " "
		if d.Default {
			star = "*"
		}
		t.Logf("  %s %-45s id=%s", star, d.Name, d.ID)
	}

	out := NewAudioOutput()
	if err := out.Start(""); err != nil {
		t.Fatalf("cannot open default output: %v", err)
	}
	defer out.Close()
	t.Log("output device opened")

	ac := NewAudioClient(host, secure, "", sp.sessionID)
	ac.SetTuning(7_100_000, "lsb", -2700, -300) // 40 m, below the 10 MHz cutoff

	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	go ac.Run(ctx)

	var frames, samples int
	var lastLevel Signal
	deadline := time.After(12 * time.Second)

loop:
	for {
		select {
		case pcm := <-ac.PCM:
			frames++
			samples += len(pcm)
			out.Push(pcm)
		case lv := <-ac.Level:
			lastLevel = lv
		case msg := <-ac.Status:
			t.Logf("status: %s", msg)
		case <-deadline:
			break loop
		case <-ctx.Done():
			break loop
		}
	}

	buffered, dropped := out.Stats()
	t.Logf("decoded %d frames, %d samples (%.1f s of audio at %d Hz)",
		frames, samples, float64(samples)/float64(opusOutputRate), opusOutputRate)
	t.Logf("baseband %.1f dBFS, noise %.1f dBFS, SNR %.1f dB; mixer buffered=%d dropped=%d",
		lastLevel.Power, lastLevel.Noise, lastLevel.SNR(), buffered, dropped)

	if frames == 0 {
		t.Fatal("no audio frames decoded")
	}
	// Audio should arrive in real time; well under half is a stall.
	if got := float64(samples) / float64(opusOutputRate); got < 5 {
		t.Errorf("only %.1f s of audio in 12 s — the stream is stalling", got)
	}
	// The player must be draining, or the buffer would sit at its cap.
	if buffered >= opusOutputRate {
		t.Errorf("mixer buffer is full (%d samples) — output is not draining", buffered)
	}

	// Retuning in place must not break the stream.
	ac.Tune(14_074_000, "usb", 300, 2700)
	after := 0
	t.Log("retuned to 14.074 MHz USB")
	tick := time.After(4 * time.Second)
drain:
	for {
		select {
		case pcm := <-ac.PCM:
			after += len(pcm)
			out.Push(pcm)
		case <-tick:
			break drain
		case <-ctx.Done():
			break drain
		}
	}
	t.Logf("%.1f s of audio after retune", float64(after)/float64(opusOutputRate))
	if after == 0 {
		t.Error("audio stopped after retuning")
	}
}

// TestLiveSharedSession is the explicit check that spectrum and audio can run
// concurrently on one session UUID, which is how the server counts users.
func TestLiveSharedSession(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("set UBERSDR_TEST_SERVER to run the live shared-session test")
	}
	host, secure := parseServer(target, false)

	sp, err := NewClient(host, secure, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := sp.CheckConnection(); err != nil {
		t.Fatalf("/connection: %v", err)
	}

	ac := NewAudioClient(host, secure, "", sp.sessionID)
	if ac.sessionID != sp.sessionID {
		t.Fatal("audio and spectrum must share the session UUID")
	}
	ac.SetTuning(7_100_000, "lsb", -2700, -300)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	go sp.Run(ctx, 7_100_000, 20)
	go ac.Run(ctx)

	var specFrames, audioFrames int
	var cfg SpectrumConfig
	deadline := time.After(15 * time.Second)

loop:
	for {
		select {
		case c := <-sp.Configs:
			cfg = c
		case <-sp.Frames:
			specFrames++
		case <-ac.PCM:
			audioFrames++
		case msg := <-ac.Status:
			t.Logf("audio: %s", msg)
		case msg := <-sp.Status:
			t.Logf("spectrum: %s", msg)
		case <-deadline:
			break loop
		case <-ctx.Done():
			break loop
		}
	}

	t.Logf("session %s carried %d spectrum frames and %d audio frames concurrently",
		sp.sessionID, specFrames, audioFrames)
	t.Logf("spectrum span %.0f Hz, %d bins", cfg.TotalBandwidth, cfg.BinCount)

	if specFrames == 0 {
		t.Error("spectrum stopped while audio was running")
	}
	if audioFrames == 0 {
		t.Error("audio produced nothing while the spectrum was running")
	}
}
