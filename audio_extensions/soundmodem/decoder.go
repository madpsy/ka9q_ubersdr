package soundmodem

/*
 * Sound Modem Decoder
 * Manages the QtSoundModem subprocess lifecycle.
 *
 * Audio flow:
 *   audioChan ([]int16 mono PCM) → writeLoop → subprocess stdin (int16 LE)
 *
 * Decoded packet flow:
 *   subprocess KISS TCP server → kissReadLoop → resultChan (binary frames)
 *
 * Each instance gets its own working directory in /dev/shm (RAM-backed tmpfs)
 * containing a QtSoundModem.ini with unique KISS and AGW port numbers.
 * The directory is removed on Stop().
 *
 * KISS framing:
 *   FEND (0xC0) [type_byte] [ax25_data...] FEND (0xC0)
 *   type_byte bits 7-4: port number, bits 3-0: command (0=data)
 *
 * Wire protocol sent to resultChan (backend → frontend):
 *   0x20  AX.25 packet
 *         [type:1=0x20][kiss_port:1][frame_len:4 uint32 BE][ax25_frame: N bytes]
 *   0x21  Error
 *         [type:1=0x21][msg_len:4 uint32 BE][msg: UTF-8]
 */

import (
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	// KISS framing constants
	kissFrameEnd  = 0xC0
	kissFrameEsc  = 0xDB
	kissTFrameEnd = 0xDC
	kissTFrameEsc = 0xDD

	// kissConnectTimeout is how long we wait for QtSoundModem to start
	// listening on its KISS port before giving up.
	kissConnectTimeout = 10 * time.Second

	// kissConnectRetryInterval is how long to wait between TCP connect attempts.
	kissConnectRetryInterval = 200 * time.Millisecond

	// kissReadBufSize is the size of the KISS TCP read buffer.
	kissReadBufSize = 4096
)

// ChannelConfig holds per-modem-channel configuration.
// QtSoundModem supports up to 4 channels (A/B/C/D).
type ChannelConfig struct {
	Enabled   bool    // whether this channel is active
	ModemType int     // modem type index (0=AFSK300, 1=AFSK1200, 4=BPSK1200, etc.)
	Freq      float64 // center frequency in Hz (e.g. 1700.0 for Bell 202)
	RcvrPairs int     // number of receiver diversity pairs (0–8)
	FX25      int     // FX.25 mode: 0=off, 1=RX only, 2=RX+TX
	IL2P      int     // IL2P mode: 0=off, 1=IL2P, 2=IL2P+CRC, 3=both
}

// OutputMode controls what the backend sends to the frontend for each decoded frame.
type OutputMode string

const (
	// OutputModeAX25 strips KISS framing and sends raw AX.25 bytes in a 0x20 envelope.
	// Use this for the built-in web frontend display.
	OutputModeAX25 OutputMode = "ax25"

	// OutputModeKISS sends the complete raw KISS frame (0xC0 delimiters + type byte + AX.25)
	// in a 0x22 envelope. Use this when the client wants to pipe frames to other software.
	OutputModeKISS OutputMode = "kiss"
)

// SoundModemConfig holds the full configuration for a QtSoundModem instance.
type SoundModemConfig struct {
	SampleRate   int
	DCDThreshold int
	OutputMode   OutputMode
	Channels     [4]ChannelConfig
}

// DefaultSoundModemConfig returns a sensible default: one channel, AFSK 1200bd at 1700 Hz.
// OutputMode is intentionally left empty — it must be set explicitly by the caller.
func DefaultSoundModemConfig(sampleRate int) SoundModemConfig {
	cfg := SoundModemConfig{
		SampleRate:   sampleRate,
		DCDThreshold: 20,
		OutputMode:   "", // must be set explicitly — no default
	}
	cfg.Channels[0] = ChannelConfig{
		Enabled:   true,
		ModemType: 1,    // AFSK AX.25 1200bd (Bell 202)
		Freq:      1700, // standard Bell 202 center frequency
		RcvrPairs: 0,
		FX25:      1, // FX.25 RX enabled
		IL2P:      0,
	}
	return cfg
}

// buildIni generates the QtSoundModem.ini content for this instance.
// agwPort and kissPort are the unique TCP ports assigned to this instance.
func buildIni(cfg SoundModemConfig, agwPort, kissPort int) string {
	var b strings.Builder

	// [AGWHost]
	fmt.Fprintf(&b, "[AGWHost]\nPort=%d\nServer=1\n\n", agwPort)

	// [AX25_A] through [AX25_D]
	chNames := []string{"A", "B", "C", "D"}
	for i, name := range chNames {
		ch := cfg.Channels[i]
		fx25 := ch.FX25
		if !ch.Enabled {
			fx25 = 0
		}
		fmt.Fprintf(&b, "[AX25_%s]\n", name)
		fmt.Fprintf(&b, "BitRecovery=0\n")
		fmt.Fprintf(&b, "DynamicFrack=0\n")
		fmt.Fprintf(&b, "ExcludeAPRSFrmType=\n")
		fmt.Fprintf(&b, "ExcludeCallsigns=\n")
		fmt.Fprintf(&b, "FX25=%d\n", fx25)
		fmt.Fprintf(&b, "FrackTime=5\n")
		fmt.Fprintf(&b, "FrameCollector=6\n")
		fmt.Fprintf(&b, "HiToneRaise=0\n")
		fmt.Fprintf(&b, "IL2P=%d\n", ch.IL2P)
		fmt.Fprintf(&b, "IL2PCRC=0\n")
		fmt.Fprintf(&b, "IPOLL=80\n")
		fmt.Fprintf(&b, "IdleTime=180\n")
		fmt.Fprintf(&b, "KISSOptimization=0\n")
		fmt.Fprintf(&b, "MEMRecovery=200\n")
		fmt.Fprintf(&b, "Maxframe=3\n")
		fmt.Fprintf(&b, "MyDigiCall=\n")
		fmt.Fprintf(&b, "NonAX25Frm=0\n")
		fmt.Fprintf(&b, "Persist=128\n")
		fmt.Fprintf(&b, "RSID_SABM=0\n")
		fmt.Fprintf(&b, "RSID_SetModem=0\n")
		fmt.Fprintf(&b, "RSID_UI=0\n")
		fmt.Fprintf(&b, "RespTime=1500\n")
		fmt.Fprintf(&b, "Retries=15\n")
		fmt.Fprintf(&b, "SlotTime=100\n")
		fmt.Fprintf(&b, "TXFrmMode=1\n")
		fmt.Fprintf(&b, "\n")
	}

	// [Init]
	fmt.Fprintf(&b, "[Init]\n")
	fmt.Fprintf(&b, "CM108Addr=/dev/hidraw0\n")
	fmt.Fprintf(&b, "DispMode=0\n")
	fmt.Fprintf(&b, "DualPTT=0\n")
	fmt.Fprintf(&b, "FLRigHost=127.0.0.1\n")
	fmt.Fprintf(&b, "FLRigPort=12345\n")
	fmt.Fprintf(&b, "HamLibHost=127.0.0.1\n")
	fmt.Fprintf(&b, "HamLibPort=4532\n")
	fmt.Fprintf(&b, "MinimizetoTray=0\n")
	fmt.Fprintf(&b, "PTT=\n")
	fmt.Fprintf(&b, "PTTBAUD=19200\n")
	fmt.Fprintf(&b, "PTTMode=1\n")
	fmt.Fprintf(&b, "PTTOffString=\n")
	fmt.Fprintf(&b, "PTTOnString=\n")
	fmt.Fprintf(&b, "RXSampleRate=%d\n", cfg.SampleRate)
	fmt.Fprintf(&b, "SCO=0\n")
	fmt.Fprintf(&b, "SndRXDeviceName=stdin\n")
	fmt.Fprintf(&b, "SndTXDeviceName=null\n")
	fmt.Fprintf(&b, "SoundMode=0\n")
	fmt.Fprintf(&b, "TXPort=8884\n")
	fmt.Fprintf(&b, "TXRotate=0\n")
	fmt.Fprintf(&b, "TXSampleRate=%d\n", cfg.SampleRate)
	fmt.Fprintf(&b, "UDPClientPort=8888\n")
	fmt.Fprintf(&b, "UDPHost=127.0.0.1\n")
	fmt.Fprintf(&b, "UDPServer=0\n")
	fmt.Fprintf(&b, "UDPServerPort=8884\n")
	fmt.Fprintf(&b, "WaterfallMax=3300\n")
	fmt.Fprintf(&b, "WaterfallMin=0\n")
	fmt.Fprintf(&b, "darkTheme=false\n")
	fmt.Fprintf(&b, "multiCore=0\n")
	fmt.Fprintf(&b, "onlyMixSnoop=false\n")
	fmt.Fprintf(&b, "pttGPIOPin=17\n")
	fmt.Fprintf(&b, "pttGPIOPinR=17\n")
	fmt.Fprintf(&b, "txLatency=50\n")
	fmt.Fprintf(&b, "useKISSControls=false\n")
	fmt.Fprintf(&b, "\n")

	// [KISS]
	fmt.Fprintf(&b, "[KISS]\nPort=%d\nServer=1\n\n", kissPort)

	// [MGMT] — Port=0 disables the management server
	fmt.Fprintf(&b, "[MGMT]\nPort=0\n\n")

	// [Modem]
	fmt.Fprintf(&b, "[Modem]\n")
	fmt.Fprintf(&b, "CWIDCall=\n")
	fmt.Fprintf(&b, "CWIDInterval=0\n")
	fmt.Fprintf(&b, "CWIDLeft=0\n")
	fmt.Fprintf(&b, "CWIDMark=\n")
	fmt.Fprintf(&b, "CWIDRight=0\n")
	fmt.Fprintf(&b, "CWIDType=1\n")
	fmt.Fprintf(&b, "DCDThreshold=%d\n", cfg.DCDThreshold)
	for i := 0; i < 4; i++ {
		ch := cfg.Channels[i]
		modemType := ch.ModemType
		if !ch.Enabled {
			modemType = 0
		}
		fmt.Fprintf(&b, "ModemType%d=%d\n", i+1, modemType)
	}
	for i := 0; i < 4; i++ {
		fmt.Fprintf(&b, "NRRcvrPairs%d=%d\n", i+1, cfg.Channels[i].RcvrPairs)
	}
	for i := 0; i < 4; i++ {
		fmt.Fprintf(&b, "PreEmphasisAll%d=0\n", i+1)
	}
	for i := 0; i < 4; i++ {
		fmt.Fprintf(&b, "PreEmphasisDB%d=0\n", i+1)
	}
	for i := 0; i < 4; i++ {
		freq := cfg.Channels[i].Freq
		if freq <= 0 {
			freq = 1700
		}
		fmt.Fprintf(&b, "RXFreq%d=%.0f\n", i+1, freq)
	}
	for i := 0; i < 4; i++ {
		fmt.Fprintf(&b, "RcvrShift%d=30\n", i+1)
	}
	for i := 0; i < 4; i++ {
		fmt.Fprintf(&b, "TxDelay%d=250\n", i+1)
	}
	for i := 0; i < 4; i++ {
		fmt.Fprintf(&b, "TxTail%d=50\n", i+1)
	}
	fmt.Fprintf(&b, "afterTraffic=false\n")
	fmt.Fprintf(&b, "rxOffset=0\n")
	// soundChannel: 0=disabled, 1=left, 2=right
	// Since we feed mono stdin (duplicated to L+R), all active channels use left (1).
	for i := 0; i < 4; i++ {
		sc := 0
		if cfg.Channels[i].Enabled {
			sc = 1
		}
		fmt.Fprintf(&b, "soundChannel%d=%d\n", i+1, sc)
	}
	fmt.Fprintf(&b, "\n")

	// [SixPack]
	fmt.Fprintf(&b, "[SixPack]\nDevice=\nEnable=0\nPort=0\n\n")

	// [Window] — disable waterfall (no GUI)
	fmt.Fprintf(&b, "[Window]\nWaterfall1=0\nWaterfall2=0\n")

	return b.String()
}

// SoundModemDecoder manages the QtSoundModem subprocess.
type SoundModemDecoder struct {
	cfg      SoundModemConfig
	kissPort int
	agwPort  int

	tempDir string // /dev/shm/soundmodem-XXXXXX

	cmd   *exec.Cmd
	stdin io.WriteCloser

	kissConn net.Conn // TCP connection to KISS server

	running   bool
	stopChan  chan struct{}
	crashChan chan error
	wg        sync.WaitGroup
	mu        sync.Mutex
}

// NewSoundModemDecoder creates a new decoder but does not start the subprocess.
func NewSoundModemDecoder(cfg SoundModemConfig, kissPort, agwPort int) (*SoundModemDecoder, error) {
	return &SoundModemDecoder{
		cfg:       cfg,
		kissPort:  kissPort,
		agwPort:   agwPort,
		crashChan: make(chan error, 1),
	}, nil
}

// Start launches the subprocess and begins the read/write goroutines.
func (d *SoundModemDecoder) Start(audioChan <-chan AudioSample, resultChan chan<- []byte) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.running {
		return fmt.Errorf("sound modem decoder already running")
	}

	// Create per-instance working directory in /dev/shm (RAM-backed tmpfs).
	// Fall back to os.TempDir() if /dev/shm is not available.
	tmpBase := "/dev/shm"
	if _, err := os.Stat(tmpBase); os.IsNotExist(err) {
		tmpBase = os.TempDir()
	}
	tempDir, err := os.MkdirTemp(tmpBase, "soundmodem-*")
	if err != nil {
		return fmt.Errorf("failed to create temp dir: %w", err)
	}
	d.tempDir = tempDir

	// Write QtSoundModem.ini into the temp dir.
	iniPath := tempDir + "/QtSoundModem.ini"
	iniContent := buildIni(d.cfg, d.agwPort, d.kissPort)
	if err := os.WriteFile(iniPath, []byte(iniContent), 0644); err != nil {
		_ = os.RemoveAll(tempDir)
		return fmt.Errorf("failed to write QtSoundModem.ini: %w", err)
	}

	// Launch QtSoundModem in nogui mode with the temp dir as CWD.
	cmd := exec.Command(binaryPath, "nogui")
	cmd.Dir = tempDir
	cmd.Stderr = io.Discard // suppress Qt/debug output

	stdin, err := cmd.StdinPipe()
	if err != nil {
		_ = os.RemoveAll(tempDir)
		return fmt.Errorf("failed to create stdin pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = os.RemoveAll(tempDir)
		return fmt.Errorf("failed to start %s: %w", binaryPath, err)
	}

	// Deprioritise the subprocess — CPU-heavy but not latency-sensitive.
	if err := syscall.Setpriority(syscall.PRIO_PROCESS, cmd.Process.Pid, 10); err != nil {
		log.Printf("[SoundModem] Warning: failed to renice process %d: %v", cmd.Process.Pid, err)
	}

	d.cmd = cmd
	d.stdin = stdin
	d.stopChan = make(chan struct{})
	d.running = true

	// Build a summary of active channels for the log line.
	var chSummary []string
	modemNames := []string{
		"AFSK300", "AFSK1200", "AFSK600", "AFSK2400",
		"BPSK1200", "BPSK600", "BPSK300", "BPSK2400",
		"QPSK4800", "QPSK3600", "QPSK2400", "BPSKFEC",
		"QPSKV26A", "8PSKV27", "QPSKV26B", "ARDOP",
	}
	for i, ch := range d.cfg.Channels {
		if ch.Enabled {
			name := "UNKNOWN"
			if ch.ModemType >= 0 && ch.ModemType < len(modemNames) {
				name = modemNames[ch.ModemType]
			}
			chSummary = append(chSummary, fmt.Sprintf("ch%d=%s@%.0fHz", i+1, name, ch.Freq))
		}
	}
	log.Printf("[SoundModem pid=%d] Started QtSoundModem nogui (KISS=%d, AGW=%d, dir=%s, channels=[%s])",
		cmd.Process.Pid, d.kissPort, d.agwPort, tempDir, strings.Join(chSummary, " "))

	// Connect to the KISS TCP server (with retry until QtSoundModem is ready).
	kissConn, err := d.connectKISS()
	if err != nil {
		// Subprocess started but KISS port never opened — kill and clean up.
		d.running = false
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		_ = os.RemoveAll(tempDir)
		return fmt.Errorf("failed to connect to KISS port %d: %w", d.kissPort, err)
	}
	d.kissConn = kissConn

	// Start goroutines.
	d.wg.Add(3)
	go d.writeLoop(audioChan)
	go d.kissReadLoop(resultChan)
	go d.waitLoop()

	return nil
}

// connectKISS retries connecting to the KISS TCP port until QtSoundModem
// is ready or the timeout expires.
func (d *SoundModemDecoder) connectKISS() (net.Conn, error) {
	addr := fmt.Sprintf("127.0.0.1:%d", d.kissPort)
	deadline := time.Now().Add(kissConnectTimeout)

	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, kissConnectRetryInterval)
		if err == nil {
			log.Printf("[SoundModem] Connected to KISS port %d", d.kissPort)
			return conn, nil
		}
		// Check if stop was requested while waiting.
		select {
		case <-d.stopChan:
			return nil, fmt.Errorf("stopped while waiting for KISS port")
		default:
		}
		time.Sleep(kissConnectRetryInterval)
	}
	return nil, fmt.Errorf("timed out after %s", kissConnectTimeout)
}

// Stop shuts down the subprocess and cleans up resources.
func (d *SoundModemDecoder) Stop() error {
	d.mu.Lock()
	if !d.running {
		d.mu.Unlock()
		return nil
	}
	d.running = false
	close(d.stopChan)

	// Close stdin → subprocess sees EOF and exits.
	if d.stdin != nil {
		_ = d.stdin.Close()
	}
	// Close KISS connection → kissReadLoop unblocks.
	if d.kissConn != nil {
		_ = d.kissConn.Close()
	}
	d.mu.Unlock()

	// Wait for goroutines with a timeout, then force-kill.
	done := make(chan struct{})
	go func() {
		d.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		// Clean exit.
	case <-time.After(stopTimeout):
		log.Printf("[SoundModem] Subprocess did not exit within %s — killing", stopTimeout)
		d.mu.Lock()
		if d.cmd != nil && d.cmd.Process != nil {
			_ = d.cmd.Process.Kill()
		}
		d.mu.Unlock()
		<-done
	}

	// Remove the per-instance temp directory.
	if d.tempDir != "" {
		if err := os.RemoveAll(d.tempDir); err != nil {
			log.Printf("[SoundModem] Warning: failed to remove temp dir %s: %v", d.tempDir, err)
		}
	}

	log.Printf("[SoundModem] Subprocess stopped")
	return nil
}

// writeLoop reads AudioSamples from audioChan and writes raw int16 LE mono PCM
// to the subprocess stdin.
func (d *SoundModemDecoder) writeLoop(audioChan <-chan AudioSample) {
	defer d.wg.Done()

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

			// Cast []int16 → []byte in-place (safe on little-endian platforms).
			n := len(sample.PCMData) * 2
			byteSlice := unsafe.Slice((*byte)(unsafe.Pointer(&sample.PCMData[0])), n)

			d.mu.Lock()
			stdin := d.stdin
			running := d.running
			d.mu.Unlock()

			if !running || stdin == nil {
				return
			}

			if _, err := stdin.Write(byteSlice); err != nil {
				if d.running {
					log.Printf("[SoundModem] stdin write error: %v", err)
				}
				return
			}
		}
	}
}

// kissReadLoop reads KISS-framed AX.25 packets from the TCP connection and
// forwards them as binary frames on resultChan.
func (d *SoundModemDecoder) kissReadLoop(resultChan chan<- []byte) {
	defer d.wg.Done()

	buf := make([]byte, kissReadBufSize)
	var frame []byte
	inFrame := false
	escaped := false

	for {
		// Check stop before blocking read.
		select {
		case <-d.stopChan:
			return
		default:
		}

		d.mu.Lock()
		conn := d.kissConn
		d.mu.Unlock()

		if conn == nil {
			return
		}

		n, err := conn.Read(buf)
		if n > 0 {
			for _, b := range buf[:n] {
				if escaped {
					escaped = false
					switch b {
					case kissTFrameEnd:
						frame = append(frame, kissFrameEnd)
					case kissTFrameEsc:
						frame = append(frame, kissFrameEsc)
					default:
						frame = append(frame, b)
					}
					continue
				}

				switch b {
				case kissFrameEnd:
					if inFrame && len(frame) > 1 {
						// frame[0] is the KISS type byte: high nibble=port, low nibble=cmd
						kissPort := (frame[0] >> 4) & 0x0F
						kissCmd := frame[0] & 0x0F
						if kissCmd == 0 { // data frame
							var pkt []byte
							switch d.cfg.OutputMode {
							case OutputModeKISS:
								// Send the complete raw KISS frame (with 0xC0 delimiters)
								// so the client can pipe it directly to other KISS software.
								pkt = encodeKISSFrame(frame)
							default:
								// OutputModeAX25: strip KISS type byte, send raw AX.25 in envelope.
								ax25 := frame[1:]
								pkt = encodePacketFrame(kissPort, ax25)
							}
							select {
							case resultChan <- pkt:
							default:
								log.Printf("[SoundModem] Result channel full, dropping frame")
							}
						}
					}
					// Reset for next frame.
					frame = frame[:0]
					inFrame = false

				case kissFrameEsc:
					if inFrame {
						escaped = true
					}

				default:
					if !inFrame {
						inFrame = true
						frame = frame[:0]
					}
					frame = append(frame, b)
				}
			}
		}

		if err != nil {
			if err != io.EOF {
				d.mu.Lock()
				running := d.running
				d.mu.Unlock()
				if running {
					log.Printf("[SoundModem] KISS read error: %v", err)
					select {
					case resultChan <- encodeErrorFrame("Sound Modem KISS connection lost"):
					default:
					}
				}
			}
			return
		}
	}
}

// waitLoop waits for the subprocess to exit and signals a crash if unexpected.
func (d *SoundModemDecoder) waitLoop() {
	defer d.wg.Done()

	if d.cmd == nil {
		return
	}

	err := d.cmd.Wait()

	d.mu.Lock()
	running := d.running
	d.mu.Unlock()

	if running {
		if err != nil {
			log.Printf("[SoundModem] Subprocess exited unexpectedly: %v", err)
			select {
			case d.crashChan <- err:
			default:
			}
		} else {
			log.Printf("[SoundModem] Subprocess exited unexpectedly (exit code 0)")
			select {
			case d.crashChan <- fmt.Errorf("QtSoundModem exited unexpectedly"):
			default:
			}
		}
	} else {
		log.Printf("[SoundModem] Subprocess exited cleanly")
	}
}

// CrashChan returns a channel that receives an error if the subprocess crashes
// while still supposed to be running.
func (d *SoundModemDecoder) CrashChan() <-chan error {
	return d.crashChan
}

// encodePacketFrame builds a 0x20 binary frame (output_mode="ax25"):
//
//	[type:1=0x20][kiss_port:1][frame_len:4 uint32 BE][ax25_frame: N bytes]
//
// The KISS type byte is stripped; only the raw AX.25 frame bytes are included.
func encodePacketFrame(kissPort byte, ax25 []byte) []byte {
	pkt := make([]byte, 1+1+4+len(ax25))
	pkt[0] = MsgPacket
	pkt[1] = kissPort
	binary.BigEndian.PutUint32(pkt[2:6], uint32(len(ax25)))
	copy(pkt[6:], ax25)
	return pkt
}

// encodeKISSFrame builds a 0x22 binary frame (output_mode="kiss"):
//
//	[type:1=0x22][frame_len:4 uint32 BE][kiss_frame: N bytes]
//
// kiss_frame is the complete KISS frame including the 0xC0 delimiters and type byte,
// exactly as it would appear on a KISS TNC TCP connection. Clients can pipe this
// directly to direwolf, APRS software, or any other KISS-aware application.
func encodeKISSFrame(kissContent []byte) []byte {
	// Reconstruct the full KISS frame: FEND + content + FEND
	// kissContent is the raw bytes between the 0xC0 delimiters (type byte + AX.25 data)
	kissFrame := make([]byte, 1+len(kissContent)+1)
	kissFrame[0] = kissFrameEnd
	copy(kissFrame[1:], kissContent)
	kissFrame[len(kissFrame)-1] = kissFrameEnd

	pkt := make([]byte, 1+4+len(kissFrame))
	pkt[0] = MsgKISSFrame
	binary.BigEndian.PutUint32(pkt[1:5], uint32(len(kissFrame)))
	copy(pkt[5:], kissFrame)
	return pkt
}

// encodeErrorFrame builds a 0x21 binary frame:
//
//	[type:1=0x21][msg_len:4 uint32 BE][msg: UTF-8]
func encodeErrorFrame(msg string) []byte {
	b := []byte(msg)
	pkt := make([]byte, 1+4+len(b))
	pkt[0] = MsgError
	binary.BigEndian.PutUint32(pkt[1:5], uint32(len(b)))
	copy(pkt[5:], b)
	return pkt
}
