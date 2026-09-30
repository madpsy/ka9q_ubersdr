package hpsdr

import (
	"context"
	"encoding/binary"
	"os"
	"testing"
	"time"

	"github.com/ka9q/ubersdr/clients/hpsdr-go/internal/ubersdr"
)

// TestLiveP2 runs a protocol 2 client against a real receiver:
//
//	UBERSDR_LIVE_URL=https://m9psy-1.instance.ubersdr.org go test -run Live -v ./internal/hpsdr/
//
// Two DDCs at 384 and 48 kHz, which needs a session allowed both. It checks the
// packets arrive at each DDC's own rate, contiguous, with signal in them -- the
// things only a real server's timing and a real band can show.
func TestLiveP2(t *testing.T) {
	url := os.Getenv("UBERSDR_LIVE_URL")
	if url == "" || testing.Short() {
		t.Skip("set UBERSDR_LIVE_URL to run against a real receiver")
	}
	srv, err := ubersdr.NewServer(url, os.Getenv("UBERSDR_LIVE_PASSWORD"))
	if err != nil {
		t.Fatal(err)
	}
	logs := &logBuf{}
	var b *Bridge
	for attempt := 0; attempt < 20; attempt++ {
		b, err = New(Config{Server: srv, NumRx: 2, Device: DeviceHermesLite, MinMargin: 26,
			BasePort: 21000 + attempt*50, Logf: func(s string) { logs.add(s); t.Log(s) }})
		if err == nil {
			break
		}
	}
	if err != nil {
		t.Fatal(err)
	}
	b.Start()
	defer b.Close()

	c := newClient(t, b.cfg.BasePort)
	word := func(hz float64) uint32 { return uint32(hz*4294967296.0/DDCClockHz + 0.5) }
	startP2(t, c, 0x08, map[int]int{0: 384, 1: 48}, word(14_074_000), word(7_074_000))
	keepAlive(t, c)

	// Let both sockets connect and settle, then count for a fixed window.
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		s := b.Status()
		if s.Receivers[0].State == RxStreaming && s.Receivers[1].State == RxStreaming {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	time.Sleep(time.Second)
	for _, ddc := range []int{0, 1} {
		c.drain(PortDDC0 + ddc)
	}

	const window = 4 * time.Second
	type tally struct {
		packets, gaps int
		lastSeq       uint32
		peak          int32
	}
	got := map[int]*tally{0: {}, 1: {}}
	end := time.Now().Add(window)
	for time.Now().Before(end) {
		for ddc, tl := range got {
		drain:
			for {
				select {
				case p := <-c.ch(c.base + PortDDC0 + ddc):
					seq := binary.BigEndian.Uint32(p)
					if tl.packets > 0 && seq != tl.lastSeq+1 {
						tl.gaps++
					}
					tl.lastSeq = seq
					tl.packets++
					for j := 0; j < 238; j++ {
						if v := get24(p[16+6*j:]); v > tl.peak {
							tl.peak = v
						}
					}
				default:
					break drain
				}
			}
		}
		time.Sleep(time.Millisecond)
	}
	for ddc, khz := range map[int]int{0: 384, 1: 48} {
		tl := got[ddc]
		rate := float64(tl.packets*238) / window.Seconds()
		t.Logf("DDC%d: %d packets, %.0f samples/s (%.3f of %d kHz), %d sequence gaps, peak %d",
			ddc, tl.packets, rate, rate/float64(khz*1000), khz, tl.gaps, tl.peak)
		if rate < 0.9*float64(khz*1000) || rate > 1.1*float64(khz*1000) {
			t.Errorf("DDC%d delivered %.0f samples/s for %d kHz", ddc, rate, khz)
		}
		if tl.gaps > 0 {
			t.Errorf("DDC%d: %d sequence gaps", ddc, tl.gaps)
		}
		if tl.peak == 0 {
			t.Errorf("DDC%d carried no signal", ddc)
		}
	}
	if s := c.recv(PortDDCSpecific, time.Second); len(s) != 60 {
		t.Error("no status stream")
	}
}

// TestLiveRouted tunes one DDC between two real receivers:
//
//	UBERSDR_LIVE_URL=https://rx1 UBERSDR_LIVE_BAND_URL=https://rx2 go test -run LiveRouted -v ./internal/hpsdr/
//
// 20m goes to the first, 40m to the second. It checks each move lands on the
// right receiver by callsign, IQ flows after each, and the sequence carries on
// across them.
func TestLiveRouted(t *testing.T) {
	mainURL, bandURL := os.Getenv("UBERSDR_LIVE_URL"), os.Getenv("UBERSDR_LIVE_BAND_URL")
	if mainURL == "" || bandURL == "" || testing.Short() {
		t.Skip("set UBERSDR_LIVE_URL and UBERSDR_LIVE_BAND_URL to run against two real receivers")
	}
	route := func(url string, bands ...string) *Route {
		srv, err := ubersdr.NewServer(url, os.Getenv("UBERSDR_LIVE_PASSWORD"))
		if err != nil {
			t.Fatal(err)
		}
		d, err := srv.Describe(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("%s: %s, %d-%d Hz", srv.Host(), d.Callsign, d.MinHz, d.MaxHz)
		return &Route{Server: srv, Callsign: d.Callsign, Bands: bands, MinHz: d.MinHz, MaxHz: d.MaxHz}
	}
	main, forty := route(mainURL), route(bandURL, "40m")
	logs := &logBuf{}
	var b *Bridge
	var err error
	for attempt := 0; attempt < 20; attempt++ {
		b, err = New(Config{Routes: []*Route{main, forty}, NumRx: 1, Device: DeviceHermesLite, MinMargin: 26,
			BasePort: 22000 + attempt*50, Logf: func(s string) { logs.add(s); t.Log(s) }})
		if err == nil {
			break
		}
	}
	if err != nil {
		t.Fatal(err)
	}
	b.Start()
	defer b.Close()

	c := newClient(t, b.cfg.BasePort)
	keepAlive(t, c)
	startP2(t, c, 0, map[int]int{0: 48}, 14_074_000)

	var seq uint32
	for step, want := range []struct {
		hz  uint32
		on  *Route
		why Why
	}{{14_074_000, main, WhyAll}, {7_074_000, forty, WhyBand}, {14_074_000, main, WhyAll}} {
		if step > 0 {
			c.send(PortHighPrio, highPrio(uint32(step), true, want.hz))
		}
		deadline := time.Now().Add(15 * time.Second)
		for {
			s := b.Status().Receivers[0]
			if s.State == RxStreaming && s.Instance == want.on.Name && s.FreqHz == int64(want.hz) {
				if s.Callsign != want.on.Callsign || s.Why != want.why {
					t.Fatalf("step %d: %+v", step, s)
				}
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("step %d: never streaming on %s: %+v", step, want.on.Name, s)
			}
			time.Sleep(50 * time.Millisecond)
		}
		c.drain(PortDDC0)
		n := 0
		end := time.Now().Add(2 * time.Second)
		for time.Now().Before(end) {
			select {
			case p := <-c.ch(c.base + PortDDC0):
				s := binary.BigEndian.Uint32(p)
				if seq != 0 && s <= seq {
					t.Fatalf("step %d: sequence went back from %d to %d", step, seq, s)
				}
				seq = s
				n++
			case <-time.After(100 * time.Millisecond):
			}
		}
		rate := float64(n*238) / 2
		t.Logf("step %d: %.3f MHz on %s (%c): %.0f samples/s", step, float64(want.hz)/1e6, want.on.Callsign, want.why, rate)
		if rate < 0.8*48000 {
			t.Errorf("step %d: %.0f samples/s at 48 kHz", step, rate)
		}
	}

	// Above both ranges: the socket closes and nothing reconnects, where
	// the server would refuse the socket and close it again and again.
	c.send(PortHighPrio, highPrio(9, true, 64_000_000))
	deadline := time.Now().Add(5 * time.Second)
	for b.Status().Receivers[0].State != RxOutOfRange {
		if time.Now().After(deadline) {
			t.Fatalf("64 MHz: %+v", b.Status().Receivers[0])
		}
		time.Sleep(50 * time.Millisecond)
	}
	time.Sleep(2 * time.Second)
	if s := b.Status().Receivers[0]; s.State != RxOutOfRange || logs.has("EOF") || logs.has("reconnecting") {
		t.Fatalf("64 MHz: %+v", s)
	}
}
