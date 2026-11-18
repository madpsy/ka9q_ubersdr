package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// freeAddr returns a loopback address with a port nothing is listening on.
func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	return addr
}

func holdingGet(t *testing.T, method, url string) (int, http.Header, string) {
	t.Helper()
	req, _ := http.NewRequest(method, url, nil)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, string(body)
}

func TestHoldingServerAnswers(t *testing.T) {
	addr := freeAddr(t)
	stop := startHoldingServer(addr)
	defer stop()

	// The Docker health check: wget --spider http://localhost:8080/
	code, _, body := holdingGet(t, http.MethodGet, "http://"+addr+"/")
	if code != http.StatusOK || !strings.Contains(body, "Receiver starting") {
		t.Errorf("GET /: %d %q; want 200 and the holding page", code, body)
	}
	code, _, body = holdingGet(t, http.MethodHead, "http://"+addr+"/")
	if code != http.StatusOK || body != "" {
		t.Errorf("HEAD /: %d with %d bytes; want 200 and no body", code, len(body))
	}
	for _, path := range []string{"/api/description", "/ws", "/index.html", "/mcp"} {
		code, hdr, _ := holdingGet(t, http.MethodGet, "http://"+addr+path)
		if code != http.StatusServiceUnavailable || hdr.Get("Retry-After") == "" {
			t.Errorf("GET %s: %d, Retry-After %q; want 503 with Retry-After", path, code, hdr.Get("Retry-After"))
		}
	}
}

func TestHoldingServerReleasesPort(t *testing.T) {
	addr := freeAddr(t)
	stop := startHoldingServer(addr)
	holdingGet(t, http.MethodGet, "http://"+addr+"/")
	stop()
	stop() // a second call is harmless

	// The real server must be able to bind the port straight away.
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("port not free after stop: %v", err)
	}
	ln.Close()
}

func TestHoldingServerStopsWithClientsConnected(t *testing.T) {
	old := holdingStopTimeout
	holdingStopTimeout = 200 * time.Millisecond
	defer func() { holdingStopTimeout = old }()

	addr := freeAddr(t)
	stop := startHoldingServer(addr)
	// An idle connection that never sends a request must not hold up the
	// handover.
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	time.Sleep(20 * time.Millisecond)

	done := make(chan struct{})
	go func() { stop(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("stop did not return with a client connected")
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("port not free after stop: %v", err)
	}
	ln.Close()
}

func TestHoldingServerPortTaken(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	// Must not panic or block; startup carries on without it.
	stop := startHoldingServer(ln.Addr().String())
	stop()
	stop()
}

func TestHoldingServerBadAddress(t *testing.T) {
	stop := startHoldingServer("not an address")
	stop()
}

// The holding server runs only while a VACUUM does: it answers during it and
// the port is free again once ReclaimSpaceAtStartup returns.
func TestReclaimAtStartupHoldsPortWhileVacuuming(t *testing.T) {
	withVacuumGuards(t, 1<<40, nil)
	mgr, _ := oldStyleDB(t)
	addr := freeAddr(t)

	started, finished := 0, 0
	answered := 0
	vacuumed := mgr.ReclaimSpaceAtStartup(context.Background(), func() func() {
		started++
		stop := startHoldingServer(addr)
		// The database is held by the VACUUM from here on; the health check
		// must still be answered.
		if code, _, _ := holdingGet(t, http.MethodGet, "http://"+addr+"/"); code == http.StatusOK {
			answered++
		}
		return func() { stop(); finished++ }
	})
	if !vacuumed {
		t.Fatal("did not vacuum")
	}
	if started != 1 || finished != 1 || answered != 1 {
		t.Errorf("started %d, finished %d, answered %d; want 1 each", started, finished, answered)
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("port not free after the VACUUM: %v", err)
	}
	ln.Close()

	// Next start: nothing to do, so nothing listens.
	if mgr.ReclaimSpaceAtStartup(context.Background(), func() func() {
		t.Error("holding server started with no VACUUM to run")
		return nil
	}) {
		t.Error("vacuumed again")
	}
}

func TestReclaimAtStartupNoHoldWhenSkipped(t *testing.T) {
	// Not enough disk: the VACUUM is skipped, so the hook must not run.
	withVacuumGuards(t, 1, nil)
	mgr, _ := oldStyleDB(t)
	mgr.ReclaimSpaceAtStartup(context.Background(), func() func() {
		t.Error("holding server started although the VACUUM was skipped")
		return nil
	})
}

func TestReclaimAtStartupReleasesOnCancel(t *testing.T) {
	withVacuumGuards(t, 1<<40, nil)
	mgr, _ := oldStyleDB(t)
	ctx, cancel := context.WithCancel(context.Background())
	finished := 0
	mgr.ReclaimSpaceAtStartup(ctx, func() func() {
		cancel() // a stop request arrives as the VACUUM starts
		return func() { finished++ }
	})
	if finished != 1 {
		t.Errorf("done called %d times after a cancelled VACUUM; want 1", finished)
	}
}

// A panicking hook must not take the process down.
func TestReclaimAtStartupHookPanic(t *testing.T) {
	withVacuumGuards(t, 1<<40, nil)
	mgr, _ := oldStyleDB(t)
	mgr.ReclaimSpaceAtStartup(context.Background(), func() func() { panic("boom") })
}
