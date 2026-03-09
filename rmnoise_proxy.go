package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"net/http/cookiejar"

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
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
	req.Header.Set("Origin", "https://rmnoise.com")
	req.Header.Set("Referer", "https://rmnoise.com/")
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

	// Use a no-redirect client for login so we capture Set-Cookie from the
	// login response directly (before any redirect strips it).
	noRedirectClient := &http.Client{
		Jar:     jar,
		Timeout: 15 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse // do not follow redirects
		},
	}

	formBody := url.Values{}
	formBody.Set("username", req.Username)
	formBody.Set("password", req.Password)

	resp, err := rmNoiseOutboundRequest(noRedirectClient, http.MethodPost,
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

	// Read and log the login response body for debugging
	loginBody, _ := io.ReadAll(resp.Body)
	log.Printf("RMNoise proxy: login HTTP %d, Set-Cookie: %v, body: %.200s",
		resp.StatusCode, resp.Header["Set-Cookie"], string(loginBody))

	// Log cookies stored in jar after login
	loginURL, _ := url.Parse("https://rmnoise.com")
	cookies := jar.Cookies(loginURL)
	log.Printf("RMNoise proxy: cookies after login (%d): %v", len(cookies), cookies)

	// Accept 200 or 302 (redirect after successful login) as success
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusFound && resp.StatusCode != http.StatusSeeOther {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprintf(w, `{"ok":false,"error":"Login failed: HTTP %d — %s"}`, resp.StatusCode, jsonEscapeString(string(loginBody)))
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

	w.WriteHeader(resp.StatusCode)
	w.Write(body)
}

// ── Utility ────────────────────────────────────────────────────────────────────

// jsonEscapeString escapes a string for safe embedding in a JSON string literal.
func jsonEscapeString(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return "internal error"
	}
	// json.Marshal wraps in quotes; strip them
	return string(b[1 : len(b)-1])
}
