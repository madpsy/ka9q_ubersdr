package main

import (
	"net"
	"net/http"
	"testing"
	"time"
)

// startTestHTTPServer brings up h on a loopback port and returns the server
// plus its base URL.
func startTestHTTPServer(t *testing.T, h http.Handler) (*http.Server, string) {
	t.Helper()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	srv := &http.Server{Handler: h}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	return srv, "http://" + ln.Addr().String()
}

// TestShutdownAllDrainsInFlightHandlers is the property main depends on: when
// ShutdownAll returns, no handler is still running, so it is safe to start
// tearing down the resources those handlers use.
func TestShutdownAllDrainsInFlightHandlers(t *testing.T) {
	started := make(chan struct{})
	finished := make(chan struct{})

	srv, url := startTestHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		time.Sleep(150 * time.Millisecond)
		close(finished)
		w.WriteHeader(http.StatusOK)
	}))

	group := newHTTPServerGroup(5 * time.Second)
	group.Add("test", srv)

	status := make(chan int, 1)
	go func() {
		resp, err := http.Get(url)
		if err != nil {
			status <- 0
			return
		}
		resp.Body.Close()
		status <- resp.StatusCode
	}()

	<-started
	group.ShutdownAll()

	select {
	case <-finished:
	default:
		t.Fatal("ShutdownAll returned while a handler was still running")
	}

	if code := <-status; code != http.StatusOK {
		t.Errorf("client got status %d, want 200 — the request was cut off instead of drained", code)
	}

	// The listener must be gone.
	if _, err := http.Get(url); err == nil {
		t.Error("server still accepting requests after ShutdownAll")
	}
}

// TestShutdownAllIsBoundedByGrace covers the long-lived WebSocket case: an
// unbounded Shutdown would wait for the connection to go idle, which never
// happens, so the grace period has to cap it and force the connection closed.
func TestShutdownAllIsBoundedByGrace(t *testing.T) {
	const grace = 150 * time.Millisecond

	started := make(chan struct{})
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })

	srv, url := startTestHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-release // never returns during the test, like a live WebSocket
	}))

	group := newHTTPServerGroup(grace)
	group.Add("test", srv)

	go func() {
		resp, err := http.Get(url)
		if err == nil {
			resp.Body.Close()
		}
	}()
	<-started

	begin := time.Now()
	group.ShutdownAll()
	elapsed := time.Since(begin)

	if elapsed < grace {
		t.Errorf("ShutdownAll returned after %v, before the %v grace period elapsed", elapsed, grace)
	}
	if elapsed > 3*time.Second {
		t.Errorf("ShutdownAll took %v — a stuck handler must not block the exit", elapsed)
	}
}

// TestShutdownAllRepeatCallsWait: a second caller must not race ahead of the
// first and let teardown start early.
func TestShutdownAllRepeatCallsWait(t *testing.T) {
	started := make(chan struct{})
	finished := make(chan struct{})

	srv, url := startTestHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		time.Sleep(200 * time.Millisecond)
		close(finished)
	}))

	group := newHTTPServerGroup(5 * time.Second)
	group.Add("test", srv)

	go func() {
		resp, err := http.Get(url)
		if err == nil {
			resp.Body.Close()
		}
	}()
	<-started

	firstDone := make(chan struct{})
	go func() {
		group.ShutdownAll()
		close(firstDone)
	}()

	// Give the first call time to take ownership, then join it.
	time.Sleep(20 * time.Millisecond)
	group.ShutdownAll()

	select {
	case <-finished:
	default:
		t.Fatal("the second ShutdownAll returned while a handler was still running")
	}
	<-firstDone
}

// TestShutdownGroupAddAfterShutdown covers the startup/shutdown overlap: the
// KiwiSDR and WebSDR listeners are registered after the signal handler is
// already running, so a server that arrives late must still be stopped.
func TestShutdownGroupAddAfterShutdown(t *testing.T) {
	group := newHTTPServerGroup(time.Second)
	group.ShutdownAll()

	srv, url := startTestHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	group.Add("late", srv)

	if _, err := http.Get(url); err == nil {
		t.Error("a server registered after ShutdownAll was left running")
	}
}

// TestShutdownGroupEmptyAndNil: optional listeners are registered
// unconditionally, so nil must be tolerated.
func TestShutdownGroupEmptyAndNil(t *testing.T) {
	group := newHTTPServerGroup(0)
	group.Add("nil", nil)
	group.ShutdownAll()
	group.ShutdownAll()

	shutdownHTTPServer("nil", nil, time.Second)
}

// TestShutdownBeforeGeoIPCloseKeepsLookupsSafe reproduces the shape of the
// production crash end to end.
//
// httpLogger performs its GeoIP lookup *after* the inner handler returns, so a
// request that is still in flight at shutdown does a database lookup at the
// worst possible moment.  With the servers drained first, that lookup completes
// against a live database; the deferred GeoIP close then has nothing left
// racing it.
func TestShutdownBeforeGeoIPCloseKeepsLookupsSafe(t *testing.T) {
	svc := newTestGeoIPService(t)

	started := make(chan struct{})
	type outcome struct {
		code string
		err  error
	}
	logged := make(chan outcome, 1)

	// Same order of operations as httpLogger: run the request, then geolocate.
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		time.Sleep(100 * time.Millisecond)
		w.WriteHeader(http.StatusOK)

		result, err := svc.Lookup(testGeoIPAddr, false)
		if err != nil {
			logged <- outcome{err: err}
			return
		}
		logged <- outcome{code: result.CountryCode}
	})

	srv, url := startTestHTTPServer(t, handler)
	group := newHTTPServerGroup(5 * time.Second)
	group.Add("main", srv)

	go func() {
		resp, err := http.Get(url)
		if err == nil {
			resp.Body.Close()
		}
	}()
	<-started

	group.ShutdownAll()
	if err := svc.Close(); err != nil {
		t.Fatalf("GeoIP Close: %v", err)
	}

	select {
	case got := <-logged:
		if got.err != nil {
			t.Errorf("in-flight request logged a GeoIP error (%v) — it was not drained before the database closed", got.err)
		} else if got.code != "GB" {
			t.Errorf("logged country %q, want GB", got.code)
		}
	default:
		t.Fatal("the request had not finished logging when the GeoIP database was closed")
	}
}
