package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// A timed-out QRZ request must not leak the session key or credentials that
// ride in the query string.
func TestQRZTransportErrorRedactsQuery(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-block
	}))
	defer srv.Close()
	defer close(block)

	client := &http.Client{Timeout: 50 * time.Millisecond}
	_, err := client.Get(srv.URL + "/?s=SECRETKEY&username=ME&password=HUNTER2")
	if err == nil {
		t.Fatal("expected timeout")
	}
	if !strings.Contains(err.Error(), "SECRETKEY") {
		t.Fatalf("precondition: raw error should contain the URL, got %q", err)
	}

	red := qrzTransportError(err)
	for _, secret := range []string{"SECRETKEY", "HUNTER2", "username", srv.URL} {
		if strings.Contains(red.Error(), secret) {
			t.Errorf("redacted error leaks %q: %q", secret, red)
		}
	}
	if !errors.Is(red, context.DeadlineExceeded) && !strings.Contains(red.Error(), "Client.Timeout") {
		t.Errorf("cause lost: %q", red)
	}
}

func TestQRZTransportErrorNested(t *testing.T) {
	inner := &url.Error{Op: "Get", URL: "https://x/?s=INNER", Err: errors.New("boom")}
	outer := &url.Error{Op: "Get", URL: "https://x/?s=OUTER", Err: inner}
	got := qrzTransportError(outer).Error()
	if strings.Contains(got, "INNER") || strings.Contains(got, "OUTER") || !strings.Contains(got, "boom") {
		t.Errorf("got %q", got)
	}
	if got := qrzTransportError(errors.New("s=RAW")).Error(); strings.Contains(got, "RAW") {
		t.Errorf("non-url error passed through: %q", got)
	}
}

// Secrets the fake QRZ hands out or is handed; none may appear in any error,
// HTTP response or log line.
const (
	leakTestUser     = "LEAKUSER"
	leakTestPassword = "LEAKPASSWORD"
	leakTestKey      = "LEAKSESSIONKEY"
)

// fakeQRZTransport answers the login request (when loginOK) and fails every
// other request at the transport level, as a QRZ timeout would.  http.Client
// wraps that failure in a *url.Error carrying the full query string.
type fakeQRZTransport struct{ loginOK bool }

func (f fakeQRZTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if f.loginOK && r.URL.Query().Get("password") != "" {
		body := `<?xml version="1.0"?><QRZDatabase xmlns="http://xmldata.qrz.com"><Session><Key>` +
			leakTestKey + `</Key><SubExp>never</SubExp></Session></QRZDatabase>`
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader(body)),
			Header:     make(http.Header),
			Request:    r,
		}, nil
	}
	return nil, context.DeadlineExceeded
}

func assertNoQRZSecrets(t *testing.T, where, s string) {
	t.Helper()
	for _, secret := range []string{leakTestUser, leakTestPassword, leakTestKey, "password=", "?s=", "&s="} {
		if strings.Contains(s, secret) {
			t.Errorf("%s leaks %q: %s", where, secret, s)
		}
	}
}

func newLeakTestQRZService(loginOK bool) *QRZService {
	s := NewQRZService(QRZConfig{Username: leakTestUser, Password: leakTestPassword}, 100)
	s.httpClient.Transport = fakeQRZTransport{loginOK: loginOK}
	return s
}

// Every QRZ request path — login, lookup, and the admin credential test —
// must keep the session key and the account credentials out of its errors.
func TestQRZErrorsNeverLeakSecrets(t *testing.T) {
	logs := captureLog(t)

	t.Run("login fails", func(t *testing.T) {
		_, err := newLeakTestQRZService(false).LookupFrom(qrzSourceAPI, "F6DQV")
		if err == nil {
			t.Fatal("expected error")
		}
		assertNoQRZSecrets(t, "login error", err.Error())
	})

	t.Run("lookup fails after login", func(t *testing.T) {
		s := newLeakTestQRZService(true)
		_, err := s.LookupFrom(qrzSourceAPI, "F6DQV")
		if err == nil {
			t.Fatal("expected error")
		}
		if s.sessionKey != leakTestKey {
			t.Fatalf("precondition: login should have stored the key, got %q", s.sessionKey)
		}
		assertNoQRZSecrets(t, "lookup error", err.Error())
	})

	t.Run("admin credential test", func(t *testing.T) {
		prev := http.DefaultTransport
		http.DefaultTransport = fakeQRZTransport{}
		defer func() { http.DefaultTransport = prev }()

		_, err := testQRZCredentials(leakTestUser, leakTestPassword)
		if err == nil {
			t.Fatal("expected error")
		}
		assertNoQRZSecrets(t, "credential test error", err.Error())
	})

	assertNoQRZSecrets(t, "log", logs.String())
}

// /api/lookup must not hand upstream error detail to the caller.
func TestLookupAPIErrorNeverLeaksSecrets(t *testing.T) {
	logs := captureLog(t)

	prev := globalQRZService
	globalQRZService = newLeakTestQRZService(true)
	defer func() { globalQRZService = prev }()

	// A trusted container avoids needing a live audio session.
	cfg := &Config{}
	cfg.LookupServices.Enabled = true
	cfg.LookupServices.Provider = "qrz"
	cfg.LookupServices.TrustedContainers = []string{"dxcluster"}
	cfg.Server.containerNameByIP = map[string]string{"172.20.0.10": "dxcluster"}

	req := httptest.NewRequest(http.MethodGet, "/api/lookup?callsign=F6DQV", nil)
	req.RemoteAddr = "172.20.0.10:40000"
	rec := httptest.NewRecorder()
	handleLookup(rec, req, cfg, nil, nil, nil, nil)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status %d, want 502; body %s", rec.Code, rec.Body)
	}
	body := rec.Body.String()
	assertNoQRZSecrets(t, "response", body)
	if strings.Contains(body, "xmldata.qrz.com") || strings.Contains(body, "deadline") {
		t.Errorf("response carries upstream detail: %s", body)
	}
	assertNoQRZSecrets(t, "log", logs.String())
}
