package main

import (
	"fmt"
	"net/http"
)

// uberSDRServerHeader is the Server: value on every UberSDR listener except
// the KiwiSDR and WebSDR compatibility ports, which claim to be the software
// they emulate.  It deliberately carries no version.
const uberSDRServerHeader = "UberSDR"

// kiwiSDRServerHeader is the Server: value a real KiwiSDR sends, built from
// the configured firmware version (KiwiSDRVersionString) so it always agrees
// with /VER, /status and the version MSG.
func kiwiSDRServerHeader(s *ServerConfig) string {
	return fmt.Sprintf("KiwiSDR_%s/Mongoose_7.14", s.KiwiSDRVersionString())
}

// serverHeaderMiddleware sets Server: value on every response next writes.
// It is set before next runs so handlers that build their own headers keep
// it; a WebSocket upgrade bypasses the ResponseWriter's headers, so upgrade
// sites pass upgradeResponseHeader(w) to carry it over.
func serverHeaderMiddleware(value string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Server", value)
		next.ServeHTTP(w, r)
	})
}

// upgradeResponseHeader is the responseHeader for a gorilla Upgrade: just the
// Server: value serverHeaderMiddleware set on w, or nil when there is none.
func upgradeResponseHeader(w http.ResponseWriter) http.Header {
	v := w.Header().Get("Server")
	if v == "" {
		return nil
	}
	return http.Header{"Server": {v}}
}
