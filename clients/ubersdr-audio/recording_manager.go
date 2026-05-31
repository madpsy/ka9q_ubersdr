package main

// recording_manager.go — RecordingManager coordinates audio recording state.
//
// RecordingManager implements StreamSink so it can be plugged directly into
// the MultiSink pipeline.  When not recording, WritePCM is a near-zero-cost
// no-op (one mutex read + nil check).
//
// State machine:
//
//	idle ──Start()──► recording ──Stop()──► ready
//	                      │                   │
//	                  auto-stop           Start() (deletes old file)
//	                      │                   │
//	                      └──────────────────►┘
//	                                       ready → recording
//
// File formats:
//   - "pcm"  → WAV (little-endian int16, standard 44-byte header finalised on close)
//   - "opus" → OGG/Opus (libopus via cgo; minimal OGG page writer)
//
// The maximum recording duration is 60 minutes.  When the timer fires the
// recording is stopped automatically and onAutoStop (set by main()) is called
// so the GUI can update its button state.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// maxRecordingDuration is the hard cap on a single recording.
const maxRecordingDuration = 60 * time.Minute

// RecordingState describes the current state of the recording manager.
type RecordingState string

const (
	RecordingIdle   RecordingState = "idle"
	RecordingActive RecordingState = "recording"
	RecordingReady  RecordingState = "ready" // stopped, file available for download
)

// RecordingStatus is a snapshot of the manager's state, safe to read without
// holding the lock.
type RecordingStatus struct {
	State           RecordingState
	Format          string // "pcm" or "opus"
	Filename        string // base name only (no directory)
	FilePath        string // full path on host
	SizeBytes       int64
	StartedAt       time.Time
	StoppedAt       time.Time
	ElapsedSecs     float64
	RemainingSecs   float64
	MaxDurationSecs int
	AutoStopped     bool
}

// RecordingManager manages a single audio recording session.
// It implements StreamSink so it can be wired into the MultiSink pipeline.
type RecordingManager struct {
	mu          sync.Mutex
	state       RecordingState
	format      string // "pcm" or "opus"
	filePath    string
	startedAt   time.Time
	stoppedAt   time.Time
	autoStopped bool
	sink        *recordingSink // non-nil while recording
	stopTimer   *time.Timer

	// recordDir is the directory where recordings are written.
	recordDir string

	// onAutoStop is called (from a timer goroutine) when the 60-minute limit
	// fires.  Set by main() to update the GUI button.
	onAutoStop func()
}

// NewRecordingManager creates a RecordingManager that writes files to dir.
func NewRecordingManager(dir string) *RecordingManager {
	return &RecordingManager{
		state:     RecordingIdle,
		recordDir: dir,
	}
}

// WritePCM implements StreamSink.  It is a no-op when not recording.
func (m *RecordingManager) WritePCM(pcmLE []byte, sampleRate, channels int) {
	m.mu.Lock()
	s := m.sink
	m.mu.Unlock()
	if s == nil {
		return
	}
	s.writePCM(pcmLE, sampleRate, channels)
}

// Close implements StreamSink.  Stops any active recording.
func (m *RecordingManager) Close() {
	_ = m.Stop()
}

// Start begins a new recording in the given format ("pcm" or "opus").
// freq and mode are embedded in the filename for identification.
// If a completed recording already exists it is deleted first.
func (m *RecordingManager) Start(format, freq, mode string) error {
	if format != "pcm" && format != "opus" {
		return fmt.Errorf("unsupported recording format %q: must be \"pcm\" or \"opus\"", format)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	if m.state == RecordingActive {
		return errors.New("already recording")
	}

	// Delete any previous completed recording.
	if m.state == RecordingReady && m.filePath != "" {
		_ = os.Remove(m.filePath)
		m.filePath = ""
	}

	// Build filename: ubersdr-20060102-150405-14200kHz-USB.wav / .ogg
	ts := time.Now().Format("20060102-150405")
	ext := ".wav"
	if format == "opus" {
		ext = ".ogg"
	}
	name := fmt.Sprintf("ubersdr-%s-%s-%s%s", ts, freq, mode, ext)
	path := filepath.Join(m.recordDir, name)

	// Create the sink.
	s, err := newRecordingSink(path, format)
	if err != nil {
		return fmt.Errorf("recording: open file: %w", err)
	}

	m.sink = s
	m.state = RecordingActive
	m.format = format
	m.filePath = path
	m.startedAt = time.Now()
	m.stoppedAt = time.Time{}
	m.autoStopped = false

	// Arm the 60-minute auto-stop timer.
	m.stopTimer = time.AfterFunc(maxRecordingDuration, func() {
		_ = m.stopInternal(true)
		if m.onAutoStop != nil {
			m.onAutoStop()
		}
	})

	return nil
}

// Stop stops the active recording and finalises the file.
func (m *RecordingManager) Stop() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state != RecordingActive {
		return errors.New("not recording")
	}
	return m.stopInternal(false)
}

// stopInternal finalises the recording.  Must be called with m.mu held.
func (m *RecordingManager) stopInternal(auto bool) error {
	if m.stopTimer != nil {
		m.stopTimer.Stop()
		m.stopTimer = nil
	}
	var closeErr error
	if m.sink != nil {
		closeErr = m.sink.close()
		m.sink = nil
	}
	m.state = RecordingReady
	m.stoppedAt = time.Now()
	m.autoStopped = auto
	return closeErr
}

// IsRecording returns true when a recording is in progress.
func (m *RecordingManager) IsRecording() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state == RecordingActive
}

// DeleteFile removes the completed recording file and resets state to idle.
func (m *RecordingManager) DeleteFile() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state != RecordingReady {
		return errors.New("no completed recording to delete")
	}
	if m.filePath != "" {
		if err := os.Remove(m.filePath); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	m.state = RecordingIdle
	m.filePath = ""
	return nil
}

// Status returns a consistent snapshot of the current recording state.
func (m *RecordingManager) Status() RecordingStatus {
	m.mu.Lock()
	defer m.mu.Unlock()

	st := RecordingStatus{
		State:           m.state,
		Format:          m.format,
		FilePath:        m.filePath,
		StartedAt:       m.startedAt,
		StoppedAt:       m.stoppedAt,
		MaxDurationSecs: int(maxRecordingDuration.Seconds()),
		AutoStopped:     m.autoStopped,
	}
	if m.filePath != "" {
		st.Filename = filepath.Base(m.filePath)
		if info, err := os.Stat(m.filePath); err == nil {
			st.SizeBytes = info.Size()
		}
	}
	if m.state == RecordingActive {
		st.ElapsedSecs = time.Since(m.startedAt).Seconds()
		st.RemainingSecs = maxRecordingDuration.Seconds() - st.ElapsedSecs
		if st.RemainingSecs < 0 {
			st.RemainingSecs = 0
		}
	} else if m.state == RecordingReady && !m.stoppedAt.IsZero() {
		st.ElapsedSecs = m.stoppedAt.Sub(m.startedAt).Seconds()
	}
	return st
}

// ── recordingSink ─────────────────────────────────────────────────────────────

// opusFrameSamples is the number of samples per channel for a 20 ms Opus frame at 48 kHz.
// This is the standard frame size used for encoding; all valid Opus frame sizes are
// multiples of 2.5 ms (120 samples at 48 kHz), but 960 (20 ms) is the most common.
const opusFrameSamples = 960

// recordingSink writes decoded PCM frames to a file.
// For "pcm" format it writes a WAV file (header finalised on close).
// For "opus" format it encodes to OGG/Opus.
type recordingSink struct {
	mu         sync.Mutex
	file       *os.File
	format     string
	sampleRate int
	channels   int

	// WAV: byte offset where the data chunk payload starts (after the 44-byte header).
	wavDataStart int64
	wavBytes     int64 // bytes written to the data chunk so far

	// Opus: encoder + OGG writer
	opusEnc *opusEncoder
	ogg     *oggWriter

	// opusBuf accumulates int16 samples (interleaved channels) until a full
	// opusFrameSamples-per-channel frame is available for encoding.
	// This handles the case where the incoming PCM chunks are not exactly
	// the right size for opus_encode (which requires exact frame sizes).
	opusBuf []int16
}

func newRecordingSink(path, format string) (*recordingSink, error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	s := &recordingSink{file: f, format: format}
	return s, nil
}

// writePCM is called from RecordingManager.WritePCM (under no lock — the sink
// itself serialises writes with its own mutex).
func (s *recordingSink) writePCM(pcmLE []byte, sampleRate, channels int) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.file == nil || len(pcmLE) == 0 {
		return
	}

	switch s.format {
	case "pcm":
		s.writeWAV(pcmLE, sampleRate, channels)
	case "opus":
		s.writeOpus(pcmLE, sampleRate, channels)
	}
}

// ── WAV writer ────────────────────────────────────────────────────────────────

// writeWAV writes PCM frames to the WAV file.
// On the first call it writes the 44-byte placeholder header.
func (s *recordingSink) writeWAV(pcmLE []byte, sampleRate, channels int) {
	if s.sampleRate == 0 {
		// First frame — write placeholder header and record data start offset.
		s.sampleRate = sampleRate
		s.channels = channels
		writeWAVHeader(s.file, sampleRate, channels, 0) // placeholder sizes
		s.wavDataStart = 44
	}
	n, _ := s.file.Write(pcmLE)
	s.wavBytes += int64(n)
}

// writeWAVHeader writes a standard 44-byte PCM WAV header.
// dataBytes is the size of the data chunk payload (0 for placeholder).
func writeWAVHeader(w io.WriteSeeker, sampleRate, channels int, dataBytes uint32) {
	const bitsPerSample = 16
	byteRate := uint32(sampleRate * channels * bitsPerSample / 8)
	blockAlign := uint16(channels * bitsPerSample / 8)
	riffSize := 36 + dataBytes // 36 = rest of header after RIFF+size

	buf := make([]byte, 44)
	copy(buf[0:4], "RIFF")
	binary.LittleEndian.PutUint32(buf[4:8], riffSize)
	copy(buf[8:12], "WAVE")
	copy(buf[12:16], "fmt ")
	binary.LittleEndian.PutUint32(buf[16:20], 16) // PCM chunk size
	binary.LittleEndian.PutUint16(buf[20:22], 1)  // PCM format
	binary.LittleEndian.PutUint16(buf[22:24], uint16(channels))
	binary.LittleEndian.PutUint32(buf[24:28], uint32(sampleRate))
	binary.LittleEndian.PutUint32(buf[28:32], byteRate)
	binary.LittleEndian.PutUint16(buf[32:34], blockAlign)
	binary.LittleEndian.PutUint16(buf[34:36], bitsPerSample)
	copy(buf[36:40], "data")
	binary.LittleEndian.PutUint32(buf[40:44], dataBytes)

	w.Seek(0, io.SeekStart) //nolint:errcheck
	w.Write(buf)            //nolint:errcheck
}

// ── Opus/OGG writer ───────────────────────────────────────────────────────────

// writeOpus encodes a PCM frame to Opus and writes it as an OGG page.
// Incoming PCM chunks may be any size; samples are buffered until a full
// opusFrameSamples-per-channel frame is available, then encoded.
func (s *recordingSink) writeOpus(pcmLE []byte, sampleRate, channels int) {
	// Initialise encoder on first frame.
	if s.opusEnc == nil {
		enc, err := newOpusEncoder(sampleRate, channels)
		if err != nil {
			// Fall back to WAV if Opus encoder unavailable.
			s.format = "pcm"
			s.writeWAV(pcmLE, sampleRate, channels)
			return
		}
		s.opusEnc = enc
		s.sampleRate = sampleRate
		s.channels = channels
		s.ogg = newOGGWriter(s.file, sampleRate, channels)
		if err := s.ogg.writeHeaders(enc.header(), enc.commentHeader()); err != nil {
			s.format = "pcm"
			s.opusEnc = nil
			s.ogg = nil
			s.writeWAV(pcmLE, sampleRate, channels)
			return
		}
	}

	// Convert LE int16 bytes → int16 samples and append to the buffer.
	numSamples := len(pcmLE) / 2
	for i := 0; i < numSamples; i++ {
		s.opusBuf = append(s.opusBuf, int16(binary.LittleEndian.Uint16(pcmLE[i*2:])))
	}

	// Encode as many complete frames as are available.
	frameTotal := opusFrameSamples * channels // total int16 samples per frame (all channels)
	for len(s.opusBuf) >= frameTotal {
		frame := s.opusBuf[:frameTotal]
		encoded, err := s.opusEnc.encode(frame)
		if err == nil && len(encoded) > 0 {
			_ = s.ogg.writeAudioPage(encoded, opusFrameSamples)
		}
		// Consume the frame from the buffer (copy remainder to front).
		s.opusBuf = s.opusBuf[frameTotal:]
	}
}

// close finalises the file (rewrite WAV header or write OGG EOS page).
func (s *recordingSink) close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.file == nil {
		return nil
	}

	var closeErr error
	switch s.format {
	case "pcm":
		if s.sampleRate > 0 && s.wavBytes > 0 {
			// Rewrite header with correct sizes.
			writeWAVHeader(s.file, s.sampleRate, s.channels, uint32(s.wavBytes))
		}
	case "opus":
		// Flush any remaining buffered samples by zero-padding to a full frame.
		if s.opusEnc != nil && s.ogg != nil && len(s.opusBuf) > 0 {
			frameTotal := opusFrameSamples * s.channels
			// Pad with silence to complete the frame.
			for len(s.opusBuf) < frameTotal {
				s.opusBuf = append(s.opusBuf, 0)
			}
			if encoded, err := s.opusEnc.encode(s.opusBuf[:frameTotal]); err == nil && len(encoded) > 0 {
				_ = s.ogg.writeAudioPage(encoded, opusFrameSamples)
			}
			s.opusBuf = nil
		}
		if s.ogg != nil {
			_ = s.ogg.writeEOS()
		}
		if s.opusEnc != nil {
			s.opusEnc.close()
		}
	}

	closeErr = s.file.Close()
	s.file = nil
	return closeErr
}

// ── Minimal OGG page writer ───────────────────────────────────────────────────
//
// OGG format reference: https://www.xiph.org/ogg/doc/framing.html
// Opus-in-OGG: https://wiki.xiph.org/OggOpus

type oggWriter struct {
	w          io.Writer
	serial     uint32
	seqNo      uint32
	granulePos uint64
	sampleRate int
	channels   int
}

func newOGGWriter(w io.Writer, sampleRate, channels int) *oggWriter {
	return &oggWriter{
		w:          w,
		serial:     0x4F505553, // "OPUS" as serial
		sampleRate: sampleRate,
		channels:   channels,
	}
}

// writeHeaders writes the OpusHead and OpusTags OGG pages.
func (o *oggWriter) writeHeaders(head, tags []byte) error {
	if err := o.writePage(head, true, false, 0); err != nil {
		return err
	}
	return o.writePage(tags, false, false, 0)
}

// writeAudioPage writes one Opus packet as an OGG audio page.
// samplesPerChannel is the number of samples per channel in this frame,
// used to advance the granule position accurately.
func (o *oggWriter) writeAudioPage(packet []byte, samplesPerChannel int) error {
	// OGG granule position for Opus is in 48 kHz samples.
	// If the encoder sample rate differs from 48 kHz, scale accordingly.
	granuleSamples := samplesPerChannel
	if o.sampleRate != 48000 {
		granuleSamples = samplesPerChannel * 48000 / o.sampleRate
	}
	o.granulePos += uint64(granuleSamples)
	return o.writePage(packet, false, false, o.granulePos)
}

// writeEOS writes the end-of-stream OGG page.
func (o *oggWriter) writeEOS() error {
	return o.writePage(nil, false, true, o.granulePos)
}

// writePage writes a single OGG page containing one segment (packet).
// For simplicity we use one packet per page (lacing value = len(packet) if
// < 255, or a chain of 255-byte lacing values for larger packets).
func (o *oggWriter) writePage(packet []byte, bos, eos bool, granule uint64) error {
	// Build lacing values for the packet.
	var lacing []byte
	remaining := len(packet)
	for remaining >= 255 {
		lacing = append(lacing, 255)
		remaining -= 255
	}
	lacing = append(lacing, byte(remaining))

	// Page header (27 bytes) + lacing table + packet data.
	headerSize := 27 + len(lacing)
	page := make([]byte, headerSize+len(packet))

	copy(page[0:4], "OggS")
	page[4] = 0 // version
	flags := byte(0)
	if bos {
		flags |= 0x02
	}
	if eos {
		flags |= 0x04
	}
	page[5] = flags
	binary.LittleEndian.PutUint64(page[6:14], granule)
	binary.LittleEndian.PutUint32(page[14:18], o.serial)
	binary.LittleEndian.PutUint32(page[18:22], o.seqNo)
	o.seqNo++
	// CRC placeholder at [22:26] — filled in below.
	page[26] = byte(len(lacing))
	copy(page[27:], lacing)
	copy(page[headerSize:], packet)

	// Compute CRC-32 (OGG uses a specific polynomial: 0x04c11db7).
	crc := oggCRC32(page)
	binary.LittleEndian.PutUint32(page[22:26], crc)

	_, err := o.w.Write(page)
	return err
}

// oggCRC32 computes the OGG CRC-32 checksum (polynomial 0x04c11db7, no inversion).
func oggCRC32(data []byte) uint32 {
	var crc uint32
	for _, b := range data {
		crc ^= uint32(b) << 24
		for i := 0; i < 8; i++ {
			if crc&0x80000000 != 0 {
				crc = (crc << 1) ^ 0x04c11db7
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}

// ── Opus encoder (cgo stub — falls back to WAV if unavailable) ────────────────
//
// opusEncoder wraps the platform-specific Opus encoder.
// On platforms where Opus encoding is not available (no cgo / no libopus),
// newOpusEncoder returns an error and the recording falls back to WAV.

// opusEncoder is defined in opus_encoder_*.go per-platform.
// The interface is:
//   newOpusEncoder(sampleRate, channels int) (*opusEncoder, error)
//   (e *opusEncoder) encode(samples []int16) ([]byte, error)
//   (e *opusEncoder) header() []byte
//   (e *opusEncoder) commentHeader() []byte
//   (e *opusEncoder) close()

// ── OpusHead / OpusTags builders (pure Go) ────────────────────────────────────

// buildOpusHead builds the OpusHead identification header for OGG/Opus.
// https://wiki.xiph.org/OggOpus#ID_Header
func buildOpusHead(channels, sampleRate int) []byte {
	buf := make([]byte, 19)
	copy(buf[0:8], "OpusHead")
	buf[8] = 1 // version
	buf[9] = byte(channels)
	binary.LittleEndian.PutUint16(buf[10:12], 0)                  // pre-skip
	binary.LittleEndian.PutUint32(buf[12:16], uint32(sampleRate)) // input sample rate
	binary.LittleEndian.PutUint16(buf[16:18], 0)                  // output gain
	buf[18] = 0                                                   // channel mapping family 0
	return buf
}

// buildOpusTags builds a minimal OpusTags comment header.
func buildOpusTags() []byte {
	vendor := "ubersdr-audio"
	buf := make([]byte, 8+4+len(vendor)+4)
	copy(buf[0:8], "OpusTags")
	binary.LittleEndian.PutUint32(buf[8:12], uint32(len(vendor)))
	copy(buf[12:12+len(vendor)], vendor)
	binary.LittleEndian.PutUint32(buf[12+len(vendor):], 0) // 0 user comments
	return buf
}

// ── Disk space pre-check ──────────────────────────────────────────────────────

// estimateMaxBytes returns a conservative upper bound on the file size for a
// 60-minute recording in the given format at the given sample rate / channels.
func estimateMaxBytes(format string, sampleRate, channels int) int64 {
	const durationSecs = int64(maxRecordingDuration / time.Second)
	switch format {
	case "opus":
		// ~32 kbps = 4000 bytes/s
		return 4000 * durationSecs
	default: // pcm / wav
		return int64(sampleRate) * int64(channels) * 2 * durationSecs
	}
}

// pcmDBFS computes the RMS level of a little-endian int16 PCM buffer in dBFS.
// Returns -999 for empty or silent buffers.
func pcmDBFS(pcmLE []byte) float32 {
	n := len(pcmLE) / 2
	if n == 0 {
		return -999
	}
	var sum float64
	for i := 0; i < n; i++ {
		s := float64(int16(binary.LittleEndian.Uint16(pcmLE[i*2:])))
		sum += s * s
	}
	rms := math.Sqrt(sum / float64(n))
	if rms < 1 {
		return -999
	}
	return float32(20 * math.Log10(rms/32768.0))
}
