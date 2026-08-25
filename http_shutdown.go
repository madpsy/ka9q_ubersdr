package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"sync"
	"time"
)

// httpShutdownGrace bounds how long shutdown waits for in-flight HTTP handlers
// to finish before their connections are torn down.  It has to be long enough
// for an ordinary request to complete and short enough that a wedged handler
// cannot hold up the process.
const httpShutdownGrace = 5 * time.Second

type namedHTTPServer struct {
	name string
	srv  *http.Server
}

// httpServerGroup collects the HTTP servers that must be stopped when the
// process shuts down: the main listener plus the KiwiSDR and WebSDR
// compatibility listeners.
//
// The servers are registered from the main goroutine as they are started, but
// stopped from the signal-handler goroutine, which is already running by then
// — hence the mutex.  Registering a server after shutdown has begun stops it
// immediately, so a listener that came up in the middle of the signal handler
// cannot be left running.
type httpServerGroup struct {
	mu      sync.Mutex
	servers []namedHTTPServer
	grace   time.Duration
	stopped bool
	done    chan struct{}
}

func newHTTPServerGroup(grace time.Duration) *httpServerGroup {
	if grace <= 0 {
		grace = httpShutdownGrace
	}
	return &httpServerGroup{grace: grace, done: make(chan struct{})}
}

// Add registers a server to be stopped by ShutdownAll.  A nil server is
// ignored so callers do not have to guard optional listeners.
func (g *httpServerGroup) Add(name string, srv *http.Server) {
	if srv == nil {
		return
	}

	g.mu.Lock()
	if g.stopped {
		grace := g.grace
		g.mu.Unlock()
		shutdownHTTPServer(name, srv, grace)
		return
	}
	g.servers = append(g.servers, namedHTTPServer{name: name, srv: srv})
	g.mu.Unlock()
}

// ShutdownAll stops every registered server and returns once they have all
// drained (or the grace period expired).  Concurrent and repeat callers block
// until the first shutdown has finished, so the caller can rely on no handler
// being mid-flight when it returns.
func (g *httpServerGroup) ShutdownAll() {
	g.mu.Lock()
	if g.stopped {
		g.mu.Unlock()
		<-g.done
		return
	}
	g.stopped = true
	servers := g.servers
	g.servers = nil
	grace := g.grace
	g.mu.Unlock()

	var wg sync.WaitGroup
	for _, ns := range servers {
		wg.Add(1)
		go func(ns namedHTTPServer) {
			defer wg.Done()
			shutdownHTTPServer(ns.name, ns.srv, grace)
		}(ns)
	}
	wg.Wait()

	close(g.done)
}

// shutdownHTTPServer stops srv, giving in-flight handlers up to grace to finish
// before forcing their connections closed.
//
// Neither half works on its own here.  Shutdown waits for every connection to
// go idle, and this process serves long-lived WebSockets, so an unbounded
// Shutdown blocks for as long as a client stays connected.  Close returns
// immediately but leaves handlers running, which is how a request could still
// be inside a GeoIP lookup while main was already unmapping the database.
// A bounded Shutdown followed by Close both terminates and drains.
func shutdownHTTPServer(name string, srv *http.Server, grace time.Duration) {
	if srv == nil {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()

	err := srv.Shutdown(ctx)
	if err == nil {
		return
	}

	if errors.Is(err, context.DeadlineExceeded) {
		log.Printf("%s server: handlers still running after %v, forcing connections closed", name, grace)
	} else {
		log.Printf("%s server: graceful shutdown failed: %v", name, err)
	}

	if err := srv.Close(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Printf("%s server: error closing: %v", name, err)
	}
}
