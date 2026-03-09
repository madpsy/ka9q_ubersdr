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
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/publicsuffix"
)

// csrfTokenRe extracts the CSRF token from a Flask-WTF login form.
// Matches: <input ... name="csrf_token" ... value="TOKEN" ...>
var csrfTokenRe = regexp.MustCompile(`name="csrf_token"[^>]*value="([^"]+)"`)

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

	// No-redirect client: we stop at each response to capture Set-Cookie headers
	// before any redirect discards them, and to read the CSRF token from the login page.
	noRedirectClient := &http.Client{
		Jar:     jar,
		Timeout: 15 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	// ── Step 1: GET the login page to obtain the CSRF token and session cookie ──
	getResp, err := rmNoiseOutboundRequest(noRedirectClient, http.MethodGet,
		"https://rmnoise.com/users2/login", "", "")
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprintf(w, `{"ok":false,"error":"Login page fetch failed: %s"}`, jsonEscapeString(err.Error()))
		return
	}
	getBody, _ := io.ReadAll(getResp.Body)
	getResp.Body.Close()
	log.Printf("RMNoise proxy: GET login HTTP %d, Set-Cookie: %v", getResp.StatusCode, getResp.Header["Set-Cookie"])

	// Extract CSRF token from the login form HTML
	csrfToken := ""
	if m := csrfTokenRe.FindSubmatch(getBody); len(m) == 2 {
		csrfToken = string(m[1])
	}
	// Also try value-first attribute order: value="TOKEN" ... name="csrf_token"
	if csrfToken == "" {
		altRe := regexp.MustCompile(`value="([^"]+)"[^>]*name="csrf_token"`)
		if m := altRe.FindSubmatch(getBody); len(m) == 2 {
			csrfToken = string(m[1])
		}
	}
	log.Printf("RMNoise proxy: CSRF token: %.20s…", csrfToken)

	// ── Step 2: POST credentials (+ CSRF token) to log in ──
	formBody := url.Values{}
	formBody.Set("username", req.Username)
	formBody.Set("password", req.Password)
	if csrfToken != "" {
		formBody.Set("csrf_token", csrfToken)
	}

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
	log.Printf("RMNoise proxy: POST login HTTP %d, Set-Cookie: %v, body: %.200s",
		resp.StatusCode, resp.Header["Set-Cookie"], string(loginBody))

	// Log cookies stored in jar after login
	loginURL, _ := url.Parse("https://rmnoise.com")
	cookies := jar.Cookies(loginURL)
	log.Printf("RMNoise proxy: cookies after login (%d): %v", len(cookies), cookies)

	// rmnoise.com returns HTTP 302 on successful login, 200+login-page on failure.
	loginBodyStr := string(loginBody)
	loginFailed := false
	switch resp.StatusCode {
	case http.StatusFound, http.StatusSeeOther:
		// 302/303 redirect = successful login (standard Flask-Login pattern)
		loginFailed = false
	case http.StatusOK:
		// 200 with login page HTML = bad credentials
		if strings.Contains(loginBodyStr, "<title>Login</title>") ||
			strings.Contains(loginBodyStr, "Invalid username or password") ||
			strings.Contains(loginBodyStr, "action=\"/users2/login\"") {
			loginFailed = true
		}
	default:
		loginFailed = true
	}

	if loginFailed {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"ok":false,"error":"Invalid username or password"}`)
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
