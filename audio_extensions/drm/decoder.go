package drm

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"gopkg.in/hraban/opus.v2"
)

/*
 * DRM Decoder
 * Manages the ubersdr-drm subprocess lifecycle.
 *
 * The binary reads stereo int16 IQ from stdin (little-endian, I=even, Q=odd)
 * and writes mono int16 PCM to stdout (little-endian, 12 kHz) when a DRM
 * signal is being decoded.
 *
 * Wire protocol (backend → frontend):
 *   [type:1=0x02][timestamp:8][sample_rate:4][channels:1][opus_data: N bytes]
 *   type        - 0x02 = Opus audio frame
 *   timestamp   - GPS Unix time in nanoseconds (big-endian uint64)
 *   sample_rate - output sample rate in Hz (big-endian uint32)
 *   channels    - number of channels (uint8, always 1)
 *   opus_data   - Opus-encoded audio bytes
 *
 * Opus encoding:
 *   - 12 kHz mono, AppVoIP application type
 *   - 20 ms frames (240 samples at 12 kHz)
 *   - PCM from stdout is accumulated in a shared ring buffer.
 *     A time.Ticker emits exactly one Opus frame every 20 ms, re-pacing
 *     the bursty output of the binary.
 *
 * Status protocol (backend → frontend):
 *   [type:1=0x03][json: N bytes]
 *   The binary writes JSON Lines on fd 3 — station label, text message,
 *   country, language and signal quality — which statusLoop forwards
 *   verbatim. Keeping it off stdout leaves the audio stream headerless.
 */

const (
	// MessageTypeOpusFrame is the binary protocol message type for Opus-encoded audio.
	MessageTypeOpusFrame = 0x02

	// MessageTypeStatus carries one JSON status object from the decoder: the
	// station label, text message, country and language, and the signal
	// quality figures. The binary writes these on a descriptor of its own so
	// stdout stays raw PCM; see statusLoop.
	MessageTypeStatus = 0x03

	// maxStatusLine bounds a single status line. The binary caps its own at
	// 2 KB; this is the guard against a wedged pipe growing the scanner buffer
	// without limit.
	maxStatusLine = 64 * 1024

	// opusFrameSamples is the number of int16 samples per Opus frame.
	// 20 ms at 12 kHz = 240 samples.
	opusFrameSamples = 240

	// readBufSamples is the number of int16 samples to read per iteration from stdout.
	readBufSamples = 1024

	// maxPCMBufSamples caps the shared PCM accumulation buffer at 1 s of audio
	// (12000 samples at 12 kHz). Oldest samples are dropped on overflow. The
	// binary emits a whole 400 ms audio super frame at a time, so the cap has
	// to clear that burst plus scheduling jitter comfortably.
	maxPCMBufSamples = 12000

	// maxFramesPerTick bounds how fast the emitter may drain a backlog, so a
	// stalled-then-flushed subprocess doesn't dump a burst at the browser.
	maxFramesPerTick = 2

	// catchUpThresholdSamples is the backlog (60 ms) above which the emitter
	// sends a second frame in the same tick to claw back the ticker's drift.
	catchUpThresholdSamples = 3 * opusFrameSamples
)

// DRMDecoder manages the ubersdr-drm subprocess.
type DRMDecoder struct {
	config DRMConfig

	cmd     *exec.Cmd
	stdin   io.WriteCloser
	stdout  io.ReadCloser
	statusR *os.File // read end of the binary's fd 3 status channel

	opusEncoder *opus.Encoder // Opus encoder for decoded audio output

	running   bool
	stopChan  chan struct{}
	crashChan chan error // closed/sent when subprocess exits unexpectedly
	wg        sync.WaitGroup
	mu        sync.Mutex
}

// NewDRMDecoder creates a new DRMDecoder but does not start the subprocess yet.
// An Opus encoder is initialised here so that any error surfaces before the subprocess starts.
func NewDRMDecoder(config DRMConfig) (*DRMDecoder, error) {
	enc, err := opus.NewEncoder(config.OutputSampleRate, 1, opus.AppVoIP)
	if err != nil {
		return nil, fmt.Errorf("failed to create Opus encoder (%d Hz): %w", config.OutputSampleRate, err)
	}

	return &DRMDecoder{
		config:      config,
		opusEncoder: enc,
		stopChan:    make(chan struct{}),
		crashChan:   make(chan error, 1),
	}, nil
}

// Start launches the subprocess and begins the read/write goroutines.
func (d *DRMDecoder) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.running {
		return fmt.Errorf("DRM decoder already running")
	}

	// Build argument list
	args := []string{
		"--input-sample-rate", strconv.Itoa(d.config.InputSampleRate),
	}

	cmd := exec.Command(binaryPath, args...)
	// The binary only reports acquisition/decode state changes on stderr, so
	// forward it to the log — it is the only visibility into whether a DRM
	// signal actually locked.
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("failed to create stderr pipe: %w", err)
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	// The status channel. ExtraFiles[0] becomes fd 3 in the child, which is
	// where the binary writes its JSON Lines by default. A failure here is not
	// fatal: the decoder runs perfectly well with no status channel, and audio
	// matters more than metadata.
	statusR, statusW, err := os.Pipe()
	if err != nil {
		log.Printf("[DRM] Warning: no status channel (pipe failed: %v)", err)
	} else {
		cmd.ExtraFiles = []*os.File{statusW}
	}

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return fmt.Errorf("failed to start %s: %w", binaryPath, err)
	}

	// Deprioritise the DRM decoder child — CPU-heavy but not latency-sensitive
	if err := syscall.Setpriority(syscall.PRIO_PROCESS, cmd.Process.Pid, 10); err != nil {
		log.Printf("[DRM] Warning: failed to renice decoder process %d: %v", cmd.Process.Pid, err)
	}

	d.cmd = cmd
	d.stdin = stdin
	d.stdout = stdout
	d.running = true

	log.Printf("[DRM] Subprocess started (pid=%d): %s %v", cmd.Process.Pid, binaryPath, args)

	// The child holds its own copy of the write end; this one has to go or the
	// reader below never sees EOF when the subprocess exits.
	if statusW != nil {
		_ = statusW.Close()
	}
	if statusR != nil {
		d.statusR = statusR
		d.wg.Add(1)
		go d.statusLoop(statusR, resultChan)
	}

	// stderrLoop: relay the binary's status lines to the log. Not tracked by
	// wg — it ends at EOF when the subprocess exits.
	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || isPeriodicStatusLine(line) {
				continue
			}
			log.Printf("[DRM] %s", line)
		}
	}()

	// writeLoop: forward IQ PCM from audioChan → subprocess stdin
	d.wg.Add(1)
	go d.writeLoop(audioChan)

	// readLoop: read decoded mono PCM from subprocess stdout → resultChan
	d.wg.Add(1)
	go d.readLoop(resultChan)

	// waitLoop: reap the subprocess when it exits
	d.wg.Add(1)
	go d.waitLoop()

	return nil
}

// Stop shuts down the subprocess cleanly by closing stdin, then waits for goroutines.
func (d *DRMDecoder) Stop() error {
	d.mu.Lock()
	if !d.running {
		d.mu.Unlock()
		return nil
	}
	d.running = false
	close(d.stopChan)

	// Closing stdin signals the binary to exit
	if d.stdin != nil {
		_ = d.stdin.Close()
	}
	d.mu.Unlock()

	// Give the process a moment to exit gracefully, then kill it
	done := make(chan struct{})
	go func() {
		d.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		// clean exit
	case <-time.After(3 * time.Second):
		log.Printf("[DRM] Subprocess did not exit in time, killing")
		d.mu.Lock()
		if d.cmd != nil && d.cmd.Process != nil {
			_ = d.cmd.Process.Kill()
		}
		d.mu.Unlock()
		d.wg.Wait()
	}

	log.Printf("[DRM] Subprocess stopped")
	return nil
}

// isPeriodicStatusLine reports whether a stderr line is one of the binary's
// once-a-second acquisition telemetry lines, e.g.
//
//	[ubersdr-drm] acq=1 fac=3 sdc=1 audio=0 wmer=4.9 dB service=""
//
// They say nothing a state change doesn't already log, and at one per second
// they bury everything else, so they are dropped rather than relayed.
func isPeriodicStatusLine(line string) bool {
	return strings.Contains(line, "acq=") && strings.Contains(line, "wmer=")
}

// writeLoop reads AudioSamples from audioChan and writes stereo IQ int16 PCM
// to the subprocess stdin as little-endian bytes.
// The binary uses native-endian int16 (C short via fread()), which on x86/ARM
// Linux is little-endian — the same byte order as Go's binary.LittleEndian.
func (d *DRMDecoder) writeLoop(audioChan <-chan AudioSample) {
	defer d.wg.Done()

	for {
		select {
		case <-d.stopChan:
			return

		case sample, ok := <-audioChan:
			if !ok {
				// audioChan closed — extension is being torn down
				return
			}

			if len(sample.PCMData) == 0 {
				continue
			}

			// Encode int16 samples as little-endian bytes
			buf := make([]byte, len(sample.PCMData)*2)
			for i, s := range sample.PCMData {
				binary.LittleEndian.PutUint16(buf[i*2:], uint16(s))
			}

			d.mu.Lock()
			stdin := d.stdin
			d.mu.Unlock()

			if stdin == nil {
				return
			}

			if _, err := stdin.Write(buf); err != nil {
				// stdin closed — subprocess has exited or Stop() was called
				return
			}
		}
	}
}

// readLoop reads decoded mono int16 PCM from the subprocess stdout and re-paces
// it for smooth playback in the browser.
//
// The ubersdr-drm binary may write multiple frames at once when it catches up
// after a stall. We accumulate into a shared buffer and emit exactly one Opus
// frame every 20 ms via a time.Ticker to prevent burst-induced stuttering.
func (d *DRMDecoder) readLoop(resultChan chan<- []byte) {
	defer d.wg.Done()

	// pcmBuf is the shared accumulation buffer between the stdout reader and
	// the ticker emitter.
	var pcmMu sync.Mutex
	pcmBuf := make([]int16, 0, maxPCMBufSamples)

	opusBuf := make([]byte, 4000) // max Opus frame size — reused by ticker goroutine only

	// Inner goroutine: read stdout → accumulate into pcmBuf.
	// Not tracked by wg — exits naturally when stdout is closed (EOF) after
	// Stop() closes stdin and the binary exits.
	go func() {
		readBuf := make([]byte, readBufSamples*2)
		for {
			n, err := d.stdout.Read(readBuf)
			if n > 0 {
				// Trim to the last complete int16 sample (n must be even)
				n = n &^ 1

				pcmMu.Lock()
				for i := 0; i < n; i += 2 {
					pcmBuf = append(pcmBuf, int16(binary.LittleEndian.Uint16(readBuf[i:])))
				}
				// Cap the buffer to prevent unbounded latency growth.
				// Drop the oldest samples so the listener hears the most recent audio.
				if len(pcmBuf) > maxPCMBufSamples {
					dropped := len(pcmBuf) - maxPCMBufSamples
					pcmBuf = pcmBuf[dropped:]
					log.Printf("[DRM] PCM buffer overflow, dropped %d old samples", dropped)
				}
				pcmMu.Unlock()
			}
			if err != nil {
				if err != io.EOF {
					d.mu.Lock()
					running := d.running
					d.mu.Unlock()
					if running {
						log.Printf("[DRM] stdout read error: %v", err)
					}
				}
				return
			}
		}
	}()

	// Ticker: emit exactly one Opus frame every 20 ms.
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-d.stopChan:
			return

		case <-ticker.C:
			// One frame per tick, plus a catch-up frame whenever a backlog has
			// built up. A 20 ms ticker fires marginally slower than 50 Hz, so
			// draining strictly one frame per tick consumes slightly under
			// 12 kHz and the buffer creeps upwards until it overflows and
			// discards audio — roughly one dropped frame per second.
			for emitted := 0; emitted < maxFramesPerTick; emitted++ {
				pcmMu.Lock()
				if len(pcmBuf) < opusFrameSamples {
					// Binary hasn't decoded a frame this tick.
					pcmMu.Unlock()
					break
				}
				// Take exactly one frame from the front of the buffer.
				frame := make([]int16, opusFrameSamples)
				copy(frame, pcmBuf[:opusFrameSamples])
				pcmBuf = pcmBuf[opusFrameSamples:]
				backlog := len(pcmBuf)
				pcmMu.Unlock()

				nEncoded, encErr := d.opusEncoder.Encode(frame, opusBuf)
				if encErr != nil {
					log.Printf("[DRM] Opus encode error: %v", encErr)
					break
				}

				timestamp := time.Now().UnixNano()
				pkt := encodeOpusFrame(opusBuf[:nEncoded], d.config.OutputSampleRate, timestamp)

				select {
				case resultChan <- pkt:
				default:
					log.Printf("[DRM] Result channel full, dropping Opus frame")
				}

				if backlog < catchUpThresholdSamples {
					break
				}
			}
		}
	}
}

// statusLoop forwards the binary's JSON Lines status channel to the frontend.
//
// Each line is sent on as a 0x03 frame with the JSON untouched, so adding a
// field to the binary needs no change here. Lines are only parsed far enough
// to log the first lock — the frontend does the rest.
func (d *DRMDecoder) statusLoop(r *os.File, resultChan chan<- []byte) {
	defer d.wg.Done()
	defer r.Close()

	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 8*1024), maxStatusLine)

	logged := false
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}

		// Say once when a station is identified. Repeating it every second
		// would bury the log, and the frontend shows the live value anyway.
		if !logged {
			var st struct {
				Service string  `json:"service"`
				Audio   int     `json:"audio"`
				WMER    float64 `json:"wmer"`
			}
			if json.Unmarshal(line, &st) == nil && st.Service != "" {
				log.Printf("[DRM] Decoding %q (audio=%d, wmer=%.1f dB)", st.Service, st.Audio, st.WMER)
				logged = true
			}
		}

		pkt := make([]byte, 1+len(line))
		pkt[0] = MessageTypeStatus
		copy(pkt[1:], line)

		select {
		case resultChan <- pkt:
		case <-d.stopChan:
			return
		default:
			// Status is not worth blocking audio for; the next line supersedes
			// this one a second later.
		}
	}

	if err := sc.Err(); err != nil {
		d.mu.Lock()
		running := d.running
		d.mu.Unlock()
		if running {
			log.Printf("[DRM] status channel read error: %v", err)
		}
	}
}

// waitLoop waits for the subprocess to exit and logs the result.
// If the subprocess exits while d.running is still true (i.e. not due to Stop()),
// it sends the exit error to crashChan so the manager can notify the frontend.
func (d *DRMDecoder) waitLoop() {
	defer d.wg.Done()

	if d.cmd == nil {
		return
	}

	err := d.cmd.Wait()

	d.mu.Lock()
	running := d.running
	d.mu.Unlock()

	if running {
		// Unexpected exit — subprocess crashed or was killed externally
		if err != nil {
			log.Printf("[DRM] Subprocess exited unexpectedly: %v", err)
			select {
			case d.crashChan <- err:
			default:
			}
		} else {
			log.Printf("[DRM] Subprocess exited unexpectedly (exit code 0)")
			select {
			case d.crashChan <- fmt.Errorf("ubersdr-drm exited unexpectedly"):
			default:
			}
		}
	} else {
		log.Printf("[DRM] Subprocess exited cleanly")
	}
}

// CrashChan returns a channel that receives an error if the subprocess crashes
// while the decoder is still supposed to be running. The channel is buffered (1)
// and will receive at most one value.
func (d *DRMDecoder) CrashChan() <-chan error {
	return d.crashChan
}

// encodeOpusFrame encodes an Opus-compressed audio payload into the binary wire protocol:
//
//	[type:1=0x02][timestamp:8][sample_rate:4][channels:1][opus_data: N bytes]
//
// This matches the Opus packet format used by the main WebSocket audio handler.
func encodeOpusFrame(opusData []byte, sampleRate int, timestampNs int64) []byte {
	const headerSize = 1 + 8 + 4 + 1 // type + timestamp + sample_rate + channels
	pkt := make([]byte, headerSize+len(opusData))

	pkt[0] = MessageTypeOpusFrame
	binary.BigEndian.PutUint64(pkt[1:9], uint64(timestampNs))
	binary.BigEndian.PutUint32(pkt[9:13], uint32(sampleRate))
	pkt[13] = 1 // channels: always mono
	copy(pkt[14:], opusData)

	return pkt
}
