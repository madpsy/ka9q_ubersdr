package hpsdr

import (
	"errors"
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/ubersdr"
)

// Config is everything a bridge needs to run.
type Config struct {
	Server *ubersdr.Server

	// NumRx is how many DDCs to emulate, 1..MaxReceivers.
	NumRx int
	// Device is DeviceHermes or DeviceHermesLite.
	Device byte
	// MinMargin is the reduced-depth margin in dB, or 0 for lossless.
	MinMargin int
	// RatesKHz are the rates offered to clients: advertised in the protocol 2
	// discovery reply and the only ones a receiver will connect at. Empty
	// offers all four.
	RatesKHz []int
	// MAC goes in both protocols' discovery replies.
	MAC [6]byte

	// Iface, when set, restricts the bridge to clients on that interface's
	// subnet (and loopback): discovery and the start of a stream from anywhere
	// else are ignored, so the radio only appears on the network chosen. The
	// sockets still bind the wildcard address, which is what receives a
	// broadcast discovery on every platform.
	Iface Iface

	// MinHz and MaxHz are the receiver's tuning range. A client tuned outside
	// it is warned about, not clamped: the HPSDR protocol has no field for a
	// range, so the client takes its limits from the hardware it thinks it is
	// talking to. Zero for both means the defaults.
	MinHz, MaxHz int64

	// BasePort is the discovery port, 1024 on a real radio; the others follow
	// at fixed offsets. BindIP is the address every socket binds, nil for the
	// wildcard -- which is what receives a broadcast discovery. Both exist for
	// the tests.
	BasePort int
	BindIP   net.IP

	// Wideband sends the bandscope from WidebandFile, a sweep of 16384 16-bit
	// samples written by a local RX888 setup.
	Wideband     bool
	WidebandFile string

	// Debug logs every DDC frequency request.
	Debug bool

	// Logf receives one line per call, without a trailing newline. Nil
	// discards.
	Logf func(string)

	// Timings; zero takes the defaults. Tests shorten them.
	Watchdog       time.Duration // no client UDP at all for this long stops protocol 2 (10 s)
	ReconnectDelay time.Duration // after a socket closes or the rate changes (1 s)
	RetryDelay     time.Duration // after a failed connect (2 s)
	RefusedDelay   time.Duration // after /connection refuses (5 s)
	IdleTimeout    time.Duration // no frame from the server for this long reconnects (15 s)
}

const (
	defaultWatchdog       = 10 * time.Second
	defaultReconnectDelay = 1 * time.Second
	defaultRetryDelay     = 2 * time.Second
	defaultRefusedDelay   = 5 * time.Second
	defaultIdleTimeout    = 15 * time.Second

	// ThroughputInterval is how often the IQ line is logged while streaming.
	ThroughputInterval = 5 * time.Second
)

// DefaultWidebandFile is where the C bridge read the bandscope from.
const DefaultWidebandFile = "/dev/shm/rx888wb.bin"

func (c *Config) setDefaults() error {
	if c.Server == nil {
		return errors.New("no server configured")
	}
	if c.NumRx < 1 || c.NumRx > MaxReceivers {
		return fmt.Errorf("receivers must be 1-%d, not %d", MaxReceivers, c.NumRx)
	}
	if c.Device != DeviceHermes && c.Device != DeviceHermesLite {
		return fmt.Errorf("device must be %d (Hermes) or %d (Hermes Lite), not %d", DeviceHermes, DeviceHermesLite, c.Device)
	}
	if len(c.RatesKHz) == 0 {
		c.RatesKHz = []int{48, 96, 192, 384}
	}
	for _, r := range c.RatesKHz {
		if RateMask([]int{r}) == 0 {
			return fmt.Errorf("%d kHz is not a rate the HPSDR protocol carries", r)
		}
	}
	if c.MinHz == 0 && c.MaxHz == 0 {
		c.MinHz, c.MaxHz = ubersdr.DefaultMinHz, ubersdr.DefaultMaxHz
	}
	if c.BasePort == 0 {
		c.BasePort = 1024
	}
	if c.WidebandFile == "" {
		c.WidebandFile = DefaultWidebandFile
	}
	def := func(d *time.Duration, v time.Duration) {
		if *d == 0 {
			*d = v
		}
	}
	def(&c.Watchdog, defaultWatchdog)
	def(&c.ReconnectDelay, defaultReconnectDelay)
	def(&c.RetryDelay, defaultRetryDelay)
	def(&c.RefusedDelay, defaultRefusedDelay)
	def(&c.IdleTimeout, defaultIdleTimeout)
	return nil
}

// ddcState is one DDC as the client has configured it.
type ddcState struct {
	enable  bool
	rateKHz int
	freq    int64
}

// Bridge is one emulated radio.
type Bridge struct {
	cfg Config
	p1  *P1

	disc, ddcSpec, mic, hp, audio, txiq *net.UDPConn
	ddc                                 []*net.UDPConn

	mu sync.Mutex
	// running is set by whichever protocol is streaming: the high priority
	// packet's run bit for protocol 2, the run command for protocol 1.
	running bool
	// genRcvd and client are set by a protocol 2 general packet; client is
	// where every radio->host packet goes.
	genRcvd  bool
	client   *net.UDPAddr
	freqMode int
	wb       General
	rx       [MaxReceivers]ddcState
	iqSeq    [MaxReceivers]uint32
	lastAct  time.Time

	hpSeq, gpSeq, ddcSeq uint32
	hpCount              int
	hpRateStart          time.Time
	warned               map[string]bool

	receivers []*receiver

	stop     chan struct{}
	stopOnce sync.Once
	wg       sync.WaitGroup
}

// New opens every socket, so a port already in use is reported here rather
// than from a goroutine, and returns a bridge ready to Start.
func New(cfg Config) (*Bridge, error) {
	if err := cfg.setDefaults(); err != nil {
		return nil, err
	}
	b := &Bridge{cfg: cfg, freqMode: -1, warned: map[string]bool{}, stop: make(chan struct{})}
	b.p1 = newP1(b)

	open := func(off int) (*net.UDPConn, error) {
		addr := &net.UDPAddr{IP: cfg.BindIP, Port: cfg.BasePort + off}
		c, err := net.ListenUDP("udp4", addr)
		if err != nil {
			return nil, fmt.Errorf("cannot listen on UDP port %d: %w", addr.Port, err)
		}
		return c, nil
	}
	var err error
	all := []struct {
		dst **net.UDPConn
		off int
	}{
		{&b.disc, PortDiscovery}, {&b.ddcSpec, PortDDCSpecific}, {&b.mic, PortMic},
		{&b.hp, PortHighPrio}, {&b.audio, PortAudio}, {&b.txiq, PortTXIQ},
	}
	for _, s := range all {
		if *s.dst, err = open(s.off); err != nil {
			b.closeSockets()
			return nil, err
		}
	}
	for i := 0; i < cfg.NumRx; i++ {
		c, err := open(PortDDC0 + i)
		if err != nil {
			b.closeSockets()
			return nil, err
		}
		b.ddc = append(b.ddc, c)
	}
	for i := 0; i < cfg.NumRx; i++ {
		b.receivers = append(b.receivers, newReceiver(b, i))
	}
	return b, nil
}

func (b *Bridge) closeSockets() {
	for _, c := range []*net.UDPConn{b.disc, b.ddcSpec, b.mic, b.hp, b.audio, b.txiq} {
		if c != nil {
			c.Close()
		}
	}
	for _, c := range b.ddc {
		c.Close()
	}
}

// Start runs the bridge until Close.
func (b *Bridge) Start() {
	b.logf("Listening for HPSDR clients on UDP %d (protocol 1 and 2), %d receivers, rates %s kHz",
		b.cfg.BasePort, b.cfg.NumRx, joinInts(b.cfg.RatesKHz))
	loops := []func(){
		b.discoveryLoop, b.ddcSpecificLoop, b.highPriorityLoop,
		b.statusLoop, b.micLoop, b.watchdogLoop, b.throughputLoop,
		func() { b.drainLoop(b.mic) }, func() { b.drainLoop(b.audio) }, func() { b.drainLoop(b.txiq) },
	}
	if b.cfg.Wideband {
		loops = append(loops, b.widebandLoop)
	}
	for _, r := range b.receivers {
		loops = append(loops, r.run)
	}
	for _, f := range loops {
		b.wg.Add(1)
		go func(f func()) {
			defer b.wg.Done()
			f()
		}(f)
	}
}

// Close stops everything and waits for it.
func (b *Bridge) Close() {
	b.stopOnce.Do(func() {
		close(b.stop)
		b.closeSockets()
	})
	b.wg.Wait()
}

func (b *Bridge) stopped() bool {
	select {
	case <-b.stop:
		return true
	default:
		return false
	}
}

// sleep waits, returning false if the bridge stopped meanwhile.
func (b *Bridge) sleep(d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-b.stop:
		return false
	case <-t.C:
		return true
	}
}

func (b *Bridge) logf(format string, args ...any) {
	if b.cfg.Logf != nil {
		b.cfg.Logf(fmt.Sprintf(format, args...))
	}
}

// once logs a message the first time its key is seen.
func (b *Bridge) once(key, format string, args ...any) {
	b.mu.Lock()
	seen := b.warned[key]
	b.warned[key] = true
	b.mu.Unlock()
	if !seen {
		b.logf(format, args...)
	}
}

func (b *Bridge) touch() {
	b.mu.Lock()
	b.lastAct = time.Now()
	b.mu.Unlock()
}

func (b *Bridge) notify(i int) {
	if i >= 0 && i < len(b.receivers) {
		b.receivers[i].poke()
	}
}

func (b *Bridge) notifyAll() {
	for _, r := range b.receivers {
		r.poke()
	}
}

// clearDDCs forgets every DDC's configuration. Caller holds b.mu.
func (b *Bridge) clearDDCs() {
	for i := range b.rx {
		b.rx[i] = ddcState{}
	}
}

// offers reports whether a rate is one this bridge serves.
func (b *Bridge) offers(khz int) bool {
	for _, r := range b.cfg.RatesKHz {
		if r == khz {
			return true
		}
	}
	return false
}

func (b *Bridge) inRange(hz int64) bool {
	return hz == 0 || (hz >= b.cfg.MinHz && hz <= b.cfg.MaxHz)
}

func (b *Bridge) warnRange(label string, ddc int, hz int64) {
	b.logf("%s: WARNING DDC%d tuned to %.3f MHz, outside the receiver's %.3f kHz - %.3f MHz",
		label, ddc, float64(hz)/1e6, float64(b.cfg.MinHz)/1e3, float64(b.cfg.MaxHz)/1e6)
}

// readLoop reads a socket until it is closed. Other errors are logged once and
// survived: a stray datagram or an ICMP error surfaced on a read must not kill
// a control path that is only respawned by restarting the bridge.
func (b *Bridge) readLoop(c *net.UDPConn, name string, size int, handle func([]byte, *net.UDPAddr)) {
	buf := make([]byte, size)
	for {
		n, from, err := c.ReadFromUDP(buf)
		if err != nil {
			if errors.Is(err, net.ErrClosed) || b.stopped() {
				return
			}
			b.once("read-"+name+err.Error(), "%s: %v", name, err)
			if !b.sleep(10 * time.Millisecond) {
				return
			}
			continue
		}
		handle(buf[:n], from)
	}
}

// ---- protocol 2 control -------------------------------------------------

// discoveryLoop serves the discovery port: protocol 1 gets first refusal, then
// protocol 2 discovery and the general packet.
func (b *Bridge) discoveryLoop() {
	b.readLoop(b.disc, "discovery", 2048, func(pkt []byte, from *net.UDPAddr) {
		if !b.cfg.Iface.Admits(from.IP) {
			b.once("iface-"+from.IP.String(), "Ignoring %s: not on %s", from.IP, b.cfg.Iface)
			return
		}
		b.touch()
		if b.p1.HandleDatagram(b.disc, pkt, from) {
			return
		}
		switch {
		case IsP2Discovery(pkt):
			b.mu.Lock()
			busy := b.running
			b.mu.Unlock()
			status := 2
			if busy {
				status = 3
			}
			b.logf("Protocol 2 discovery from %s (status %d)", from.IP, status)
			reply := P2DiscoveryReply(busy, b.cfg.MAC, b.cfg.Device, b.cfg.NumRx, RateMask(b.cfg.RatesKHz))
			_, _ = b.disc.WriteToUDP(reply, from)
		case IsP2General(pkt):
			b.handleGeneral(pkt, from)
		}
	})
}

func (b *Bridge) handleGeneral(pkt []byte, from *net.UDPAddr) {
	// Protocol 1 has the receivers. Taking the general packet now would point
	// the IQ at this client while the samples still leave as EP6 to the other.
	if b.p1.Active() {
		b.once("p2-while-p1", "P2: ignoring a client while a protocol 1 client is streaming")
		return
	}
	g := ParseGeneral(pkt)
	var logs []string
	b.mu.Lock()
	newClient := b.client == nil || !b.client.IP.Equal(from.IP) || b.client.Port != from.Port
	b.client = &net.UDPAddr{IP: append(net.IP(nil), from.IP...), Port: from.Port}
	b.genRcvd = true
	if g.Seq != 0 && b.gpSeq != 0 && g.Seq != b.gpSeq+1 {
		logs = append(logs, fmt.Sprintf("GP: SEQ ERROR, old=%d new=%d", b.gpSeq, g.Seq))
	}
	b.gpSeq = g.Seq
	if int(g.FreqMode) != b.freqMode {
		b.freqMode = int(g.FreqMode)
		mode := "raw Hz"
		if g.PhaseWord() {
			mode = "phase word"
		}
		logs = append(logs, fmt.Sprintf("GP: frequency mode byte37=0x%02x (%s)", g.FreqMode, mode))
	}
	old := b.wb
	b.wb = g
	b.mu.Unlock()

	if newClient {
		b.logf("Protocol 2 client %s", from)
	}
	for _, l := range logs {
		b.logf("%s", l)
	}
	if g.PortOverride {
		b.once("gp-ports", "GP: WARNING client requests non-default UDP ports (general packet bytes 5-22); not supported, using defaults")
	}
	if !b.cfg.Wideband && g.WidebandEnable {
		b.once("gp-wb", "GP: client requested wideband data but the bridge was started without wideband (ignored)")
	}
	if b.cfg.Wideband && (old.WidebandEnable != g.WidebandEnable || old.WidebandLen != g.WidebandLen) {
		b.logf("GP: wideband enable=%v length=%d size=%d rate=%d ppf=%d",
			g.WidebandEnable, g.WidebandLen, g.WidebandSize, g.WidebandRate, g.WidebandPPF)
	}
}

func (b *Bridge) highPriorityLoop() {
	b.readLoop(b.hp, "high priority", 2048, func(pkt []byte, _ *net.UDPAddr) {
		// Protocol 1 owns the receivers; this would reconfigure them under it.
		if b.p1.Active() {
			return
		}
		b.touch()
		b.countHP()
		b.mu.Lock()
		phase := b.freqMode >= 0 && b.freqMode&0x08 != 0
		b.mu.Unlock()
		hp, err := ParseHighPriority(pkt, b.cfg.NumRx, phase)
		if err != nil {
			b.logf("HP: %v (ignored)", err)
			return
		}
		b.applyHighPriority(hp)
	})
}

func (b *Bridge) countHP() {
	if !b.cfg.Debug {
		return
	}
	now := time.Now()
	b.mu.Lock()
	b.hpCount++
	if b.hpRateStart.IsZero() {
		b.hpRateStart = now
	}
	el := now.Sub(b.hpRateStart)
	n := b.hpCount
	if el >= 10*time.Second {
		b.hpCount, b.hpRateStart = 0, now
	}
	b.mu.Unlock()
	if el >= 10*time.Second {
		b.logf("HP: %.0f packets/sec from client", float64(n)/el.Seconds())
	}
}

func (b *Bridge) applyHighPriority(hp HighPriority) {
	var logs []string
	var changed []int
	b.mu.Lock()
	if !b.running {
		b.hpSeq = 0
	}
	if hp.Seq != 0 && b.hpSeq != 0 && hp.Seq != b.hpSeq+1 {
		logs = append(logs, fmt.Sprintf("HP: SEQ ERROR, old=%d new=%d", b.hpSeq, hp.Seq))
	}
	b.hpSeq = hp.Seq
	for i := 0; i < b.cfg.NumRx; i++ {
		f := hp.Freq[i]
		if f == b.rx[i].freq {
			continue
		}
		b.rx[i].freq = f
		changed = append(changed, i)
	}
	runChanged := hp.Run != b.running
	if runChanged {
		b.running = hp.Run
		if !hp.Run {
			b.clearDDCs()
		}
	}
	b.mu.Unlock()

	for _, l := range logs {
		b.logf("%s", l)
	}
	for _, i := range changed {
		if !b.inRange(hp.Freq[i]) {
			b.warnRange("RX", i, hp.Freq[i])
		}
		if b.cfg.Debug {
			b.logf("HP: DDC%d freq: %d", i, hp.Freq[i])
		}
		b.notify(i)
	}
	if runChanged {
		b.logf("HP: Running = %v", hp.Run)
		b.notifyAll()
	}
}

func (b *Bridge) ddcSpecificLoop() {
	b.readLoop(b.ddcSpec, "DDC specific", 2048, func(pkt []byte, _ *net.UDPAddr) {
		if b.p1.Active() {
			return
		}
		b.touch()
		d, err := ParseDDCSpecific(pkt, b.cfg.NumRx)
		if err != nil {
			b.logf("RXspec: %v (ignored)", err)
			return
		}
		b.applyDDCSpecific(d)
	})
}

func (b *Bridge) applyDDCSpecific(d DDCSpecific) {
	if d.Synced >= 0 {
		b.once("ddc-sync", "RX: WARNING client requests synced DDCs (byte %d = 0x%02x); diversity/PureSignal not supported",
			1363+d.Synced, d.SyncedByte)
	}
	for _, i := range d.Clamped {
		b.once(fmt.Sprintf("clamp-%d", i), "RX: WARNING DDC%d requested more than 384 kHz, the widest rate UberSDR offers; using 384", i)
	}
	var logs []string
	var changed []int
	b.mu.Lock()
	if !b.running {
		b.ddcSeq = 0
	}
	if d.Seq != 0 && b.ddcSeq != 0 && d.Seq != b.ddcSeq+1 {
		logs = append(logs, fmt.Sprintf("RXspec: SEQ ERROR, old=%d new=%d", b.ddcSeq, d.Seq))
	}
	b.ddcSeq = d.Seq
	for i := 0; i < b.cfg.NumRx; i++ {
		mod := false
		// A zero rate is the client not saying, not the client asking for none.
		if r := d.RateKHz[i]; r != 0 && r != b.rx[i].rateKHz {
			b.rx[i].rateKHz = r
			mod = true
		}
		if d.Enable[i] != b.rx[i].enable {
			b.rx[i].enable = d.Enable[i]
			mod = true
		}
		if mod {
			changed = append(changed, i)
			logs = append(logs, fmt.Sprintf("RX: DDC%d Enable=%v Rate=%d", i, b.rx[i].enable, b.rx[i].rateKHz))
		}
	}
	b.mu.Unlock()
	for _, l := range logs {
		b.logf("%s", l)
	}
	for _, i := range changed {
		b.notify(i)
	}
}

// drainLoop reads a host->radio port the bridge does not act on -- audio, TX
// IQ, DUC specific. Without a listener every client packet draws an ICMP port
// unreachable, and clients send audio continuously during receive. Draining
// also counts as client activity for the watchdog.
func (b *Bridge) drainLoop(c *net.UDPConn) {
	b.readLoop(c, "drain", 2048, func([]byte, *net.UDPAddr) { b.touch() })
}

// p2Target is where protocol 2 radio->host traffic goes, or nil when no
// protocol 2 client is streaming.
func (b *Bridge) p2Target() *net.UDPAddr {
	if b.p1.Active() {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.running || !b.genRcvd || b.client == nil {
		return nil
	}
	return b.client
}

// statusLoop sends the radio->host high priority status every 50 ms, from port
// 1025 as the protocol requires.
func (b *Bridge) statusLoop() {
	var seq uint32
	t := time.NewTicker(50 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-b.stop:
			return
		case <-t.C:
		}
		to := b.p2Target()
		if to == nil {
			seq = 0
			continue
		}
		if _, err := b.ddcSpec.WriteToUDP(BuildP2Status(seq), to); err != nil && !b.stopped() {
			b.once("status-send", "HP status: %v", err)
		}
		seq++
	}
}

// micLoop sends a silent mic packet every 1.333 ms while a protocol 2 client
// streams. Paced against an absolute schedule so timer granularity -- coarse on
// Windows -- costs jitter but never rate; a stall longer than 100 ms resets the
// schedule rather than bursting to catch up.
func (b *Bridge) micLoop() {
	var seq uint32
	next := time.Now()
	timer := time.NewTimer(time.Hour)
	defer timer.Stop()
	for {
		to := b.p2Target()
		if to == nil {
			seq = 0
			if !b.sleep(50 * time.Millisecond) {
				return
			}
			next = time.Now()
			continue
		}
		next = next.Add(MicInterval)
		if d := time.Until(next); d > 0 {
			timer.Reset(d)
			select {
			case <-b.stop:
				return
			case <-timer.C:
			}
		} else if d < -100*time.Millisecond {
			next = time.Now()
		}
		if _, err := b.mic.WriteToUDP(BuildP2Mic(seq), to); err != nil && !b.stopped() {
			b.once("mic-send", "Mic: %v", err)
		}
		seq++
	}
}

// watchdogLoop stops a client that has gone silent. Protocol 2 counts any
// client UDP as activity, as the C bridge does, and allows Config.Watchdog;
// protocol 1 has its own, shorter one.
func (b *Bridge) watchdogLoop() {
	period := b.cfg.Watchdog / 20
	if period > 50*time.Millisecond {
		period = 50 * time.Millisecond
	}
	t := time.NewTicker(period)
	defer t.Stop()
	for {
		select {
		case <-b.stop:
			return
		case <-t.C:
		}
		b.p1.CheckWatchdog()
		if b.p1.Active() {
			continue
		}
		b.mu.Lock()
		since := time.Since(b.lastAct)
		expired := b.running && !b.lastAct.IsZero() && since > b.cfg.Watchdog
		if expired {
			b.running = false
			b.lastAct = time.Time{}
			b.clearDDCs()
		}
		b.mu.Unlock()
		if expired {
			b.logf("HP: no client UDP activity for %.1fs, client disconnected", since.Seconds())
			b.notifyAll()
		}
	}
}

// widebandLoop sends the bandscope sweep from a file a local RX888 setup
// writes, at about 15 sweeps a second, on the high priority port.
func (b *Bridge) widebandLoop() {
	for {
		b.mu.Lock()
		on := b.wb.WidebandEnable
		plen := b.wb.WidebandLen
		b.mu.Unlock()
		to := b.p2Target()
		if to == nil || !on {
			if !b.sleep(50 * time.Millisecond) {
				return
			}
			continue
		}
		sweep, err := os.ReadFile(b.cfg.WidebandFile)
		if err != nil {
			b.once("wb-file", "Wideband: %s does not exist (will keep retrying)", b.cfg.WidebandFile)
			if !b.sleep(time.Second) {
				return
			}
			continue
		}
		if len(sweep) < WidebandSweepBytes {
			// Caught mid-write; the next read gets a whole one.
			if !b.sleep(5 * time.Millisecond) {
				return
			}
			continue
		}
		for _, pkt := range BuildWideband(sweep[:WidebandSweepBytes], WidebandPacketLen(plen)) {
			if _, err := b.hp.WriteToUDP(pkt, to); err != nil {
				b.once("wb-send", "Wideband: %v", err)
				break
			}
		}
		if !b.sleep(66 * time.Millisecond) {
			return
		}
	}
}

// ---- protocol 1 host -----------------------------------------------------

func (b *Bridge) p1SetRate(rx, hz int) {
	if rx < 0 || rx >= b.cfg.NumRx {
		return
	}
	b.mu.Lock()
	changed := b.rx[rx].rateKHz != hz/1000
	b.rx[rx].rateKHz = hz / 1000
	b.mu.Unlock()
	if changed {
		b.notify(rx)
	}
}

func (b *Bridge) p1SetFreq(rx int, hz int64) {
	if rx < 0 || rx >= b.cfg.NumRx {
		return
	}
	if !b.inRange(hz) {
		b.warnRange("P1", rx, hz)
	}
	b.mu.Lock()
	b.rx[rx].freq = hz
	b.mu.Unlock()
	if b.cfg.Debug {
		b.logf("P1: DDC%d tuned to %d Hz", rx, hz)
	}
	b.notify(rx)
}

func (b *Bridge) p1Enable(rx int, on bool) {
	if rx < 0 || rx >= b.cfg.NumRx {
		return
	}
	b.mu.Lock()
	b.rx[rx].enable = on
	b.running = on
	if !on {
		b.rx[rx].rateKHz = 0
		b.rx[rx].freq = 0
	}
	b.mu.Unlock()
	b.notifyAll()
}

func (b *Bridge) p1StopAll() {
	b.mu.Lock()
	b.clearDDCs()
	b.running = false
	b.mu.Unlock()
	b.notifyAll()
}

// p1P2Busy: is a protocol 2 client streaming?
func (b *Bridge) p1P2Busy() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.running && b.genRcvd
}

func (b *Bridge) mac() [6]byte    { return b.cfg.MAC }
func (b *Bridge) boardType() byte { return b.cfg.Device }

// ---- IQ out --------------------------------------------------------------

// samplesPerPacket is how many complex samples go in the next packet. Which
// framing the samples leave in is the only thing about the IQ path that depends
// on the protocol.
func (b *Bridge) samplesPerPacket() int {
	if b.p1.Active() {
		return P1SamplesPerPacket
	}
	return P2SamplesPerPacket
}

// emit sends one packet of a receiver's IQ, interleaved re, im and already
// scaled. The stream itself paces this: samples arrive at the receiver's own
// rate, so a packet goes out when there are enough for one and there is no
// timer to drift against. Samples with nowhere to go are dropped, never queued.
func (b *Bridge) emit(i int, iq []float32) bool {
	if b.p1.Active() {
		if i != 0 {
			return false
		}
		pkt, conn, to := b.p1.BuildEP6(iq)
		if pkt == nil {
			return false
		}
		_, err := conn.WriteTo(pkt, to)
		if err != nil && !b.stopped() {
			b.once("ep6-send", "P1: %v", err)
		}
		return err == nil
	}
	b.mu.Lock()
	st := b.rx[i]
	ok := b.running && b.genRcvd && b.client != nil && st.enable && st.rateKHz != 0 && st.freq != 0
	seq := b.iqSeq[i]
	if ok {
		b.iqSeq[i]++
	} else {
		b.iqSeq[i] = 0
	}
	to := b.client
	b.mu.Unlock()
	if !ok {
		return false
	}
	buf := make([]byte, p2IQLen)
	BuildP2IQ(buf, seq, iq)
	if _, err := b.ddc[i].WriteToUDP(buf, to); err != nil {
		if !b.stopped() {
			b.once(fmt.Sprintf("ddc%d-send", i), "RX: DDC%d send: %v", i, err)
		}
		return false
	}
	return true
}

// ---- throughput and status -----------------------------------------------

// throughputLoop logs what the IQ stream costs every five seconds while a
// client streams, counted off the WebSocket rather than worked out from the
// rate: version 4 codes IQ predictively, so a quiet band costs less than a busy
// one, and reduced depth less again. It also keeps the per-second rates the
// status display shows.
func (b *Bridge) throughputLoop() {
	t := time.NewTicker(250 * time.Millisecond)
	defer t.Stop()
	last, lastUI := time.Now(), time.Now()
	wasRunning := false
	for {
		select {
		case <-b.stop:
			return
		case <-t.C:
		}
		now := time.Now()
		if el := now.Sub(lastUI); el >= time.Second {
			for _, r := range b.receivers {
				r.kbps.Store(uint64(float64(r.uiBytes.Swap(0)) * 8 / el.Seconds()))
			}
			lastUI = now
		}

		b.mu.Lock()
		running := b.running
		b.mu.Unlock()
		// A client arriving restarts the interval rather than joining the one
		// in progress, or its first line divides five seconds of traffic by
		// time it was not there for.
		if running != wasRunning {
			wasRunning = running
			for _, r := range b.receivers {
				r.logBytes.Store(0)
			}
			last = now
			continue
		}
		el := now.Sub(last)
		if el < ThroughputInterval {
			continue
		}
		last = now
		var parts []string
		total := 0.0
		for _, r := range b.receivers {
			bytes := r.logBytes.Swap(0)
			if !running || bytes == 0 {
				continue
			}
			kbps := float64(bytes) * 8 / 1000 / el.Seconds()
			total += kbps
			parts = append(parts, fmt.Sprintf("DDC%d %.1f kbps", r.idx, kbps))
		}
		switch {
		case len(parts) > 1:
			b.logf("IQ: %s  total %.1f kbps", strings.Join(parts, "  "), total)
		case len(parts) == 1:
			b.logf("IQ: %s", parts[0])
		}
	}
}

// Status is a snapshot for a display.
type Status struct {
	// Protocol is 0 when no client streams, else 1 or 2.
	Protocol  int
	Client    string
	Running   bool
	Receivers []RxStatus
	TotalKbps float64
}

// RxStatus is one DDC.
type RxStatus struct {
	Index   int
	Enabled bool
	RateKHz int
	FreqHz  int64
	// State is what the receiver's socket is doing, Detail why.
	State  RxState
	Detail string
	// ServerMode is what the server says it is serving.
	ServerMode string
	Kbps       float64
	Packets    uint64
}

// Status returns a snapshot.
func (b *Bridge) Status() Status {
	var s Status
	p1 := b.p1.Active()
	p1Client := b.p1.Client()
	b.mu.Lock()
	s.Running = b.running
	switch {
	case p1:
		s.Protocol = 1
		if p1Client != nil {
			s.Client = p1Client.String()
		}
	case b.running && b.genRcvd:
		s.Protocol = 2
		if b.client != nil {
			s.Client = b.client.String()
		}
	}
	rx := b.rx
	b.mu.Unlock()
	for _, r := range b.receivers {
		st, detail, mode := r.state()
		k := float64(r.kbps.Load()) / 1000
		s.TotalKbps += k
		s.Receivers = append(s.Receivers, RxStatus{
			Index: r.idx, Enabled: rx[r.idx].enable, RateKHz: rx[r.idx].rateKHz, FreqHz: rx[r.idx].freq,
			State: st, Detail: detail, ServerMode: mode, Kbps: k, Packets: r.packets.Load(),
		})
	}
	return s
}

// want is what a receiver should be doing now.
type want struct {
	active bool
	khz    int
	freq   int64
}

func (b *Bridge) want(i int) want {
	b.mu.Lock()
	defer b.mu.Unlock()
	st := b.rx[i]
	return want{
		active: b.running && st.enable && st.rateKHz != 0 && st.freq != 0,
		khz:    st.rateKHz,
		freq:   st.freq,
	}
}

func joinInts(v []int) string {
	s := append([]int(nil), v...)
	sort.Ints(s)
	parts := make([]string, len(s))
	for i, x := range s {
		parts[i] = fmt.Sprint(x)
	}
	return strings.Join(parts, "/")
}

// counters shared with receiver.go
type rxCounters struct {
	logBytes atomic.Uint64
	uiBytes  atomic.Uint64
	kbps     atomic.Uint64 // bits per second over the last second
	packets  atomic.Uint64
}
