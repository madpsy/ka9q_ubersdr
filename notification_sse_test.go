package main

import (
	"bufio"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// newTestSSEStream returns an isolated stream so tests never touch the
// package-level singleton (which the HTTP handler takes as a parameter).
func newTestSSEStream() *notificationSSEStream {
	return &notificationSSEStream{
		clients:    make(map[*notificationSSEClient]struct{}),
		heartbeat:  defaultSSEHeartbeatSeconds * time.Second,
		maxClients: defaultSSEMaxClients,
	}
}

func TestValidateSSEPassword(t *testing.T) {
	tests := []struct {
		name    string
		pw      string
		wantErr bool
	}{
		{"empty", "", true},
		{"eleven alphanumerics", "abcdefghij1", true},
		{"twelve alphanumerics", "abcdefghij12", false},
		{"letters only", "abcdefghijklmnop", true},
		{"digits only", "123456789012", true},
		{"unreserved punctuation does not count towards the minimum", "abcdefghij1-._~", true},
		{"unreserved punctuation allowed alongside twelve alphanumerics", "abcdefghijk1-._~", false},
		{"space rejected", "abcdefghij12 x", true},
		{"percent rejected", "abcdefghij12%x", true},
		{"generated-style password", "k7RqmVxpLdTn6Ywb2QfH4jSc", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := validateSSEPassword(tc.pw)
			if tc.wantErr && got == "" {
				t.Errorf("validateSSEPassword(%q) = accepted, want rejected", tc.pw)
			}
			if !tc.wantErr && got != "" {
				t.Errorf("validateSSEPassword(%q) = %q, want accepted", tc.pw, got)
			}
		})
	}
}

func TestGenerateSSEPasswordMeetsPolicy(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 50; i++ {
		pw, err := generateSSEPassword()
		if err != nil {
			t.Fatalf("generateSSEPassword: %v", err)
		}
		if reason := validateSSEPassword(pw); reason != "" {
			t.Fatalf("generated password %q violates the policy: %s", pw, reason)
		}
		if seen[pw] {
			t.Fatalf("generateSSEPassword returned a duplicate: %q", pw)
		}
		seen[pw] = true
	}
}

func TestSSEChannelValidation(t *testing.T) {
	tests := []struct {
		name        string
		channelName string
		cfg         NotificationChannelConfig
		wantIssue   string
	}{
		{
			name:        "valid",
			channelName: sseChannelName,
			cfg:         NotificationChannelConfig{Type: "sse", SSEPassword: "abcdefghij12"},
		},
		{
			name:        "wrong name",
			channelName: "my_stream",
			cfg:         NotificationChannelConfig{Type: "sse", SSEPassword: "abcdefghij12"},
			wantIssue:   "must be named",
		},
		{
			name:        "weak password",
			channelName: sseChannelName,
			cfg:         NotificationChannelConfig{Type: "sse", SSEPassword: "short1"},
			wantIssue:   "sse_password",
		},
		{
			name:        "heartbeat out of range",
			channelName: sseChannelName,
			cfg:         NotificationChannelConfig{Type: "sse", SSEPassword: "abcdefghij12", SSEHeartbeatSeconds: 1},
			wantIssue:   "sse_heartbeat_seconds",
		},
		{
			name:        "too many clients",
			channelName: sseChannelName,
			cfg:         NotificationChannelConfig{Type: "sse", SSEPassword: "abcdefghij12", SSEMaxClients: 5000},
			wantIssue:   "sse_max_clients",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := &NotificationsConfig{
				Enabled:  true,
				Channels: map[string]NotificationChannelConfig{tc.channelName: tc.cfg},
			}
			issues := cfg.Validate()
			if tc.wantIssue == "" {
				if len(issues) > 0 {
					t.Fatalf("expected no issues, got %v", issues)
				}
				return
			}
			for _, issue := range issues {
				if strings.Contains(issue, tc.wantIssue) {
					return
				}
			}
			t.Fatalf("expected an issue mentioning %q, got %v", tc.wantIssue, issues)
		})
	}
}

func TestSSEStreamBroadcastAndEviction(t *testing.T) {
	stream := newTestSSEStream()
	stream.activate(NotificationChannelConfig{Type: "sse", SSEPassword: "abcdefghij12"})

	client := &notificationSSEClient{ch: make(chan string, 4), closed: make(chan struct{})}
	if !stream.register(client) {
		t.Fatal("register: refused an initial subscriber")
	}

	if n := stream.broadcast("hello", "dx_spot", "My rule"); n != 1 {
		t.Fatalf("broadcast delivered to %d subscribers, want 1", n)
	}

	select {
	case frame := <-client.ch:
		for _, want := range []string{"event: notification", `"message":"hello"`, `"event":"dx_spot"`, `"rule":"My rule"`} {
			if !strings.Contains(frame, want) {
				t.Errorf("frame %q missing %q", frame, want)
			}
		}
	default:
		t.Fatal("no frame delivered to the subscriber")
	}

	// A rotated password must invalidate sessions opened with the old one.
	stream.activate(NotificationChannelConfig{Type: "sse", SSEPassword: "zyxwvutsrq98"})
	select {
	case <-client.closed:
	default:
		t.Fatal("changing the password did not disconnect the existing subscriber")
	}
	if stream.authorise("abcdefghij12") {
		t.Error("the old password still authorises after rotation")
	}
	if !stream.authorise("zyxwvutsrq98") {
		t.Error("the new password does not authorise")
	}

	// Deactivating stops authorising entirely.
	stream.deactivate()
	if stream.authorise("zyxwvutsrq98") {
		t.Error("a deactivated stream still authorises")
	}
	if stream.IsActive() {
		t.Error("IsActive is true after deactivate")
	}
}

func TestSSEStreamSlowSubscriberIsSkippedNotBlocked(t *testing.T) {
	stream := newTestSSEStream()
	stream.activate(NotificationChannelConfig{Type: "sse", SSEPassword: "abcdefghij12"})

	// A subscriber with a full queue must never stall the publisher.
	client := &notificationSSEClient{ch: make(chan string, 1), closed: make(chan struct{})}
	if !stream.register(client) {
		t.Fatal("register: refused subscriber")
	}
	stream.broadcast("first", "", "")
	stream.broadcast("second", "", "")

	if got := client.dropped.Load(); got != 1 {
		t.Errorf("dropped = %d, want 1", got)
	}
	if got := stream.totalSent.Load(); got != 2 {
		t.Errorf("totalSent = %d, want 2", got)
	}
}

func TestSSEStreamMaxClients(t *testing.T) {
	stream := newTestSSEStream()
	stream.activate(NotificationChannelConfig{Type: "sse", SSEPassword: "abcdefghij12", SSEMaxClients: 1})

	first := &notificationSSEClient{ch: make(chan string, 1), closed: make(chan struct{})}
	second := &notificationSSEClient{ch: make(chan string, 1), closed: make(chan struct{})}
	if !stream.register(first) {
		t.Fatal("first subscriber refused")
	}
	if stream.register(second) {
		t.Fatal("second subscriber accepted despite sse_max_clients=1")
	}
	stream.unregister(first)
	if !stream.register(second) {
		t.Fatal("subscriber refused after a slot was freed")
	}
}

func TestHandleNotificationStreamAuth(t *testing.T) {
	stream := newTestSSEStream()
	handler := HandleNotificationStream(stream, NewSSEIPLimiter(4), &ServerConfig{})

	// Inactive stream: 503 regardless of credentials.
	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(http.MethodGet, sseStreamPath+"?password=abcdefghij12", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("inactive stream returned %d, want 503", rec.Code)
	}

	stream.activate(NotificationChannelConfig{Type: "sse", SSEPassword: "abcdefghij12"})

	// Wrong password and missing password are both rejected.
	for _, target := range []string{sseStreamPath, sseStreamPath + "?password=wrongpassword1"} {
		rec = httptest.NewRecorder()
		handler(rec, httptest.NewRequest(http.MethodGet, target, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("GET %s returned %d, want 401", target, rec.Code)
		}
	}
}

func TestHandleNotificationStreamDelivers(t *testing.T) {
	stream := newTestSSEStream()
	stream.activate(NotificationChannelConfig{
		Type:                "sse",
		SSEPassword:         "abcdefghij12",
		SSEHeartbeatSeconds: minSSEHeartbeatSeconds,
	})

	srv := httptest.NewServer(HandleNotificationStream(stream, NewSSEIPLimiter(4), &ServerConfig{}))
	defer srv.Close()

	// The Authorization header is the documented alternative to the query
	// parameter — exercise that path rather than the one already covered above.
	req, err := http.NewRequest(http.MethodGet, srv.URL+sseStreamPath, nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer abcdefghij12")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q, want text/event-stream", ct)
	}

	// Wait for the handler to register the subscriber before publishing.
	deadline := time.Now().Add(2 * time.Second)
	for stream.ClientCount() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if stream.ClientCount() != 1 {
		t.Fatalf("ClientCount = %d, want 1", stream.ClientCount())
	}

	stream.broadcast("station spotted", "dx_spot", "DX alert")

	reader := bufio.NewReader(resp.Body)
	var payload string
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if strings.HasPrefix(line, "data: {") && strings.Contains(line, "station spotted") {
			payload = line
			break
		}
	}
	if payload == "" {
		t.Fatal("did not receive the published notification")
	}
	for _, want := range []string{`"channel":"` + sseChannelName + `"`, `"event":"dx_spot"`, `"rule":"DX alert"`} {
		if !strings.Contains(payload, want) {
			t.Errorf("payload %q missing %q", payload, want)
		}
	}

	// A heartbeat must follow on an idle connection so subscribers can tell
	// "no alerts" from a dead connection.
	var heartbeat string
	for deadline := time.Now().Add(time.Duration(minSSEHeartbeatSeconds+3) * time.Second); time.Now().Before(deadline); {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if strings.HasPrefix(line, "event: heartbeat") {
			heartbeat = line
			break
		}
	}
	if heartbeat == "" {
		t.Fatal("no heartbeat received on an idle connection")
	}
}

func TestSSEAuthThrottle(t *testing.T) {
	throttle := &sseAuthThrottle{entries: make(map[string][]time.Time)}
	const ip = "203.0.113.7"

	for i := 0; i < sseAuthMaxFailures-1; i++ {
		throttle.fail(ip)
		if throttle.blocked(ip) {
			t.Fatalf("blocked after %d failures, want block only at %d", i+1, sseAuthMaxFailures)
		}
	}
	throttle.fail(ip)
	if !throttle.blocked(ip) {
		t.Fatalf("not blocked after %d failures", sseAuthMaxFailures)
	}
	// A different IP is unaffected, and a success clears the record.
	if throttle.blocked("198.51.100.4") {
		t.Error("an unrelated IP was blocked")
	}
	throttle.succeed(ip)
	if throttle.blocked(ip) {
		t.Error("still blocked after a successful authentication")
	}
}

func TestSyncSSEStreamDeactivatesWhenChannelRemoved(t *testing.T) {
	// syncSSEStream operates on the package singleton; leave it inactive after.
	defer notificationSSE.deactivate()

	notificationSSE.activate(NotificationChannelConfig{Type: "sse", SSEPassword: "abcdefghij12"})

	cfg := &NotificationsConfig{
		Enabled: true,
		Channels: map[string]NotificationChannelConfig{
			sseChannelName: {Type: "sse", SSEPassword: "abcdefghij12"},
		},
	}
	syncSSEStream(cfg)
	if !notificationSSE.IsActive() {
		t.Fatal("stream deactivated while still present in the config")
	}

	syncSSEStream(&NotificationsConfig{Enabled: true, Channels: map[string]NotificationChannelConfig{}})
	if notificationSSE.IsActive() {
		t.Fatal("stream still active after its channel was removed")
	}

	// Notifications disabled as a whole must also stop the stream.
	notificationSSE.activate(NotificationChannelConfig{Type: "sse", SSEPassword: "abcdefghij12"})
	syncSSEStream(&NotificationsConfig{Enabled: false, Channels: cfg.Channels})
	if notificationSSE.IsActive() {
		t.Fatal("stream still active while notifications are disabled")
	}
}
