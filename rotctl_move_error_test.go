package main

import (
	"bufio"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeRotctld answers "p" with a settable position and acks every other
// command without moving, like a rotator whose motor is broken.
type fakeRotctld struct {
	ln     net.Listener
	mu     sync.Mutex
	az, el float64
}

func newFakeRotctld(t *testing.T, az float64) *fakeRotctld {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeRotctld{ln: ln, az: az}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(conn)
		}
	}()
	return f
}

func (f *fakeRotctld) serve(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		if strings.TrimSpace(line) == "p" {
			f.mu.Lock()
			fmt.Fprintf(conn, "%.1f\n%.1f\n", f.az, f.el)
			f.mu.Unlock()
		} else {
			fmt.Fprint(conn, "RPRT 0\n")
		}
	}
}

func (f *fakeRotctld) setAzimuth(az float64) {
	f.mu.Lock()
	f.az = az
	f.mu.Unlock()
}

func newTestController(t *testing.T, f *fakeRotctld) *RotatorController {
	t.Helper()
	addr := f.ln.Addr().(*net.TCPAddr)
	rc := NewRotatorController("127.0.0.1", addr.Port, true)
	rc.stuckThreshold = time.Millisecond
	if err := rc.Connect(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { rc.Disconnect() })
	return rc
}

// pollUntilStopped drives UpdateState the way backgroundUpdater does until
// the controller stops trying to move.
func pollUntilStopped(t *testing.T, rc *RotatorController) {
	t.Helper()
	for i := 0; i < 50; i++ {
		if err := rc.UpdateState(); err != nil {
			t.Fatal(err)
		}
		if !rc.GetState().Moving {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("rotator never stopped trying")
}

func TestRotatorMoveErrorSurvivesPositionPolls(t *testing.T) {
	f := newFakeRotctld(t, 90)
	rc := newTestController(t, f)

	if err := rc.SetAzimuth(180); err != nil {
		t.Fatal(err)
	}
	pollUntilStopped(t, rc)

	s := rc.GetState()
	if s.MoveError == nil {
		t.Fatal("expected MoveError after giving up on a stuck rotator")
	}
	failedAt := s.MoveErrorAt

	// The bug: the next successful position read wiped the failure, so the
	// health probe reported "recovered" one poll later.
	for i := 0; i < 5; i++ {
		if err := rc.UpdateState(); err != nil {
			t.Fatal(err)
		}
	}
	if s := rc.GetState(); s.MoveError == nil || s.LastError != nil {
		t.Fatalf("position polls cleared the move failure: MoveError=%v LastError=%v", s.MoveError, s.LastError)
	}

	// Re-sending a command (as sun tracking does) is not recovery either.
	if err := rc.SetAzimuth(180); err != nil {
		t.Fatal(err)
	}
	if rc.GetState().MoveError == nil {
		t.Fatal("a new move command cleared the move failure")
	}
	pollUntilStopped(t, rc)
	if s := rc.GetState(); s.MoveError == nil || !s.MoveErrorAt.After(failedAt) {
		t.Fatalf("second failed move not recorded: MoveError=%v at %v", s.MoveError, s.MoveErrorAt)
	}

	// Nor is "arriving" at a target the rotator is already sitting on.
	if err := rc.SetAzimuth(91); err != nil {
		t.Fatal(err)
	}
	pollUntilStopped(t, rc)
	if rc.GetState().MoveError == nil {
		t.Fatal("reaching a target without moving cleared the move failure")
	}

	// Jitter within the noise threshold doesn't count as moving.
	f.setAzimuth(93)
	if err := rc.UpdateState(); err != nil {
		t.Fatal(err)
	}
	if rc.GetState().MoveError == nil {
		t.Fatal("3° of jitter cleared the move failure")
	}

	// Actually moving does.
	f.setAzimuth(120)
	if err := rc.UpdateState(); err != nil {
		t.Fatal(err)
	}
	if s := rc.GetState(); s.MoveError != nil || !s.MoveErrorAt.IsZero() {
		t.Fatalf("move failure not cleared once the rotator moved: %v", s.MoveError)
	}
}
