package main

import (
	"sync"
	"testing"
	"time"
)

// The centre frequency is the parameter a pan changes and the only one a lost
// pan leaves wrong, so it is the one these guard: a watchdog that checked bin
// bandwidth and bin count alone reported a channel in perfect health while it
// was producing bins from somewhere else entirely.

func TestSpectrumParamMismatchDetectsFrequency(t *testing.T) {
	want := spectrumGeometry{frequency: 14100000, binBW: 100, binCount: 1024}

	agrees := radiodSpectrumReport{
		frequency: 14100000, binBW: 100, binCount: 1024,
		hasFrequency: true, hasBinBW: true, hasBinCount: true,
	}
	if m := spectrumParamMismatch(want, agrees); m != 0 {
		t.Errorf("identical parameters reported as mismatched: %v", m.params())
	}

	// The failure being guarded: a pan that never arrived. Everything a
	// pan does not touch still matches.
	lostPan := agrees
	lostPan.frequency = 14090000
	m := spectrumParamMismatch(want, lostPan)
	if m&mismatchFrequency == 0 {
		t.Error("a centre 10 kHz from the one asked for was not reported as a mismatch")
	}
	if m&(mismatchBinBW|mismatchBinCount) != 0 {
		t.Errorf("bin bandwidth and bin count agree but were flagged: %v", m.params())
	}
	if got := m.params(); len(got) != 1 || got[0] != "frequency" {
		t.Errorf("params() = %v, want [frequency]", got)
	}
}

func TestSpectrumParamMismatchOneHertz(t *testing.T) {
	// Frequency crosses the wire as a double converted from an integer number of
	// Hz and radiod stores what it is given, so there is no rounding to absorb
	// and no tolerance to allow: 1 Hz out means the command did not arrive.
	want := spectrumGeometry{frequency: 7100000, binBW: 20, binCount: 512}
	got := radiodSpectrumReport{
		frequency: 7100001, binBW: 20, binCount: 512,
		hasFrequency: true, hasBinBW: true, hasBinCount: true,
	}
	if spectrumParamMismatch(want, got)&mismatchFrequency == 0 {
		t.Error("a 1 Hz difference in centre frequency was not detected")
	}
}

func TestSpectrumParamMismatchBinBWTolerance(t *testing.T) {
	// Bin bandwidth does round: it goes out as a float32. A tolerance too tight
	// would report a mismatch that no command could ever fix, and the watchdog
	// would re-send for ever.
	want := spectrumGeometry{frequency: 10000000, binBW: 29296.875, binCount: 1024}
	got := radiodSpectrumReport{
		frequency: 10000000, binBW: 29296.875, binCount: 1024,
		hasFrequency: true, hasBinBW: true, hasBinCount: true,
	}
	if m := spectrumParamMismatch(want, got); m != 0 {
		t.Errorf("the default full-span bin bandwidth round-tripped as a mismatch: %v", m.params())
	}

	got.binBW = 29297.5
	if spectrumParamMismatch(want, got)&mismatchBinBW == 0 {
		t.Error("a bin bandwidth 0.6 Hz out was not detected")
	}
}

func TestSpectrumParamMismatchIgnoresUnreported(t *testing.T) {
	// A parameter radiod did not mention is not the same as one it reported as
	// zero: acting on the absence would retune the channel to nothing.
	want := spectrumGeometry{frequency: 14100000, binBW: 100, binCount: 1024}
	if m := spectrumParamMismatch(want, radiodSpectrumReport{}); m != 0 {
		t.Errorf("an empty report was read as a mismatch: %v", m.params())
	}
}

func TestSpectrumParamMismatchBinCount(t *testing.T) {
	want := spectrumGeometry{frequency: 14100000, binBW: 0.5, binCount: 256}
	got := radiodSpectrumReport{
		frequency: 14100000, binBW: 0.5, binCount: 512,
		hasFrequency: true, hasBinBW: true, hasBinCount: true,
	}
	m := spectrumParamMismatch(want, got)
	if m != mismatchBinCount {
		t.Errorf("mismatch = %v, want [bin_count]", m.params())
	}
}

// --- what the session will admit about radiod -------------------------------

func newSpectrumSessionForTest() *Session {
	return &Session{
		IsSpectrum:   true,
		Frequency:    14100000,
		BinBandwidth: 100,
		BinCount:     1024,
	}
}

func TestRadiodContradictsNeedsEvidence(t *testing.T) {
	s := newSpectrumSessionForTest()

	// Nothing heard from radiod yet says nothing about radiod.
	if s.radiodContradicts(14100000, 100, 1024) {
		t.Error("a session that has never heard from radiod claimed to know it disagrees")
	}

	// A report that arrives hard on the heels of a command describes the channel
	// as it was beforehand. Reading it as disagreement would answer every
	// ordinary retune with a redundant re-send.
	s.noteSpectrumCommand()
	s.observeRadiodSpectrum(14090000, 100, 1024, time.Now())
	if s.radiodContradicts(14100000, 100, 1024) {
		t.Error("a report from inside the settle window was treated as evidence")
	}

	// Once it has had time to answer, the same disagreement counts.
	s.observeRadiodSpectrum(14090000, 100, 1024, time.Now().Add(spectrumSettleTime+time.Second))
	if !s.radiodContradicts(14100000, 100, 1024) {
		t.Error("a settled report of the wrong centre was not treated as a contradiction")
	}
	if s.radiodContradicts(14090000, 100, 1024) {
		t.Error("radiod was reported as contradicting the very geometry it reported")
	}
}

func TestRadiodContradictsExemptsSharedSubscribers(t *testing.T) {
	// The shared channel's geometry is the shared channel's business. A
	// subscriber re-asserting it would have every default-view client poking one
	// SSRC on radiod's behalf.
	s := newSpectrumSessionForTest()
	s.IsSharedSubscriber = true
	s.observeRadiodSpectrum(14090000, 100, 1024, time.Now().Add(spectrumSettleTime+time.Second))
	if s.radiodContradicts(14100000, 100, 1024) {
		t.Error("a shared-channel subscriber tried to re-assert the shared geometry")
	}
}

// --- pacing -----------------------------------------------------------------

// recordingPacer collects what reached the wire, with the timing loosened
// enough that these do not depend on scheduler luck.
type recordingPacer struct {
	mu   sync.Mutex
	sent []spectrumUpdate
}

func (r *recordingPacer) send(_ uint32, u spectrumUpdate) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.sent = append(r.sent, u)
	return nil
}

func (r *recordingPacer) snapshot() []spectrumUpdate {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]spectrumUpdate(nil), r.sent...)
}

func TestPacerSendsTheFirstRequestImmediately(t *testing.T) {
	// Pacing must not cost latency on a view that has been sitting still: a
	// bookmark click has to move the spectrum now, not one gap from now.
	rec := &recordingPacer{}
	p := newSpectrumUpdatePacer(50*time.Millisecond, rec.send)

	if err := p.Submit(1, spectrumUpdate{frequency: 7100000, binBandwidth: 100}); err != nil {
		t.Fatalf("Submit: %v", err)
	}
	sent := rec.snapshot()
	if len(sent) != 1 || sent[0].frequency != 7100000 {
		t.Fatalf("first request did not go out at once: %+v", sent)
	}
}

func TestPacerCoalescesABurstAndKeepsTheLast(t *testing.T) {
	// The shape of a drag: far more requests than radiod will take, and the one
	// that decides where the view ends up is the last.
	rec := &recordingPacer{}
	p := newSpectrumUpdatePacer(50*time.Millisecond, rec.send)

	for i := 0; i < 20; i++ {
		if err := p.Submit(1, spectrumUpdate{frequency: uint64(7100000 + i*1000), binBandwidth: 100}); err != nil {
			t.Fatalf("Submit %d: %v", i, err)
		}
	}

	// Immediately: the first only. The other nineteen are held.
	if got := len(rec.snapshot()); got != 1 {
		t.Fatalf("%d commands went out during the burst, want 1", got)
	}

	time.Sleep(150 * time.Millisecond)

	sent := rec.snapshot()
	if len(sent) != 2 {
		t.Fatalf("burst produced %d commands, want 2 (leading and trailing): %+v", len(sent), sent)
	}
	// The trailing send is the whole point: where the gesture finished is where
	// the channel must end up.
	if last := sent[len(sent)-1]; last.frequency != 7100000+19*1000 {
		t.Errorf("trailing send carried %d Hz, want the last request %d Hz", last.frequency, 7100000+19*1000)
	}
}

func TestPacerKeepsBinCountThroughCoalescing(t *testing.T) {
	// A zoom carries the bin count and a pan does not. Coalescing a pan on top
	// of a zoom must not drop the bin count the zoom asked for — radiod would
	// keep the old FFT and the view would be the wrong width.
	rec := &recordingPacer{}
	p := newSpectrumUpdatePacer(50*time.Millisecond, rec.send)

	p.Submit(1, spectrumUpdate{frequency: 7100000, binBandwidth: 100}) // leading, goes out
	p.Submit(1, spectrumUpdate{frequency: 7100000, binBandwidth: 20, binCount: 512, sendBinCount: true})
	p.Submit(1, spectrumUpdate{frequency: 7105000, binBandwidth: 20})

	time.Sleep(150 * time.Millisecond)

	sent := rec.snapshot()
	if len(sent) != 2 {
		t.Fatalf("got %d commands, want 2: %+v", len(sent), sent)
	}
	last := sent[1]
	if !last.sendBinCount || last.binCount != 512 {
		t.Errorf("coalesced command lost the bin count: %+v", last)
	}
	if last.frequency != 7105000 || last.binBandwidth != 20 {
		t.Errorf("coalesced command did not carry the newest geometry: %+v", last)
	}
}

func TestPacerCancelDropsPendingWork(t *testing.T) {
	// radiod creates a channel for any command carrying parameters, so a
	// trailing send arriving after the channel was terminated would raise the
	// dead — a spectrum channel nobody is watching, polled by nobody, sitting
	// there until it times out.
	rec := &recordingPacer{}
	p := newSpectrumUpdatePacer(50*time.Millisecond, rec.send)

	p.Submit(7, spectrumUpdate{frequency: 7100000, binBandwidth: 100})
	p.Submit(7, spectrumUpdate{frequency: 7200000, binBandwidth: 100})
	p.Cancel(7)

	time.Sleep(150 * time.Millisecond)

	if got := len(rec.snapshot()); got != 1 {
		t.Fatalf("%d commands reached the wire after Cancel, want only the leading one", got)
	}
}

func TestPacerIsPerChannel(t *testing.T) {
	// One busy channel must not pace another. Every spectrum session has its
	// own SSRC and radiod's queue is per channel too.
	rec := &recordingPacer{}
	p := newSpectrumUpdatePacer(50*time.Millisecond, rec.send)

	p.Submit(1, spectrumUpdate{frequency: 7100000, binBandwidth: 100})
	p.Submit(2, spectrumUpdate{frequency: 14100000, binBandwidth: 100})

	if got := len(rec.snapshot()); got != 2 {
		t.Fatalf("%d commands went out, want 2 — one per channel", got)
	}
}

// --- the packet itself ------------------------------------------------------

func TestBuildUpdateSpectrumCommandCarriesFrequency(t *testing.T) {
	buf := buildUpdateSpectrumCommand(0x12345678, spectrumUpdate{
		frequency:    14100000,
		binBandwidth: 100,
	})

	pktType, tlvs := parseCommandPacket(t, buf)
	if pktType != pktTypeCmd {
		t.Errorf("packet type = %d, want %d (CMD)", pktType, pktTypeCmd)
	}
	if v, ok := findTLV(tlvs, tagOutputSSRC); !ok || decodeInt64(v.value) != 0x12345678 {
		t.Errorf("SSRC missing or wrong: %v", tlvs)
	}
	e, ok := findTLV(tlvs, tagRadioFrequency)
	if !ok {
		t.Fatal("no RADIO_FREQUENCY in update packet: the pan would never reach radiod")
	}
	if got := decodeDouble(e.value); got != 14100000 {
		t.Errorf("RADIO_FREQUENCY = %v, want 14100000", got)
	}
	// Bin count is the one change that makes radiod tear down and rebuild the
	// channel's FFT, so a pan must not carry it.
	if _, ok := findTLV(tlvs, tagBinCount); ok {
		t.Error("a pan carried BIN_COUNT; radiod would rebuild the FFT for nothing")
	}
}

func TestBuildUpdateSpectrumCommandCarriesBinCountWhenAsked(t *testing.T) {
	buf := buildUpdateSpectrumCommand(1, spectrumUpdate{
		frequency:    14100000,
		binBandwidth: 20,
		binCount:     512,
		sendBinCount: true,
	})
	_, tlvs := parseCommandPacket(t, buf)
	e, ok := findTLV(tlvs, tagBinCount)
	if !ok {
		t.Fatal("no BIN_COUNT in a packet that asked for one")
	}
	if got := decodeInt64(e.value); got != 512 {
		t.Errorf("BIN_COUNT = %d, want 512", got)
	}
}

// --- housekeeping -----------------------------------------------------------

func TestPruneMismatchTrackingDropsIdleEntries(t *testing.T) {
	// Both maps are keyed by an SSRC that is never reused, so without pruning
	// they grow for the life of the process.
	mismatchMutex.Lock()
	lastMismatchLog[0xdead0001] = time.Now().Add(-time.Hour)
	lastRetryTime[0xdead0001] = time.Now().Add(-time.Hour)
	lastMismatchLog[0xdead0002] = time.Now()
	lastRetryTime[0xdead0002] = time.Now()
	mismatchMutex.Unlock()

	pruneMismatchTracking(5 * time.Minute)

	mismatchMutex.Lock()
	defer mismatchMutex.Unlock()
	if _, ok := lastMismatchLog[0xdead0001]; ok {
		t.Error("an hour-old entry survived the prune")
	}
	if _, ok := lastRetryTime[0xdead0001]; ok {
		t.Error("an hour-old retry entry survived the prune")
	}
	if _, ok := lastMismatchLog[0xdead0002]; !ok {
		t.Error("a current entry was pruned")
	}
	delete(lastMismatchLog, 0xdead0002)
	delete(lastRetryTime, 0xdead0002)
}
