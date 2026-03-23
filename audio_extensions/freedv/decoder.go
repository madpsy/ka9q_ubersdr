package freedv

import (
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"gopkg.in/hraban/opus.v2"
)

/*
 * FreeDV Decoder
 * Manages the freedv-ka9q subprocess lifecycle.
 *
 * The binary reads raw int16 PCM from stdin and writes decoded int16 PCM to
 * stdout only when a valid RADE signal is present (output is sparse).
 * All log output from the binary goes to stderr.
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
 *   - PCM from stdout is accumulated until a full frame is available
 */

const (
	// MessageTypeAudioFrame is reserved for raw PCM (not currently sent)
	MessageTypeAudioFrame = 0x01

	// MessageTypeOpusFrame is the binary protocol message type for Opus-encoded audio
	MessageTypeOpusFrame = 0x02

	// opusFrameSamples is the number of int16 samples per Opus frame.
	// 20 ms at 16 kHz = 320 samples — a standard Opus wideband frame duration.
	opusFrameSamples = 320

	// readBufSamples is the number of int16 samples to read per iteration from stdout.
	readBufSamples = 1024
)

// FreeDVDecoder manages the freedv-ka9q subprocess
type FreeDVDecoder struct {
	config FreeDVConfig

	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser

	opusEncoder *opus.Encoder // Opus encoder for decoded audio output

	running   bool
	stopChan  chan struct{}
	crashChan chan error // closed/sent when subprocess exits unexpectedly
	wg        sync.WaitGroup
	mu        sync.Mutex
}

// NewFreeDVDecoder creates a new FreeDVDecoder but does not start the subprocess yet.
// An Opus encoder is initialised here so that any error surfaces before the subprocess starts.
func NewFreeDVDecoder(config FreeDVConfig) (*FreeDVDecoder, error) {
	enc, err := opus.NewEncoder(config.OutputSampleRate, 1, opus.AppVoIP)
	if err != nil {
		return nil, fmt.Errorf("failed to create Opus encoder (%d Hz): %w", config.OutputSampleRate, err)
	}

	return &FreeDVDecoder{
		config:      config,
		opusEncoder: enc,
		stopChan:    make(chan struct{}),
		crashChan:   make(chan error, 1),
	}, nil
}

// Start launches the subprocess and begins the read/write goroutines.
func (d *FreeDVDecoder) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.running {
		return fmt.Errorf("FreeDV decoder already running")
	}

	// Build argument list
	args := []string{
		"--input-sample-rate", strconv.Itoa(d.config.InputSampleRate),
		"--output-sample-rate", strconv.Itoa(d.config.OutputSampleRate),
	}

	// Only add reporting args when reporting is enabled and all three required fields are present.
	// Set enableReporting = true in extension.go to activate FreeDV Reporter.
	if enableReporting && d.config.Callsign != "" && d.config.Locator != "" && d.config.FreqHz > 0 {
		args = append(args,
			"--reporting-callsign", d.config.Callsign,
			"--reporting-locator", d.config.Locator,
			"--reporting-freq-hz", strconv.FormatInt(d.config.FreqHz, 10),
		)
		if d.config.Message != "" {
			args = append(args, "--reporting-message", d.config.Message)
		}
	}

	cmd := exec.Command(binaryPath, args...)
	cmd.Stderr = io.Discard // suppress noisy binary stderr output

	// The freedv-ka9q binary depends on shared libraries (e.g. libRADE) that live
	// in the same directory as the binary. Prepend that directory to LD_LIBRARY_PATH
	// so the dynamic linker can find them without requiring a system-wide install.
	binaryDir := filepath.Dir(binaryPath)
	ldLibPath := binaryDir
	if existing := os.Getenv("LD_LIBRARY_PATH"); existing != "" {
		ldLibPath = binaryDir + ":" + existing
	}
	cmd.Env = append(os.Environ(), "LD_LIBRARY_PATH="+ldLibPath)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return fmt.Errorf("failed to start %s: %w", binaryPath, err)
	}

	d.cmd = cmd
	d.stdin = stdin
	d.stdout = stdout
	d.running = true

	log.Printf("[FreeDV] Subprocess started (pid=%d): %s %v", cmd.Process.Pid, binaryPath, args)

	// writeLoop: forward PCM from audioChan → subprocess stdin
	d.wg.Add(1)
	go d.writeLoop(audioChan)

	// readLoop: read decoded PCM from subprocess stdout → resultChan
	d.wg.Add(1)
	go d.readLoop(resultChan)

	// waitLoop: reap the subprocess when it exits
	d.wg.Add(1)
	go d.waitLoop()

	return nil
}

// Stop shuts down the subprocess cleanly by closing stdin, then waits for goroutines.
func (d *FreeDVDecoder) Stop() error {
	d.mu.Lock()
	if !d.running {
		d.mu.Unlock()
		return nil
	}
	d.running = false
	close(d.stopChan)

	// Closing stdin signals the binary to exit ("stdin pipe closed, exiting")
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
		log.Printf("[FreeDV] Subprocess did not exit in time, killing")
		d.mu.Lock()
		if d.cmd != nil && d.cmd.Process != nil {
			_ = d.cmd.Process.Kill()
		}
		d.mu.Unlock()
		d.wg.Wait()
	}

	log.Printf("[FreeDV] Subprocess stopped")
	return nil
}

// writeLoop reads AudioSamples from audioChan and writes raw int16 PCM to the subprocess stdin.
// The binary uses native-endian int16 (C short via read()/write()), which on x86/ARM Linux is
// little-endian — the same byte order as Go's binary.LittleEndian.
func (d *FreeDVDecoder) writeLoop(audioChan <-chan AudioSample) {
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

// readLoop reads decoded int16 PCM from the subprocess stdout, accumulates complete
// 20 ms Opus frames (240 samples at 12 kHz), encodes them with Opus, and sends the
// result to the frontend. Output is sparse — only present when a RADE signal is decoded.
func (d *FreeDVDecoder) readLoop(resultChan chan<- []byte) {
	defer d.wg.Done()

	readBuf := make([]byte, readBufSamples*2)      // raw read buffer (bytes from stdout)
	pcmBuf := make([]int16, 0, opusFrameSamples*2) // accumulation buffer (int16 samples)
	opusBuf := make([]byte, 4000)                  // max Opus frame size

	for {
		// Blocking read — returns io.EOF when the subprocess exits
		n, err := d.stdout.Read(readBuf)
		if n > 0 {
			// Trim to the last complete int16 sample (n must be even)
			n = n &^ 1

			// Decode bytes → int16 samples and append to accumulation buffer
			for i := 0; i < n; i += 2 {
				pcmBuf = append(pcmBuf, int16(binary.LittleEndian.Uint16(readBuf[i:])))
			}

			// Encode and emit as many complete Opus frames as we have
			for len(pcmBuf) >= opusFrameSamples {
				frame := pcmBuf[:opusFrameSamples]
				pcmBuf = pcmBuf[opusFrameSamples:]

				nEncoded, encErr := d.opusEncoder.Encode(frame, opusBuf)
				if encErr != nil {
					log.Printf("[FreeDV] Opus encode error: %v", encErr)
					continue
				}

				timestamp := time.Now().UnixNano()
				pkt := encodeOpusFrame(opusBuf[:nEncoded], d.config.OutputSampleRate, timestamp)

				select {
				case resultChan <- pkt:
				default:
					log.Printf("[FreeDV] Result channel full, dropping Opus frame")
				}
			}
		}

		if err != nil {
			if err != io.EOF {
				d.mu.Lock()
				running := d.running
				d.mu.Unlock()
				if running {
					log.Printf("[FreeDV] stdout read error: %v", err)
				}
			}
			return
		}
	}
}

// waitLoop waits for the subprocess to exit and logs the result.
// If the subprocess exits while d.running is still true (i.e. not due to Stop()),
// it sends the exit error (or a sentinel) to crashChan so the manager can notify
// the frontend.
func (d *FreeDVDecoder) waitLoop() {
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
			log.Printf("[FreeDV] Subprocess exited unexpectedly: %v", err)
			select {
			case d.crashChan <- err:
			default:
			}
		} else {
			// Exited with code 0 but we didn't ask it to stop
			log.Printf("[FreeDV] Subprocess exited unexpectedly (exit code 0)")
			select {
			case d.crashChan <- fmt.Errorf("freedv-ka9q exited unexpectedly"):
			default:
			}
		}
	} else {
		log.Printf("[FreeDV] Subprocess exited cleanly")
	}
}

// CrashChan returns a channel that receives an error if the subprocess crashes
// while the decoder is still supposed to be running. The channel is buffered (1)
// and will receive at most one value.
func (d *FreeDVDecoder) CrashChan() <-chan error {
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
