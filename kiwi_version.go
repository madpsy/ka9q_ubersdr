package main

import (
	"bytes"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// defaultKiwiSDRVersion is the KiwiSDR firmware version the emulation claims
// when server.kiwisdr_version is unset or unparseable.
const defaultKiwiSDRVersion = "1.902"

// parseKiwiSDRVersion splits a "major.minor" firmware version such as "1.902".
// Both halves are plain non-negative integers, as in the real firmware's
// VERSION_MAJ / VERSION_MIN; the minor is a number, not a decimal fraction.
func parseKiwiSDRVersion(s string) (maj, min int, ok bool) {
	majStr, minStr, found := strings.Cut(strings.TrimSpace(s), ".")
	if !found {
		return 0, 0, false
	}
	maj, err1 := strconv.Atoi(majStr)
	min, err2 := strconv.Atoi(minStr)
	if err1 != nil || err2 != nil || maj < 1 || min < 0 || majStr[0] == '+' || minStr[0] == '+' {
		return 0, 0, false
	}
	return maj, min, true
}

// KiwiSDRVersionParts is the firmware version the emulation reports. It is
// the single source for every place a client or the rx.kiwisdr.com directory
// reads one: the /VER reply, the version MSG, /status sdr_hw and sw_version,
// the directory registration, and the kiwi_check_js_version stamps in the
// bundled frontend (see serveKiwiStampedJS).
func (s *ServerConfig) KiwiSDRVersionParts() (maj, min int) {
	if maj, min, ok := parseKiwiSDRVersion(s.KiwiSDRVersion); ok {
		return maj, min
	}
	maj, min, _ = parseKiwiSDRVersion(defaultKiwiSDRVersion)
	return maj, min
}

// KiwiSDRVersionString is KiwiSDRVersionParts as "major.minor".
func (s *ServerConfig) KiwiSDRVersionString() string {
	maj, min := s.KiwiSDRVersionParts()
	return fmt.Sprintf("%d.%d", maj, min)
}

// kiwiVersionMsg is the body of the single version/hardware MSG a real
// KiwiSDR sends once a SND, W/F, mon or admin stream authenticates
// (rx/rx_cmd.cpp). It is already a run of name=value pairs, so it goes out
// as sendMsg's name: passing it as the value would put a stray "=" in front
// and clients would never see version_maj.
func kiwiVersionMsg(maj, min int) string {
	return fmt.Sprintf("version_maj=%d version_min=%d debian_ver=11 model=2 platform=0 hw=1 ext_clk=0 freq_offset=0.000 abyy=B25 dx_db_name=dx has_attn=0",
		maj, min)
}

// kiwiStampedJSFiles are the frontend files that register themselves with
// kiwi_check_js_version. The browser compares each stamp with the /VER reply
// and warns about stale Javascript on any mismatch, so they are served with
// the configured version written in rather than whatever the file says.
var kiwiStampedJSFiles = map[string]bool{
	"/kiwi/kiwi_js_load.js": true,
	"/config/config.js":     true,
}

var kiwiJSVersionStamp = regexp.MustCompile(`VERSION_MAJ:\s*\d+,\s*VERSION_MIN:\s*\d+`)

// stampKiwiJSVersion rewrites every kiwi_check_js_version stamp in src.
func stampKiwiJSVersion(src []byte, maj, min int) []byte {
	return kiwiJSVersionStamp.ReplaceAll(src, []byte(fmt.Sprintf("VERSION_MAJ:%d, VERSION_MIN:%d", maj, min)))
}

// serveKiwiStampedJS serves one of kiwiStampedJSFiles from dir with its
// version stamps set to maj.min. It reports false, writing nothing, when the
// path is not one of them so the caller falls through to the file server.
func serveKiwiStampedJS(w http.ResponseWriter, r *http.Request, dir string, maj, min int) bool {
	if !kiwiStampedJSFiles[r.URL.Path] {
		return false
	}
	name := filepath.Join(dir, filepath.FromSlash(r.URL.Path))
	info, err := os.Stat(name)
	if err != nil {
		return false
	}
	src, err := os.ReadFile(name)
	if err != nil {
		log.Printf("KiwiSDR: reading %s: %v", name, err)
		return false
	}
	// The version is part of the ETag so a browser holding a copy stamped
	// with an earlier version revalidates into the new one.
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("ETag", fmt.Sprintf(`"%x-%d-%d.%d"`, info.ModTime().UnixNano(), info.Size(), maj, min))
	http.ServeContent(w, r, info.Name(), time.Time{}, bytes.NewReader(stampKiwiJSVersion(src, maj, min)))
	return true
}
