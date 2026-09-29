package hpsdr

import (
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
