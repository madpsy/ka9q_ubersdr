package main

// Readers of a band's FFT buffer against the ingest goroutine, which appends
// to it under fftMu's write lock. The voice-activity paths used to take the
// read lock only to look the buffer up, then scan it unlocked while frames
// were being added. Run with -race: that is what turns an unlocked read into
// a failure here.

import (
	"math/rand"
	"sync"
	"testing"
	"time"
)

// TestFFTBufferSnapshotIsIndependent: a snapshot keeps exactly the samples it
// was taken with while the live buffer appends, ages samples out and
// reallocates under it.
func TestFFTBufferSnapshotIsIndependent(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	now := time.Now()
	buf := NewFFTBuffer("20m", 14000000, 14350000, 200, 2*time.Second)
	for i := 0; i < 30; i++ {
		buf.AddSample(now.Add(time.Duration(i)*100*time.Millisecond), bandFrame(rng, 64))
	}
	snap := buf.snapshot()
	want := make([]FFTSample, len(snap.Samples))
	for i, s := range snap.Samples {
		want[i] = FFTSample{Timestamp: s.Timestamp, Data: append([]float32(nil), s.Data...)}
	}
	for i := 30; i < 2000; i++ {
		buf.AddSample(now.Add(time.Duration(i)*100*time.Millisecond), bandFrame(rng, 64))
	}
	if len(snap.Samples) != len(want) {
		t.Fatalf("snapshot length changed: %d, was %d", len(snap.Samples), len(want))
	}
	for i := range want {
		if !snap.Samples[i].Timestamp.Equal(want[i].Timestamp) {
			t.Fatalf("snapshot sample %d's timestamp changed", i)
		}
		for j := range want[i].Data {
			if snap.Samples[i].Data[j] != want[i].Data[j] {
				t.Fatalf("snapshot sample %d's data changed", i)
			}
		}
	}
}

// TestVoiceActivityReadsDuringIngest drives the real entry points -- the one
// the MQTT publisher calls every second for every band, and the programmatic
// one -- while frames are ingested exactly as the monitor ingests them.
func TestVoiceActivityReadsDuringIngest(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	now := time.Now()
	buf := voiceBuffer(rng, 600, now)
	buf.MaxAge = 5 * time.Second
	nfm := &NoiseFloorMonitor{fftBuffers: map[string]*FFTBuffer{"20m": buf}}
	params := DefaultDetectionParams()

	frames := make([][]float32, 64)
	for i := range frames {
		frames[i] = bandFrame(rng, 600)
	}

	stop := make(chan struct{})
	var writer sync.WaitGroup
	writer.Add(1)
	go func() { // the ingest goroutine, as noise_floor.go adds a band frame
		defer writer.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			nfm.fftMu.Lock()
			if b, ok := nfm.fftBuffers["20m"]; ok {
				b.AddSample(now.Add(time.Duration(i)*10*time.Millisecond), frames[i%len(frames)])
			}
			nfm.fftMu.Unlock()
		}
	}()

	var readers sync.WaitGroup
	for r := 0; r < 4; r++ {
		readers.Add(1)
		go func(r int) {
			defer readers.Done()
			for i := 0; i < 25; i++ {
				if r%2 == 0 {
					GetVoiceActivityResponseForBand(nfm, "20m", params)
				} else if _, err := GetVoiceActivityForBand(nfm, "20m", params); err != nil {
					t.Error(err)
					return
				}
			}
		}(r)
	}
	readers.Wait()
	close(stop)
	writer.Wait()
}
