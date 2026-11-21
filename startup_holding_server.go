package main

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"time"
)

// The holding server answers on the HTTP port while startup work that runs
// before the real server (the one-time VACUUM) is in progress. Docker's
// health check fetches "/" and gives the container about a minute and a half;
// a VACUUM can take several minutes, and without an answer the container is
// marked unhealthy and the services that depend on it refuse to start.
//
// "/" answers 200 with a short page saying the receiver is starting, so the
// health check passes and a browser sees why the receiver is not there yet.
// Everything else answers 503 with Retry-After, so API clients and the
// reverse proxy see "not ready" rather than a closed port.

const holdingRetryAfterSeconds = "30"

const holdingPage = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30"><title>Receiver starting</title>
<style>body{font-family:sans-serif;background:#111;color:#ddd;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box;text-align:center}</style>
</head><body><div><h1>Receiver starting</h1>
<p>One-time database maintenance is in progress. This can take a few minutes.</p>
<p>This page reloads by itself.</p></div></body></html>
`

// holdingStopTimeout bounds how long stopping waits for requests in flight.
var holdingStopTimeout = 2 * time.Second

func holdingHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		// No keep-alive: every connection is gone by the time the real
		// server takes the port.
		w.Header().Set("Connection", "close")
		if r.URL.Path == "/" {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			if r.Method != http.MethodHead {
				w.Write([]byte(holdingPage))
			}
			return
		}
		w.Header().Set("Retry-After", holdingRetryAfterSeconds)
		http.Error(w, "receiver starting: database maintenance in progress", http.StatusServiceUnavailable)
	})
}

// startHoldingServer listens on addr and serves the holding responses until
// the returned function is called. That function closes the listener and
// returns once the port is free for the real server. It is safe to call more
// than once.
//
// It never stops startup: if the port cannot be bound it logs why and returns
// a function that does nothing, and the maintenance carries on as before.
func startHoldingServer(addr string) (stop func()) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Printf("[Startup] could not answer on %s during database maintenance (health checks may fail until it finishes): %v", addr, err)
		return func() {}
	}
	srv := &http.Server{
		Handler:           serverHeaderMiddleware(uberSDRServerHeader, holdingHandler()),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
	served := make(chan struct{})
	go func() {
		defer close(served)
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[Startup] holding server recovered from panic: %v", r)
			}
		}()
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("[Startup] holding server on %s stopped: %v", addr, err)
		}
	}()
	log.Printf("[Startup] answering on %s with a \"receiver starting\" page while database maintenance runs", addr)

	stopped := false
	return func() {
		if stopped {
			return
		}
		stopped = true
		ctx, cancel := context.WithTimeout(context.Background(), holdingStopTimeout)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			srv.Close()
		}
		<-served
	}
}
