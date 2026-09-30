package hdradio

// What happens when the subprocess is missing, dies, hangs or sends nonsense,
// that commands reach it, and that its three output streams come out framed
// as the frontend expects -- with a shell script standing in for the binary.
// TestRealBinaryDecodesWSHE runs the real one when it is available.

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var iq48 = AudioExtensionParams{SampleRate: 48000, Channels: 2, BitsPerSample: 16}

// fakeBinary points the package at a shell script for one test.
func fakeBinary(t *testing.T, script string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ubersdr-hdradio")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	saved := binaryPath
	binaryPath = path
	t.Cleanup(func() { binaryPath = saved })
}

func noLimit(t *testing.T) {
	t.Helper()
	saved := GlobalConfig
	GlobalConfig = nil
	t.Cleanup(func() { GlobalConfig = saved })
}

func start(t *testing.T, params map[string]interface{}) (*HDRadioExtension, chan AudioSample, chan []byte) {
	t.Helper()
	ext, err := NewHDRadioExtension(iq48, params)
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}
	audio := make(chan AudioSample, 64)
	results := make(chan []byte, 256)
	if err := ext.Start(audio, results); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() { _ = ext.Stop() })
	return ext, audio, results
}

// next returns the next result of the given type, or fails after timeout.
func next(t *testing.T, results chan []byte, typ byte, timeout time.Duration) []byte {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case pkt := <-results:
			if len(pkt) > 0 && pkt[0] == typ {
				return pkt
			}
		case <-deadline:
			t.Fatalf("no 0x%02x message within %v", typ, timeout)
			return nil
		}
	}
}

// ── Refused at attach ────────────────────────────────────────────────────────

func TestMissingBinaryIsRefusedAtAttach(t *testing.T) {
	noLimit(t)
	saved := binaryPath
	binaryPath = filepath.Join(t.TempDir(), "not-here")
	defer func() { binaryPath = saved }()
	if _, err := NewHDRadioExtension(iq48, nil); err == nil || !strings.Contains(err.Error(), "not installed") {
		t.Fatalf("got %v, want a not-installed error", err)
	}
}

func TestWrongInputIsRefused(t *testing.T) {
	noLimit(t)
	fakeBinary(t, "exit 0\n")
	for name, p := range map[string]AudioExtensionParams{
		"mono":      {SampleRate: 24000, Channels: 1, BitsPerSample: 16},
		"too slow":  {SampleRate: 8000, Channels: 2, BitsPerSample: 16},
		"not 16bit": {SampleRate: 48000, Channels: 2, BitsPerSample: 8},
	} {
		if _, err := NewHDRadioExtension(p, nil); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	for _, bad := range []interface{}{float64(-1), float64(8), float64(1.5), "one"} {
		if _, err := NewHDRadioExtension(iq48, map[string]interface{}{"program": bad}); err == nil {
			t.Errorf("program %v accepted", bad)
		}
	}
}

func TestUserLimitIsHeldAndReleased(t *testing.T) {
	fakeBinary(t, "cat >/dev/null\n")
	saved := GlobalConfig
	GlobalConfig = &GlobalConfigProvider{MaxUsers: 1}
	defer func() { GlobalConfig = saved }()

	first, err := NewHDRadioExtension(iq48, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewHDRadioExtension(iq48, nil); err == nil {
		t.Fatal("a second user was allowed past a limit of one")
	}
	_ = first.Stop()
	_ = first.Stop() // twice must not free two slots
	second, err := NewHDRadioExtension(iq48, nil)
	if err != nil {
		t.Fatalf("slot not released on Stop: %v", err)
	}
	_ = second.Stop()
	activeUserMutex.Lock()
	n := activeUserCount
	activeUserMutex.Unlock()
	if n != 0 {
		t.Errorf("%d slots held after both stopped", n)
	}
}

// ── The streams ─────────────────────────────────────────────────────────────

func TestStreamsAreFramedForTheFrontend(t *testing.T) {
	noLimit(t)
	// One status line, one image frame (a 13-byte header and a 4-byte JPEG
	// start), and half a second of silence as audio; then wait for stdin.
	fakeBinary(t, `
echo '{"t":"status","sync":true,"name":"WTST"}' >&3
printf '\015\000\000\000{"t":"image"}\004\000\000\000\377\330\377\340' >&5
head -c 96000 /dev/zero
cat >/dev/null
`)
	_, _, results := start(t, map[string]interface{}{"program": float64(1)})

	// Status and images come from separate goroutines, so in either order.
	got := map[byte][]byte{}
	deadline := time.After(5 * time.Second)
	for len(got) < 3 {
		select {
		case pkt := <-results:
			if _, seen := got[pkt[0]]; !seen {
				got[pkt[0]] = pkt
			}
		case <-deadline:
			t.Fatalf("after 5 s, got message types %v; want 0x02, 0x03 and 0x04", keys(got))
		}
	}

	status := got[MessageTypeStatus]
	var st map[string]interface{}
	if err := json.Unmarshal(status[1:], &st); err != nil || st["name"] != "WTST" {
		t.Errorf("status %q did not come through unchanged (%v)", status[1:], err)
	}

	img := got[MessageTypeImage]
	hl := binary.BigEndian.Uint32(img[1:5])
	if string(img[5:5+hl]) != `{"t":"image"}` || string(img[5+hl:]) != "\xff\xd8\xff\xe0" {
		t.Errorf("image message %q", img)
	}

	audio := got[MessageTypeAudio]
	if len(audio) < 15 {
		t.Fatalf("audio message of %d bytes", len(audio))
	}
	if rate := binary.BigEndian.Uint32(audio[9:13]); rate != 48000 || audio[13] != 2 {
		t.Errorf("audio header says %d Hz, %d channels; want 48000 stereo", rate, audio[13])
	}
}

func keys(m map[byte][]byte) []byte {
	var out []byte
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestCommandsReachTheBinary(t *testing.T) {
	noLimit(t)
	got := filepath.Join(t.TempDir(), "commands")
	fakeBinary(t, "cat <&4 > '"+got+"' &\ncat >/dev/null\n")
	ext, _, _ := start(t, nil)

	if err := ext.SetProgram(2); err != nil {
		t.Fatalf("SetProgram: %v", err)
	}
	ext.Retune(830000)
	if err := ext.SetProgram(9); err == nil {
		t.Error("program 9 accepted")
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		b, _ := os.ReadFile(got)
		if string(b) == "program 2\nreset\n" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	b, _ := os.ReadFile(got)
	t.Fatalf("binary received %q, want \"program 2\\nreset\\n\"", b)
}

func TestControlAfterStopIsHarmless(t *testing.T) {
	noLimit(t)
	fakeBinary(t, "cat >/dev/null\n")
	ext, _, _ := start(t, nil)
	_ = ext.Stop()
	if err := ext.SetProgram(1); err == nil {
		t.Error("SetProgram on a stopped decoder reported success")
	}
	ext.Retune(830000) // must not panic
	_ = ext.Stop()
}

// ── Failures ─────────────────────────────────────────────────────────────────

func TestCrashIsReported(t *testing.T) {
	noLimit(t)
	fakeBinary(t, "exit 3\n")
	ext, _, _ := start(t, nil)
	select {
	case err := <-ext.CrashChan():
		if err == nil {
			t.Error("crash reported without an error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a subprocess that exited was not reported")
	}
}

func TestHungBinaryIsKilledOnStop(t *testing.T) {
	noLimit(t)
	// Ignores stdin closing and every polite signal.
	fakeBinary(t, "trap '' TERM INT HUP\nwhile :; do sleep 1; done\n")
	ext, _, _ := start(t, nil)
	begun := time.Now()
	_ = ext.Stop()
	if took := time.Since(begun); took > stopTimeout+2*time.Second {
		t.Errorf("Stop took %v", took)
	}
}

func TestCorruptImageStreamIsAbandonedNotFatal(t *testing.T) {
	noLimit(t)
	// A header length of 0xFFFFFFFF, then a status line that must still get
	// through.
	fakeBinary(t, `
printf '\377\377\377\377garbage' >&5
sleep 0.2
echo '{"t":"status","name":"after"}' >&3
cat >/dev/null
`)
	_, _, results := start(t, nil)
	status := next(t, results, MessageTypeStatus, 5*time.Second)
	if !strings.Contains(string(status), "after") {
		t.Errorf("status %q", status)
	}
}

func TestOversizedStatusLineDoesNotStopTheDecoder(t *testing.T) {
	noLimit(t)
	// A 2 MiB line (over the 1 MiB bound), then a normal one. Like the real
	// binary, the stand-in ignores SIGPIPE: once the status reader gives up,
	// its writes to fd 3 fail and it carries on with the audio.
	fakeBinary(t, `
trap '' PIPE
head -c 2097152 /dev/zero | tr '\0' 'x' >&3
echo >&3
head -c 96000 /dev/zero
cat >/dev/null
`)
	_, _, results := start(t, nil)
	// Status is abandoned; audio must still flow.
	next(t, results, MessageTypeAudio, 5*time.Second)
}

// ── The real binary ─────────────────────────────────────────────────────────

// TestRealBinaryDecodesWSHE plays the WSHE recording through the real
// ubersdr-hdradio: HDRADIO_BINARY names the binary (default: the installed
// one) and HDRADIO_SAMPLE the 48 kHz recording from its testdata/. Skipped
// when either is missing.
func TestRealBinaryDecodesWSHE(t *testing.T) {
	noLimit(t)
	if b := os.Getenv("HDRADIO_BINARY"); b != "" {
		saved := binaryPath
		binaryPath = b
		defer func() { binaryPath = saved }()
	}
	if _, err := os.Stat(binaryPath); err != nil {
		t.Skipf("no ubersdr-hdradio at %s (set HDRADIO_BINARY)", binaryPath)
	}
	sample := os.Getenv("HDRADIO_SAMPLE")
	wav, err := os.ReadFile(sample)
	if sample == "" || err != nil {
		t.Skip("set HDRADIO_SAMPLE to testdata/wshe_na5b_820000Hz_iq48.wav from ubersdr-hdradio")
	}

	ext, audio, results := start(t, nil)
	go func() {
		pcm := wav[44:]
		const block = 4800 * 4 // 0.1 s
		for off := 0; off+block <= len(pcm); off += block {
			s := make([]int16, block/2)
			for i := range s {
				s[i] = int16(binary.LittleEndian.Uint16(pcm[off+i*2:]))
			}
			audio <- AudioSample{PCMData: s}
			time.Sleep(10 * time.Millisecond) // 10x real time
		}
	}()

	sawName, sawAudio := false, false
	deadline := time.After(20 * time.Second)
	for !(sawName && sawAudio) {
		select {
		case pkt := <-results:
			switch pkt[0] {
			case MessageTypeStatus:
				if strings.Contains(string(pkt), `"name":"WSHE"`) {
					sawName = true
				}
			case MessageTypeAudio:
				sawAudio = true
			}
		case <-deadline:
			t.Fatalf("after 20 s: station named %v, audio %v", sawName, sawAudio)
		}
	}

	// A reset, as after a retune, clears the station.
	ext.Retune(830000)
	deadline = time.After(5 * time.Second)
	for {
		select {
		case pkt := <-results:
			if pkt[0] == MessageTypeStatus && strings.Contains(string(pkt), `"name":""`) {
				return
			}
		case <-deadline:
			t.Fatal("status never cleared after Retune")
		}
	}
}
