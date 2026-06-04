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
 * AGW monitoring flow:
 *   subprocess AGW TCP server → agwReadLoop → resultChan (DCD + monitor text)
 *
 * Each instance gets its own working directory in /dev/shm (RAM-backed tmpfs)
 * containing a QtSoundModem.ini with unique KISS and AGW port numbers.
 * The directory is removed on Stop().
 *
 * KISS framing:
 *   FEND (0xC0) [type_byte] [ax25_data...] FEND (0xC0)
 *   type_byte bits 7-4: port number, bits 3-0: command (0=data)
 *
 * AGW PE protocol (subset used here):
 *   Each frame: [port:1][reserved:3][datakind:1][reserved:1][pid:1][reserved:1]
 *               [callfrom:10][callto:10][datalen:4 LE][reserved:4][data: datalen bytes]
 *   datakind 'U' = unproto/UI frame monitor text
 *   datakind 'I' = connected I-frame monitor text
 *   datakind 'S' = supervisory frame monitor text
 *   datakind 'T' = own transmitted frame monitor text
 *   datakind 'd' = DCD state (data[0] = 0 or 1)
 *
 * Wire protocol sent to resultChan (backend → frontend):
 *   0x20  AX.25 packet
 *         [type:1=0x20][kiss_port:1][frame_len:4 uint32 BE][ax25_frame: N bytes]
 *   0x21  Error
 *         [type:1=0x21][msg_len:4 uint32 BE][msg: UTF-8]
 *   0x22  Raw KISS frame (output_mode="kiss")
 *         [type:1=0x22][frame_len:4 uint32 BE][kiss_frame: N bytes]
 *   0x23  DCD state change
 *         [type:1=0x23][channel:1][dcd_on:1]
 *   0x24  Monitor text (decoded frame as human-readable string)
 *         [type:1=0x24][channel:1][is_tx:1][text_len:4 uint32 BE][text: UTF-8]
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

	// agwConnectTimeout is how long we wait for the AGW port to open.
	agwConnectTimeout = 10 * time.Second

	// agwConnectRetryInterval is how long to wait between AGW connect attempts.
	agwConnectRetryInterval = 200 * time.Millisecond

	// agwHeaderSize is the fixed size of an AGW PE frame header.
	agwHeaderSize = 36
)

// AGW PE datakind constants (the frame type byte at offset 4 in the header).
const (
	agwKindMonitorUI  = 'U' // unproto / UI frame monitor text
	agwKindMonitorI   = 'I' // connected I-frame monitor text
	agwKindMonitorS   = 'S' // supervisory frame monitor text
	agwKindMonitorT   = 'T' // own transmitted frame monitor text
	agwKindDCD        = 'd' // DCD state change
	agwKindVersion    = 'R' // version info (sent on connect)
	agwKindPortInfo   = 'G' // port info
	agwKindMonitorRaw = 'K' // raw monitor frame
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
	agwConn  net.Conn // TCP connection to AGW PE server

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
	// Log stderr to help diagnose startup failures (KISS port not opening, etc.)
	// In production this can be changed to io.Discard once stable.
	cmd.Stderr = os.Stderr

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
	kissConn, err := d.connectWithRetry("KISS", d.kissPort, kissConnectTimeout, kissConnectRetryInterval)
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

	// Connect to the AGW PE TCP server (non-fatal if it fails — KISS still works).
	agwConn, err := d.connectWithRetry("AGW", d.agwPort, agwConnectTimeout, agwConnectRetryInterval)
	if err != nil {
		log.Printf("[SoundModem] Warning: failed to connect to AGW port %d: %v (DCD/monitor disabled)", d.agwPort, err)
	} else {
		d.agwConn = agwConn
		// Send AGW 'M' command to enable frame monitoring.
		if err := d.sendAGWMonitorEnable(agwConn); err != nil {
			log.Printf("[SoundModem] Warning: failed to send AGW monitor enable: %v", err)
		}
	}

	// Start goroutines.
	d.wg.Add(3)
	go d.writeLoop(audioChan)
	go d.kissReadLoop(resultChan)
	go d.waitLoop()

	// Start AGW read goroutine only if we have a connection.
	if d.agwConn != nil {
		d.wg.Add(1)
		go d.agwReadLoop(resultChan)
	}

	return nil
}

// connectWithRetry retries connecting to a TCP port until it opens or the timeout expires.
func (d *SoundModemDecoder) connectWithRetry(name string, port int, timeout, retryInterval time.Duration) (net.Conn, error) {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, retryInterval)
		if err == nil {
			log.Printf("[SoundModem] Connected to %s port %d", name, port)
			return conn, nil
		}
		// Check if stop was requested while waiting.
		select {
		case <-d.stopChan:
			return nil, fmt.Errorf("stopped while waiting for %s port", name)
		default:
		}
		time.Sleep(retryInterval)
	}
	return nil, fmt.Errorf("timed out after %s waiting for %s port %d", timeout, name, port)
}

// sendAGWMonitorEnable sends the AGW 'M' command to enable frame monitoring output.
// The AGW PE protocol requires this before the server will send 'U'/'I'/'S'/'T' frames.
func (d *SoundModemDecoder) sendAGWMonitorEnable(conn net.Conn) error {
	// AGW header: 36 bytes, all zero except datakind at offset 4.
	hdr := make([]byte, agwHeaderSize)
	hdr[4] = 'M' // enable monitoring
	_, err := conn.Write(hdr)
	return err
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
	// Close AGW connection → agwReadLoop unblocks.
	if d.agwConn != nil {
		_ = d.agwConn.Close()
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
				}
			}
			return
		}
	}
}

// waitLoop waits for the subprocess to exit and sends a crash error if it
// exits unexpectedly while the decoder is still supposed to be running.
func (d *SoundModemDecoder) waitLoop() {
	defer d.wg.Done()

	err := d.cmd.Wait()

	d.mu.Lock()
	running := d.running
	d.mu.Unlock()

	if running {
		// Process exited while we were still supposed to be running — always notify.
		exitDesc := "exited cleanly"
		if err != nil {
			exitDesc = err.Error()
		}
		log.Printf("[SoundModem] Subprocess exited unexpectedly: %s", exitDesc)
		crashErr := fmt.Errorf("modem process exited unexpectedly: %s", exitDesc)
		select {
		case d.crashChan <- crashErr:
		default:
		}
	}
}

// agwReadLoop reads AGW PE frames from the AGW TCP connection and emits
// DCD state (0x23) and monitor text (0x24) messages on resultChan.
func (d *SoundModemDecoder) agwReadLoop(resultChan chan<- []byte) {
	defer d.wg.Done()

	hdr := make([]byte, agwHeaderSize)

	for {
		// Check stop before blocking read.
		select {
		case <-d.stopChan:
			return
		default:
		}

		d.mu.Lock()
		conn := d.agwConn
		d.mu.Unlock()
		if conn == nil {
			return
		}

		// Read the fixed 36-byte header.
		if _, err := io.ReadFull(conn, hdr); err != nil {
			d.mu.Lock()
			running := d.running
			d.mu.Unlock()
			if running {
				log.Printf("[SoundModem] AGW read error (header): %v", err)
			}
			return
		}

		port := hdr[0]                                    // AGW port (0-based channel index)
		kind := hdr[4]                                    // datakind
		dataLen := binary.LittleEndian.Uint32(hdr[28:32]) // payload length

		// Read the payload (may be zero bytes).
		var data []byte
		if dataLen > 0 {
			// Sanity-cap to avoid OOM on corrupt frames.
			if dataLen > 65536 {
				log.Printf("[SoundModem] AGW frame too large (%d bytes), skipping", dataLen)
				// Drain the bytes to stay in sync.
				drain := make([]byte, dataLen)
				_, _ = io.ReadFull(conn, drain)
				continue
			}
			data = make([]byte, dataLen)
			if _, err := io.ReadFull(conn, data); err != nil {
				d.mu.Lock()
				running := d.running
				d.mu.Unlock()
				if running {
					log.Printf("[SoundModem] AGW read error (data): %v", err)
				}
				return
			}
		}

		switch kind {
		case agwKindDCD:
			// data[0] = 0 (DCD off) or 1 (DCD on)
			dcdOn := byte(0)
			if len(data) > 0 && data[0] != 0 {
				dcdOn = 1
			}
			pkt := encodeDCDFrame(port, dcdOn)
			select {
			case resultChan <- pkt:
			default:
				log.Printf("[SoundModem] Result channel full, dropping DCD frame")
			}

		case agwKindMonitorUI, agwKindMonitorI, agwKindMonitorS:
			// RX monitor text — isTX = 0
			if len(data) > 0 {
				pkt := encodeMonitorFrame(port, 0, data)
				select {
				case resultChan <- pkt:
				default:
					log.Printf("[SoundModem] Result channel full, dropping monitor frame")
				}
			}

		case agwKindMonitorT:
			// TX monitor text — isTX = 1 (we are RX-only but log it anyway)
			if len(data) > 0 {
				pkt := encodeMonitorFrame(port, 1, data)
				select {
				case resultChan <- pkt:
				default:
					log.Printf("[SoundModem] Result channel full, dropping TX monitor frame")
				}
			}

		case agwKindVersion, agwKindPortInfo, agwKindMonitorRaw:
			// Informational frames — ignore silently.

		default:
			// Unknown frame kind — ignore.
		}
	}
}

// CrashChan returns a channel that receives an error if the subprocess crashes
// while still supposed to be running.
func (d *SoundModemDecoder) CrashChan() <-chan error {
	return d.crashChan
}

// --- Wire-protocol frame encoders ---

// encodePacketFrame builds a 0x20 AX.25 packet envelope:
//
//	[type:1=0x20][kiss_port:1][frame_len:4 uint32 BE][ax25_frame: N bytes]
func encodePacketFrame(kissPort byte, ax25 []byte) []byte {
	buf := make([]byte, 6+len(ax25))
	buf[0] = MsgPacket
	buf[1] = kissPort
	binary.BigEndian.PutUint32(buf[2:6], uint32(len(ax25)))
	copy(buf[6:], ax25)
	return buf
}

// encodeKISSFrame builds a 0x22 raw KISS frame envelope:
//
//	[type:1=0x22][frame_len:4 uint32 BE][kiss_frame: N bytes]
//
// where kiss_frame = 0xC0 [kiss_type_byte] [ax25_data...] 0xC0
func encodeKISSFrame(frame []byte) []byte {
	// Reconstruct the full KISS frame with 0xC0 delimiters.
	kissFrame := make([]byte, 0, 2+len(frame))
	kissFrame = append(kissFrame, kissFrameEnd)
	kissFrame = append(kissFrame, frame...)
	kissFrame = append(kissFrame, kissFrameEnd)

	buf := make([]byte, 5+len(kissFrame))
	buf[0] = MsgKISSFrame
	binary.BigEndian.PutUint32(buf[1:5], uint32(len(kissFrame)))
	copy(buf[5:], kissFrame)
	return buf
}

// encodeErrorFrame builds a 0x21 error message envelope:
//
//	[type:1=0x21][msg_len:4 uint32 BE][msg: UTF-8]
func encodeErrorFrame(msg string) []byte {
	msgBytes := []byte(msg)
	buf := make([]byte, 5+len(msgBytes))
	buf[0] = MsgError
	binary.BigEndian.PutUint32(buf[1:5], uint32(len(msgBytes)))
	copy(buf[5:], msgBytes)
	return buf
}

// encodeDCDFrame builds a 0x23 DCD state change envelope:
//
//	[type:1=0x23][channel:1][dcd_on:1]
func encodeDCDFrame(channel, dcdOn byte) []byte {
	return []byte{MsgDCD, channel, dcdOn}
}

// encodeMonitorFrame builds a 0x24 monitor text envelope:
//
//	[type:1=0x24][channel:1][is_tx:1][text_len:4 uint32 BE][text: UTF-8]
func encodeMonitorFrame(channel, isTX byte, text []byte) []byte {
	buf := make([]byte, 7+len(text))
	buf[0] = MsgMonitor
	buf[1] = channel
	buf[2] = isTX
	binary.BigEndian.PutUint32(buf[3:7], uint32(len(text)))
	copy(buf[7:], text)
	return buf
}
