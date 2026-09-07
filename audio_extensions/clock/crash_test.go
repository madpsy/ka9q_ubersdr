package clock

// What happens when the subprocess is not there, dies, hangs, or talks
// nonsense — and, in every case, that nothing panics.
//
// This matters more than it would in a library. Start() runs two goroutines
// with no recover() (the convention here — see wefax/params_test.go), and a
// panic on either takes down the whole receiver for every listener, not just
// the one who opened the decoder. ubersdr-clock is a separate binary that may
// be missing, stale, or killed by an OOM at any moment, so every one of these
// is a real state and not a hypothetical.

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeBinary points the package at a shell script for the duration of one test.
// binaryPath is a package var resolved at init; saving and restoring it keeps
// the tests independent of each other and of whether a real one is installed.
func fakeBinary(t *testing.T, script string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ubersdr-clock")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	saved := binaryPath
	binaryPath = path
	t.Cleanup(func() { binaryPath = saved })
}

func startExt(t *testing.T) (*ClockExtension, chan AudioSample, chan []byte) {
	t.Helper()
	ext, err := NewClockExtension(12000, map[string]interface{}{
		"tuned_frequency_hz": float64(9_999_000),
	})
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}
	audioChan := make(chan AudioSample, 64)
	resultChan := make(chan []byte, 64)
	if err := ext.Start(audioChan, resultChan); err != nil {
		t.Fatalf("start: %v", err)
	}
	return ext, audioChan, resultChan
}

func block(n int) AudioSample {
	return AudioSample{PCMData: make([]int16, n), GPSTimeNs: time.Now().UnixNano()}
}

// --- the binary is missing --------------------------------------------------

func TestMissingBinaryIsRefusedAtAttach(t *testing.T) {
	saved := binaryPath
	binaryPath = filepath.Join(t.TempDir(), "definitely-not-here")
	defer func() { binaryPath = saved }()

	_, err := NewClockExtension(12000, nil)
	if err == nil {
		t.Fatal("a missing binary was accepted; the attach must fail so the user is told")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Fatalf("the error should name the problem, got: %v", err)
	}
}

func TestUnstartableBinaryFailsStartRatherThanPanicking(t *testing.T) {
	// Present and executable, but not a program: exec fails at the kernel.
	path := filepath.Join(t.TempDir(), "ubersdr-clock")
	if err := os.WriteFile(path, []byte("\x00\x01not an executable"), 0o755); err != nil {
		t.Fatal(err)
	}
	saved := binaryPath
	binaryPath = path
	defer func() { binaryPath = saved }()

	ext, err := NewClockExtension(12000, nil)
	if err != nil {
		t.Fatalf("the constructor only stats the file, so it should succeed: %v", err)
	}
	if err := ext.Start(make(chan AudioSample), make(chan []byte)); err == nil {
		t.Fatal("Start should have failed on a non-executable")
	}
	// The manager calls Stop() after a failed Start to release anything the
	// constructor took. It must be safe on an extension that never ran.
	if err := ext.Stop(); err != nil {
		t.Fatalf("Stop after a failed Start: %v", err)
	}
}

// --- the binary dies --------------------------------------------------------

func TestSubprocessDeathIsReportedNotSwallowed(t *testing.T) {
	// Says one thing, then dies — an OOM kill, a segfault, a bad build.
	fakeBinary(t, `echo '{"type":"state","state":"acquiring","station":"unknown"}'; exit 1`)
	ext, audioChan, resultChan := startExt(t)
	defer func() { _ = ext.Stop() }()

	select {
	case frame := <-resultChan:
		if !strings.Contains(string(frame), "acquiring") {
			t.Fatalf("unexpected first frame: %s", frame)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the line it did emit never arrived")
	}

	// The manager watches this and turns it into an audio_extension_error, so
	// the panel says the decoder died instead of showing one that has simply
	// gone quiet — which on a decoder that takes four minutes to lock is
	// indistinguishable from working.
	select {
	case <-ext.CrashChan():
	case <-time.After(5 * time.Second):
		t.Fatal("the subprocess died and CrashChan said nothing")
	}

	// Audio still arriving after the death must not panic on the broken pipe.
	// Writing to a closed pipe raises SIGPIPE, which Go turns into an EPIPE
	// error for any fd other than stdout/stderr — but only if nothing else
	// mishandles it first.
	for i := 0; i < 50; i++ {
		select {
		case audioChan <- block(240):
		default:
		}
	}
	time.Sleep(200 * time.Millisecond)
}

func TestSubprocessThatDiesImmediatelyDoesNotPanic(t *testing.T) {
	fakeBinary(t, `exit 3`)
	ext, audioChan, _ := startExt(t)

	for i := 0; i < 200; i++ {
		select {
		case audioChan <- block(240):
		default:
		}
	}
	select {
	case <-ext.CrashChan():
	case <-time.After(5 * time.Second):
		t.Fatal("no crash reported")
	}
	if err := ext.Stop(); err != nil {
		t.Fatalf("Stop after a crash: %v", err)
	}
}

// --- the binary hangs -------------------------------------------------------

func TestAHungSubprocessIsKilledRatherThanWaitedOnForever(t *testing.T) {
	// Ignores the signals it can and never reads stdin, so closing stdin will
	// not make it leave. Only SIGKILL ends this, which is what the timeout is
	// for — without it Stop() would block the manager's teardown for ever and
	// the session could never be detached.
	fakeBinary(t, `trap "" TERM INT HUP; while true; do sleep 0.2; done`)
	ext, _, _ := startExt(t)

	start := time.Now()
	if err := ext.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	elapsed := time.Since(start)

	if elapsed < stopTimeout {
		t.Fatalf("Stop returned in %s — it should have waited out the %s grace period first",
			elapsed, stopTimeout)
	}
	if elapsed > stopTimeout+3*time.Second {
		t.Fatalf("Stop took %s; the kill path is not working", elapsed)
	}
}

// --- the binary talks nonsense ---------------------------------------------

func TestGarbageOnStdoutIsDroppedNotForwarded(t *testing.T) {
	fakeBinary(t, `
echo 'this is not json'
echo ''
echo '{"type":"state","state":"locked","station":"wwv"}'
echo '{ broken json'
echo 'null'
echo '[1,2,3]'
sleep 10
`)
	ext, _, resultChan := startExt(t)
	defer func() { _ = ext.Stop() }()

	// Only the one real event should reach the client. Everything else is
	// dropped at the readLoop, because a frontend that has to defend itself
	// against the decoder's output is one bad line from a blank panel.
	select {
	case frame := <-resultChan:
		if !strings.Contains(string(frame), `"state":"locked"`) {
			t.Fatalf("forwarded something that was not the valid event: %s", frame)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the valid event never arrived")
	}

	select {
	case frame := <-resultChan:
		t.Fatalf("forwarded a second frame, but only one line was valid JSON: %s", frame)
	case <-time.After(300 * time.Millisecond):
	}
}

func TestAnAbsurdlyLongLineDoesNotWedgeTheReader(t *testing.T) {
	// The scanner has a 256 kB ceiling. Past it Scan stops, which is treated as
	// the subprocess having failed — the point is that it is noticed rather
	// than the decoder silently going quiet, which on something that takes four
	// minutes to lock is indistinguishable from working.
	fakeBinary(t, `exec awk 'BEGIN { printf "{\"type\":\"x\",\"pad\":\""; for(i=0;i<400000;i++) printf "a"; printf "\"}\n" }'`)
	ext, _, _ := startExt(t)
	defer func() { _ = ext.Stop() }()

	select {
	case <-ext.CrashChan():
	case <-time.After(10 * time.Second):
		t.Fatal("an over-long line should end the read and be reported, not hang")
	}
}

// A subprocess that leaves a child behind when it dies.
//
// This is what found the io.Discard bug. cmd.Stderr as an io.Writer makes exec
// build a pipe and run a goroutine copying it, and cmd.Wait() waits for that
// goroutine — which cannot finish while ANY writer still holds the pipe open.
// Process.Kill() ends the process we started and not its children, so one
// orphan was enough to hang Wait(), and with it Stop(), and with it the
// manager's teardown: a session that could never be detached. cmd.Stderr = nil
// hands the child os.DevNull instead, so there is no pipe and no goroutine.
//
// The shipped binary forks nothing, so this is about the wrapper scripts people
// really do put in front of these things while debugging.
func TestAStubbornGrandchildDoesNotWedgeStop(t *testing.T) {
	// No `exec`: the shell stays as the parent, and the background child
	// outlives a kill aimed at the shell while still holding stderr and stdout.
	fakeBinary(t, `sleep 60 & trap "" TERM INT HUP; while true; do sleep 0.2; done`)
	ext, _, _ := startExt(t)

	done := make(chan error, 1)
	go func() { done <- ext.Stop() }()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Stop: %v", err)
		}
	case <-time.After(stopTimeout + 8*time.Second):
		t.Fatal("Stop hung — a child outliving the process it was spawned from " +
			"must not be able to block teardown")
	}
}

// --- lifecycle abuse --------------------------------------------------------

func TestStopIsIdempotentAndConcurrencySafe(t *testing.T) {
	// Two websocket connections can share a UserSessionID (the same UUID in two
	// tabs), so a replace-on-attach and a disconnect really can reach one
	// extension at once. A second close of stopChan would panic.
	fakeBinary(t, `cat > /dev/null`)
	ext, _, _ := startExt(t)

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _ = ext.Stop() }()
	}
	wg.Wait()

	if err := ext.Stop(); err != nil {
		t.Fatalf("a later Stop: %v", err)
	}
}

func TestStopWithoutStartIsSafe(t *testing.T) {
	fakeBinary(t, `cat > /dev/null`)
	ext, err := NewClockExtension(12000, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := ext.Stop(); err != nil {
		t.Fatalf("Stop before Start: %v", err)
	}
	if ext.CrashChan() != nil {
		t.Fatal("an extension that never started should have no crash channel")
	}
}

func TestDoubleStartIsRefused(t *testing.T) {
	fakeBinary(t, `cat > /dev/null`)
	ext, audioChan, resultChan := startExt(t)
	defer func() { _ = ext.Stop() }()

	if err := ext.Start(audioChan, resultChan); err == nil {
		t.Fatal("a second Start should be refused, not silently orphan the first subprocess")
	}
}

// --- hostile input ----------------------------------------------------------

func TestOddAudioBlocksDoNotPanic(t *testing.T) {
	// writeLoop takes the address of PCMData[0] to cast the slice to bytes,
	// which panics on an empty slice. An empty block is not hypothetical: a
	// blocked-frequency session substitutes audio in place, and a mode change
	// can produce a short one.
	fakeBinary(t, `cat > /dev/null`)
	ext, audioChan, _ := startExt(t)
	defer func() { _ = ext.Stop() }()

	for _, s := range []AudioSample{
		{PCMData: nil},
		{PCMData: []int16{}},
		{PCMData: []int16{0}},
		{PCMData: make([]int16, 240), GPSTimeNs: 0},  // no timestamp
		{PCMData: make([]int16, 240), GPSTimeNs: -1}, // nonsense timestamp
		{PCMData: make([]int16, 65536)},              // a very large block
	} {
		audioChan <- s
	}
	time.Sleep(300 * time.Millisecond)
}

func TestHostileExtensionParamsAreRefusedNotPanicked(t *testing.T) {
	// extensionParams is a map[string]interface{} decoded from the client's
	// JSON, so every value here is a shape a browser can actually send. A bare
	// type assertion on any of them would panic on the manager's goroutine and
	// take the server with it.
	fakeBinary(t, `cat > /dev/null`)

	for i, params := range []map[string]interface{}{
		{"tuned_frequency_hz": "not a number"},
		{"tuned_frequency_hz": nil},
		{"tuned_frequency_hz": []interface{}{1, 2}},
		{"tuned_frequency_hz": map[string]interface{}{"a": 1}},
		{"tuned_frequency_hz": true},
		{"station": 42},
		{"station": nil},
		{"station": []interface{}{"wwv"}},
		{"station": "wwv; rm -rf /"},
		{"station": ""},
	} {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Fatalf("case %d panicked on %v: %v", i, params, r)
				}
			}()
			// Either outcome is fine; only a panic is not. An unusable value
			// must never reach the command line as an argument.
			if ext, err := NewClockExtension(12000, params); err == nil {
				if ext.station != "wwv" && ext.station != "wwvh" && ext.station != "wwvb" {
					t.Fatalf("case %d produced station %q, which would be passed to the binary",
						i, ext.station)
				}
			}
		}()
	}
}

func TestSampleRatesEveryModeCanProduce(t *testing.T) {
	fakeBinary(t, `cat > /dev/null`)
	// Every rate GetSampleRateForMode can return for a mono mode. All must be
	// accepted, because the user picks the mode and the decoder simply gets
	// whatever the session is on.
	for _, rate := range []int{12000, 24000} {
		if _, err := NewClockExtension(rate, nil); err != nil {
			t.Fatalf("%d Hz is a real UberSDR mode rate and was refused: %v", rate, err)
		}
	}
	// And a few that are not, which must be refused rather than decoded wrongly.
	for _, rate := range []int{0, -1, 1, 12345, 11999} {
		if _, err := NewClockExtension(rate, nil); err == nil {
			t.Fatalf("%d Hz was accepted but cannot be decimated evenly", rate)
		}
	}
}

func TestResultChannelBackpressureDropsRatherThanBlocks(t *testing.T) {
	// A client that stops draining must not stall the audio writer behind it.
	// These are status updates: a stale one is worth nothing, so dropping is
	// the right failure and blocking would be the wrong one.
	fakeBinary(t, fmt.Sprintf(`i=0; while [ $i -lt 500 ]; do echo '{"type":"diag","n":'$i'}'; i=$((i+1)); done; sleep 5`))

	ext, err := NewClockExtension(12000, nil)
	if err != nil {
		t.Fatal(err)
	}
	audioChan := make(chan AudioSample, 8)
	resultChan := make(chan []byte, 4) // deliberately tiny, and never drained
	if err := ext.Start(audioChan, resultChan); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ext.Stop() }()

	// If readLoop blocked on the full channel, Stop() would hit its timeout.
	done := make(chan struct{})
	go func() { _ = ext.Stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(stopTimeout + 3*time.Second):
		t.Fatal("Stop blocked — readLoop is stuck on a full result channel")
	}
}
