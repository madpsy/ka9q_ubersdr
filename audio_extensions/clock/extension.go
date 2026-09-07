package clock

/*
 * WWV/WWVH/WWVB time-code decoder extension.
 *
 * Spawns /opt/ubersdr-clock/ubersdr-clock_<goarch> as a subprocess. The binary
 * reads mono int16 little-endian PCM from stdin at the session sample rate and
 * writes newline-delimited JSON to stdout, one object per event:
 *
 *   {"type":"state","state":"locked","station":"wwv"}
 *   {"type":"time","utc":"...","quality":100,"offset_ms":-341.2,...}
 *   {"type":"frame","minute":1,"hour":7,"dut1_tenths":-3,...}
 *   {"type":"second","symbol":1,"confidence":0.49,"envelope":[...],...}
 *   {"type":"diag","tone_snr_db":18.0,"refusal":"staleness",...}
 *
 * Those lines are forwarded to the frontend verbatim as binary WebSocket
 * frames — the newer audio-extension convention is UTF-8 JSON in a binary
 * frame, so no repacking into a type-byte format is needed. See
 * static/v2/src/extensions/protocol.js.
 *
 * The one exception is offset_ms, which is rewritten here. See the anchor
 * discussion on sampleClock below.
 *
 * Tuning is the operator's job and the panel says so: WWV/WWVH wants USB at
 * (carrier - 1 kHz) with a passband reaching 2.2 kHz, WWVB wants USB at
 * 0.059 MHz. The station argument is derived from the session's tuned
 * frequency rather than asked for.
 *
 * Multiple instances may run concurrently (one per user session). All shared
 * state is protected by e.mu or accessed atomically.
 */

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

const binaryDir = "/opt/ubersdr-clock"

// binaryPath is the decoder binary this build should spawn. The C++ build
// names its output after the target architecture using Go's own GOARCH
// spellings (ubersdr-clock_amd64, ubersdr-clock_arm64, ...) so several
// architectures can share /opt/ubersdr-clock/. Falls back to the unsuffixed
// name so a hand install that dropped one binary in still works — the same
// arrangement the drm extension uses.
var binaryPath = resolveBinaryPath()

func resolveBinaryPath() string {
	arch := filepath.Join(binaryDir, "ubersdr-clock_"+runtime.GOARCH)
	if _, err := os.Stat(arch); err == nil {
		return arch
	}
	return filepath.Join(binaryDir, "ubersdr-clock")
}

// stopTimeout is how long Stop() waits for the subprocess to exit cleanly
// after stdin is closed before sending SIGKILL.
const stopTimeout = 2 * time.Second

// wwvbCeilingHz is the dial frequency below which the session is taken to be
// on WWVB. WWVB is received by tuning USB at 0.059 MHz; nothing else this
// decoder handles lives below 1 MHz, and the two stations need genuinely
// different decoders (a 100 Hz BCD subcarrier against PWM on the carrier's own
// amplitude), so this has to be decided before the subprocess starts.
const wwvbCeilingHz = 1_000_000

// AudioSample contains PCM audio data with timing information.
type AudioSample struct {
	PCMData      []int16
	RTPTimestamp uint32
	GPSTimeNs    int64
}

// sampleClock maps a decoder sample index onto a host timestamp.
//
// This exists because of what the offset actually means. The decoder reports
// the broadcast time at a given input sample; the offset is that minus the
// host clock at the same instant, so something has to say when a sample index
// happened. Left to itself the binary uses the wall clock when it read its
// first sample and advances by the sample count, which is all a pipe can tell
// it — and which absorbs every scheduling delay between here and there, then
// keeps that error for the life of the process.
//
// Here we can do better: every AudioSample carries the time its RTP packet
// arrived, so the mapping is re-anchored continuously rather than once.
//
// It is NOT a hardware timestamp, whatever the AudioSample field name says:
// audio.go takes it as time.Now().UnixNano() when the packet arrives from
// radiod. So the residual error is radiod's own buffering plus the multicast
// hop — a fixed bias of some tens of milliseconds, not a drift. Good enough to
// say a browser clock is 3 seconds out; not good enough to discipline an NTP
// server with, and the panel does not offer to.
//
// A packet's arrival is taken as the time of its LAST sample: its audio was
// captured before it was sent, so the end of the block is the closer of the
// two edges to the moment it landed here.
type sampleClock struct {
	mu     sync.Mutex
	rate   int
	marks  []clockMark
	cursor int   // next write position (ring)
	filled bool  // the ring has wrapped
	total  int64 // samples written to the subprocess so far
}

type clockMark struct {
	sample int64 // decoder sample index of the end of a block
	hostNs int64
}

// A few minutes of marks at ~50 packets/s, which is more than the decoder's
// 8-frame voter window can ever reach back for.
const clockMarkCap = 4096

func newSampleClock(rate int) *sampleClock {
	return &sampleClock{rate: rate, marks: make([]clockMark, clockMarkCap)}
}

// advance records that n samples ending at host time hostNs have been written.
func (c *sampleClock) advance(n int, hostNs int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.total += int64(n)
	if hostNs <= 0 {
		return // nothing useful to anchor to; leave the ring alone
	}
	c.marks[c.cursor] = clockMark{sample: c.total, hostNs: hostNs}
	c.cursor++
	if c.cursor == len(c.marks) {
		c.cursor = 0
		c.filled = true
	}
}

// hostMsAt returns the host time in milliseconds at a decoder sample index,
// and whether an anchor was available at all.
//
// The nearest mark is used and extrapolated from, rather than interpolating
// between two: consecutive marks are one RTP packet apart, so the nearest is
// always within a packet of the sample being asked about, and extrapolating a
// few milliseconds at the true sample rate is more honest than interpolating
// across a gap where a packet may have been dropped.
func (c *sampleClock) hostMsAt(sample int64) (float64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	n := len(c.marks)
	if !c.filled {
		n = c.cursor
	}
	if n == 0 {
		return 0, false
	}

	best := clockMark{}
	bestDist := int64(-1)
	for i := 0; i < n; i++ {
		m := c.marks[i]
		if m.hostNs == 0 {
			continue
		}
		d := m.sample - sample
		if d < 0 {
			d = -d
		}
		if bestDist < 0 || d < bestDist {
			bestDist, best = d, m
		}
	}
	if bestDist < 0 {
		return 0, false
	}

	deltaMs := float64(sample-best.sample) * 1000.0 / float64(c.rate)
	return float64(best.hostNs)/1e6 + deltaMs, true
}

// ClockExtension wraps the ubersdr-clock subprocess.
type ClockExtension struct {
	sampleRate int
	station    string // "wwv" or "wwvb"
	tunedHz    uint64

	clock *sampleClock

	mu     sync.Mutex
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser

	// running is accessed atomically so readLoop/writeLoop can check it
	// without holding mu (avoids lock contention on the hot audio path).
	running atomic.Bool

	stopChan  chan struct{}
	crashChan chan error
	wg        sync.WaitGroup
}

// NewClockExtension creates a new clock extension instance.
// Returns an error immediately if the binary is not found.
func NewClockExtension(sampleRate int, extensionParams map[string]interface{}) (*ClockExtension, error) {
	if _, err := os.Stat(binaryPath); os.IsNotExist(err) {
		return nil, fmt.Errorf("ubersdr-clock binary not found at %s — "+
			"install it from https://github.com/madpsy/ubersdr-clock", binaryPath)
	}

	// The decoders decimate to a fixed series rate — 200 Hz for WWV/WWVH,
	// 100 Hz for WWVB — so a rate that is not a multiple of it decimates
	// unevenly and drifts. Every UberSDR mode rate clears this (12000 and
	// 24000 both divide by 200), but a refused attach naming the reason beats
	// a decoder that silently never locks.
	// The <= 0 half is not redundant with the modulo: 0 %% 200 is 0, so a
	// zero rate passed the divisibility check and reached the binary as
	// --sample-rate 0, turning an attach-time refusal into a subprocess that
	// fails to start for reasons the user never sees.
	if sampleRate <= 0 || sampleRate%200 != 0 {
		return nil, fmt.Errorf("clock: sample rate %d Hz must be positive and a multiple "+
			"of 200 Hz, or it cannot be decimated evenly", sampleRate)
	}

	// Station from the dial, not from the user: the manager injects the tuned
	// frequency into every attach, and the two stations are different decoders
	// rather than a setting.
	var tunedHz uint64
	switch v := extensionParams["tuned_frequency_hz"].(type) {
	case float64:
		tunedHz = uint64(v)
	case uint64:
		tunedHz = v
	case int64:
		tunedHz = uint64(v)
	case int:
		tunedHz = uint64(v)
	}

	station := "wwv"
	if tunedHz > 0 && tunedHz < wwvbCeilingHz {
		station = "wwvb"
	}
	// An explicit override, for a receiver whose dial the server cannot see
	// the way the panel does. Not exposed in the UI.
	if s, ok := extensionParams["station"].(string); ok {
		switch s {
		case "wwv", "wwvh", "wwvb":
			station = s
		default:
			return nil, fmt.Errorf("clock: unknown station %q (expected wwv, wwvh or wwvb)", s)
		}
	}

	log.Printf("[Clock] Created: %d Hz, station=%s, dial=%.6f MHz",
		sampleRate, station, float64(tunedHz)/1e6)

	return &ClockExtension{
		sampleRate: sampleRate,
		station:    station,
		tunedHz:    tunedHz,
		clock:      newSampleClock(sampleRate),
	}, nil
}

// GetName returns the extension name.
func (e *ClockExtension) GetName() string { return "clock" }

// CrashChan implements the manager's optional CrashReporter interface, so a
// subprocess that dies while the extension is still attached reaches the
// frontend as an error rather than as silence.
func (e *ClockExtension) CrashChan() <-chan error {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.crashChan
}

// Start launches the subprocess and begins the read/write goroutines.
// Safe to call after a previous Stop().
func (e *ClockExtension) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.running.Load() {
		return fmt.Errorf("clock decoder already running")
	}

	args := []string{
		"--sample-rate", strconv.Itoa(e.sampleRate),
		"--station", e.station,
		// The 1 s alignment arrays, ~1.4 kB/s on top of a 24 kB/s audio
		// session. Always on rather than a toggle: they are attach-time
		// parameters, so turning them on later would restart the decoder and
		// throw away a lock that takes four minutes of clean signal to
		// acquire. Nobody would trade that for a display they can already see.
		"--envelope",
		// The panel is the only consumer and it renders diagnostics live, so
		// the default 10 s interval is too coarse to watch an acquisition.
		"--diag-seconds", "2",
	}

	cmd := exec.Command(binaryPath, args...)
	// nil, NOT io.Discard. They look equivalent and are not: an io.Writer makes
	// exec build a pipe and run a goroutine copying it, and cmd.Wait() blocks
	// until every writer on that pipe is closed. Kill() ends the process we
	// spawned but not anything IT spawned, so one orphaned grandchild holding
	// stderr open makes Wait() — and therefore Stop(), and therefore the
	// manager's whole teardown — hang for ever, with the session unable to
	// detach. nil hands the child os.DevNull directly: no pipe, no goroutine,
	// nothing to wait on. Caught by TestAStubbornGrandchildDoesNotWedgeStop.
	//
	// stderr is dropped rather than logged because the binary only writes
	// argument errors there, and those are refused before we reach here.
	cmd.Stderr = nil

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start ubersdr-clock: %w", err)
	}

	e.cmd = cmd
	e.stdin = stdin
	e.stdout = stdout
	e.stopChan = make(chan struct{})
	e.crashChan = make(chan error, 1)
	e.clock = newSampleClock(e.sampleRate)
	e.running.Store(true)

	log.Printf("[Clock pid=%d] Started ubersdr-clock (%d Hz, %s)",
		cmd.Process.Pid, e.sampleRate, e.station)

	e.wg.Add(2)
	go e.writeLoop(audioChan)
	go e.readLoop(resultChan, e.crashChan)

	return nil
}

// Stop signals the subprocess to exit and waits for the goroutines to finish.
// Idempotent — safe to call multiple times.
func (e *ClockExtension) Stop() error {
	e.mu.Lock()
	if !e.running.Load() {
		e.mu.Unlock()
		return nil
	}
	e.running.Store(false)
	stopChan := e.stopChan
	stdin := e.stdin
	stdout := e.stdout
	cmd := e.cmd
	e.mu.Unlock()

	// Unblock writeLoop.
	close(stopChan)

	// Close stdin → subprocess sees EOF → exits → stdout closes → readLoop exits.
	// That is the whole shutdown when the binary is behaving.
	if stdin != nil {
		_ = stdin.Close()
	}

	// Both goroutines must finish before cmd.Wait() — StdoutPipe forbids
	// waiting while a read is still in flight — and then the PROCESS has to
	// actually exit before Wait() returns. One deadline covers both, because
	// either can be what is stuck:
	//
	//   the goroutines   readLoop sits in Scan() on a subprocess that is alive
	//                    and silent;
	//   the process      readLoop has already returned (a crash, a malformed
	//                    line, an over-long one) and the subprocess is still
	//                    running, wedged writing into a stdout pipe nobody
	//                    reads any more.
	//
	// The second is what an earlier version got wrong: it timed out on the
	// goroutines only, so a subprocess that outlived its read loop hung Stop()
	// for ever, and with it the manager's teardown and the session's ability to
	// detach. Caught by TestAnAbsurdlyLongLineDoesNotWedgeTheReader.
	finished := make(chan struct{})
	go func() {
		e.wg.Wait()
		if cmd != nil {
			_ = cmd.Wait() // reap
		}
		close(finished)
	}()

	select {
	case <-finished:
		// Left on its own.
	case <-time.After(stopTimeout):
		log.Printf("[Clock] subprocess did not exit within %s — killing", stopTimeout)
		if cmd != nil && cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		// Killing the process we started does not free a reader blocked on a
		// pipe that one of ITS children still holds open, so close our end as
		// well. Closing an *os.File out from under an in-flight Read is safe
		// here — the runtime poller returns ErrFileClosing rather than
		// blocking — and it is the only thing that reliably ends readLoop.
		if stdout != nil {
			_ = stdout.Close()
		}
		<-finished
	}

	log.Printf("[Clock] ubersdr-clock stopped")
	return nil
}

// writeLoop reads AudioSamples from audioChan and writes raw int16 LE PCM to
// the subprocess stdin, recording the sample<->host mapping as it goes.
func (e *ClockExtension) writeLoop(audioChan <-chan AudioSample) {
	defer e.wg.Done()

	for {
		select {
		case <-e.stopChan:
			return
		case sample, ok := <-audioChan:
			if !ok {
				return
			}
			if len(sample.PCMData) == 0 {
				continue
			}

			e.clock.advance(len(sample.PCMData), sample.GPSTimeNs)

			// Cast []int16 → []byte in place. Safe on little-endian platforms
			// (amd64, arm64 — the only two this ships for), and it is what the
			// binary reads: audio.go has already byte-swapped radiod's
			// big-endian PCM into host-order int16.
			n := len(sample.PCMData) * 2
			byteSlice := unsafe.Slice((*byte)(unsafe.Pointer(&sample.PCMData[0])), n)
			if _, err := e.stdin.Write(byteSlice); err != nil {
				if e.running.Load() {
					log.Printf("[Clock] stdin write error: %v", err)
				}
				return
			}
		}
	}
}

// readLoop reads newline-delimited JSON from the subprocess stdout and
// forwards each line to the frontend as a binary frame.
func (e *ClockExtension) readLoop(resultChan chan<- []byte, crashChan chan error) {
	defer e.wg.Done()

	scanner := bufio.NewScanner(e.stdout)
	// A `second` event carrying two 200-point float arrays runs to a few kB;
	// the default 64 kB ceiling is ample, but the starting buffer is not, and
	// a Scanner that hits its limit stops silently.
	scanner.Buffer(make([]byte, 0, 16*1024), 256*1024)

	for scanner.Scan() {
		line := scanner.Bytes()

		// Validated here, once, rather than left to the client. A prefix check
		// alone would pass `{ broken json` straight through, and while the
		// panel does drop what it cannot parse, a frontend that has to defend
		// itself against its own decoder is one bad line away from a blank
		// panel. The unmarshal is not extra work: rewriteOffset needs it too.
		out, ok := e.rewriteOffset(line)
		if !ok {
			continue
		}

		// Copy: Scanner reuses its buffer, and this crosses a channel.
		frame := make([]byte, len(out))
		copy(frame, out)

		select {
		case resultChan <- frame:
		case <-e.stopChan:
			return
		default:
			// The client is not draining. Dropping a decode is right: these
			// are status updates and a stale one is worth nothing, whereas
			// blocking here would stall the audio writer behind it.
		}
	}

	// Scanner ended. If we did not ask for that, the subprocess died.
	if e.running.Load() {
		err := scanner.Err()
		log.Printf("[Clock] subprocess output ended unexpectedly: %v", err)
		select {
		case crashChan <- err:
		default:
		}
	}
}

// rewriteOffset parses one line of the binary's output, replacing the offset
// on a `time` event with one measured against RTP packet arrival — see the
// sampleClock comment.
//
// Returns ok=false for anything that is not a JSON object, which is how the
// read loop drops noise. Every other event is returned exactly as it arrived:
// this understands the one field it rewrites and nothing else, so a future
// event type passes through untouched rather than being reshaped by a
// round trip through a map.
func (e *ClockExtension) rewriteOffset(line []byte) ([]byte, bool) {
	var ev map[string]interface{}
	if err := json.Unmarshal(line, &ev); err != nil || ev == nil {
		return nil, false
	}
	if t, _ := ev["type"].(string); t != "time" {
		return line, true
	}

	utcMs, ok1 := ev["utc_ms"].(float64)
	edge, ok2 := ev["last_edge_sample"].(float64)
	if !ok1 || !ok2 {
		return line, true
	}

	hostMs, ok := e.clock.hostMsAt(int64(edge))
	if !ok {
		// No anchor yet — the binary's own offset is the best there is, and
		// leaving it alone is better than reporting one measured against
		// nothing.
		return line, true
	}

	ev["offset_ms"] = utcMs - hostMs
	// So the panel can say which clock the number is against rather than
	// implying a precision neither of them has.
	ev["offset_source"] = "packet"

	out, err := json.Marshal(ev)
	if err != nil {
		return line, true
	}
	return out, true
}
