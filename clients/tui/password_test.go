package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

// The three answers a receiver can give to a password, reproduced exactly as
// the server produces them (handleConnectionCheck in the repository root).
//
// Testing them here rather than against a live receiver is deliberate: sending
// a guessed password to somebody else's instance is a login attempt on their
// system, and the one case that can be checked live — a wrong password against
// a receiver known to have one — is.
func connectionStub(t *testing.T, bypassPassword string, bypassedIP bool) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Password string `json:"password"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		w.Header().Set("Content-Type", "application/json")

		// A password that does not match one the receiver has is refused
		// outright, before anything else is decided.
		if req.Password != "" && bypassPassword != "" && req.Password != bypassPassword {
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"allowed": false, "reason": "Invalid bypass password", "bypassed": false,
			})
			return
		}
		// Otherwise the bypass is granted by a matching password OR by the
		// address being on the operator's list.
		bypassed := bypassedIP || (req.Password != "" && req.Password == bypassPassword)
		resp := map[string]interface{}{"allowed": true, "bypassed": bypassed}
		if bypassed {
			resp["allowed_iq_modes"] = []string{"iq48", "iq96", "iq192", "iq384"}
		} else {
			resp["max_session_time"] = 900
		}
		json.NewEncoder(w).Encode(resp)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func stubClient(t *testing.T, srv *httptest.Server, password string) *Client {
	t.Helper()
	c, err := NewClient(strings.TrimPrefix(srv.URL, "http://"), false, password)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// A password that does not match is a startup error, not something to discover
// later from a session that will not open a socket.
func TestWrongPasswordIsRefused(t *testing.T) {
	srv := connectionStub(t, "correcthorse", false)
	c := stubClient(t, srv, "wrong")

	err := c.CheckConnection()
	if err == nil {
		t.Fatal("a wrong password was accepted")
	}
	// The receiver's own words, plus which side needs fixing: the server
	// refuses a wrong password and a missing one with the same status, so its
	// message alone does not say.
	if !strings.Contains(err.Error(), "Invalid bypass password") {
		t.Errorf("the receiver's reason was lost: %v", err)
	}
	if !strings.Contains(err.Error(), "-password") {
		t.Errorf("nothing points at the flag that needs fixing: %v", err)
	}
	if c.PasswordState() != PasswordNone && c.Bypassed() {
		t.Error("a refused check left the session looking bypassed")
	}
}

// The right password lifts the session limits and opens the wide IQ modes,
// which is the whole reason for having one.
func TestRightPasswordIsAccepted(t *testing.T) {
	srv := connectionStub(t, "correcthorse", false)
	c := stubClient(t, srv, "correcthorse")

	if err := c.CheckConnection(); err != nil {
		t.Fatalf("the right password was refused: %v", err)
	}
	if !c.Bypassed() {
		t.Error("the right password did not grant the bypass")
	}
	if got := c.PasswordState(); got != PasswordAccepted {
		t.Errorf("password state %v, want accepted", got)
	}
	if note := c.PasswordState().Note("rx"); !strings.Contains(note, "accepted") {
		t.Errorf("nothing said the password worked: %q", note)
	}
	if c.SessionLimit() != 0 {
		t.Errorf("a bypassed session is limited to %v", c.SessionLimit())
	}
	if len(c.AllowedIQModes()) != 4 {
		t.Errorf("a bypassed session was offered %v", c.AllowedIQModes())
	}
}

// A receiver with no bypass password configured allows the session and grants
// nothing. The password was not wrong — there was nothing for it to unlock —
// and saying so beats leaving the user to work out why the wide IQ modes are
// missing from a session they thought was privileged.
func TestPasswordWithNothingToUnlock(t *testing.T) {
	srv := connectionStub(t, "", false)
	c := stubClient(t, srv, "anything")

	if err := c.CheckConnection(); err != nil {
		t.Fatalf("a receiver with no bypass password refused the session: %v", err)
	}
	if c.Bypassed() {
		t.Error("a receiver with no bypass password granted one")
	}
	if got := c.PasswordState(); got != PasswordIgnored {
		t.Errorf("password state %v, want ignored", got)
	}
	note := c.PasswordState().Note("rx.example")
	if !strings.Contains(note, "no effect") || !strings.Contains(note, "rx.example") {
		t.Errorf("unhelpful message %q", note)
	}
}

// The bypass also comes from the address being on the operator's list, which is
// indistinguishable from a working password and makes no difference to what
// follows — so it must not be reported as a password problem.
func TestBypassedAddressWithoutAPassword(t *testing.T) {
	srv := connectionStub(t, "correcthorse", true)

	c := stubClient(t, srv, "")
	if err := c.CheckConnection(); err != nil {
		t.Fatal(err)
	}
	if !c.Bypassed() {
		t.Error("a listed address was not bypassed")
	}
	if got := c.PasswordState(); got != PasswordNone {
		t.Errorf("password state %v with no password given, want none", got)
	}
	if note := c.PasswordState().Note("rx"); note != "" {
		t.Errorf("said %q about a password nobody gave", note)
	}

	// And with one, which the receiver also accepts: the two together are
	// still just "bypassed".
	c2 := stubClient(t, srv, "correcthorse")
	if err := c2.CheckConnection(); err != nil {
		t.Fatal(err)
	}
	if c2.PasswordState() != PasswordAccepted {
		t.Errorf("password state %v, want accepted", c2.PasswordState())
	}
}

// A receiver that requires a password refuses a session that gives none, with
// the same status as a wrong one — so the message has to say which it was.
func TestReceiverThatDemandsAPassword(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"allowed": false, "reason": "This receiver requires a password to access",
		})
	}))
	t.Cleanup(srv.Close)

	err := stubClient(t, srv, "").CheckConnection()
	if err == nil {
		t.Fatal("a receiver demanding a password let a session in without one")
	}
	if !strings.Contains(err.Error(), "give one with -password") {
		t.Errorf("nothing says how to answer it: %v", err)
	}
}

// The password reaches every socket the session opens, not just the handshake:
// the server binds the UUID to what /connection was called with, and the wide
// IQ modes are re-checked at the audio socket.
func TestPasswordReachesTheAudioSocket(t *testing.T) {
	q := connectQuery(t, func(a *AudioClient) {})
	if got := q.Get("password"); got != "" {
		t.Errorf("a session with no password sent password=%q", got)
	}

	if got := connectQueryWith(t, "correcthorse").Get("password"); got != "correcthorse" {
		t.Errorf("the audio socket sent password=%q, want it carried through", got)
	}
}

// The spectrum socket carries it too. The server binds the session UUID to what
// /connection was called with and re-checks the bypass at each socket, so a
// password that reached the handshake and nothing else would open a privileged
// session that then behaved like a public one.
func TestPasswordReachesTheSpectrumSocket(t *testing.T) {
	seen := make(chan url.Values, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case seen <- r.URL.Query():
		default:
		}
		http.Error(w, "no", http.StatusForbidden)
	}))
	t.Cleanup(srv.Close)

	c := stubClient(t, srv, "correcthorse")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go c.Run(ctx, 14_074_000, 0)

	select {
	case q := <-seen:
		if got := q.Get("password"); got != "correcthorse" {
			t.Errorf("the spectrum socket sent password=%q, want it carried through", got)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the spectrum client never connected")
	}
}
