package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestParseKiwiSDRVersion(t *testing.T) {
	for _, tc := range []struct {
		in       string
		maj, min int
		ok       bool
	}{
		{"1.902", 1, 902, true},
		{" 1.826 ", 1, 826, true},
		{"2.0", 2, 0, true},
		{"", 0, 0, false},
		{"1", 0, 0, false},
		{"1.", 0, 0, false},
		{"v1.902", 0, 0, false},
		{"1.902.1", 0, 0, false},
		{"0.902", 0, 0, false},
		{"1.-5", 0, 0, false},
		{"1.+5", 0, 0, false},
	} {
		maj, min, ok := parseKiwiSDRVersion(tc.in)
		if ok != tc.ok || maj != tc.maj || min != tc.min {
			t.Errorf("parseKiwiSDRVersion(%q) = %d, %d, %v; want %d, %d, %v",
				tc.in, maj, min, ok, tc.maj, tc.min, tc.ok)
		}
	}
}

func TestKiwiSDRVersionFallsBackToDefault(t *testing.T) {
	for _, v := range []string{"", "garbage"} {
		s := ServerConfig{KiwiSDRVersion: v}
		if got := s.KiwiSDRVersionString(); got != defaultKiwiSDRVersion {
			t.Errorf("KiwiSDRVersion %q reports %q, want %q", v, got, defaultKiwiSDRVersion)
		}
	}
	s := ServerConfig{KiwiSDRVersion: "1.910"}
	if got := s.KiwiSDRVersionString(); got != "1.910" {
		t.Errorf("reports %q, want 1.910", got)
	}
}

// TestKiwiVersionMsgParses splits the version MSG the way kiwiclient's
// _process_msg and the KiwiSDR browser's kiwi_msg do: on spaces, then on
// the first "=". Every pair must have a name, or version_maj is lost and
// kiwirecorder --wf crashes comparing a None version.
func TestKiwiVersionMsgParses(t *testing.T) {
	msg := kiwiVersionMsg(1, 902)
	got := map[string]string{}
	for _, pair := range strings.Split(msg, " ") {
		name, value, ok := strings.Cut(pair, "=")
		if !ok || name == "" {
			t.Fatalf("malformed pair %q in %q", pair, msg)
		}
		got[name] = value
	}
	for name, want := range map[string]string{"version_maj": "1", "version_min": "902", "freq_offset": "0.000", "has_attn": "0"} {
		if got[name] != want {
			t.Errorf("%s = %q, want %q", name, got[name], want)
		}
	}
}

// TestKiwiStampedJSFilesCarryStamps guards the list in kiwiStampedJSFiles
// against the bundled frontend: every file that registers with
// kiwi_check_js_version must be on it, or the browser sees that file's
// literal stamp, which disagrees with /VER once kiwisdr_version moves.
func TestKiwiStampedJSFilesCarryStamps(t *testing.T) {
	push := regexp.MustCompile(`kiwi_check_js_version\.push\(\{\s*VERSION_MAJ:`)
	err := filepath.Walk("kiwi", func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".js") {
			return err
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		urlPath := "/" + filepath.ToSlash(strings.TrimPrefix(path, "kiwi"+string(filepath.Separator)))
		if push.Match(src) != kiwiStampedJSFiles[urlPath] {
			t.Errorf("%s: registers a version stamp = %v, but listed in kiwiStampedJSFiles = %v",
				urlPath, push.Match(src), kiwiStampedJSFiles[urlPath])
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestServeKiwiStampedJS(t *testing.T) {
	for path := range kiwiStampedJSFiles {
		rec := httptest.NewRecorder()
		if !serveKiwiStampedJS(rec, httptest.NewRequest(http.MethodGet, path, nil), "kiwi", 1, 917) {
			t.Fatalf("%s: not served", path)
		}
		body := rec.Body.String()
		if !strings.Contains(body, "VERSION_MAJ:1, VERSION_MIN:917") {
			t.Errorf("%s: stamp not rewritten", path)
		}
		if kiwiJSVersionStamp.FindString(strings.ReplaceAll(body, "VERSION_MAJ:1, VERSION_MIN:917", "")) != "" {
			t.Errorf("%s: an unrewritten stamp remains", path)
		}

		// A copy stamped with another version must not revalidate as current.
		etag := rec.Header().Get("ETag")
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("If-None-Match", etag)
		rec = httptest.NewRecorder()
		serveKiwiStampedJS(rec, req, "kiwi", 1, 918)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: version change answered %d to a stale ETag, want 200", path, rec.Code)
		}
	}
	if serveKiwiStampedJS(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/kiwi/kiwi.js", nil), "kiwi", 1, 902) {
		t.Error("an unstamped file was intercepted")
	}
}
