package hdradio

/*
 * The ubersdr-hdradio subprocess and its four streams.
 *
 * Wire protocol (backend → frontend), one binary WebSocket message each:
 *
 *   0x02 audio   [type:1][timestamp:8][sample_rate:4][channels:1][opus...]
 *                timestamp ns since the epoch, sample_rate and all integers
 *                big-endian; 48 kHz stereo Opus, 20 ms frames. The same
 *                layout the DRM extension uses.
 *   0x03 status  [type:1][json...]  one status line from fd 3, unchanged
 *   0x04 image   [type:1][header length:4][header json][image bytes]
 *                the header as the binary wrote it on fd 5 ({"t":"image",
 *                "kind","program","lot","mime","name","bounds"}), then the
 *                JPEG or PNG
 *
 * Every goroutine here recovers from panics: one unrecovered panic in any
 * goroutine ends the whole server, for every listener, and a decoder is never
 * worth that.
 */

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"gopkg.in/hraban/opus.v2"
)

const (
	MessageTypeAudio  = 0x02
	MessageTypeStatus = 0x03
	MessageTypeImage  = 0x04

	// outputSampleRate is what the binary is asked for, and what Opus encodes.
	outputSampleRate = 48000
	outputChannels   = 2

	// opusBitrate: AM HD audio is narrow, so this is ample for stereo.
	opusBitrate = 64000

	// opusFrameSamples is one 20 ms Opus frame, both channels interleaved.
	opusFrameSamples = outputSampleRate / 50 * outputChannels

	// maxPCMBufSamples caps the audio waiting to be encoded at 1 s. The
	// binary writes 0.14–0.19 s at a time at a steady rate, so this is only
	// reached if the ticker stalls; the oldest audio goes first.
	maxPCMBufSamples = outputSampleRate * outputChannels

	// prerollSamples is how much audio is gathered before playback starts,
	// and again after it runs dry, so the browser is not fed a frame at a
	// time from the edge of the binary's output.
	prerollSamples = outputSampleRate / 5 * outputChannels // 200 ms

	// maxFramesPerTick and catchUpThreshold drain a backlog: a 20 ms ticker
	// runs marginally slow, so without a second frame now and then the buffer
	// creeps up to its cap and drops audio.
	maxFramesPerTick = 2
	catchUpThreshold = 3 * opusFrameSamples

	// maxStatusLine: the binary keeps a status line under 512 KiB.
	maxStatusLine = 1 << 20

	// Bounds on an image frame from fd 5. The binary never sends an image
	// over 512 KiB, or a header of more than a few hundred bytes; anything
	// larger means the stream is not what it should be, and it is abandoned.
	maxImageHeader = 16 * 1024
	maxImageBytes  = 512 * 1024

	// imageSendTimeout is how long an image may wait for room in the result
	// channel. Images are rare and wanted, so they are not dropped at the
	// first full channel the way status lines are.
	imageSendTimeout = 2 * time.Second

	stopTimeout = 3 * time.Second
)

// Decoder manages one ubersdr-hdradio subprocess.
type Decoder struct {
	inputSampleRate int
	program         int

	cmd      *exec.Cmd
	stdin    io.WriteCloser
	stdout   io.ReadCloser
	controlW *os.File // our end of the child's fd 4

	opusEncoder *opus.Encoder

	// pcm is the decoded audio waiting to be encoded, shared between the
	// stdout reader and the ticker.
	pcmMu  sync.Mutex
	pcm    []int16
	primed bool

	// ctlMu serialises writes to controlW and its closing.
	ctlMu sync.Mutex

	running   bool
	stopChan  chan struct{}
	crashChan chan error
	wg        sync.WaitGroup
	mu        sync.Mutex
}

// recoverGoroutine is deferred at the top of every goroutine here.
func recoverGoroutine(where string) {
	if r := recover(); r != nil {
		log.Printf("[HD Radio] panic in %s recovered: %v\n%s", where, r, debug.Stack())
	}
}

// NewDecoder prepares a decoder; the subprocess starts in Start.
func NewDecoder(inputSampleRate, program int) (*Decoder, error) {
	enc, err := opus.NewEncoder(outputSampleRate, outputChannels, opus.AppAudio)
	if err != nil {
		return nil, fmt.Errorf("failed to create Opus encoder: %w", err)
	}
	if err := enc.SetBitrate(opusBitrate); err != nil {
		return nil, fmt.Errorf("failed to set Opus bitrate: %w", err)
	}
	return &Decoder{
		inputSampleRate: inputSampleRate,
		program:         program,
		opusEncoder:     enc,
		stopChan:        make(chan struct{}),
		crashChan:       make(chan error, 1),
	}, nil
}

// Start launches the subprocess and the goroutines around it.
func (d *Decoder) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.running {
		return fmt.Errorf("HD Radio decoder already running")
	}

	args := []string{
		"--input-sample-rate", strconv.Itoa(d.inputSampleRate),
		"--output-sample-rate", strconv.Itoa(outputSampleRate),
		"--program", strconv.Itoa(d.program),
	}
	cmd := exec.Command(binaryPath, args...)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("failed to create stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("failed to create stderr pipe: %w", err)
	}

	// fd 3 status, fd 4 control, fd 5 images: ExtraFiles[i] is fd 3+i. The
	// decoder runs without any of them, so a pipe that cannot be made is
	// logged and that stream done without, rather than the start failed.
	var statusR, statusW, controlR, controlW, imageR, imageW *os.File
	if statusR, statusW, err = os.Pipe(); err != nil {
		log.Printf("[HD Radio] no status channel: %v", err)
		statusR, statusW = nil, nil
	}
	if controlR, controlW, err = os.Pipe(); err != nil {
		log.Printf("[HD Radio] no control channel: %v", err)
		controlR, controlW = nil, nil
	}
	if imageR, imageW, err = os.Pipe(); err != nil {
		log.Printf("[HD Radio] no image channel: %v", err)
		imageR, imageW = nil, nil
	}
	// A nil entry leaves that descriptor closed in the child, which the
	// binary treats as "not wanted".
	cmd.ExtraFiles = []*os.File{statusW, controlR, imageW}

	closeAll := func(files ...*os.File) {
		for _, f := range files {
			if f != nil {
				_ = f.Close()
			}
		}
	}

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		closeAll(statusR, statusW, controlR, controlW, imageR, imageW)
		return fmt.Errorf("failed to start %s: %w", binaryPath, err)
	}
	// The child holds its own copies; ours must go, or the readers never
	// see EOF when it exits.
	closeAll(statusW, controlR, imageW)

	if err := syscall.Setpriority(syscall.PRIO_PROCESS, cmd.Process.Pid, 10); err != nil {
		log.Printf("[HD Radio] could not renice decoder %d: %v", cmd.Process.Pid, err)
	}

	d.cmd = cmd
	d.stdin = stdin
	d.stdout = stdout
	d.controlW = controlW
	d.running = true
	log.Printf("[HD Radio] Subprocess started (pid=%d): %s %v", cmd.Process.Pid, binaryPath, args)

	// stderr is the binary's log of state changes; not tracked by wg, it
	// ends at EOF when the subprocess exits.
	go d.stderrLoop(stderr)

	if statusR != nil {
		d.wg.Add(1)
		go d.statusLoop(statusR, resultChan)
	}
	if imageR != nil {
		d.wg.Add(1)
		go d.imageLoop(imageR, resultChan)
	}
	d.wg.Add(3)
	go d.writeLoop(audioChan)
	go d.readLoop(resultChan)
	go d.waitLoop()
	return nil
}

// Stop ends the subprocess: stdin and the control channel are closed, which
// is how the binary is asked to exit, and it is killed if it has not after
// stopTimeout. Idempotent.
func (d *Decoder) Stop() error {
	d.mu.Lock()
	if !d.running {
		d.mu.Unlock()
		return nil
	}
	d.running = false
	close(d.stopChan)
	if d.stdin != nil {
		_ = d.stdin.Close()
	}
	d.mu.Unlock()

	d.ctlMu.Lock()
	if d.controlW != nil {
		_ = d.controlW.Close()
		d.controlW = nil
	}
	d.ctlMu.Unlock()

	done := make(chan struct{})
	go func() {
		defer recoverGoroutine("stop wait")
		d.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(stopTimeout):
		log.Printf("[HD Radio] Subprocess did not exit in time, killing")
		d.mu.Lock()
		if d.cmd != nil && d.cmd.Process != nil {
			_ = d.cmd.Process.Kill()
		}
		d.mu.Unlock()
		<-done
	}
	log.Printf("[HD Radio] Subprocess stopped")
	return nil
}

// CrashChan receives an error if the subprocess exits while it should be
// running. Buffered (1); at most one value.
func (d *Decoder) CrashChan() <-chan error {
	return d.crashChan
}

// SetProgram tells the binary to play another program.
func (d *Decoder) SetProgram(program int) error {
	if err := d.command(fmt.Sprintf("program %d", program)); err != nil {
		return err
	}
	d.dropPCM()
	return nil
}

// Reset tells the binary to forget the station and acquire afresh. Safe to
// call at any time, including after Stop.
func (d *Decoder) Reset() {
	if err := d.command("reset"); err != nil {
		log.Printf("[HD Radio] reset not sent: %v", err)
	}
	// Audio still buffered is the old station's.
	d.dropPCM()
}

// command writes one line to the binary's fd 4. A decoder that has stopped,
// or never got a control channel, returns an error rather than anything
// worse.
func (d *Decoder) command(line string) error {
	d.ctlMu.Lock()
	defer d.ctlMu.Unlock()
	if d.controlW == nil {
		return fmt.Errorf("decoder is not running")
	}
	// Bounded, so a wedged child cannot hold the caller: the pipe has 64 KiB
	// of room and a command is a few bytes, so this only matters if the child
	// has stopped reading entirely.
	_ = d.controlW.SetWriteDeadline(time.Now().Add(time.Second))
	_, err := d.controlW.Write([]byte(line + "\n"))
	return err
}

func (d *Decoder) dropPCM() {
	d.pcmMu.Lock()
	d.pcm = d.pcm[:0]
	d.primed = false
	d.pcmMu.Unlock()
}

// writeLoop feeds IQ to the subprocess as little-endian int16.
func (d *Decoder) writeLoop(audioChan <-chan AudioSample) {
	defer d.wg.Done()
	defer recoverGoroutine("write loop")

	var buf []byte
	for {
		select {
		case <-d.stopChan:
			return
		case sample, ok := <-audioChan:
			if !ok {
				return
			}
			if len(sample.PCMData) == 0 {
				continue
			}
			need := len(sample.PCMData) * 2
			if cap(buf) < need {
				buf = make([]byte, need)
			}
			buf = buf[:need]
			for i, s := range sample.PCMData {
				binary.LittleEndian.PutUint16(buf[i*2:], uint16(s))
			}
			if _, err := d.stdin.Write(buf); err != nil {
				return // the subprocess has gone, or Stop closed stdin
			}
		}
	}
}

// readLoop gathers the binary's audio and sends one Opus frame every 20 ms.
func (d *Decoder) readLoop(resultChan chan<- []byte) {
	defer d.wg.Done()
	defer recoverGoroutine("read loop")

	// The reader: stdout into d.pcm. Not tracked by wg; it ends at EOF when
	// the subprocess exits.
	go func() {
		defer recoverGoroutine("stdout reader")
		readBuf := make([]byte, 16*1024)
		carry := 0 // a byte of a sample split across reads
		for {
			n, err := d.stdout.Read(readBuf[carry:])
			n += carry
			if whole := n &^ 1; whole > 0 {
				d.pcmMu.Lock()
				for i := 0; i < whole; i += 2 {
					d.pcm = append(d.pcm, int16(binary.LittleEndian.Uint16(readBuf[i:])))
				}
				if over := len(d.pcm) - maxPCMBufSamples; over > 0 {
					// Keep whole stereo frames: drop an even count.
					over += over & 1
					d.pcm = append(d.pcm[:0], d.pcm[over:]...)
				}
				d.pcmMu.Unlock()
				carry = n - whole
				if carry > 0 {
					readBuf[0] = readBuf[whole]
				}
			} else {
				carry = n
			}
			if err != nil {
				return
			}
		}
	}()

	frame := make([]int16, opusFrameSamples)
	opusBuf := make([]byte, 4000)
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-d.stopChan:
			return
		case <-ticker.C:
		}
		for emitted := 0; emitted < maxFramesPerTick; emitted++ {
			d.pcmMu.Lock()
			if !d.primed && len(d.pcm) >= prerollSamples {
				d.primed = true
			}
			if !d.primed || len(d.pcm) < opusFrameSamples {
				if len(d.pcm) < opusFrameSamples {
					d.primed = false // run dry: gather a preroll again
				}
				d.pcmMu.Unlock()
				break
			}
			copy(frame, d.pcm[:opusFrameSamples])
			d.pcm = append(d.pcm[:0], d.pcm[opusFrameSamples:]...)
			backlog := len(d.pcm)
			d.pcmMu.Unlock()

			n, err := d.opusEncoder.Encode(frame, opusBuf)
			if err != nil {
				log.Printf("[HD Radio] Opus encode error: %v", err)
				break
			}
			select {
			case resultChan <- encodeAudioFrame(opusBuf[:n], time.Now().UnixNano()):
			default:
				// The client is not keeping up; the next frame follows in 20 ms.
			}
			if backlog < catchUpThreshold {
				break
			}
		}
	}
}

// statusLoop forwards each status line from fd 3 as a 0x03 message.
func (d *Decoder) statusLoop(r *os.File, resultChan chan<- []byte) {
	defer d.wg.Done()
	defer r.Close()
	defer recoverGoroutine("status loop")

	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 16*1024), maxStatusLine)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		pkt := make([]byte, 1+len(line))
		pkt[0] = MessageTypeStatus
		copy(pkt[1:], line)
		select {
		case resultChan <- pkt:
		case <-d.stopChan:
			return
		default:
			// The next line supersedes this one within a second.
		}
	}
	if err := sc.Err(); err != nil && d.isRunning() {
		log.Printf("[HD Radio] status channel: %v", err)
	}
}

// imageLoop forwards each image frame from fd 5 as a 0x04 message.
func (d *Decoder) imageLoop(r *os.File, resultChan chan<- []byte) {
	defer d.wg.Done()
	defer r.Close()
	defer recoverGoroutine("image loop")

	br := bufio.NewReader(r)
	for {
		header, err := readChunk(br, maxImageHeader)
		if err != nil {
			d.imageStreamEnded(err)
			return
		}
		data, err := readChunk(br, maxImageBytes)
		if err != nil {
			d.imageStreamEnded(err)
			return
		}
		pkt := make([]byte, 1+4+len(header)+len(data))
		pkt[0] = MessageTypeImage
		binary.BigEndian.PutUint32(pkt[1:5], uint32(len(header)))
		copy(pkt[5:], header)
		copy(pkt[5+len(header):], data)

		timer := time.NewTimer(imageSendTimeout)
		select {
		case resultChan <- pkt:
		case <-d.stopChan:
			timer.Stop()
			return
		case <-timer.C:
			log.Printf("[HD Radio] image dropped: the client is not keeping up")
		}
		timer.Stop()
	}
}

func (d *Decoder) imageStreamEnded(err error) {
	if err != io.EOF && d.isRunning() {
		// A frame that breaks the format leaves no way to find the next
		// one, so the stream is abandoned; audio and status carry on.
		log.Printf("[HD Radio] image channel abandoned: %v", err)
	}
}

// readChunk reads one [length u32 LE][bytes] chunk of at most max bytes.
func readChunk(r io.Reader, max int) ([]byte, error) {
	var lenBuf [4]byte
	if _, err := io.ReadFull(r, lenBuf[:]); err != nil {
		return nil, err
	}
	n := binary.LittleEndian.Uint32(lenBuf[:])
	if n > uint32(max) {
		return nil, fmt.Errorf("chunk of %d bytes exceeds %d", n, max)
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		if err == io.EOF {
			err = io.ErrUnexpectedEOF
		}
		return nil, err
	}
	return b, nil
}

// stderrLoop relays the binary's state-change lines to the log.
func (d *Decoder) stderrLoop(r io.Reader) {
	defer recoverGoroutine("stderr loop")
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		if line := strings.TrimSpace(sc.Text()); line != "" {
			log.Printf("[HD Radio] %s", line)
		}
	}
}

// waitLoop reaps the subprocess, and reports an exit nobody asked for.
func (d *Decoder) waitLoop() {
	defer d.wg.Done()
	defer recoverGoroutine("wait loop")

	err := d.cmd.Wait()
	if !d.isRunning() {
		log.Printf("[HD Radio] Subprocess exited")
		return
	}
	if err == nil {
		err = fmt.Errorf("ubersdr-hdradio exited unexpectedly")
	}
	log.Printf("[HD Radio] Subprocess exited unexpectedly: %v", err)
	select {
	case d.crashChan <- err:
	default:
	}
}

func (d *Decoder) isRunning() bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.running
}

// encodeAudioFrame builds a 0x02 message.
func encodeAudioFrame(opusData []byte, timestampNs int64) []byte {
	const headerSize = 1 + 8 + 4 + 1
	pkt := make([]byte, headerSize+len(opusData))
	pkt[0] = MessageTypeAudio
	binary.BigEndian.PutUint64(pkt[1:9], uint64(timestampNs))
	binary.BigEndian.PutUint32(pkt[9:13], uint32(outputSampleRate))
	pkt[13] = outputChannels
	copy(pkt[14:], opusData)
	return pkt
}
