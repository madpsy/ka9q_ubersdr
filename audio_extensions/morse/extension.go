package morse

/*
 * External CW Decoder Extension
 *
 * Spawns /usr/local/bin/cw-decoder as a subprocess.
 * The binary reads mono int16 little-endian PCM from stdin (at the session
 * sample rate) and writes newline-delimited JSON to stdout:
 *
 *   decode event:
 *     {"type":"decode","text":"CQ DE W1AW","cost":0.12,"confidence":"high","pitch":600,"speed":20}
 *
 *   stats event (pitch/speed update without new text):
 *     {"type":"stats","pitch":600,"speed":20}
 *
 * Binary wire protocol (backend → frontend):
 *
 *   0x10  Decode event
 *         [type:1=0x10][confidence:1][cost:4 float32 BE][pitch:4 float32 BE][speed:4 float32 BE]
 *         [text_len:4 uint32 BE][text: UTF-8]
 *         confidence byte: 0=high 1=medium 2=low 3=poor
 *
 *   0x11  Stats event (pitch/speed update, no text)
 *         [type:1=0x11][pitch:4 float32 BE][speed:4 float32 BE]
 *
 *   0x12  Error event (e.g. binary not found, subprocess crash)
 *         [type:1=0x12][msg_len:4 uint32 BE][msg: UTF-8]
 *
 * Multiple instances may run concurrently (one per user session).
 * All shared state is protected by e.mu or atomic operations.
 */

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"
)

const cwDecoderBinary = "/usr/local/bin/cw-decoder"

// stopTimeout is how long Stop() waits for the subprocess to exit cleanly
// after stdin is closed before sending SIGKILL.
const stopTimeout = 2 * time.Second

// Message type bytes
const (
	MsgDecode = 0x10
	MsgStats  = 0x11
	MsgError  = 0x12
)

// Confidence byte values
const (
	ConfHigh   = 0
	ConfMedium = 1
	ConfLow    = 2
	ConfPoor   = 3
)

// AudioSample contains PCM audio data with timing information
type AudioSample struct {
	PCMData      []int16
	RTPTimestamp uint32
	GPSTimeNs    int64
}

// cwEvent is the JSON structure emitted by cw-decoder on stdout
type cwEvent struct {
	Type       string  `json:"type"`
	Text       string  `json:"text"`
	Cost       float32 `json:"cost"`
	Confidence string  `json:"confidence"`
	Pitch      float32 `json:"pitch"`
	Speed      float32 `json:"speed"`
}

// ExternalMorseExtension wraps the cw-decoder subprocess.
// Multiple instances may be created and run concurrently.
type ExternalMorseExtension struct {
	sampleRate int

	mu     sync.Mutex
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser

	// running is accessed atomically so readLoop/writeLoop can check it
	// without holding mu (avoids lock contention on the hot audio path).
	running atomic.Bool

	stopChan chan struct{}
	wg       sync.WaitGroup
}

// NewMorseExtension creates a new external morse extension.
// Returns an error immediately if the binary is not found.
func NewMorseExtension(sampleRate int, _ map[string]interface{}) (*ExternalMorseExtension, error) {
	if _, err := os.Stat(cwDecoderBinary); os.IsNotExist(err) {
		return nil, fmt.Errorf("cw-decoder binary not found at %s — "+
			"build it from audio_extensions/morse/external/ and install to /usr/local/bin/",
			cwDecoderBinary)
	}
	return &ExternalMorseExtension{
		sampleRate: sampleRate,
	}, nil
}

// GetName returns the extension name
func (e *ExternalMorseExtension) GetName() string { return "morse" }

// Start launches the subprocess and begins the read/write goroutines.
// Safe to call after a previous Stop().
func (e *ExternalMorseExtension) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.running.Load() {
		return fmt.Errorf("morse decoder already running")
	}

	args := []string{"--sample-rate", strconv.Itoa(e.sampleRate)}
	cmd := exec.Command(cwDecoderBinary, args...)
	cmd.Stderr = os.Stderr // forward cw-decoder log output to our stderr

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start cw-decoder: %w", err)
	}

	e.cmd = cmd
	e.stdin = stdin
	e.stdout = stdout
	e.stopChan = make(chan struct{})
	e.running.Store(true)

	log.Printf("[Morse pid=%d] Started cw-decoder (%d Hz)", cmd.Process.Pid, e.sampleRate)

	e.wg.Add(2)
	go e.writeLoop(audioChan)
	go e.readLoop(resultChan)

	return nil
}

// Stop signals the subprocess to exit and waits for goroutines to finish.
// Idempotent — safe to call multiple times.
func (e *ExternalMorseExtension) Stop() error {
	e.mu.Lock()
	if !e.running.Load() {
		e.mu.Unlock()
		return nil
	}
	e.running.Store(false)
	stopChan := e.stopChan
	stdin := e.stdin
	cmd := e.cmd
	e.mu.Unlock()

	// Unblock writeLoop
	close(stopChan)

	// Close stdin → subprocess sees EOF → exits → stdout closes → readLoop exits
	if stdin != nil {
		_ = stdin.Close()
	}

	// Wait for goroutines with a timeout, then force-kill
	done := make(chan struct{})
	go func() {
		e.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		// Clean exit
	case <-time.After(stopTimeout):
		log.Printf("[Morse] subprocess did not exit within %s — killing", stopTimeout)
		if cmd != nil && cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		<-done // still wait for goroutines after kill
	}

	if cmd != nil {
		_ = cmd.Wait() // reap zombie
	}

	log.Printf("[Morse] cw-decoder stopped")
	return nil
}

// writeLoop reads AudioSamples from audioChan and writes raw int16 LE PCM to
// the subprocess stdin. Uses a direct memory cast on LE platforms (x86/ARM)
// to avoid the reflection overhead of binary.Write.
func (e *ExternalMorseExtension) writeLoop(audioChan <-chan AudioSample) {
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
			// Cast []int16 → []byte in-place (safe on little-endian platforms).
			// This avoids the reflection loop inside binary.Write.
			n := len(sample.PCMData) * 2
			byteSlice := unsafe.Slice((*byte)(unsafe.Pointer(&sample.PCMData[0])), n)
			if _, err := e.stdin.Write(byteSlice); err != nil {
				if e.running.Load() {
					log.Printf("[Morse] stdin write error: %v", err)
				}
				return
			}
		}
	}
}

// readLoop reads newline-delimited JSON from the subprocess stdout and converts
// each event into a binary frame sent on resultChan.
// If the subprocess exits unexpectedly while still running, a 0x12 error frame
// is sent so the frontend can display a meaningful message.
func (e *ExternalMorseExtension) readLoop(resultChan chan<- []byte) {
	defer e.wg.Done()

	scanner := bufio.NewScanner(e.stdout)
	for scanner.Scan() {
		line := scanner.Bytes()

		var ev cwEvent
		if err := json.Unmarshal(line, &ev); err != nil {
			log.Printf("[Morse] JSON parse error: %v (line: %s)", err, line)
			continue
		}

		var msg []byte
		switch ev.Type {
		case "decode":
			msg = encodeDecodeMsg(ev)
		case "stats":
			msg = encodeStatsMsg(ev)
		default:
			log.Printf("[Morse] unknown event type: %q", ev.Type)
			continue
		}

		select {
		case resultChan <- msg:
		default:
			// resultChan full — drop this frame rather than block
		}
	}

	if err := scanner.Err(); err != nil {
		log.Printf("[Morse] stdout read error: %v", err)
	}

	// If we exited the scan loop while still supposed to be running, the
	// subprocess crashed. Notify the frontend.
	if e.running.Load() {
		log.Printf("[Morse] subprocess exited unexpectedly")
		select {
		case resultChan <- encodeErrorMsg("cw-decoder subprocess exited unexpectedly"):
		default:
		}
	}
}

// encodeDecodeMsg builds a 0x10 binary frame.
//
//	[type:1=0x10][confidence:1][cost:4 float32 BE][pitch:4 float32 BE][speed:4 float32 BE]
//	[text_len:4 uint32 BE][text: UTF-8]
func encodeDecodeMsg(ev cwEvent) []byte {
	textBytes := []byte(ev.Text)
	msg := make([]byte, 1+1+4+4+4+4+len(textBytes))
	msg[0] = MsgDecode
	msg[1] = confidenceByte(ev.Confidence)
	binary.BigEndian.PutUint32(msg[2:6], math.Float32bits(ev.Cost))
	binary.BigEndian.PutUint32(msg[6:10], math.Float32bits(ev.Pitch))
	binary.BigEndian.PutUint32(msg[10:14], math.Float32bits(ev.Speed))
	binary.BigEndian.PutUint32(msg[14:18], uint32(len(textBytes)))
	copy(msg[18:], textBytes)
	return msg
}

// encodeStatsMsg builds a 0x11 binary frame.
//
//	[type:1=0x11][pitch:4 float32 BE][speed:4 float32 BE]
func encodeStatsMsg(ev cwEvent) []byte {
	msg := make([]byte, 1+4+4)
	msg[0] = MsgStats
	binary.BigEndian.PutUint32(msg[1:5], math.Float32bits(ev.Pitch))
	binary.BigEndian.PutUint32(msg[5:9], math.Float32bits(ev.Speed))
	return msg
}

// encodeErrorMsg builds a 0x12 binary frame.
//
//	[type:1=0x12][msg_len:4 uint32 BE][msg: UTF-8]
func encodeErrorMsg(errText string) []byte {
	b := []byte(errText)
	msg := make([]byte, 1+4+len(b))
	msg[0] = MsgError
	binary.BigEndian.PutUint32(msg[1:5], uint32(len(b)))
	copy(msg[5:], b)
	return msg
}

func confidenceByte(s string) byte {
	switch s {
	case "high":
		return ConfHigh
	case "medium":
		return ConfMedium
	case "low":
		return ConfLow
	default:
		return ConfPoor
	}
}
