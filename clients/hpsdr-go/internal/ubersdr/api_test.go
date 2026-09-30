package ubersdr

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
)

func TestNormalizeURL(t *testing.T) {
	good := map[string]string{
		"host:8080":                    "http://host:8080",
		"http://host:8080/":            "http://host:8080",
		"https://sdr.example.com":      "https://sdr.example.com",
		"ws://10.0.0.5:8073":           "http://10.0.0.5:8073",
		"WSS://Host":                   "https://Host",
		"  http://h:1  ":               "http://h:1",
		"m9psy-1.instance.ubersdr.org": "http://m9psy-1.instance.ubersdr.org",
		"http://[::1]:8080":            "http://[::1]:8080",
	}
	for in, want := range good {
		got, err := NormalizeURL(in)
		if err != nil || got != want {
			t.Errorf("NormalizeURL(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "ftp://h", "http://", "http://h/sdr", "http://h?x=1", "http://h/#f"} {
		if got, err := NormalizeURL(bad); err == nil {
			t.Errorf("NormalizeURL(%q) = %q, want an error", bad, got)
		}
	}
}

func TestModes(t *testing.T) {
	for khz, want := range map[int]string{48: "iq48", 96: "iq96", 192: "iq192", 384: "iq384", 1536: "iq384", 12: "iq48"} {
		if got := ModeForKHz(khz); got != want {
			t.Errorf("ModeForKHz(%d) = %s", khz, got)
		}
	}
	for mode, want := range map[string]int{"iq48": 48, "IQ384": 384, " iq96 ": 96, "iq": 0, "usb": 0} {
		if got := KHzForMode(mode); got != want {
			t.Errorf("KHzForMode(%q) = %d", mode, got)
		}
	}
}

func TestSessionID(t *testing.T) {
	re := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		id := NewSessionID()
		if !re.MatchString(id) || seen[id] {
			t.Fatalf("bad or repeated session ID %q", id)
		}
		seen[id] = true
	}
}

func TestConnResult(t *testing.T) {
	r, err := parseConnResult([]byte(`{"allowed":true,"bypassed":true,"allowed_iq_modes":["iq384","iq48","iq","iq1234"],"max_session_time":0}`), 200)
	if err != nil {
		t.Fatal(err)
	}
	if !r.Allowed || !r.Bypassed || !r.ModesKnown || strings.Join(r.AllowedIQModes, ",") != "iq48,iq384" {
		t.Fatalf("%+v", r)
	}
	if !r.AllowsKHz(48) || r.AllowsKHz(192) {
		t.Fatal("AllowsKHz")
	}
	if r.PasswordOutcome(true) != PasswordAccepted || r.PasswordOutcome(false) != PasswordNone {
		t.Fatal("password outcome when bypassed")
	}

	// An older server that does not say: everything, as far as this end knows.
	r, _ = parseConnResult([]byte(`{"allowed":true}`), 200)
	if r.ModesKnown || !r.AllowsKHz(384) {
		t.Fatalf("%+v", r)
	}
	if r.PasswordOutcome(true) != PasswordIgnored {
		t.Fatal("a password on an unbypassed allowed session is ignored")
	}

	// An empty list is none, not unknown.
	r, _ = parseConnResult([]byte(`{"allowed":true,"allowed_iq_modes":[]}`), 200)
	if !r.ModesKnown || r.AllowsKHz(48) {
		t.Fatalf("%+v", r)
	}

	r, _ = parseConnResult([]byte(`{"allowed":false,"reason":"Invalid password"}`), 403)
	if r.Refusal(true) != "Invalid password (the password was not accepted)" {
		t.Fatal(r.Refusal(true))
	}
	r, _ = parseConnResult([]byte(`{"allowed":false,"reason":"Password required"}`), 403)
	if r.Refusal(false) != "Password required (this receiver needs a password)" {
		t.Fatal(r.Refusal(false))
	}
	r, _ = parseConnResult([]byte(`{"allowed":false}`), 429)
	if r.Refusal(false) != "connection refused by server" || !r.RateLimited() {
		t.Fatal(r.Refusal(false))
	}
	r, _ = parseConnResult([]byte(`{"allowed":false,"reason":"Rate limit exceeded. Please wait before trying again."}`), 429)
	if !r.RateLimited() {
		t.Fatal("429 not read as a rate limit")
	}
	if r, _ := parseConnResult([]byte(`{"allowed":false}`), 403); r.RateLimited() {
		t.Fatal("403 read as a rate limit")
	}
	if _, err := parseConnResult([]byte(`<html>`), 502); err == nil {
		t.Fatal("HTML accepted as a /connection answer")
	}
}

// The precheck body, headers and the socket URL carry an awkward password
// intact: quotes, an ampersand, spaces, non-ASCII.
func TestCheckAndIQURL(t *testing.T) {
	const pw = `p&ss "wörd"'=?`
	var got map[string]string
	var ua, ctype string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/connection" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		ua, ctype = r.UserAgent(), r.Header.Get("Content-Type")
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{"allowed":true,"bypassed":true,"allowed_iq_modes":["iq48"]}`))
	}))
	defer srv.Close()
	s, err := NewServer(srv.URL+"/", pw)
	if err != nil {
		t.Fatal(err)
	}
	res, err := s.Check(context.Background(), "abc")
	if err != nil || !res.Allowed {
		t.Fatalf("%+v %v", res, err)
	}
	if got["password"] != pw || got["user_session_id"] != "abc" || ua != UserAgent || ctype != "application/json" {
		t.Fatalf("body %v ua %q type %q", got, ua, ctype)
	}

	u, err := url.Parse(s.IQURL("abc", 7_074_000, 192, 26))
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if u.Scheme != "ws" || u.Path != "/ws" || q.Get("password") != pw || q.Get("mode") != "iq192" ||
		q.Get("frequency") != "7074000" || q.Get("min_margin") != "26" || q.Get("version") != "4" ||
		q.Get("format") != "pcm-zstd" || q.Get("user_session_id") != "abc" {
		t.Fatalf("socket URL %s", u)
	}
	// Lossless and no password: both parameters absent, not empty.
	s.Password = ""
	u, _ = url.Parse(s.IQURL("abc", 1, 48, 0))
	if _, ok := u.Query()["min_margin"]; ok {
		t.Fatal("min_margin sent for a lossless stream")
	}
	if _, ok := u.Query()["password"]; ok {
		t.Fatal("empty password sent")
	}
	tls, _ := NewServer("https://h", "")
	if !strings.HasPrefix(tls.IQURL("a", 1, 48, 0), "wss://h/ws?") {
		t.Fatal(tls.IQURL("a", 1, 48, 0))
	}
}

func TestCheckUnreachable(t *testing.T) {
	s, _ := NewServer("http://127.0.0.1:1", "")
	if _, err := s.Check(context.Background(), "x"); err == nil {
		t.Fatal("no error from an unreachable server")
	}
}

func TestDescription(t *testing.T) {
	d, err := parseDescription([]byte(`{"receiver":{"name":"N","callsign":"M9PSY","location":"L"},"version":"0.1.70",
		"noise_floor":{"min_frequency":1},"tuning_range":{"min_frequency":10000,"max_frequency":60000000}}`))
	if err != nil {
		t.Fatal(err)
	}
	if d.Callsign != "M9PSY" || d.MinHz != 10000 || d.MaxHz != 60_000_000 || d.Version != "0.1.70" {
		t.Fatalf("%+v", d)
	}
	// Each edge falls back on its own.
	d, _ = parseDescription([]byte(`{"tuning_range":{"max_frequency":54000000}}`))
	if d.MinHz != DefaultMinHz || d.MaxHz != 54_000_000 {
		t.Fatalf("%+v", d)
	}
	// Inverted is refused outright.
	d, _ = parseDescription([]byte(`{"tuning_range":{"min_frequency":30000000,"max_frequency":100}}`))
	if d.MinHz != DefaultMinHz || d.MaxHz != DefaultMaxHz || d.RangeNote == "" {
		t.Fatalf("%+v", d)
	}
	// Nothing published: the defaults, quietly.
	d, _ = parseDescription([]byte(`{}`))
	if d.MinHz != DefaultMinHz || d.MaxHz != DefaultMaxHz || d.RangeNote != "" {
		t.Fatalf("%+v", d)
	}
	if !d.InRange(0) || !d.InRange(7_000_000) || d.InRange(50_000_000) || d.InRange(5_000) {
		t.Fatal("InRange")
	}
}

func TestDirectory(t *testing.T) {
	list, err := parseDirectory([]byte(`{"instances":[
		{"name":"Zed","callsign":"","host":"z.example","port":8080,"public_iq_modes":["iq48"]},
		{"name":"Beta","callsign":"m9psy","host":"b.example","port":443,"tls":true,"public_iq_modes":["iq","iq96","iq48"],"available_clients":3,"max_clients":10},
		{"name":"NoWide","callsign":"AAA","host":"n.example","port":80,"public_iq_modes":["iq"]},
		{"name":"NoHost","callsign":"BBB","host":"","port":80,"public_iq_modes":["iq48"]},
		{"name":"Alpha","callsign":"G0ABC","host":"a.example","port":8073,"public_iq_modes":["iq384"]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, i := range list {
		names = append(names, i.Name)
	}
	if strings.Join(names, ",") != "Alpha,Beta,Zed" {
		t.Fatalf("order %v", names)
	}
	b := list[1]
	if b.URL() != "https://b.example" || strings.Join(b.PublicIQModes, ",") != "iq48,iq96" || b.Available != 3 {
		t.Fatalf("%+v", b)
	}
	if list[0].URL() != "http://a.example:8073" || list[2].Available != -1 {
		t.Fatalf("%+v %+v", list[0], list[2])
	}
	if i, ok := FindCallsign(list, "M9PSY "); !ok || i.Name != "Beta" {
		t.Fatal("callsign lookup")
	}
	if _, ok := FindCallsign(list, "nobody"); ok {
		t.Fatal("found a callsign that is not there")
	}
	if !b.Matches("m9p") || !b.Matches("b.EXAMPLE") || b.Matches("zzz") || !b.Matches("") {
		t.Fatal("Matches")
	}
	if b.Label() != "m9psy · Beta" {
		t.Fatal(b.Label())
	}
}

func TestFetchDirectory(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.UserAgent() != UserAgent {
			w.WriteHeader(400)
			return
		}
		_, _ = w.Write([]byte(`{"instances":[{"name":"A","host":"a","port":1,"public_iq_modes":["iq48"]}]}`))
	}))
	defer srv.Close()
	list, err := FetchDirectory(context.Background(), srv.URL)
	if err != nil || len(list) != 1 {
		t.Fatalf("%v %v", list, err)
	}
}

func TestUnescapeDNSName(t *testing.T) {
	for in, want := range map[string]string{
		`ubersdr\ on\ box`: "ubersdr on box",
		`caf\195\169`:      "café",
		`plain`:            "plain",
		`trailing\`:        "trailing",
	} {
		if got := unescapeDNSName(in); got != want {
			t.Errorf("unescapeDNSName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseMinMargin(t *testing.T) {
	for in, want := range map[string]int{"0": 0, "15": 15, "60": 60, "26": 26, " 20 ": 20, "20.4": 20, "20.5": 21} {
		got, _, err := ParseMinMargin(in)
		if err != nil || got != want {
			t.Errorf("ParseMinMargin(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	if _, note, _ := ParseMinMargin("20.4"); note == "" {
		t.Error("rounding not noted")
	}
	for _, bad := range []string{"", "2O", "20dB", "6", "14.9", "60.1", "-20", "NaN", "Inf"} {
		if _, _, err := ParseMinMargin(bad); err == nil {
			t.Errorf("ParseMinMargin(%q) accepted", bad)
		}
	}
}
