package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

// newTestMCPServer builds an MCP server around cfg the way main does, with
// whichever optional parts a test supplies.
func newTestMCPServer(t *testing.T, cfg *Config, sessions *SessionManager, nfm *NoiseFloorMonitor) *MCPServer {
	t.Helper()
	if cfg == nil {
		cfg = &Config{}
	}
	if err := cfg.MCP.parseAllowedIPs(); err != nil {
		t.Fatalf("parseAllowedIPs: %v", err)
	}
	bans := &IPBanManager{entries: map[string]*bannedEntry{}, uaEntries: map[string]*bannedUAEntry{}}
	return NewMCPServer(sessions, nil, nfm, nil, cfg, bans, nil, nil, nil, nil, nil, nil)
}

// callTool invokes a tool handler the way mcp-go does, from a client IP.
func callTool(t *testing.T, m *MCPServer, name, ip string, args map[string]interface{}) *mcp.CallToolResult {
	t.Helper()
	tool := m.mcpServer.GetTool(name)
	if tool == nil {
		t.Fatalf("tool %q is not registered", name)
	}
	ctx := context.WithValue(context.Background(), mcpClientIPKey{}, ip)
	req := mcp.CallToolRequest{}
	req.Params.Name = name
	req.Params.Arguments = args
	// Through the argument validation every real call passes, so a test
	// cannot rely on a value a client could never get past it.
	res, err := m.validateToolArgs(tool.Handler)(ctx, req)
	if err != nil {
		t.Fatalf("%s: handler error: %v", name, err)
	}
	if res == nil {
		t.Fatalf("%s: nil result", name)
	}
	return res
}

// resultText is the first text content of a tool result.
func resultText(t *testing.T, res *mcp.CallToolResult) string {
	t.Helper()
	for _, c := range res.Content {
		if tc, ok := c.(mcp.TextContent); ok {
			return tc.Text
		}
	}
	t.Fatalf("result has no text content: %+v", res.Content)
	return ""
}

// resultJSON decodes a successful tool result's JSON text into v.
func resultJSON(t *testing.T, res *mcp.CallToolResult, v interface{}) {
	t.Helper()
	text := resultText(t, res)
	if res.IsError {
		t.Fatalf("tool returned an error: %s", text)
	}
	if err := json.Unmarshal([]byte(text), v); err != nil {
		t.Fatalf("result is not JSON: %v\n%s", err, text)
	}
}

// wantToolError asserts the result is an error mentioning want.
func wantToolError(t *testing.T, res *mcp.CallToolResult, want string) {
	t.Helper()
	text := resultText(t, res)
	if !res.IsError {
		t.Fatalf("want an error mentioning %q, got success: %s", want, text)
	}
	if !strings.Contains(strings.ToLower(text), strings.ToLower(want)) {
		t.Errorf("error %q does not mention %q", text, want)
	}
}

func mcpInitializeRequest(remoteAddr string) *http.Request {
	body := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`
	req := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.RemoteAddr = remoteAddr
	return req
}

func TestHandleMCPEnforcesAllowedIPs(t *testing.T) {
	m := newTestMCPServer(t, nil, nil, nil) // default allowlist

	cases := []struct {
		name   string
		remote string
		header map[string]string
		status int
	}{
		{"private network", "192.168.1.20:5555", nil, http.StatusOK},
		{"docker network", "172.20.0.5:5555", nil, http.StatusOK},
		{"loopback", "127.0.0.1:5555", nil, http.StatusOK},
		{"public internet", "203.0.113.9:5555", nil, http.StatusForbidden},
		// A forwarding header from a client that is not a trusted proxy is
		// ignored, so it cannot claim to be on the LAN.
		{"spoofed X-Real-IP", "203.0.113.9:5555", map[string]string{"X-Real-IP": "192.168.1.20"}, http.StatusForbidden},
		{"spoofed X-Forwarded-For", "203.0.113.9:5555", map[string]string{"X-Forwarded-For": "10.0.0.1"}, http.StatusForbidden},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := mcpInitializeRequest(c.remote)
			for k, v := range c.header {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			m.HandleMCP(rec, req)
			if rec.Code != c.status {
				t.Fatalf("status %d, want %d: %s", rec.Code, c.status, rec.Body.String())
			}
			if c.status == http.StatusForbidden && !strings.Contains(rec.Body.String(), "mcp.allowed_ips") {
				t.Errorf("refusal does not tell the operator which setting to change: %s", rec.Body.String())
			}
			if c.status == http.StatusOK && !strings.Contains(rec.Body.String(), "UberSDR") {
				t.Errorf("initialize response does not identify the server: %s", rec.Body.String())
			}
		})
	}

	// Opening the allowlist up lets the public client in.
	open := newTestMCPServer(t, &Config{MCP: MCPConfig{AllowedIPs: []string{"0.0.0.0/0"}}}, nil, nil)
	rec := httptest.NewRecorder()
	open.HandleMCP(rec, mcpInitializeRequest("203.0.113.9:5555"))
	if rec.Code != http.StatusOK {
		t.Errorf("0.0.0.0/0: status %d, want 200", rec.Code)
	}
}

// allMCPTools is every tool the server offers. A tool added or dropped without
// updating this list (and the docs in config.yaml.example) fails the test.
var allMCPTools = []string{
	"get_active_sessions",
	"get_band_conditions",
	"get_cw_analytics",
	"get_cw_spots",
	"get_decoder_analytics",
	"get_decoder_analytics_hourly",
	"get_decoder_spots",
	"get_dx_cluster_spots",
	"get_frequency_reference",
	"get_noise_floor",
	"get_noise_floor_trends",
	"get_propagation_predictions",
	"get_receiver_info",
	"get_session_history",
	"get_snr",
	"get_space_weather",
	"get_spectrogram",
	"get_spectrogram_data",
	"get_spot_activity",
	"get_ssb_predictions",
	"get_station_rankings",
	"get_sun_times",
	"get_voice_activity",
	"get_wideband_spectrum",
	"whats_on_frequency",
}

func registeredTools(t *testing.T, m *MCPServer) []string {
	t.Helper()
	// Through the protocol, so every tool's schema must also serialise.
	raw := m.mcpServer.HandleMessage(context.Background(), json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	data, err := json.Marshal(raw)
	if err != nil {
		t.Fatalf("marshal tools/list: %v", err)
	}
	var resp struct {
		Result struct {
			Tools []struct {
				Name        string `json:"name"`
				Description string `json:"description"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		t.Fatalf("decode tools/list: %v\n%s", err, data)
	}
	names := make([]string, 0, len(resp.Result.Tools))
	for _, tool := range resp.Result.Tools {
		if tool.Description == "" {
			t.Errorf("tool %s has no description", tool.Name)
		}
		names = append(names, tool.Name)
	}
	sort.Strings(names)
	return names
}

func TestMCPToolsListed(t *testing.T) {
	m := newTestMCPServer(t, nil, nil, snrTestMonitor(t))
	got := registeredTools(t, m)
	if strings.Join(got, ",") != strings.Join(allMCPTools, ",") {
		t.Errorf("tools/list:\n got  %v\n want %v", got, allMCPTools)
	}

	example, err := readExampleConfig()
	if err != nil {
		t.Fatalf("read config.yaml.example: %v", err)
	}
	for _, name := range allMCPTools {
		if !strings.Contains(example, "* "+name+" ") {
			t.Errorf("config.yaml.example does not list the %s tool", name)
		}
	}
}

func TestMCPDisabledToolsAreWithdrawn(t *testing.T) {
	cfg := &Config{MCP: MCPConfig{DisabledTools: []string{"get_active_sessions", "Get_Session_History", "no_such_tool"}}}
	m := newTestMCPServer(t, cfg, nil, nil)
	got := strings.Join(registeredTools(t, m), ",")
	for _, gone := range []string{"get_active_sessions", "get_session_history"} {
		if strings.Contains(got, gone) {
			t.Errorf("%s is still offered after being disabled", gone)
		}
	}
	if !strings.Contains(got, "get_space_weather") {
		t.Error("disabling two tools removed others too")
	}
}

func testSession(id, uid, ip string, freq uint64, mode string) *Session {
	return &Session{
		ID: id, UserSessionID: uid, ClientIP: ip, Frequency: freq, Mode: mode,
		BandwidthLow: 50, BandwidthHigh: 2800,
		Country: "United States", CountryCode: "US", CreatedAt: time.Now(), LastActive: time.Now(),
	}
}

func testSessionManager(cfg *Config, sessions ...*Session) *SessionManager {
	sm := &SessionManager{sessions: map[string]*Session{}, config: cfg}
	for _, s := range sessions {
		sm.sessions[s.ID] = s
	}
	return sm
}

func TestGetActiveSessionsReportsProtocolAndFrequency(t *testing.T) {
	cfg := &Config{}
	spectrum := testSession("s4", "native-x", "198.51.100.4", 0, "spectrum")
	spectrum.IsSpectrum = true
	secondary := testSession("s5", "abcd", "198.51.100.1", 7_074_000, "usb")
	secondary.IsSecondary = true
	sm := testSessionManager(cfg,
		testSession("s1", "abcd", "198.51.100.1", 14_332_000, "usb"),
		testSession("s2", "kiwi-1700000000-198.51.100.2", "198.51.100.2", 660_015, "am"),
		testSession("s3", "websdr-1700000000-198.51.100.3", "198.51.100.3", 10_145_000, "usb"),
		spectrum, secondary,
	)
	m := newTestMCPServer(t, cfg, sm, nil)

	var got struct {
		Active   int                      `json:"active_sessions"`
		Sessions []map[string]interface{} `json:"sessions"`
	}
	resultJSON(t, callTool(t, m, "get_active_sessions", "127.0.0.1", nil), &got)
	if got.Active != 3 {
		t.Fatalf("active_sessions = %d, want 3 (spectrum and secondary VFO sessions are not listeners)", got.Active)
	}
	want := map[float64]string{14_332_000: "native", 660_015: "kiwi", 10_145_000: "websdr"}
	for _, s := range got.Sessions {
		freq, _ := s["frequency"].(float64)
		proto, ok := want[freq]
		if !ok {
			t.Errorf("unexpected session %v", s)
			continue
		}
		if s["protocol"] != proto {
			t.Errorf("frequency %.0f: protocol %v, want %s", freq, s["protocol"], proto)
		}
		if s["frequency_khz"] != freq/1e3 {
			t.Errorf("frequency %.0f: frequency_khz %v, want %v", freq, s["frequency_khz"], freq/1e3)
		}
		if _, has := s["bandwidth"]; has {
			t.Error("the deprecated always-3000 bandwidth field is still reported")
		}
	}

	// The text format used to print every frequency as 0: the type assertion
	// it made never matched a uint64.
	text := resultText(t, callTool(t, m, "get_active_sessions", "127.0.0.1", map[string]interface{}{"format": "text"}))
	for _, want := range []string{"14332.000 kHz | usb | native", "660.015 kHz | am | kiwi", "10145.000 kHz | usb | websdr"} {
		if !strings.Contains(text, want) {
			t.Errorf("text output lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, " 0.000 ") {
		t.Errorf("text output still shows a zero frequency:\n%s", text)
	}
}

func TestRoundCoordinate(t *testing.T) {
	for in, want := range map[float64]float64{47.7425: 47.7, -121.9883: -122.0, 4.8499: 4.8, 0.04: 0} {
		if got := roundCoordinate(in); got != want {
			t.Errorf("roundCoordinate(%v) = %v, want %v", in, got, want)
		}
	}
}

func TestMCPRateLimitIsPerClientAndTool(t *testing.T) {
	m := newTestMCPServer(t, nil, nil, nil)
	m.RateLimiter = NewFFTRateLimiter()
	ctxA := context.WithValue(context.Background(), mcpClientIPKey{}, "192.168.1.1")
	ctxB := context.WithValue(context.Background(), mcpClientIPKey{}, "192.168.1.2")

	if !m.allowToolCall(ctxA, "get_spectrogram") {
		t.Fatal("first call refused")
	}
	if m.allowToolCall(ctxA, "get_spectrogram") {
		t.Error("an immediate second call by the same client was allowed")
	}
	if !m.allowToolCall(ctxB, "get_spectrogram") {
		t.Error("another client was limited by the first client's call")
	}
	if !m.allowToolCall(ctxA, "get_session_history") {
		t.Error("a different tool was limited by the first tool's call")
	}

	m.RateLimiter = nil
	if !m.allowToolCall(ctxA, "get_spectrogram") || !m.allowToolCall(ctxA, "get_spectrogram") {
		t.Error("with no limiter configured, calls must not be limited")
	}
}

func TestCallPublicHandlerPassesCallerIP(t *testing.T) {
	ctx := context.WithValue(context.Background(), mcpClientIPKey{}, "192.168.7.7")
	var sawIP, sawQuery string
	status, body := callPublicHandler(ctx, func(w http.ResponseWriter, r *http.Request) {
		sawIP = getClientIP(r)
		sawQuery = r.URL.Query().Get("band")
		w.WriteHeader(http.StatusTeapot)
		w.Write([]byte(`{"error":"short and stout"}`))
	}, "/api/test", url.Values{"band": {"20m"}})

	if sawIP != "192.168.7.7" {
		t.Errorf("handler saw client IP %q, want the MCP caller's", sawIP)
	}
	if sawQuery != "20m" {
		t.Errorf("handler saw band=%q, want 20m", sawQuery)
	}
	if status != http.StatusTeapot || handlerError(status, body) != "short and stout" {
		t.Errorf("status %d, error %q", status, handlerError(status, body))
	}
	if got := handlerError(http.StatusBadGateway, []byte("<html>")); !strings.Contains(got, "502") {
		t.Errorf("non-JSON error body: %q", got)
	}
}

func readExampleConfig() (string, error) {
	data, err := os.ReadFile(filepath.Join("config", "config.yaml.example"))
	return string(data), err
}

// Over the real transport: the caller's IP reaches the tool handlers (via
// WithHTTPContextFunc), so the per-client rate limit applies per client.
func TestMCPClientIPReachesToolsOverHTTP(t *testing.T) {
	mgr := newSessionStatsTestDB(t)
	m := newTestMCPServer(t, &Config{}, nil, nil)
	m.SessionDB = mgr.ReadDB()
	m.RateLimiter = NewFFTRateLimiter()

	post := func(remote, session, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/mcp", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		if session != "" {
			req.Header.Set("Mcp-Session-Id", session)
		}
		req.RemoteAddr = remote
		rec := httptest.NewRecorder()
		m.HandleMCP(rec, req)
		return rec
	}
	connect := func(remote string) string {
		rec := post(remote, "", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("initialize from %s: %d %s", remote, rec.Code, rec.Body.String())
		}
		session := rec.Header().Get("Mcp-Session-Id")
		post(remote, session, `{"jsonrpc":"2.0","method":"notifications/initialized"}`)
		return session
	}
	call := func(remote, session string) string {
		rec := post(remote, session, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_session_history","arguments":{"timezone":"UTC"}}}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("tools/call from %s: %d %s", remote, rec.Code, rec.Body.String())
		}
		return rec.Body.String()
	}

	a := connect("192.168.1.10:4000")
	b := connect("192.168.1.11:4000")
	if got := call("192.168.1.10:4000", a); strings.Contains(got, "Rate limit") || !strings.Contains(got, "sessions_started") {
		t.Fatalf("first call from A: %s", got)
	}
	if got := call("192.168.1.10:4001", a); !strings.Contains(got, "Rate limit") {
		t.Errorf("second call from A was not limited, so the handler did not see A's IP: %s", got)
	}
	if got := call("192.168.1.11:4000", b); strings.Contains(got, "Rate limit") {
		t.Errorf("B was limited by A's call, so both looked like the same client: %s", got)
	}
}

// Every tool only reads receiver state, and must advertise that: without the
// hints mcp-go reports destructiveHint true and clients confirm each call.
func TestMCPToolsAreAnnotatedReadOnly(t *testing.T) {
	m := newTestMCPServer(t, nil, nil, nil)
	tools := m.mcpServer.ListTools()
	if len(tools) == 0 {
		t.Fatal("no tools registered")
	}
	for name, st := range tools {
		a := st.Tool.Annotations
		if a.ReadOnlyHint == nil || !*a.ReadOnlyHint ||
			a.DestructiveHint == nil || *a.DestructiveHint ||
			a.IdempotentHint == nil || !*a.IdempotentHint ||
			a.OpenWorldHint == nil || *a.OpenWorldHint {
			t.Errorf("%s: annotations not read-only (add mcpReadOnlyTool to its NewTool options)", name)
		}
	}
}

// get_receiver_info returns whatever the description builder returns, the map
// /api/description serves, rather than a hand-kept copy of part of it.
func TestGetReceiverInfoIsTheDescription(t *testing.T) {
	m := newTestMCPServer(t, nil, nil, nil)
	wantToolError(t, callTool(t, m, "get_receiver_info", "127.0.0.1", nil), "not available")

	m.Describe = func() map[string]interface{} {
		return map[string]interface{}{"tuning_range": map[string]interface{}{"max_hz": 30e6}, "addons": []string{"navtex"}}
	}
	res := callTool(t, m, "get_receiver_info", "127.0.0.1", nil)
	var got map[string]interface{}
	if err := json.Unmarshal([]byte(resultText(t, res)), &got); err != nil {
		t.Fatal(err)
	}
	if got["tuning_range"] == nil || got["addons"].([]interface{})[0] != "navtex" {
		t.Errorf("got %v, want the description map", got)
	}
}

// Every tool's arguments are checked against its schema before its handler
// runs.
func TestMCPArgumentValidation(t *testing.T) {
	m := newTestMCPServer(t, nil, nil, nil)
	cases := []struct {
		tool string
		args map[string]interface{}
		want string
	}{
		{"get_cw_spots", map[string]interface{}{"hours": "NaN"}, "finite"},
		{"get_cw_spots", map[string]interface{}{"hours": "-Inf"}, "finite"},
		{"get_cw_spots", map[string]interface{}{"hours": 0}, "between 1 and 48"},
		{"get_cw_spots", map[string]interface{}{"limit": 1e9}, "between 1 and 500"},
		{"get_cw_spots", map[string]interface{}{"hours": []interface{}{1}}, "must be a number"},
		{"get_cw_spots", map[string]interface{}{"band": "20m\n"}, ""}, // trailing whitespace is trimmed, not refused
		{"get_cw_spots", map[string]interface{}{"band": "20m\x07x"}, "control characters"},
		{"get_cw_spots", map[string]interface{}{"band": "20m; DROP TABLE"}, "a name such as 20m"},
		{"get_cw_spots", map[string]interface{}{"country": strings.Repeat("a", 300)}, "too long"},
		{"get_cw_spots", map[string]interface{}{"continent": "Europe"}, "two-letter code"},
		{"get_cw_spots", map[string]interface{}{"callsign": "G3XYZ<script>"}, "callsigns"},
		{"get_space_weather", map[string]interface{}{"format": "xml"}, "one of json, text"},
		{"get_space_weather", map[string]interface{}{"verbose": true}, `unknown argument "verbose"`},
		{"get_receiver_info", map[string]interface{}{"x": 1}, "takes no arguments"},
		{"get_cw_analytics", map[string]interface{}{"hourly": "yes"}, "true or false"},
		{"get_sun_times", map[string]interface{}{"locator": "../etc"}, "Maidenhead locator"},
		{"get_sun_times", map[string]interface{}{"locator": "../../etc"}, "too long"},
		{"get_session_history", map[string]interface{}{"timezone": "Europe/London;rm"}, "IANA timezone"},
		{"get_session_history", map[string]interface{}{"from_date": "2026-11-17T00:00"}, "YYYY-MM-DD"},
		{"whats_on_frequency", map[string]interface{}{}, "frequency_khz is required"},
		{"whats_on_frequency", map[string]interface{}{"frequency_khz": "1e400"}, "must be a number"},
		{"get_snr", map[string]interface{}{"avg_sec": 61}, "between 0 and 60"},
		{"get_voice_activity", map[string]interface{}{"min_confidence": 2}, "between 0 and 1"},
	}
	for _, c := range cases {
		res := callTool(t, m, c.tool, "127.0.0.1", c.args)
		text := resultText(t, res)
		if c.want == "" {
			if strings.Contains(text, "Invalid arguments") {
				t.Errorf("%s %v: refused: %s", c.tool, c.args, text)
			}
			continue
		}
		if !res.IsError || !strings.Contains(text, "Invalid arguments") || !strings.Contains(text, c.want) {
			t.Errorf("%s %v: got %q, want an invalid-arguments error mentioning %q", c.tool, c.args, text, c.want)
		}
	}
}

func TestMCPValidateArgsNormalises(t *testing.T) {
	schema := mcp.NewTool("t",
		mcp.WithNumber("n", mcp.Min(1), mcp.Max(10)),
		mcp.WithString("f", mcp.Enum("json", "text")),
		mcp.WithBoolean("b"),
		mcp.WithArray("l", mcp.Items(map[string]interface{}{"type": "number"})),
	).InputSchema
	got, err := mcpValidateArgs(schema, map[string]interface{}{"n": " 5 ", "f": "JSON", "b": "true", "l": []interface{}{"7.5"}, "gone": nil})
	if err == nil {
		t.Fatalf("unknown argument %q should be refused even when null", "gone")
	}
	got, err = mcpValidateArgs(schema, map[string]interface{}{"n": " 5 ", "f": "JSON", "b": "true", "l": []interface{}{"7.5"}})
	if err != nil {
		t.Fatal(err)
	}
	if got["n"] != 5.0 || got["f"] != "json" || got["b"] != true || got["l"].([]interface{})[0] != 7.5 {
		t.Errorf("normalised %v, want n=5 f=json b=true l=[7.5]", got)
	}
	if _, err := mcpValidateArgs(schema, []interface{}{1}); err == nil {
		t.Error("arguments that are not an object should be refused")
	}
}

// The validation is wired into the server itself, not only the test helper.
func TestMCPArgumentValidationIsWired(t *testing.T) {
	m := newTestMCPServer(t, nil, nil, nil)
	ctx := context.WithValue(context.Background(), mcpClientIPKey{}, "127.0.0.1")
	msg := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_cw_spots","arguments":{"hours":"NaN"}}}`
	out, err := json.Marshal(m.mcpServer.HandleMessage(ctx, json.RawMessage(msg)))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "Invalid arguments for get_cw_spots") || !strings.Contains(string(out), "finite") {
		t.Errorf("tools/call with hours=NaN through the server: %s", out)
	}
}

// A panic in a tool handler is an error for that call, not a crash.
func TestMCPToolPanicIsRecovered(t *testing.T) {
	m := newTestMCPServer(t, nil, nil, nil)
	m.mcpServer.AddTool(mcp.NewTool("zz_panics", mcpReadOnlyTool), func(ctx context.Context, r mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var nilMap map[string]*int
		return mcp.NewToolResultText(fmt.Sprint(*nilMap["x"])), nil
	})
	ctx := context.WithValue(context.Background(), mcpClientIPKey{}, "127.0.0.1")
	out, err := json.Marshal(m.mcpServer.HandleMessage(ctx, json.RawMessage(
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"zz_panics","arguments":{}}}`)))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "panic recovered") {
		t.Errorf("panicking tool: %s", out)
	}
}
