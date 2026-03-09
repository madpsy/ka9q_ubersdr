package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/publicsuffix"
)

// ── Session store ──────────────────────────────────────────────────────────────

type rmNoiseSession struct {
	jar       http.CookieJar
	createdAt time.Time
}

var rmNoiseSessions sync.Map

func init() {
	go rmNoiseSessionCleanup()
}

func rmNoiseSessionCleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	for range ticker.C {
		now := time.Now()
		rmNoiseSessions.Range(func(k, v any) bool {
			if now.Sub(v.(rmNoiseSession).createdAt) > 10*time.Minute {
				rmNoiseSessions.Delete(k)
			}
			return true
		})
	}
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

// ── Handlers ───────────────────────────────────────────────────────────────────

func handleRMNoiseLogin(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

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

	jar, err := cookiejar.New(&cookiejar.Options{PublicSuffixList: publicsuffix.List})
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, `{"ok":false,"error":"Internal error creating session"}`)
		return
	}

	// Follow redirects (default behaviour), matching the Python client.
	// On successful login rmnoise.com returns 302 → dashboard (200).
	// On failure it returns 200 directly with the login page HTML.
	client := &http.Client{
		Jar:     jar,
		Timeout: 15 * time.Second,
	}

	// Direct POST — no prior GET for CSRF token.
	// The Python client does exactly this and it works.
	formBody := url.Values{}
	formBody.Set("username", req.Username)
	formBody.Set("password", req.Password)

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
	defer resp.Body.Close()

	io.Copy(io.Discard, resp.Body) // drain body; we don't need it

	loginURL, _ := url.Parse("https://rmnoise.com")
	cookies := jar.Cookies(loginURL)
	log.Printf("RMNoise proxy: login HTTP %d, cookies after login (%d): %v",
		resp.StatusCode, len(cookies), cookies)

	// Mirror the Python client exactly: accept any HTTP 200 as login success.
	// rmnoise.com always returns 200 from the login endpoint (even on success),
	// and the session cookie it sets IS the authenticated session — _fresh=false
	// is normal Flask-Login behaviour and does not mean unauthenticated.
	// Real auth failure is detected later when get_webrtc_token returns HTML.
	if resp.StatusCode != http.StatusOK {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"ok":false,"error":"Login failed"}`)
		return
	}

	// Generate a 16-byte hex token
	tokenBytes := make([]byte, 16)
	if _, err := rand.Read(tokenBytes); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		fmt.Fprint(w, `{"ok":false,"error":"Failed to generate session token"}`)
		return
	}
	token := hex.EncodeToString(tokenBytes)

	rmNoiseSessions.Store(token, rmNoiseSession{jar: jar, createdAt: time.Now()})
	log.Printf("RMNoise proxy: login OK, session created (token prefix: %s…), %d cookies stored", token[:8], len(cookies))

	w.WriteHeader(http.StatusOK)
	fmt.Fprintf(w, `{"ok":true,"token":"%s"}`, token)
}

func handleRMNoiseWebRTCToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		fmt.Fprint(w, `{"ok":false,"error":"Method not allowed"}`)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 4096)

	var req struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"ok":false,"error":"Invalid JSON body"}`)
		return
	}

	val, ok := rmNoiseSessions.Load(req.Token)
	if !ok {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"ok":false,"error":"Session expired or invalid"}`)
		return
	}
	sess := val.(rmNoiseSession)

	// Log cookies being sent
	targetURL, _ := url.Parse("https://rmnoise.com")
	cookies := sess.jar.Cookies(targetURL)
	log.Printf("RMNoise proxy: webrtc_token sending %d cookies: %v", len(cookies), cookies)

	client := &http.Client{Jar: sess.jar, Timeout: 15 * time.Second}

	// Match Python client exactly: Content-Type: application/json, no body
	resp, err := rmNoiseOutboundRequest(client, http.MethodPost,
		"https://rmnoise.com/users2/get_webrtc_token",
		"application/json",
		"",
	)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprintf(w, `{"ok":false,"error":"WebRTC token request failed: %s"}`, jsonEscapeString(err.Error()))
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	log.Printf("RMNoise proxy: webrtc_token HTTP %d, body: %.200s", resp.StatusCode, string(body))

	// Never forward HTML to the client — it means the session is not authenticated
	if isHTMLResponse(resp, body) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"ok":false,"error":"Session not authenticated — please log in again"}`)
		return
	}

	w.WriteHeader(resp.StatusCode)
	w.Write(body)
}

func handleRMNoiseTURNCreds(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")

	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		fmt.Fprint(w, `{"ok":false,"error":"Method not allowed"}`)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 4096)

	var req struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"ok":false,"error":"Invalid JSON body"}`)
		return
	}

	val, ok := rmNoiseSessions.Load(req.Token)
	if !ok {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"ok":false,"error":"Session expired or invalid"}`)
		return
	}
	sess := val.(rmNoiseSession)

	client := &http.Client{Jar: sess.jar, Timeout: 15 * time.Second}

	// Match Python client exactly: Content-Type: application/json, no body
	resp, err := rmNoiseOutboundRequest(client, http.MethodPost,
		"https://rmnoise.com/users2/get_turn_credentials",
		"application/json",
		"",
	)
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprintf(w, `{"ok":false,"error":"TURN credentials request failed: %s"}`, jsonEscapeString(err.Error()))
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	log.Printf("RMNoise proxy: turn_creds HTTP %d, body: %.200s", resp.StatusCode, string(body))

	// Never forward HTML to the client — it means the session is not authenticated
	if isHTMLResponse(resp, body) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"ok":false,"error":"Session not authenticated — please log in again"}`)
		return
	}

	w.WriteHeader(resp.StatusCode)
	w.Write(body)
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
