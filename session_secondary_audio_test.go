package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"gopkg.in/yaml.v3"
)

// Simultaneous VFOs: see session_secondary_audio.go.

const (
	vfoTestIP   = "203.0.113.7" // a real-looking, never-bypassed listener
	vfoTestUser = "11111111-1111-4111-8111-111111111111"
	vfoTestPW   = "letmein"
)

func newVFOTestManager(t *testing.T, audioVFOs int) *SessionManager {
	t.Helper()
	cfg := &Config{}
	cfg.Audio.DefaultSampleRate = 12000
	cfg.Server.MaxSessions = 100
	cfg.Server.AudioVFOs = audioVFOs
	cfg.Server.BypassPassword = vfoTestPW
	// Long enough that the background idle sweep never fires on its own; the
	// idle test sets a session's LastActive back past it instead.
	cfg.Server.SessionTimeout = 60
	return NewSessionManager(cfg, &stubRadiod{}, nil)
}

func mustPrimary(t *testing.T, sm *SessionManager, uuid string, freq uint64) *Session {
	t.Helper()
	s, err := sm.CreateSessionWithBandwidthAndPassword(freq, "usb", 3000, vfoTestIP, vfoTestIP, uuid, "")
	if err != nil {
		t.Fatalf("primary for %s: %v", uuid, err)
	}
	return s
}

func mustSecondary(t *testing.T, sm *SessionManager, uuid string, freq uint64, vfo int) *Session {
	t.Helper()
	s, err := sm.CreateSecondaryAudioSession(freq, "usb", 3000, vfoTestIP, vfoTestIP, uuid, "", vfo)
	if err != nil {
		t.Fatalf("secondary %d for %s: %v", vfo, uuid, err)
	}
	return s
}

func sessionAlive(sm *SessionManager, id string) bool {
	_, ok := sm.GetSession(id)
	return ok
}

func TestSecondaryRefusedWithoutPrimary(t *testing.T) {
	sm := newVFOTestManager(t, 4)
	_, err := sm.CreateSecondaryAudioSession(7100000, "usb", 3000, vfoTestIP, vfoTestIP, vfoTestUser, "", 1)
	if err != errSecondaryNoPrimary {
		t.Fatalf("secondary with no primary: err = %v, want errSecondaryNoPrimary", err)
	}
	if n := sm.GetSessionCount(); n != 0 {
		t.Errorf("a refused secondary left %d sessions behind", n)
	}
	// A spectrum session is not a primary either.
	if _, err := sm.CreateSpectrumSessionWithUserIDAndPassword(vfoTestIP, vfoTestIP, vfoTestUser, ""); err != nil {
		t.Logf("spectrum session not created (%v); the check below still stands", err)
	}
	if _, err := sm.CreateSecondaryAudioSession(7100000, "usb", 3000, vfoTestIP, vfoTestIP, vfoTestUser, "", 1); err != errSecondaryNoPrimary {
		t.Errorf("secondary with only a spectrum session: err = %v, want errSecondaryNoPrimary", err)
	}
}

func TestSecondarySameIndexReplacesOnlyThatIndex(t *testing.T) {
	sm := newVFOTestManager(t, 4)
	p := mustPrimary(t, sm, vfoTestUser, 7100000)
	a1 := mustSecondary(t, sm, vfoTestUser, 7150000, 1)
	a2 := mustSecondary(t, sm, vfoTestUser, 7200000, 2)

	b1 := mustSecondary(t, sm, vfoTestUser, 7160000, 1)

	if sessionAlive(sm, a1.ID) {
		t.Error("the old VFO 1 session survived its replacement")
	}
	for name, s := range map[string]*Session{"primary": p, "VFO 2": a2, "new VFO 1": b1} {
		if !sessionAlive(sm, s.ID) {
			t.Errorf("%s was torn down by a VFO 1 reconnect", name)
		}
	}
	if got := sm.uuidAudioSessions[vfoTestUser]; got != p.ID {
		t.Errorf("uuidAudioSessions = %s, want the primary %s", got, p.ID)
	}
	if got := sm.uuidSecondaryAudio[vfoTestUser][1]; got != b1.ID {
		t.Errorf("VFO 1 is tracked as %s, want %s", got, b1.ID)
	}
	if !b1.IsSecondary || b1.VFO != 1 || p.IsSecondary || p.VFO != 0 {
		t.Errorf("flags: primary (%v,%d) secondary (%v,%d)", p.IsSecondary, p.VFO, b1.IsSecondary, b1.VFO)
	}
}

// A primary reconnect destroys the old primary; that must not cascade.
func TestPrimaryReconnectKeepsSecondaries(t *testing.T) {
	sm := newVFOTestManager(t, 4)
	old := mustPrimary(t, sm, vfoTestUser, 7100000)
	s1 := mustSecondary(t, sm, vfoTestUser, 7150000, 1)
	s3 := mustSecondary(t, sm, vfoTestUser, 7250000, 3)

	fresh := mustPrimary(t, sm, vfoTestUser, 7100000)

	if sessionAlive(sm, old.ID) {
		t.Error("the old primary survived the reconnect")
	}
	if !sessionAlive(sm, fresh.ID) || !sessionAlive(sm, s1.ID) || !sessionAlive(sm, s3.ID) {
		t.Fatal("a primary reconnect took a secondary (or itself) down")
	}
	// And the reaper leaves them be: the UUID has a primary.
	sm.reapOrphanedSecondariesAt(time.Now().Add(time.Hour))
	if !sessionAlive(sm, s1.ID) || !sessionAlive(sm, s3.ID) {
		t.Error("the orphan reaper took secondaries whose UUID has a primary")
	}
}

func TestOrphanedSecondariesReapedAfterGrace(t *testing.T) {
	sm := newVFOTestManager(t, 4)
	p := mustPrimary(t, sm, vfoTestUser, 7100000)
	s1 := mustSecondary(t, sm, vfoTestUser, 7150000, 1)
	s2 := mustSecondary(t, sm, vfoTestUser, 7200000, 2)

	if err := sm.DestroySession(p.ID); err != nil {
		t.Fatal(err)
	}
	if !sessionAlive(sm, s1.ID) || !sessionAlive(sm, s2.ID) {
		t.Fatal("destroying the primary cascaded; secondaries should wait out the grace")
	}

	now := time.Now()
	sm.reapOrphanedSecondariesAt(now)
	sm.reapOrphanedSecondariesAt(now.Add(secondaryOrphanGrace / 2))
	if !sessionAlive(sm, s1.ID) || !sessionAlive(sm, s2.ID) {
		t.Fatal("secondaries reaped inside the grace period")
	}

	sm.reapOrphanedSecondariesAt(now.Add(secondaryOrphanGrace + time.Second))
	if sessionAlive(sm, s1.ID) || sessionAlive(sm, s2.ID) {
		t.Fatal("orphaned secondaries outlived the grace period")
	}
	if _, ok := sm.uuidSecondaryAudio[vfoTestUser]; ok {
		t.Error("uuidSecondaryAudio still has an entry for a UUID with no secondaries")
	}
	if _, ok := sm.secondaryOrphanSince[vfoTestUser]; ok {
		t.Error("secondaryOrphanSince still has an entry for a UUID with no secondaries")
	}
	if n := sm.GetSessionCount(); n != 0 {
		t.Errorf("%d sessions left after the reap", n)
	}
}

// A primary that comes back inside the grace resets the orphan clock.
func TestOrphanClockResetsWhenPrimaryReturns(t *testing.T) {
	sm := newVFOTestManager(t, 4)
	p := mustPrimary(t, sm, vfoTestUser, 7100000)
	s1 := mustSecondary(t, sm, vfoTestUser, 7150000, 1)
	_ = sm.DestroySession(p.ID)

	now := time.Now()
	sm.reapOrphanedSecondariesAt(now)
	mustPrimary(t, sm, vfoTestUser, 7100000)
	sm.reapOrphanedSecondariesAt(now.Add(secondaryOrphanGrace / 2))
	if _, ok := sm.secondaryOrphanSince[vfoTestUser]; ok {
		t.Error("the orphan clock kept running after the primary came back")
	}
	sm.reapOrphanedSecondariesAt(now.Add(secondaryOrphanGrace + time.Second))
	if !sessionAlive(sm, s1.ID) {
		t.Error("a secondary was reaped although its primary had returned")
	}
}

// The client pings its primary and spectrum, never a secondary.  An idle
// secondary must not get the whole UUID kicked.
func TestIdleSweepIgnoresSecondaries(t *testing.T) {
	sm := newVFOTestManager(t, 4)
	p := mustPrimary(t, sm, vfoTestUser, 7100000)
	s1 := mustSecondary(t, sm, vfoTestUser, 7150000, 1)

	stale := time.Now().Add(-10 * time.Minute)
	s1.mu.Lock()
	s1.LastActive = stale
	s1.mu.Unlock()

	sm.cleanupInactiveSessions()
	if sm.IsUUIDKicked(vfoTestUser) {
		t.Fatal("an idle secondary got its UUID kicked")
	}
	if !sessionAlive(sm, p.ID) || !sessionAlive(sm, s1.ID) {
		t.Fatal("the idle sweep tore down a session it should have skipped")
	}

	// Control: an idle primary still does get the UUID kicked, so the test
	// above is exercising the sweep rather than a sweep that does nothing.
	p.mu.Lock()
	p.LastActive = stale
	p.mu.Unlock()
	sm.cleanupInactiveSessions()
	if !sm.IsUUIDKicked(vfoTestUser) {
		t.Fatal("control: an idle primary did not get its UUID kicked")
	}
	if sessionAlive(sm, s1.ID) {
		t.Error("a kick left the UUID's secondary running")
	}
}

// The primary holds the UUID's slot; secondaries are not counted again.
func TestSecondariesDoNotCountAgainstUserLimits(t *testing.T) {
	sm := newVFOTestManager(t, 4)
	sm.config.Server.MaxSessions = 1
	sm.maxSessions = 1
	sm.config.Server.MaxSessionsIP = 1

	mustPrimary(t, sm, vfoTestUser, 7100000)
	mustSecondary(t, sm, vfoTestUser, 7150000, 1)
	mustSecondary(t, sm, vfoTestUser, 7200000, 2)
	mustSecondary(t, sm, vfoTestUser, 7250000, 3)

	if n := sm.GetNonBypassedUserCount(); n != 1 {
		t.Errorf("non-bypassed users = %d, want 1", n)
	}
	if n := sm.GetUniqueUserCount(); n != 1 {
		t.Errorf("unique users = %d, want 1", n)
	}
	if n := len(sm.ipToUUIDs[vfoTestIP]); n != 1 {
		t.Errorf("UUIDs for the IP = %d, want 1", n)
	}
	// The limits still bite for a second user.
	other := "22222222-2222-4222-8222-222222222222"
	if _, err := sm.CreateSessionWithBandwidthAndPassword(7100000, "usb", 3000, vfoTestIP, vfoTestIP, other, ""); err == nil {
		t.Error("a second user was admitted past max_sessions=1")
	}
}

func TestLookupsReturnPrimaryNotSecondary(t *testing.T) {
	sm := newVFOTestManager(t, 4)
	p := mustPrimary(t, sm, vfoTestUser, 7100000)
	for vfo := 1; vfo <= 3; vfo++ {
		mustSecondary(t, sm, vfoTestUser, uint64(7100000+vfo*50000), vfo)
	}

	// Map iteration order is random, so ask enough times to have seen a
	// secondary come first had it been eligible.
	for i := 0; i < 50; i++ {
		if got := sm.findAudioSessionByUserID(vfoTestUser); got == nil || got.ID != p.ID {
			t.Fatalf("findAudioSessionByUserID returned %v, want the primary", got)
		}
		aem := &AudioExtensionManager{sessionManager: sm}
		if got := aem.findAudioSessionByUserID(vfoTestUser); got == nil || got.ID != p.ID {
			t.Fatalf("AudioExtensionManager.findAudioSessionByUserID returned %v, want the primary", got)
		}
		users := sm.GetAudioUsersForViewer("")
		if len(users) != 1 {
			t.Fatalf("GetAudioUsersForViewer listed %d users, want 1", len(users))
		}
		if users[0].FrequencyHz != p.Frequency {
			t.Fatalf("listed frequency %d, want the primary's %d", users[0].FrequencyHz, p.Frequency)
		}
	}
	if !sm.HasActiveAudioSession(vfoTestUser) {
		t.Error("HasActiveAudioSession false with a primary up")
	}
	_ = sm.DestroySession(p.ID)
	if sm.HasActiveAudioSession(vfoTestUser) {
		t.Error("HasActiveAudioSession true with only secondaries left")
	}
	if got := sm.findAudioSessionByUserID(vfoTestUser); got != nil {
		t.Errorf("findAudioSessionByUserID returned secondary %s once the primary was gone", got.ID)
	}

	// The admin view says which is which.
	seen := 0
	for _, info := range sm.GetAllSessionsInfo() {
		if sec, _ := info["is_secondary"].(bool); sec {
			if vfo, _ := info["vfo"].(int); vfo < 1 {
				t.Errorf("secondary listed with vfo %v", info["vfo"])
			}
			seen++
		}
	}
	if seen != 3 {
		t.Errorf("admin info lists %d secondaries, want 3", seen)
	}
}

func TestSecondaryIndexLimit(t *testing.T) {
	sm := newVFOTestManager(t, 2)
	mustPrimary(t, sm, vfoTestUser, 7100000)
	mustSecondary(t, sm, vfoTestUser, 7150000, 1)

	_, err := sm.CreateSecondaryAudioSession(7200000, "usb", 3000, vfoTestIP, vfoTestIP, vfoTestUser, "", 2)
	if err == nil || err.Error() != "This receiver allows 2 VFOs" {
		t.Fatalf("vfo 2 of 2: err = %v, want \"This receiver allows 2 VFOs\"", err)
	}

	// A bypassed listener always gets the maximum, whatever audio_vfos says.
	bp := "33333333-3333-4333-8333-333333333333"
	if _, err := sm.CreateSessionWithBandwidthAndPassword(7100000, "usb", 3000, vfoTestIP, vfoTestIP, bp, vfoTestPW); err != nil {
		t.Fatal(err)
	}
	if _, err := sm.CreateSecondaryAudioSession(7200000, "usb", 3000, vfoTestIP, vfoTestIP, bp, vfoTestPW, 3); err != nil {
		t.Errorf("bypassed vfo 3: %v", err)
	}
	if _, err := sm.CreateSecondaryAudioSession(7200000, "usb", 3000, vfoTestIP, vfoTestIP, bp, vfoTestPW, 4); err == nil ||
		err.Error() != "This receiver allows 4 VFOs" {
		t.Errorf("bypassed vfo 4: err = %v, want \"This receiver allows 4 VFOs\"", err)
	}

	// audio_vfos: 1 turns the feature off.
	off := newVFOTestManager(t, 1)
	mustPrimary(t, off, vfoTestUser, 7100000)
	if _, err := off.CreateSecondaryAudioSession(7150000, "usb", 3000, vfoTestIP, vfoTestIP, vfoTestUser, "", 1); err == nil {
		t.Error("audio_vfos: 1 still admitted a secondary")
	}
}

func TestSecondaryRefusesIQ(t *testing.T) {
	cases := []struct {
		vfo  int
		mode string
		ok   bool
	}{
		{0, "iq", true}, // the primary keeps everything it had
		{0, "usb", true},
		{1, "usb", true},
		{1, "am", true},
		{1, "iq", false},
		{2, "iq96", false},
	}
	for _, c := range cases {
		err := secondaryAudioConnectError(c.vfo, c.mode)
		if (err == nil) != c.ok {
			t.Errorf("vfo=%d mode=%s: err = %v, want ok=%v", c.vfo, c.mode, err, c.ok)
		}
	}

	// And at the session layer, which also guards the IQ case for any caller.
	sm := newVFOTestManager(t, 4)
	mustPrimary(t, sm, vfoTestUser, 7100000)
	if _, err := sm.CreateSecondaryAudioSession(7150000, "iq", 3000, vfoTestIP, vfoTestIP, vfoTestUser, "", 1); err == nil {
		t.Error("an IQ secondary was created")
	}
}

func TestParseAudioVFOParam(t *testing.T) {
	for in, want := range map[string]int{"": 0, "0": 0, "1": 1, "3": 3, "7": 7} {
		got, err := parseAudioVFOParam(in)
		if err != nil || got != want {
			t.Errorf("parseAudioVFOParam(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, bad := range []string{"-1", "x", "1.5", "1x"} {
		if _, err := parseAudioVFOParam(bad); err == nil {
			t.Errorf("parseAudioVFOParam(%q) accepted", bad)
		}
	}
}

// set_dsp is refused on a secondary in handleMessages; that guard reads only
// Session.IsSecondary, so pin what the constructor sets it to.
func TestSecondaryFlagsSetByConstructor(t *testing.T) {
	sm := newVFOTestManager(t, 4)
	p := mustPrimary(t, sm, vfoTestUser, 7100000)
	s := mustSecondary(t, sm, vfoTestUser, 7150000, 2)
	if p.IsSecondary || !s.IsSecondary || s.VFO != 2 {
		t.Errorf("primary.IsSecondary=%v secondary.IsSecondary=%v secondary.VFO=%d", p.IsSecondary, s.IsSecondary, s.VFO)
	}
}

func TestAllowAudioVFOHasPerVFOBuckets(t *testing.T) {
	rlm := NewRateLimiterManager(2)
	for i := 0; i < 2; i++ {
		if !rlm.AllowAudioVFO(vfoTestUser, 0) {
			t.Fatal("primary refused inside its budget")
		}
	}
	if rlm.AllowAudioVFO(vfoTestUser, 0) {
		t.Fatal("primary allowed past its budget")
	}
	// VFO 0 is the same bucket as plain AllowAudio.
	if rlm.AllowAudio(vfoTestUser) {
		t.Error("AllowAudio and AllowAudioVFO(0) are not the same bucket")
	}
	// Each secondary has its own.
	for vfo := 1; vfo <= 3; vfo++ {
		if !rlm.AllowAudioVFO(vfoTestUser, vfo) {
			t.Errorf("VFO %d refused although only the primary's bucket is spent", vfo)
		}
	}
}

func TestClampAudioVFOs(t *testing.T) {
	for in, want := range map[int]int{0: 2, 1: 1, 2: 2, 3: 3, 4: 4, 5: 4, 99: 4, -1: 1} {
		if got := clampAudioVFOs(in); got != want {
			t.Errorf("clampAudioVFOs(%d) = %d, want %d", in, got, want)
		}
	}
	sc := &ServerConfig{AudioVFOs: 1, BypassPassword: vfoTestPW}
	if got := sc.AudioVFOLimit(vfoTestIP, ""); got != 1 {
		t.Errorf("AudioVFOLimit = %d, want 1", got)
	}
	if got := sc.AudioVFOLimit(vfoTestIP, vfoTestPW); got != 4 {
		t.Errorf("bypassed AudioVFOLimit = %d, want 4", got)
	}
}

func TestLoadConfigAudioVFOs(t *testing.T) {
	load := func(set func(server map[string]interface{})) *Config {
		t.Helper()
		src, err := os.ReadFile("config/config.yaml.example")
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]interface{}
		if err := yaml.Unmarshal(src, &m); err != nil {
			t.Fatal(err)
		}
		set(m["server"].(map[string]interface{}))
		out, err := yaml.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(t.TempDir(), "config.yaml")
		if err := os.WriteFile(p, out, 0644); err != nil {
			t.Fatal(err)
		}
		cfg, err := LoadConfig(p)
		if err != nil {
			t.Fatal(err)
		}
		return cfg
	}
	if got := load(func(s map[string]interface{}) { delete(s, "audio_vfos") }).Server.AudioVFOs; got != 2 {
		t.Errorf("unset audio_vfos = %d, want the default 2", got)
	}
	if got := load(func(s map[string]interface{}) { s["audio_vfos"] = 9 }).Server.AudioVFOs; got != 4 {
		t.Errorf("audio_vfos 9 = %d, want it clamped to 4", got)
	}
	if got := load(func(s map[string]interface{}) { s["audio_vfos"] = 1 }).Server.AudioVFOs; got != 1 {
		t.Errorf("audio_vfos 1 = %d, want 1", got)
	}
}

func TestConnectionCheckReportsVFOs(t *testing.T) {
	sm := newVFOTestManager(t, 3)
	bans := NewIPBanManager(filepath.Join(t.TempDir(), "bans.json"))
	limiter := NewConnectionRateLimiter(100)

	check := func(password string) map[string]interface{} {
		t.Helper()
		body, _ := json.Marshal(ConnectionCheckRequest{UserSessionID: vfoTestUser, Password: password})
		req := httptest.NewRequest(http.MethodPost, "/connection", bytes.NewReader(body))
		req.RemoteAddr = vfoTestIP + ":40000"
		rec := httptest.NewRecorder()
		handleConnectionCheck(rec, req, sm, bans, limiter)
		if rec.Code != http.StatusOK {
			t.Fatalf("/connection status %d: %s", rec.Code, strings.TrimSpace(rec.Body.String()))
		}
		var out map[string]interface{}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	if got := check("")["vfos"]; got != float64(3) {
		t.Errorf("vfos = %v, want 3 (server.audio_vfos)", got)
	}
	if got := check(vfoTestPW)["vfos"]; got != float64(4) {
		t.Errorf("bypassed vfos = %v, want 4", got)
	}
}

// A secondary takes the same audio format as the listener's main audio, so a
// lossless (pcm-zstd) listener gets lossless secondaries.  Driven through the
// real /ws handler, since that is where the format used to be refused.
func TestSecondaryConnectsWithPCMZstd(t *testing.T) {
	sm := newVFOTestManager(t, 4)
	cfg := sm.config
	sm.SetUserAgent(vfoTestUser, "vfo-test")
	wsh := NewWebSocketHandler(sm, &AudioReceiver{}, cfg, NewIPBanManager(filepath.Join(t.TempDir(), "bans.json")),
		NewRateLimiterManager(0), NewIPConnectionRateLimiter(0), nil)
	srv := httptest.NewServer(http.HandlerFunc(wsh.HandleWebSocket))
	defer srv.Close()

	dial := func(vfo int) *websocket.Conn {
		t.Helper()
		u := "ws" + strings.TrimPrefix(srv.URL, "http") +
			"/?frequency=7100000&mode=usb&format=pcm-zstd&user_session_id=" + vfoTestUser
		if vfo > 0 {
			u += "&vfo=" + strconv.Itoa(vfo)
		}
		c, _, err := websocket.DefaultDialer.Dial(u, nil)
		if err != nil {
			t.Fatalf("dial vfo %d: %v", vfo, err)
		}
		return c
	}
	primary := dial(0)
	defer primary.Close()
	waitFor(t, "primary session", func() bool { return sm.GetSessionCount() == 1 })

	secondary := dial(1)
	defer secondary.Close()
	waitFor(t, "pcm-zstd secondary session", func() bool {
		sm.mu.RLock()
		defer sm.mu.RUnlock()
		_, ok := sm.uuidSecondaryAudio[vfoTestUser][1]
		return ok
	})

	// A refusal would arrive as an error message before the close; a live
	// secondary sends nothing until audio does, and there is none here.
	secondary.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	if _, msg, err := secondary.ReadMessage(); err == nil {
		t.Errorf("secondary got %q, want silence", msg)
	}
}
