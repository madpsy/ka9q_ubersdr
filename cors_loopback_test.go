package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// The multi-monitor window in the desktop client is a web page served from
// http://127.0.0.1:<random>, and before it can open audio it has to POST
// /connection to each instance — a JSON body, so a preflighted request.  With
// enable_cors off (44 of the 45 instances in the directory at the time of
// writing) the preflight used to fall through to a POST-only handler, come back
// 405, and the browser would then never send the POST at all.  The client could
// not connect to anything.
//
// The concession is deliberately narrow: this one endpoint, and only for a page
// running on the same machine as the browser.

func TestIsLoopbackOrigin(t *testing.T) {
	loopback := []string{
		"http://127.0.0.1:49500",
		"http://127.0.0.1",
		"https://127.0.0.1:8443",
		"http://localhost:3000",
		"http://localhost",
		"http://[::1]:8080",
		"http://127.0.0.2:9000", // the whole 127/8 block, not just the one address
	}
	for _, o := range loopback {
		if !isLoopbackOrigin(o) {
			t.Errorf("isLoopbackOrigin(%q) = false, want true", o)
		}
	}

	// Anything a remote page could be served from, plus the spellings that only
	// look local.  A browser sets Origin from where the page came from, so these
	// are the cases that must not be mistaken for the desktop client.
	remote := []string{
		"",
		"https://example.com",
		"https://localhost.example.com",
		"https://127.0.0.1.example.com",
		"http://192.168.1.10:8073",
		"http://10.0.0.5",
		"null",
		"file://",
		"chrome-extension://abcdefghijklmnop",
		"not a url at all",
	}
	for _, o := range remote {
		if isLoopbackOrigin(o) {
			t.Errorf("isLoopbackOrigin(%q) = true, want false", o)
		}
	}
}

// corsMiddleware with everything off — the configuration nearly every instance
// actually runs.
func corsTestHandler() http.Handler {
	config := &Config{}
	config.Server.EnableCORS = false
	config.InstanceReporting.Hostname = ""

	// Stands in for the real /connection handler, which takes POST only.  If the
	// middleware does not answer the preflight itself, this is what does.
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	return corsMiddleware(config, next)
}

func TestPreflightFromDesktopClient(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "/connection", nil)
	req.Header.Set("Origin", "http://127.0.0.1:49500")
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "content-type")
	rec := httptest.NewRecorder()

	corsTestHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d, want 204 (the browser sends no POST after anything else)", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:49500" {
		t.Errorf("Access-Control-Allow-Origin = %q, want the requesting origin", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); got == "" {
		t.Error("no Access-Control-Allow-Headers: the JSON content type would be rejected")
	}
}

// The POST that follows has to carry the header too — a preflight that passes
// and a response the browser then refuses to hand over is the same failure one
// step later.
func TestPostFromDesktopClientIsReadable(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/connection", nil)
	req.Header.Set("Origin", "http://localhost:49500")
	rec := httptest.NewRecorder()

	corsTestHandler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:49500" {
		t.Errorf("Access-Control-Allow-Origin = %q, want the requesting origin", got)
	}
}

// The concession is to one endpoint.  Everything else from a loopback origin is
// left exactly as it was.
func TestLoopbackGetsNothingElse(t *testing.T) {
	for _, path := range []string{"/admin/sessions", "/api/bookmarks", "/status"} {
		req := httptest.NewRequest(http.MethodOptions, path, nil)
		req.Header.Set("Origin", "http://127.0.0.1:49500")
		rec := httptest.NewRecorder()

		corsTestHandler().ServeHTTP(rec, req)

		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("%s: Access-Control-Allow-Origin = %q, want none", path, got)
		}
	}
}

// And a page on a real website is still refused, which is what stops any site
// the user visits from registering a session on their receiver — the websocket
// itself is not subject to CORS, so this endpoint is the only gate there is.
func TestPreflightFromRemoteSiteIsStillRefused(t *testing.T) {
	req := httptest.NewRequest(http.MethodOptions, "/connection", nil)
	req.Header.Set("Origin", "https://example.com")
	rec := httptest.NewRecorder()

	corsTestHandler().ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("Access-Control-Allow-Origin = %q, want none", got)
	}
	if rec.Code == http.StatusNoContent {
		t.Error("the preflight was answered; a remote page could then register a session")
	}
}
