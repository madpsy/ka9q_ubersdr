package main

import (
	"bytes"
	"log"
	"net"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// A datagram read from the data socket must carry the kernel's receive time,
// and that time must fall between the send and the read on the system clock.
func TestDataSocketKernelRxTimestamp(t *testing.T) {
	// A multicast group on loopback exercises the real socket setup,
	// including the SO_TIMESTAMPNS option, without needing a network.
	group := &net.UDPAddr{IP: net.IPv4(239, 255, 77, 77), Port: 0}
	probe, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	group.Port = probe.LocalAddr().(*net.UDPAddr).Port
	probe.Close()

	lo, err := getLoopbackInterface()
	if err != nil || lo == nil {
		t.Skipf("no loopback interface: %v", err)
	}
	conn, err := setupDataSocket(group, lo)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	raw, err := conn.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var enabled int
	raw.Control(func(fd uintptr) {
		enabled, _ = unix.GetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_TIMESTAMPNS)
	})
	if enabled == 0 {
		t.Fatal("SO_TIMESTAMPNS not enabled on the data socket")
	}

	// Send to the socket's own port on loopback: a unicast datagram reaches
	// the same receive path and cmsg handling as a multicast one.
	sender, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: group.Port})
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()

	buf := make([]byte, 1500)
	oob := make([]byte, 128)

	// The kernel switches receive stamping on through deferred work, so
	// datagrams in the first moments after SO_TIMESTAMPNS is set are stamped
	// at read time instead. A long-lived data socket only ever sees that on
	// its first packets; wait it out here so the check below is meaningful.
	time.Sleep(100 * time.Millisecond)

	before := time.Now().UnixNano()
	if _, err := sender.Write([]byte("rtp-ish payload")); err != nil {
		t.Fatal(err)
	}

	// Read late on purpose: the kernel stamp must not move with the read.
	time.Sleep(50 * time.Millisecond)

	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, oobn, _, _, err := conn.ReadMsgUDP(buf, oob)
	if err != nil {
		t.Fatal(err)
	}
	after := time.Now().UnixNano()

	ts, ok := kernelRxTimeNs(oob[:oobn])
	if !ok {
		t.Fatal("no SCM_TIMESTAMPNS control message on the datagram")
	}
	if ts < before || ts > after {
		t.Fatalf("kernel timestamp %d outside [%d, %d]", ts, before, after)
	}
	if after-ts < int64(40*time.Millisecond) {
		t.Fatalf("timestamp looks like read time, not receive time: only %v before the read",
			time.Duration(after-ts))
	}
}

func TestKernelRxTimeNsRejectsMissingOrMalformed(t *testing.T) {
	if _, ok := kernelRxTimeNs(nil); ok {
		t.Fatal("empty control area reported a timestamp")
	}
	if _, ok := kernelRxTimeNs([]byte{1, 2, 3}); ok {
		t.Fatal("truncated control area reported a timestamp")
	}
}

func TestThrottledLogCapsOutput(t *testing.T) {
	var out bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&out)
	defer log.SetOutput(prev)

	tl := throttledLog{interval: time.Hour}
	for i := 0; i < 10000; i++ {
		tl.Printf("boom %d", i)
	}
	if lines := strings.Count(out.String(), "\n"); lines != 1 {
		t.Fatalf("got %d log lines for 10000 calls within one interval, want 1", lines)
	}

	// Once the interval passes, the next line reports what was dropped.
	tl.last = time.Now().Add(-2 * time.Hour)
	tl.Printf("boom again")
	if !strings.Contains(out.String(), "(9999 similar suppressed)") {
		t.Fatalf("suppressed count missing: %q", out.String())
	}
}
