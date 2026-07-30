package signalling

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	defaultBinaryPath = "multimon-ng"
	decoderInputRate  = 22050
	messageDecode     = byte(0x50)
	messageError      = byte(0x51)
)

type Config struct {
	BinaryPath string
	MaxUsers   int
}

var GlobalConfig = &Config{BinaryPath: defaultBinaryPath, MaxUsers: 5}

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

type Extension struct {
	audioParams AudioExtensionParams
	profile     Profile
	binaryPath  string
	resampler   *linearResampler

	mu          sync.Mutex
	cmd         *exec.Cmd
	stdin       io.WriteCloser
	stopChan    chan struct{}
	crashChan   chan error
	stopOnce    sync.Once
	releaseOnce sync.Once
	wg          sync.WaitGroup
	running     atomic.Bool
	stopping    atomic.Bool
	acquired    bool
}

func Factory(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
	if audioParams.Channels != 1 || audioParams.BitsPerSample != 16 {
		return nil, fmt.Errorf("signalling decoding requires mono 16-bit demodulated audio")
	}
	if audioParams.SampleRate < 8000 || audioParams.SampleRate > 192000 {
		return nil, fmt.Errorf("unsupported input sample rate %d Hz", audioParams.SampleRate)
	}
	profileID := "paging"
	if value, ok := extensionParams["profile"].(string); ok && strings.TrimSpace(value) != "" {
		profileID = value
	}
	profile, err := LookupProfile(profileID)
	if err != nil {
		return nil, err
	}
	binaryPath := defaultBinaryPath
	if GlobalConfig != nil && strings.TrimSpace(GlobalConfig.BinaryPath) != "" {
		binaryPath = strings.TrimSpace(GlobalConfig.BinaryPath)
	}
	if err := validateBinary(binaryPath); err != nil {
		return nil, err
	}
	return &Extension{
		audioParams: audioParams,
		profile:     profile,
		binaryPath:  binaryPath,
		resampler:   newLinearResampler(audioParams.SampleRate, decoderInputRate),
		stopChan:    make(chan struct{}),
		crashChan:   make(chan error, 1),
	}, nil
}

func validateBinary(path string) error {
	if filepath.IsAbs(path) || strings.ContainsAny(path, `/\`) {
		info, err := os.Stat(path)
		if err != nil {
			return fmt.Errorf("multimon-ng binary not found at %s: %w", path, err)
		}
		if info.IsDir() {
			return fmt.Errorf("multimon-ng binary path is a directory: %s", path)
		}
		return nil
	}
	if _, err := exec.LookPath(path); err != nil {
		return fmt.Errorf("multimon-ng binary %q not found in PATH", path)
	}
	return nil
}

func (e *Extension) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.running.Load() {
		return errors.New("signalling decoder already running")
	}
	if err := e.acquireUser(); err != nil {
		return err
	}

	cmd := exec.Command(e.binaryPath, BuildArgs(e.profile)...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		e.releaseUser()
		return fmt.Errorf("open multimon-ng input: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		e.releaseUser()
		return fmt.Errorf("open multimon-ng output: %w", err)
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		e.releaseUser()
		return fmt.Errorf("start multimon-ng: %w", err)
	}
	e.cmd = cmd
	e.stdin = stdin
	e.running.Store(true)
	e.stopping.Store(false)
	e.sendJSON(resultChan, messageDecode, map[string]interface{}{
		"type": "signalling_started", "profile": e.profile.ID,
		"timestamp": time.Now().UTC().Format(time.RFC3339Nano),
	})

	e.wg.Add(3)
	go e.feedAudio(audioChan)
	go e.readOutput(stdout, resultChan)
	go e.waitProcess(resultChan)
	return nil
}

func (e *Extension) feedAudio(audioChan <-chan AudioSample) {
	defer e.wg.Done()
	for {
		select {
		case <-e.stopChan:
			return
		case sample, ok := <-audioChan:
			if !ok {
				return
			}
			pcm := e.resampler.process(sample.PCMData)
			buffer := make([]byte, len(pcm)*2)
			for i, value := range pcm {
				binary.LittleEndian.PutUint16(buffer[i*2:], uint16(value))
			}
			if len(buffer) > 0 {
				if _, err := e.stdin.Write(buffer); err != nil && !e.stopping.Load() {
					e.reportCrash(fmt.Errorf("write multimon-ng audio: %w", err))
					return
				}
			}
		}
	}
}

func (e *Extension) readOutput(reader io.Reader, resultChan chan<- []byte) {
	defer e.wg.Done()
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		e.sendJSON(resultChan, messageDecode, map[string]interface{}{
			"type": "signalling_decode", "profile": e.profile.ID,
			"timestamp": time.Now().UTC().Format(time.RFC3339Nano), "raw": line,
		})
	}
	if err := scanner.Err(); err != nil && !e.stopping.Load() {
		e.reportCrash(fmt.Errorf("read multimon-ng output: %w", err))
	}
}

func (e *Extension) waitProcess(resultChan chan<- []byte) {
	defer e.wg.Done()
	err := e.cmd.Wait()
	e.running.Store(false)
	e.releaseUser()
	if !e.stopping.Load() {
		if err == nil {
			err = errors.New("multimon-ng exited unexpectedly")
		}
		e.sendJSON(resultChan, messageError, map[string]interface{}{
			"type": "signalling_error", "error": err.Error(),
		})
		e.reportCrash(err)
	}
}

func (e *Extension) Stop() error {
	e.stopOnce.Do(func() {
		e.stopping.Store(true)
		e.running.Store(false)
		close(e.stopChan)
		e.mu.Lock()
		stdin, cmd := e.stdin, e.cmd
		e.mu.Unlock()
		if stdin != nil {
			_ = stdin.Close()
		}
		if cmd != nil && cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		e.releaseUser()
	})
	e.wg.Wait()
	return nil
}

func (e *Extension) GetName() string         { return "signalling" }
func (e *Extension) CrashChan() <-chan error { return e.crashChan }
func (e *Extension) reportCrash(err error) {
	select {
	case e.crashChan <- err:
	default:
	}
}
func (e *Extension) sendJSON(resultChan chan<- []byte, messageType byte, value interface{}) {
	payload, err := json.Marshal(value)
	if err != nil {
		return
	}
	select {
	case resultChan <- append([]byte{messageType}, payload...):
	default:
	}
}

func (e *Extension) acquireUser() error {
	activeMu.Lock()
	defer activeMu.Unlock()
	maxUsers := 5
	if GlobalConfig != nil {
		maxUsers = GlobalConfig.MaxUsers
	}
	if maxUsers > 0 && activeUsers >= maxUsers {
		return fmt.Errorf("signalling decoder is at capacity (%d concurrent users)", maxUsers)
	}
	activeUsers++
	e.acquired = true
	return nil
}

func (e *Extension) releaseUser() {
	e.releaseOnce.Do(func() {
		activeMu.Lock()
		defer activeMu.Unlock()
		if e.acquired && activeUsers > 0 {
			activeUsers--
		}
		e.acquired = false
	})
}

func GetInfo() map[string]interface{} {
	return map[string]interface{}{
		"name":        "signalling",
		"description": "POCSAG/FLEX paging, SAME/EAS, DTMF, two-tone and legacy telemetry via multimon-ng",
		"version":     "1.0.0",
		"profiles":    Profiles(),
	}
}
