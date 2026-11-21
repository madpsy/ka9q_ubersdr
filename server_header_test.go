package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func TestKiwiSDRServerHeader(t *testing.T) {
	for _, tc := range []struct{ ver, want string }{
		{"", "KiwiSDR_1.902/Mongoose_7.14"},
		{"1.902", "KiwiSDR_1.902/Mongoose_7.14"},
		{"1.815", "KiwiSDR_1.815/Mongoose_7.14"},
		{"bogus", "KiwiSDR_1.902/Mongoose_7.14"},
	} {
		if got := kiwiSDRServerHeader(&ServerConfig{KiwiSDRVersion: tc.ver}); got != tc.want {
			t.Errorf("version %q: got %q, want %q", tc.ver, got, tc.want)
		}
	}
}

// TestServerHeaderMiddleware checks plain responses, http.Error responses and
// WebSocket upgrades all carry the header.
func TestServerHeaderMiddleware(t *testing.T) {
	up := websocket.Upgrader{}
	mux := http.NewServeMux()
	mux.HandleFunc("/ok", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("hi")) })
	mux.HandleFunc("/err", func(w http.ResponseWriter, r *http.Request) { http.Error(w, "no", http.StatusForbidden) })
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, upgradeResponseHeader(w))
		if err == nil {
			c.Close()
		}
	})
	srv := httptest.NewServer(serverHeaderMiddleware(uberSDRServerHeader, mux))
	defer srv.Close()

	for _, p := range []string{"/ok", "/err", "/missing"} {
		resp, err := http.Get(srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("Server"); got != "UberSDR" {
			t.Errorf("%s: Server = %q, want UberSDR", p, got)
		}
	}

	c, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	if got := resp.Header.Get("Server"); got != "UberSDR" {
		t.Errorf("upgrade: Server = %q, want UberSDR", got)
	}
}

func TestUpgradeResponseHeaderWithoutMiddleware(t *testing.T) {
	if h := upgradeResponseHeader(httptest.NewRecorder()); h != nil {
		t.Errorf("got %v, want nil", h)
	}
}
