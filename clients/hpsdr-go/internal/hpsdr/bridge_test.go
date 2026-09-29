package hpsdr

import (
	"encoding/binary"
	"net"
	"testing"
	"time"
)

// End-to-end: an HPSDR client on one side, a fake UberSDR server on the other,
// and every byte in between checked.

const wait = 3 * time.Second

// checkIQ asserts consecutive DDC IQ packets carry the server's samples from
// sample index k0, scaled for khz, imaginary part first.
func checkIQ(t *testing.T, c *hpClient, ddc, khz, k0, packets int) {
	t.Helper()
	var seq0 uint32
	for n := 0; n < packets; n++ {
		p := c.recv(PortDDC0+ddc, wait)
		if len(p) != 1444 {
			t.Fatalf("IQ packet of %d bytes", len(p))
		}
		seq := binary.BigEndian.Uint32(p)
		if n == 0 {
			seq0 = seq
		} else if seq != seq0+uint32(n) {
			t.Fatalf("packet %d: sequence %d, want %d", n, seq, seq0+uint32(n))
		}
		if binary.BigEndian.Uint16(p[12:]) != 24 || binary.BigEndian.Uint16(p[14:]) != 238 {
			t.Fatal("IQ header wrong")
		}
		for j := 0; j < 238; j++ {
			k := k0 + n*238 + j
			a, b := expected(k, khz)
			if get24(p[16+6*j:]) != a || get24(p[19+6*j:]) != b {
				t.Fatalf("packet %d sample %d (k=%d): got %d,%d want %d,%d at %d kHz",
					n, j, k, get24(p[16+6*j:]), get24(p[19+6*j:]), a, b, khz)
			}
		}
	}
}

// startP2 walks a protocol 2 client through discovery, the general packet, DDC
// config and run, as Thetis does.
func startP2(t *testing.T, c *hpClient, freqMode byte, rates map[int]int, freqs ...uint32) {
	t.Helper()
	d := make([]byte, 60)
	d[4] = 0x02
	c.send(PortDiscovery, d)
	c.recv(PortDiscovery, wait)
	c.send(PortDiscovery, general(0, freqMode))
	c.send(PortDDCSpecific, ddcSpec(0, rates))
	c.send(PortHighPrio, highPrio(0, true, freqs...))
}

func TestP2EndToEnd(t *testing.T) {
	f := newFakeServer(t)
	b, logs := startBridge(t, f, "s3cr&t 'pw\"", func(c *Config) { c.RatesKHz = []int{48, 96, 192} })
	c := newClient(t, b.cfg.BasePort)

	// Discovery: status idle, the offered rates, the configured receivers.
	d := make([]byte, 60)
	d[4] = 0x02
	c.send(PortDiscovery, d)
	r := c.recv(PortDiscovery, wait)
	if r[4] != 2 || r[11] != DeviceHermesLite || r[20] != 2 || r[22] != 0x07 {
		t.Fatalf("discovery reply status %d device %d rx %d rates %#x", r[4], r[11], r[20], r[22])
	}

	c.send(PortDiscovery, general(0, 0))
	c.send(PortDDCSpecific, ddcSpec(0, map[int]int{0: 192}))
	c.send(PortHighPrio, highPrio(0, true, 7_100_000))

	ws := f.nextConn(t, wait)
	q := ws.query
	for k, want := range map[string]string{
		"mode": "iq192", "frequency": "7100000", "format": "pcm-zstd", "version": "4",
		"min_margin": "26", "password": "s3cr&t 'pw\"",
	} {
		if q.Get(k) != want {
			t.Errorf("socket %s = %q, want %q", k, q.Get(k), want)
		}
	}
	if ws.ua != "UberSDR_HPSDR/1.0" {
		t.Errorf("socket User-Agent %q", ws.ua)
	}
	f.mu.Lock()
	check := f.checks[len(f.checks)-1]
	f.mu.Unlock()
	if check["password"] != "s3cr&t 'pw\"" || check["user_session_id"] != q.Get("user_session_id") {
		t.Fatalf("precheck %v does not match socket session %s", check, q.Get("user_session_id"))
	}

	// IQ from port 1035, the server's samples exactly, from the first.
	checkIQ(t, c, 0, 192, 0, 20)

	// The high priority status stream from 1025 and the mic stream from 1026.
	if s := c.recv(PortDDCSpecific, wait); len(s) != 60 {
		t.Fatalf("status packet of %d bytes", len(s))
	}
	if m := c.recv(PortMic, wait); len(m) != 132 {
		t.Fatalf("mic packet of %d bytes", len(m))
	}

	st := waitStatus(t, b, "streaming", func(s Status) bool {
		return s.Protocol == 2 && s.Receivers[0].State == RxStreaming && s.Receivers[1].State == RxIdle
	})
	if st.Receivers[0].FreqHz != 7_100_000 || st.Receivers[0].RateKHz != 192 {
		t.Fatalf("status %+v", st.Receivers[0])
	}
	// Discovery while streaming says busy.
	c.send(PortDiscovery, d)
	if r := c.recv(PortDiscovery, wait); r[4] != 3 {
		t.Fatalf("discovery while streaming: status %d", r[4])
	}

	// Retune: a tune message on the same socket, carrying the same mode.
	c.send(PortHighPrio, highPrio(1, true, 14_074_000))
	select {
	case m := <-ws.tunes:
		if m["type"] != "tune" || m["frequency"] != float64(14_074_000) || m["mode"] != "iq192" {
			t.Fatalf("tune %v", m)
		}
	case <-time.After(wait):
		t.Fatal("no tune message")
	}

	// A rate change is a new socket at the new mode with a new session.
	c.send(PortDDCSpecific, ddcSpec(1, map[int]int{0: 96}))
	select {
	case <-ws.closed:
	case <-time.After(wait):
		t.Fatal("old socket not closed on a rate change")
	}
	ws2 := f.nextConn(t, wait)
	if ws2.query.Get("mode") != "iq96" || ws2.query.Get("frequency") != "14074000" {
		t.Fatalf("reconnect query %v", ws2.query)
	}
	if ws2.query.Get("user_session_id") == q.Get("user_session_id") {
		t.Fatal("session ID reused across a reconnect")
	}
	// New socket, new stream: find where it starts, then check it is exact at
	// the new gain.
	c.drain(PortDDC0)
	a0, b0 := expected(0, 96)
	deadline := time.Now().Add(wait)
	for {
		p := c.recv(PortDDC0, wait)
		if get24(p[16:]) == a0 && get24(p[19:]) == b0 {
			a1, b1 := expected(238, 96)
			p2 := c.recv(PortDDC0, wait)
			if get24(p2[16:]) != a1 || get24(p2[19:]) != b1 {
				t.Fatal("stream at 96 kHz not contiguous")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("never saw the 96 kHz stream start")
		}
	}
	checkIQFrom(t, c, 96, 2*238, 5)

	// Stop: the socket closes and the IQ stops.
	c.send(PortHighPrio, highPrio(2, false))
	select {
	case <-ws2.closed:
	case <-time.After(wait):
		t.Fatal("socket not closed on stop")
	}
	c.quiet(PortDDC0, 150*time.Millisecond)
	c.quiet(PortMic, 100*time.Millisecond)
	waitStatus(t, b, "stopped", func(s Status) bool { return s.Protocol == 0 && s.Receivers[0].State == RxIdle })
	if !logs.has("HP: Running = false") {
		t.Fatal("stop not logged")
	}
}

// checkIQFrom continues checkIQ at sample index k0 on the next packets.
func checkIQFrom(t *testing.T, c *hpClient, khz, k0, packets int) {
	t.Helper()
	checkIQ(t, c, 0, khz, k0, packets)
}

// Phase words (general packet byte 37 bit 3), two DDCs at once, each on its own
// socket and port.
func TestP2PhaseWordsAndTwoDDCs(t *testing.T) {
	f := newFakeServer(t)
	b, _ := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)
	w := func(hz float64) uint32 { return uint32(hz*4294967296.0/DDCClockHz + 0.5) }
	startP2(t, c, 0x08, map[int]int{0: 48, 1: 384}, w(3_573_000), w(28_074_000))

	got := map[string]string{}
	for i := 0; i < 2; i++ {
		ws := f.nextConn(t, wait)
		got[ws.query.Get("mode")] = ws.query.Get("frequency")
		if ws.query.Get("password") != "" {
			t.Fatal("password sent when none was given")
		}
	}
	if got["iq48"] != "3573000" || got["iq384"] != "28074000" {
		t.Fatalf("sockets %v", got)
	}
	checkIQ(t, c, 0, 48, 0, 3)
	checkIQ(t, c, 1, 384, 0, 3)
}

// A rate the session may not use is not connected at; the client is told by the
// discovery mask and the operator by the status.
func TestRateNotOffered(t *testing.T) {
	f := newFakeServer(t)
	b, logs := startBridge(t, f, "", func(c *Config) { c.RatesKHz = []int{48, 96} })
	c := newClient(t, b.cfg.BasePort)
	startP2(t, c, 0, map[int]int{0: 192}, 7_000_000)
	waitStatus(t, b, "not offered", func(s Status) bool { return s.Receivers[0].State == RxNotOffered })
	f.noConn(t, 200*time.Millisecond)
	logs.waitFor(t, "may not use", wait)

	// Asking for an offered rate connects.
	c.send(PortDDCSpecific, ddcSpec(1, map[int]int{0: 96}))
	if ws := f.nextConn(t, wait); ws.query.Get("mode") != "iq96" {
		t.Fatalf("mode %s", ws.query.Get("mode"))
	}
}

// A refusal at /connection is reported with the server's reason, named as a
// password problem, and retried.
func TestRefused(t *testing.T) {
	f := newFakeServer(t)
	f.set(func(f *fakeServer) { f.allow, f.status, f.reason = false, 403, "Invalid password" })
	b, _ := startBridge(t, f, "wrong", nil)
	c := newClient(t, b.cfg.BasePort)
	startP2(t, c, 0, map[int]int{0: 192}, 7_000_000)
	keepAlive(t, c)
	st := waitStatus(t, b, "refused", func(s Status) bool { return s.Receivers[0].State == RxRefused })
	if st.Receivers[0].Detail != "Invalid password (the password was not accepted)" {
		t.Fatalf("detail %q", st.Receivers[0].Detail)
	}
	f.noConn(t, 100*time.Millisecond)
	// Retried at RefusedDelay, not in a loop.
	f.mu.Lock()
	n := len(f.checks)
	f.mu.Unlock()
	time.Sleep(300 * time.Millisecond)
	f.mu.Lock()
	n2 := len(f.checks)
	f.mu.Unlock()
	if d := n2 - n; d < 2 || d > 8 {
		t.Fatalf("%d prechecks in 300 ms at a 60 ms retry", d)
	}
	// And a later yes connects.
	f.set(func(f *fakeServer) { f.allow, f.status, f.reason = true, 200, "" })
	f.nextConn(t, wait)
}

// The server serving a rate other than the one asked: scaled for what arrived,
// and a change under a live socket reconnects.
func TestServerRate(t *testing.T) {
	f := newFakeServer(t)
	f.set(func(f *fakeServer) { f.serveKHz, f.switchKHz, f.switchAfter = 96, 48, 30 })
	b, logs := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)
	startP2(t, c, 0, map[int]int{0: 192}, 7_000_000)
	ws := f.nextConn(t, wait)
	checkIQ(t, c, 0, 96, 0, 3)
	logs.waitFor(t, "asked for iq192 but the server is serving iq96", wait)
	select {
	case <-ws.closed:
	case <-time.After(wait):
		t.Fatal("rate change under a live socket did not reconnect")
	}
	logs.waitFor(t, "server sample rate changed 96000 -> 48000", wait)
	f.nextConn(t, wait)
}

// The server closing the socket is a reconnect with a fresh session.
func TestServerCloseReconnects(t *testing.T) {
	f := newFakeServer(t)
	b, _ := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)
	startP2(t, c, 0, map[int]int{0: 192}, 7_000_000)
	ws := f.nextConn(t, wait)
	checkIQ(t, c, 0, 192, 0, 2)
	close(ws.kill)
	ws2 := f.nextConn(t, wait)
	if ws2.query.Get("user_session_id") == ws.query.Get("user_session_id") {
		t.Fatal("session reused")
	}
	// Keep the client alive past the watchdog while this happens.
	c.send(PortHighPrio, highPrio(1, true, 7_000_000))
}

// A server socket opened without a precheck is refused by the real server; the
// bridge must always precheck with the same User-Agent. Here the fake refuses
// every session so the error path is exercised end to end.
func TestLegacyServer(t *testing.T) {
	f := newFakeServer(t)
	f.set(func(f *fakeServer) { f.legacy = true })
	b, logs := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)
	startP2(t, c, 0, map[int]int{0: 192}, 7_000_000)
	f.nextConn(t, wait)
	logs.waitFor(t, "needs UberSDR 0.1.63 or later", wait)
	waitStatus(t, b, "error", func(s Status) bool { return s.Receivers[0].State == RxError })
}

// A client that goes silent is stopped by the watchdog and its socket closed.
func TestP2Watchdog(t *testing.T) {
	f := newFakeServer(t)
	b, logs := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)
	startP2(t, c, 0, map[int]int{0: 192}, 7_000_000)
	ws := f.nextConn(t, wait)
	select {
	case <-ws.closed:
	case <-time.After(wait):
		t.Fatal("watchdog did not close the socket")
	}
	logs.waitFor(t, "no client UDP activity", wait)
	waitStatus(t, b, "stopped", func(s Status) bool { return !s.Running })
}

// Protocol 1: discovery, EP2 config, run, and EP6 back with the same samples a
// protocol 2 client would get, 126 to a packet. A protocol 2 client arriving
// meanwhile is refused, and stopping releases the receiver.
func TestP1EndToEnd(t *testing.T) {
	f := newFakeServer(t)
	b, logs := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)

	req := make([]byte, 63)
	req[0], req[1], req[2] = 0xEF, 0xFE, 0x02
	c.send(PortDiscovery, req)
	if r := c.recv(PortDiscovery, wait); r[2] != 2 || r[10] != DeviceHermesLite || r[19] != 1 {
		t.Fatalf("P1 discovery reply % x", r[:20])
	}

	c.send(PortDiscovery, ep2([5]byte{0x00, 0x00}))                   // 48 kHz
	c.send(PortDiscovery, ep2([5]byte{0x04, 0x00, 0x6C, 0x2C, 0x70})) // 7,089,264 Hz
	run := make([]byte, 64)
	run[0], run[1], run[2], run[3] = 0xEF, 0xFE, 0x04, 0x01
	c.send(PortDiscovery, run)

	ws := f.nextConn(t, wait)
	if ws.query.Get("mode") != "iq48" || ws.query.Get("frequency") != "7089264" {
		t.Fatalf("P1 socket %v", ws.query)
	}
	k := 0
	for n := 0; n < 10; n++ {
		p := c.recv(PortDiscovery, wait)
		if len(p) != 1032 || p[3] != 0x06 {
			t.Fatalf("EP6 packet % x", p[:4])
		}
		if seq := binary.BigEndian.Uint32(p[4:]); seq != uint32(n) {
			t.Fatalf("EP6 sequence %d, want %d", seq, n)
		}
		for f := 0; f < 2; f++ {
			frame := p[8+f*512:]
			for r := 0; r < 63; r++ {
				a, bb := expected(k, 48)
				if get24(frame[8+8*r:]) != a || get24(frame[11+8*r:]) != bb {
					t.Fatalf("EP6 %d sample %d wrong", n, k)
				}
				k++
			}
		}
		// Keep the watchdog fed.
		c.send(PortDiscovery, ep2([5]byte{0x00, 0x00}))
	}
	waitStatus(t, b, "P1", func(s Status) bool { return s.Protocol == 1 && s.Receivers[0].State == RxStreaming })

	// A protocol 2 client is turned away while protocol 1 streams.
	c2 := newClient(t, b.cfg.BasePort)
	c2.send(PortDiscovery, general(0, 0))
	c2.send(PortHighPrio, highPrio(0, true, 1_000_000))
	logs.waitFor(t, "P2: ignoring a client while a protocol 1 client is streaming", wait)
	c2.quiet(PortDDCSpecific, 150*time.Millisecond)

	stop := make([]byte, 64)
	stop[0], stop[1], stop[2] = 0xEF, 0xFE, 0x04
	c.send(PortDiscovery, stop)
	select {
	case <-ws.closed:
	case <-time.After(wait):
		t.Fatal("stop did not close the socket")
	}
	waitStatus(t, b, "stopped", func(s Status) bool { return s.Protocol == 0 && !s.Running })
}

// A protocol 1 client that goes silent is stopped after three seconds.
func TestP1WatchdogCloses(t *testing.T) {
	if testing.Short() {
		t.Skip("waits out the 3 s protocol 1 watchdog")
	}
	f := newFakeServer(t)
	b, _ := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)
	run := make([]byte, 64)
	run[0], run[1], run[2], run[3] = 0xEF, 0xFE, 0x04, 0x01
	c.send(PortDiscovery, ep2([5]byte{0x04, 0x00, 0x6C, 0x2C, 0x70}))
	c.send(PortDiscovery, run)
	ws := f.nextConn(t, wait)
	select {
	case <-ws.closed:
	case <-time.After(P1Watchdog + wait):
		t.Fatal("P1 watchdog did not stop the stream")
	}
}

// The interface filter: a client off the chosen subnet is not answered, and
// loopback always is.
func TestIfaceAdmits(t *testing.T) {
	_, n, _ := net.ParseCIDR("192.168.1.10/24")
	i := Iface{Name: "eth0", IP: net.IPv4(192, 168, 1, 10), Net: n}
	for ip, want := range map[string]bool{
		"192.168.1.77": true, "192.168.2.1": false, "10.0.0.1": false, "127.0.0.1": true,
	} {
		if got := i.Admits(net.ParseIP(ip)); got != want {
			t.Errorf("Admits(%s) = %v", ip, got)
		}
	}
	if !(Iface{}).Admits(net.ParseIP("8.8.8.8")) {
		t.Error("a zero interface refused a client")
	}
}

func TestBridgeFiltersOffSubnetDiscovery(t *testing.T) {
	f := newFakeServer(t)
	_, n, _ := net.ParseCIDR("10.99.0.0/16")
	b, logs := startBridge(t, f, "", func(c *Config) {
		c.Iface = Iface{Name: "test", IP: net.IPv4(10, 99, 0, 1), Net: n}
	})
	// Loopback is admitted whatever the interface, so a same-machine client
	// still works.
	c := newClient(t, b.cfg.BasePort)
	d := make([]byte, 60)
	d[4] = 0x02
	c.send(PortDiscovery, d)
	c.recv(PortDiscovery, wait)
	if logs.has("Ignoring") {
		t.Fatal("a loopback client was filtered")
	}
}

func TestConfigValidation(t *testing.T) {
	f := newFakeServer(t)
	srv := mustServer(t, f.srv.URL)
	for name, cfg := range map[string]Config{
		"no server":  {NumRx: 1, Device: 6},
		"zero rx":    {Server: srv, NumRx: 0, Device: 6},
		"eleven rx":  {Server: srv, NumRx: 11, Device: 6},
		"bad device": {Server: srv, NumRx: 1, Device: 3},
		"bad rate":   {Server: srv, NumRx: 1, Device: 6, RatesKHz: []int{12}},
	} {
		if _, err := New(cfg); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// keepAlive feeds the watchdog until the test ends, as a real client's
// continuous high priority packets do.
func keepAlive(t *testing.T, c *hpClient) {
	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	go func() {
		tk := time.NewTicker(50 * time.Millisecond)
		defer tk.Stop()
		for {
			select {
			case <-done:
				return
			case <-tk.C:
				c.conn.WriteToUDP(make([]byte, 16), &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: c.base + PortAudio})
			}
		}
	}()
}

// ---- disconnect and reconnect ---------------------------------------------

func p1Run(c *hpClient, on bool) {
	run := make([]byte, 64)
	run[0], run[1], run[2] = 0xEF, 0xFE, 0x04
	if on {
		run[3] = 0x01
	}
	c.send(PortDiscovery, run)
}

// A protocol 1 client that stops and starts again on the same frequency must
// stream again. EP2 repeats the frequency it sent before, which must not be
// taken for "nothing changed".
func TestP1StopStartSameFrequency(t *testing.T) {
	f := newFakeServer(t)
	b, _ := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)
	cfg := func() {
		c.send(PortDiscovery, ep2([5]byte{0x00, 0x02}))                   // 192 kHz
		c.send(PortDiscovery, ep2([5]byte{0x04, 0x00, 0x6C, 0x2C, 0x70})) // 7,089,264 Hz
	}
	for round := 0; round < 3; round++ {
		cfg()
		p1Run(c, true)
		ws := f.nextConn(t, wait)
		if ws.query.Get("frequency") != "7089264" || ws.query.Get("mode") != "iq192" {
			t.Fatalf("round %d: socket %v", round, ws.query)
		}
		if p := c.recv(PortDiscovery, wait); p[3] != 0x06 {
			t.Fatalf("round %d: no EP6", round)
		}
		p1Run(c, false)
		select {
		case <-ws.closed:
		case <-time.After(wait):
			t.Fatalf("round %d: stop did not close the socket", round)
		}
		c.quiet(PortDiscovery, 100*time.Millisecond)
	}
}

// The same, when the client configures only after the run command.
func TestP1StopStartConfigAfterRun(t *testing.T) {
	f := newFakeServer(t)
	b, _ := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)
	for round := 0; round < 3; round++ {
		p1Run(c, true)
		c.send(PortDiscovery, ep2([5]byte{0x04, 0x00, 0x6C, 0x2C, 0x70}))
		ws := f.nextConn(t, wait)
		if ws.query.Get("frequency") != "7089264" {
			t.Fatalf("round %d: socket %v", round, ws.query)
		}
		p1Run(c, false)
		<-ws.closed
	}
}

// A protocol 1 client that dies (the watchdog stops it) and comes back from a
// new port streams to the new port.
func TestP1ClientRestartsAfterWatchdog(t *testing.T) {
	if testing.Short() {
		t.Skip("waits out the 3 s protocol 1 watchdog")
	}
	f := newFakeServer(t)
	b, _ := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)
	c.send(PortDiscovery, ep2([5]byte{0x04, 0x00, 0x6C, 0x2C, 0x70}))
	p1Run(c, true)
	ws := f.nextConn(t, wait)
	<-ws.closed // silent client: the watchdog stops it
	c2 := newClient(t, b.cfg.BasePort)
	c2.send(PortDiscovery, ep2([5]byte{0x04, 0x00, 0x6C, 0x2C, 0x70}))
	p1Run(c2, true)
	f.nextConn(t, wait)
	if p := c2.recv(PortDiscovery, wait); p[3] != 0x06 {
		t.Fatal("restarted client got no EP6")
	}
}

// A protocol 2 client that stops and starts again with identical packets --
// what Thetis does on power off / power on -- streams again.
func TestP2StopStart(t *testing.T) {
	f := newFakeServer(t)
	b, _ := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)
	for round := 0; round < 3; round++ {
		startP2(t, c, 0, map[int]int{0: 192}, 7_000_000)
		ws := f.nextConn(t, wait)
		c.recv(PortDDC0, wait)
		c.send(PortHighPrio, highPrio(1, false, 7_000_000))
		select {
		case <-ws.closed:
		case <-time.After(wait):
			t.Fatalf("round %d: stop did not close the socket", round)
		}
		c.quiet(PortDDC0, 100*time.Millisecond)
	}
}

// Stop, then run again with only a high priority packet: the DDC config the
// client sent before the stop is what a real radio still has.
func TestP2RunAgainWithoutResendingDDCConfig(t *testing.T) {
	f := newFakeServer(t)
	b, _ := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)
	startP2(t, c, 0, map[int]int{0: 192}, 7_000_000)
	ws := f.nextConn(t, wait)
	c.send(PortHighPrio, highPrio(1, false, 7_000_000))
	<-ws.closed
	c.send(PortHighPrio, highPrio(2, true, 7_000_000))
	f.nextConn(t, wait)
	c.recv(PortDDC0, wait)
}

// A protocol 2 client that dies and restarts from a new port, inside the
// watchdog, gets the stream at its new address.
func TestP2ClientRestartsFromNewPort(t *testing.T) {
	f := newFakeServer(t)
	b, _ := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)
	startP2(t, c, 0, map[int]int{0: 192}, 7_000_000)
	f.nextConn(t, wait)
	c.recv(PortDDC0, wait)
	c.conn.Close() // dies without a stop
	c2 := newClient(t, b.cfg.BasePort)
	startP2(t, c2, 0, map[int]int{0: 192}, 7_000_000)
	if p := c2.recv(PortDDC0, wait); len(p) != 1444 {
		t.Fatal("restarted client got no IQ")
	}
}

// And one that dies and restarts after the watchdog has stopped it.
func TestP2ClientRestartsAfterWatchdog(t *testing.T) {
	f := newFakeServer(t)
	b, _ := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)
	startP2(t, c, 0, map[int]int{0: 192}, 7_000_000)
	ws := f.nextConn(t, wait)
	<-ws.closed
	waitStatus(t, b, "stopped", func(s Status) bool { return !s.Running })
	c2 := newClient(t, b.cfg.BasePort)
	startP2(t, c2, 0, map[int]int{0: 192}, 7_000_000)
	f.nextConn(t, wait)
	c2.recv(PortDDC0, wait)
}

// A protocol 1 client after a protocol 2 one: the configuration protocol 2 left
// on its other DDCs must not come up alongside protocol 1's one receiver.
func TestP1AfterP2LeavesOtherDDCsDown(t *testing.T) {
	f := newFakeServer(t)
	b, _ := startBridge(t, f, "", nil)
	c := newClient(t, b.cfg.BasePort)
	startP2(t, c, 0, map[int]int{0: 192, 1: 48}, 7_000_000, 14_000_000)
	w1, w2 := f.nextConn(t, wait), f.nextConn(t, wait)
	c.send(PortHighPrio, highPrio(1, false))
	<-w1.closed
	<-w2.closed

	c.send(PortDiscovery, ep2([5]byte{0x04, 0x00, 0x6C, 0x2C, 0x70}))
	p1Run(c, true)
	ws := f.nextConn(t, wait)
	if ws.query.Get("frequency") != "7089264" {
		t.Fatalf("P1 socket %v", ws.query)
	}
	f.noConn(t, 300*time.Millisecond)
	st := b.Status()
	if st.Receivers[1].State != RxIdle {
		t.Fatalf("DDC1 %v under protocol 1", st.Receivers[1].State)
	}
}
