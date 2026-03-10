package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/publicsuffix"
)

// handleRMNoiseCredentials is a single collapsed proxy endpoint.
// The client POSTs {username, password} and receives the WebRTC token and
// TURN credentials needed to establish a connection to rmnoise.com — all in
// one round-trip. No server-side session state is kept; the cookie jar is
// created per-request and discarded when the handler returns.
//
// Upstream flow (identical to the previous three-step design):
//  1. POST /users2/login          — authenticate, obtain session cookies
//  2. POST /users2/get_webrtc_token   — fetch WebRTC signalling token
//  3. POST /users2/get_turn_credentials — fetch TURN server credentials
func handleRMNoiseCredentials(w http.ResponseWriter, r *http.Request, rateLimiter *RMNoiseRateLimiter) {
	w.Header().Set("Content-Type", "application/json")

	if !rateLimiter.AllowRequest(getClientIP(r), "credentials") {
		w.WriteHeader(http.StatusTooManyRequests)
		fmt.Fprint(w, `{"ok":false,"error":"Rate limit exceeded"}`)
		return
	}

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		fmt.Fprint(w, `{"ok":false,"error":"Method not allowed"}`)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 4096)

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"ok":false,"error":"Invalid JSON body"}`)
		return
	}
	if req.Username == "" || req.Password == "" {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"ok":false,"error":"username and password are required"}`)
		return
	}
	const maxCredLen = 50
	if len(req.Username) > maxCredLen || len(req.Password) > maxCredLen {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"ok":false,"error":"username and password must be 50 characters or fewer"}`)
		return
	}

	// Build a one-shot HTTP client with a cookie jar — discarded after this request.
	jar, err := cookiejar.New(&cookiejar.Options{PublicSuffixList: publicsuffix.List})
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, `{"ok":false,"error":"Internal error creating session"}`)
		return
	}
	client := &http.Client{Jar: jar, Timeout: 15 * time.Second}

	// ── Step 1: Login ──────────────────────────────────────────────────────────
	// Direct POST to rmnoise.com — no prior GET for CSRF token.
	// A successful login returns HTTP 302 → /users2/home (followed to 200).
	// A failed login returns HTTP 200 directly with the login page HTML.
	// The rememberme field must be present (empty string is fine).
	formBody := url.Values{}
	formBody.Set("username", req.Username)
	formBody.Set("password", req.Password)
	formBody.Set("rememberme", "")

	resp, err := rmNoiseOutboundRequest(client, http.MethodPost,
		"https://rmnoise.com/users2/login",
		"application/x-www-form-urlencoded",
		formBody.Encode(),
	)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprintf(w, `{"ok":false,"error":"Login request failed: %s"}`, jsonEscapeString(err.Error()))
		return
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK || strings.Contains(resp.Request.URL.Path, "/users2/login") {
		log.Printf("RMNoise proxy: login failed for user %q (HTTP %d, final path: %s)",
			req.Username, resp.StatusCode, resp.Request.URL.Path)
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"ok":false,"error":"Invalid username or password"}`)
		return
	}
	log.Printf("RMNoise proxy: login OK for user %q", req.Username)

	// ── Step 2: WebRTC token ───────────────────────────────────────────────────
	resp, err = rmNoiseOutboundRequest(client, http.MethodPost,
		"https://rmnoise.com/users2/get_webrtc_token",
		"application/json",
		"",
	)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprintf(w, `{"ok":false,"error":"WebRTC token request failed: %s"}`, jsonEscapeString(err.Error()))
		return
	}
	webrtcBody, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	log.Printf("RMNoise proxy: webrtc_token HTTP %d", resp.StatusCode)

	if isHTMLResponse(resp, webrtcBody) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"ok":false,"error":"Session not authenticated after login — please try again"}`)
		return
	}

	// ── Step 3: TURN credentials ───────────────────────────────────────────────
	resp, err = rmNoiseOutboundRequest(client, http.MethodPost,
		"https://rmnoise.com/users2/get_turn_credentials",
		"application/json",
		"",
	)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprintf(w, `{"ok":false,"error":"TURN credentials request failed: %s"}`, jsonEscapeString(err.Error()))
		return
	}
	turnBody, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	log.Printf("RMNoise proxy: turn_creds HTTP %d", resp.StatusCode)

	if isHTMLResponse(resp, turnBody) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"ok":false,"error":"Session not authenticated after login — please try again"}`)
		return
	}

	// ── Combine and return ─────────────────────────────────────────────────────
	// Unmarshal both upstream responses and re-encode as a single JSON object
	// so the client receives one clean, well-formed response.
	var webrtcData, turnData json.RawMessage
	if err := json.Unmarshal(webrtcBody, &webrtcData); err != nil {
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprint(w, `{"ok":false,"error":"Invalid WebRTC token response from upstream"}`)
		return
	}
	if err := json.Unmarshal(turnBody, &turnData); err != nil {
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprint(w, `{"ok":false,"error":"Invalid TURN credentials response from upstream"}`)
		return
	}

	result := struct {
		OK          bool            `json:"ok"`
		WebRTCToken json.RawMessage `json:"webrtc_token"`
		TURNCreds   json.RawMessage `json:"turn_creds"`
	}{
		OK:          true,
		WebRTCToken: webrtcData,
		TURNCreds:   turnData,
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(result)
}

// ── Outbound request helper ────────────────────────────────────────────────────
//
// Mirrors the Python client with _SPOOF_BROWSER_HEADERS = False:
// no User-Agent, no Origin, no Referer — just the bare minimum headers.
// The rmnoise.com server treats requests without an Origin header as
// non-browser (API-style) requests and does not enforce CSRF protection.

func rmNoiseOutboundRequest(client *http.Client, method, targetURL, contentType, body string) (*http.Response, error) {
	var bodyReader io.Reader
	if body != "" {
		bodyReader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, targetURL, bodyReader)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	// Deliberately send NO User-Agent, Origin, or Referer headers.
	// This matches the Python client's _SPOOF_BROWSER_HEADERS = False behaviour
	// and avoids triggering CSRF enforcement on the server side.
	return client.Do(req)
}

// ── Utility ────────────────────────────────────────────────────────────────────

// isHTMLResponse returns true if the response body looks like an HTML page
// rather than a JSON API response. Used to detect when rmnoise.com redirects
// unauthenticated requests to the login page.
func isHTMLResponse(resp *http.Response, body []byte) bool {
	ct := resp.Header.Get("Content-Type")
	if strings.Contains(ct, "text/html") {
		return true
	}
	// Also check body prefix in case Content-Type is missing/wrong
	trimmed := strings.TrimSpace(string(body))
	return strings.HasPrefix(trimmed, "<!") || strings.HasPrefix(trimmed, "<html")
}

// jsonEscapeString escapes a string for safe embedding in a JSON string literal.
func jsonEscapeString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return "internal error"
	}
	// json.Marshal wraps in quotes; strip them
	return string(b[1 : len(b)-1])
}
