package digitalvoice

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultBinaryPath = "dsd-fme"
	decoderInputRate  = 48000
)

// Config contains server-controlled settings. It deliberately has no decoder
// argument or key fields: the integration supports clear/unencrypted reception
// and encrypted-call metadata only.
type Config struct {
	BinaryPath string
	MaxUsers   int
}

// GlobalConfig is populated by the main package before registration.
var GlobalConfig = &Config{BinaryPath: defaultBinaryPath, MaxUsers: 3}

var (
	activeUsers int
	activeMu    sync.Mutex
)

type AudioExtensionParams struct {
	SampleRate    int
	Channels      int
	BitsPerSample int
}

type AudioSample struct {
	PCMData      []int16
	RTPTimestamp uint32
	GPSTimeNs    int64
}

type AudioExtension interface {
	Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error
	Stop() error
	GetName() string
}

// DigitalVoiceExtension supervises one DSD-FME process for one listener.
type DigitalVoiceExtension struct {
	audioParams AudioExtensionParams
	profile     Profile
	binaryPath  string
	inverted    bool
	resampler   *linearResampler

	mu          sync.Mutex
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	udp         *net.UDPConn
	stopChan    chan struct{}
	crashChan   chan error
	stopOnce    sync.Once
	releaseOnce sync.Once
	wg          sync.WaitGroup
	running     atomic.Bool
	stopping    atomic.Bool
	latestTime  atomic.Int64
	// Refreshed by encrypted decoder events. This explicitly suppresses
	// encrypted output in addition to DSD-FME's normal encrypted-voice muting.
	suppressAudioUntil atomic.Int64
	acquired           bool
}

// Factory validates a client request and creates a decoder instance.
func Factory(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
	if audioParams.Channels != 1 {
		return nil, fmt.Errorf("digital voice decoding requires mono demodulated audio; use NFM mode (got %d channels)", audioParams.Channels)
	}
	if audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("digital voice decoding requires 16-bit PCM (got %d bits)", audioParams.BitsPerSample)
	}
	if audioParams.SampleRate < 8000 || audioParams.SampleRate > 192000 {
		return nil, fmt.Errorf("unsupported input sample rate %d Hz", audioParams.SampleRate)
	}

	protocol := stringParam(extensionParams, "protocol", "auto")
	profile, err := LookupProfile(protocol)
	if err != nil {
		return nil, err
	}
	inverted := boolParam(extensionParams, "inverted", false)
	if inverted && profile.InversionArg == "" {
		return nil, fmt.Errorf("%s does not support the inverted-signal option", profile.Name)
	}

	binaryPath := defaultBinaryPath
	if GlobalConfig != nil && strings.TrimSpace(GlobalConfig.BinaryPath) != "" {
		binaryPath = strings.TrimSpace(GlobalConfig.BinaryPath)
	}
	if err := validateBinary(binaryPath); err != nil {
		return nil, err
	}

	return &DigitalVoiceExtension{
		audioParams: audioParams,
		profile:     profile,
		binaryPath:  binaryPath,
		inverted:    inverted,
		resampler:   newLinearResampler(audioParams.SampleRate, decoderInputRate),
		stopChan:    make(chan struct{}),
		crashChan:   make(chan error, 1),
	}, nil
}

func validateBinary(path string) error {
	if filepath.IsAbs(path) || strings.ContainsAny(path, `/\`) {
		info, err := os.Stat(path)
		if err != nil {
			return fmt.Errorf("DSD-FME binary not found at %s: %w", path, err)
		}
		if info.IsDir() {
			return fmt.Errorf("DSD-FME binary path is a directory: %s", path)
		}
		return nil
	}
	if _, err := exec.LookPath(path); err != nil {
		return fmt.Errorf("DSD-FME binary %q not found in PATH", path)
	}
	return nil
}

func (e *DigitalVoiceExtension) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.running.Load() {
		return errors.New("digital voice decoder already running")
	}
	if err := e.acquireUser(); err != nil {
		return err
	}

	udp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		e.releaseUser()
		return fmt.Errorf("open decoded-audio listener: %w", err)
	}
	e.udp = udp
	port := udp.LocalAddr().(*net.UDPAddr).Port

	args, err := BuildArgs(e.profile, port, e.inverted)
	if err != nil {
		udp.Close()
		e.releaseUser()
		return err
	}
	cmd := exec.Command(e.binaryPath, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		udp.Close()
		e.releaseUser()
		return fmt.Errorf("open DSD-FME input: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		stdin.Close()
		udp.Close()
		e.releaseUser()
		return fmt.Errorf("open DSD-FME event stream: %w", err)
	}
	cmd.Stdout = io.Discard
	if err := cmd.Start(); err != nil {
		stdin.Close()
		udp.Close()
		e.releaseUser()
		return fmt.Errorf("start DSD-FME: %w", err)
	}

	e.cmd = cmd
	e.stdin = stdin
	e.running.Store(true)
	e.stopping.Store(false)

	e.sendEvent(resultChan, Event{
		Type: "digital_voice_started", Protocol: e.profile.ID,
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Raw:       fmt.Sprintf("%s decoder started; clear/unencrypted audio only", e.profile.Name),
	})

	e.wg.Add(4)
	go e.feedAudio(audioChan)
	go e.readDecodedAudio(resultChan)
	go e.readEvents(stderr, resultChan)
	go e.waitProcess(resultChan)
	return nil
}

func (e *DigitalVoiceExtension) feedAudio(audioChan <-chan AudioSample) {
	defer e.wg.Done()
	for {
		select {
		case <-e.stopChan:
			return
		case sample, ok := <-audioChan:
			if !ok {
				return
			}
			if sample.GPSTimeNs != 0 {
				e.latestTime.Store(sample.GPSTimeNs)
			}
			pcm := e.resampler.process(sample.PCMData)
			if len(pcm) == 0 {
				continue
			}
			buffer := make([]byte, len(pcm)*2)
			for i, value := range pcm {
				binary.LittleEndian.PutUint16(buffer[i*2:], uint16(value))
			}
			if err := writeAll(e.stdin, buffer); err != nil {
				if !e.stopping.Load() {
					e.reportCrash(fmt.Errorf("write DSD-FME audio: %w", err))
				}
				return
			}
		}
	}
}

func writeAll(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := writer.Write(data)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}

func (e *DigitalVoiceExtension) readDecodedAudio(resultChan chan<- []byte) {
	defer e.wg.Done()
	buffer := make([]byte, 65535)
	for {
		n, _, err := e.udp.ReadFromUDP(buffer)
		if err != nil {
			if !e.stopping.Load() && !errors.Is(err, net.ErrClosed) {
				e.reportCrash(fmt.Errorf("read DSD-FME decoded audio: %w", err))
			}
			return
		}
		if n == 0 {
			continue
		}
		if time.Now().UnixNano() < e.suppressAudioUntil.Load() {
			continue
		}
		timestamp := e.latestTime.Load()
		if timestamp == 0 {
			timestamp = time.Now().UnixNano()
		}
		message := make([]byte, 14+n)
		message[0] = messageAudio
		binary.BigEndian.PutUint64(message[1:9], uint64(timestamp))
		binary.BigEndian.PutUint32(message[9:13], uint32(e.profile.OutputSampleRate))
		message[13] = byte(e.profile.OutputChannels)
		copy(message[14:], buffer[:n])
		sendResult(resultChan, message)
	}
}

func (e *DigitalVoiceExtension) readEvents(stderr io.Reader, resultChan chan<- []byte) {
	defer e.wg.Done()
	scanner := bufio.NewScanner(stderr)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		if event, ok := parseEvent(e.profile.ID, scanner.Text(), time.Now()); ok {
			if event.Encrypted {
				e.suppressAudioUntil.Store(time.Now().Add(5 * time.Second).UnixNano())
			}
			e.sendEvent(resultChan, event)
		}
	}
	if err := scanner.Err(); err != nil && !e.stopping.Load() {
		e.reportCrash(fmt.Errorf("read DSD-FME events: %w", err))
	}
}

func (e *DigitalVoiceExtension) waitProcess(resultChan chan<- []byte) {
	defer e.wg.Done()
	err := e.cmd.Wait()
	e.running.Store(false)
	e.releaseUser()
	if !e.stopping.Load() {
		if err == nil {
			err = errors.New("DSD-FME exited unexpectedly")
		} else {
			err = fmt.Errorf("DSD-FME exited unexpectedly: %w", err)
		}
		e.sendError(resultChan, err)
		e.reportCrash(err)
	}
}

func (e *DigitalVoiceExtension) Stop() error {
	e.stopOnce.Do(func() {
		e.stopping.Store(true)
		e.running.Store(false)
		close(e.stopChan)

		e.mu.Lock()
		stdin := e.stdin
		udp := e.udp
		cmd := e.cmd
		e.mu.Unlock()

		if stdin != nil {
			_ = stdin.Close()
		}
		if udp != nil {
			_ = udp.Close()
		}
		if cmd != nil && cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		e.releaseUser()
	})
	e.wg.Wait()
	return nil
}

func (e *DigitalVoiceExtension) GetName() string {
	return "digitalvoice"
}

func (e *DigitalVoiceExtension) CrashChan() <-chan error {
	return e.crashChan
}

func (e *DigitalVoiceExtension) reportCrash(err error) {
	select {
	case e.crashChan <- err:
	default:
	}
}

func (e *DigitalVoiceExtension) sendEvent(resultChan chan<- []byte, event Event) {
	if message := eventMessage(event); len(message) > 1 {
		sendResult(resultChan, message)
	}
}

func (e *DigitalVoiceExtension) sendError(resultChan chan<- []byte, err error) {
	payload, _ := json.Marshal(map[string]string{
		"type": "digital_voice_error", "error": err.Error(),
	})
	sendResult(resultChan, append([]byte{messageError}, payload...))
}

func sendResult(resultChan chan<- []byte, message []byte) {
	select {
	case resultChan <- message:
	default:
	}
}

func (e *DigitalVoiceExtension) acquireUser() error {
	activeMu.Lock()
	defer activeMu.Unlock()
	maxUsers := 3
	if GlobalConfig != nil {
		maxUsers = GlobalConfig.MaxUsers
	}
	if maxUsers > 0 && activeUsers >= maxUsers {
		return fmt.Errorf("digital voice decoder is at capacity (%d concurrent users)", maxUsers)
	}
	activeUsers++
	e.acquired = true
	return nil
}

func (e *DigitalVoiceExtension) releaseUser() {
	e.releaseOnce.Do(func() {
		activeMu.Lock()
		defer activeMu.Unlock()
		if e.acquired && activeUsers > 0 {
			activeUsers--
		}
		e.acquired = false
	})
}

func stringParam(params map[string]interface{}, key, fallback string) string {
	if value, ok := params[key].(string); ok && strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}

func boolParam(params map[string]interface{}, key string, fallback bool) bool {
	if value, ok := params[key].(bool); ok {
		return value
	}
	return fallback
}

// GetInfo returns metadata for the main audio-extension registry.
func GetInfo() map[string]interface{} {
	return map[string]interface{}{
		"name":        "digitalvoice",
		"description": "Receive-only DMR, P25, NXDN, D-Star, YSF, M17, dPMR, ProVoice/EDACS and X2-TDMA via DSD-FME",
		"version":     "1.0.0",
		"profiles":    Profiles(),
		"security":    "No client-supplied decoder arguments or privacy/decryption keys are accepted. Encrypted-call metadata may be displayed, but encrypted voice is not decoded.",
	}
}
