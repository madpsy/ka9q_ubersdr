package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"math"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// websdrADPCMRefDecoder is the client's onmessage parse loop transcribed from
// websdr/websdr-sound-adpcm.js (plus the three tags the 2025 client added), kept
// apart from the encoder's own mirror of it so a shared misreading has to be made
// twice. Variable names follow the minified source.
type websdrADPCMRefDecoder struct {
	J, A   [20]int32
	M      int32
	v      int   // mode
	ia     int32 // step
	conv   int32 // $
	C      int   // rate
	smeter int
	out    []int16
}

func (d *websdrADPCMRefDecoder) message(b []byte) {
	at := func(i int) int32 { // reads past the end give undefined&255 = 0
		if i < len(b) {
			return int32(b[i])
		}
		return 0
	}
	for c := 0; c < len(b); c++ {
		e, h := 0, 0
		switch x := b[c]; {
		case x&0xF0 == 0xF0:
			d.smeter = int(x&15)*256 + int(at(c+1))
			c++
		case x == 0x80:
			for i := 0; i < 128; i++ {
				d.out = append(d.out, websdrALawDecode(byte(at(c+1+i))))
			}
			c += 128
			d.J, d.A, d.M = [20]int32{}, [20]int32{}, 0
		case x >= 0x90 && x <= 0xDF:
			h, e, d.v = 4, 2, 14-int(x>>4)
		case x&0x80 == 0:
			h, e = 1, 2
		case x == 0x81:
			d.C = int(at(c+1))*256 + int(at(c+2))
			c += 2
		case x == 0x82:
			d.ia = at(c+1)*256 + at(c+2)
			c += 2
		case x == 0x83:
			d.conv = at(c + 1)
			c++
		case x == 0x84:
			d.out = append(d.out, make([]int16, 128)...)
			d.J, d.A, d.M = [20]int32{}, [20]int32{}, 0
		case x == 0x85, x == 0x87: // 2025 client: AM-sync frequency, server time
			c += 6
		case x == 0x86: // 2025 client: resync, no payload
		}
		if e != 2 {
			continue
		}
		f := uint(14)
		if d.conv&16 == 16 {
			f = 12
		}
		v := d.v
		s := [8]int32{999, 999, 8, 4, 2, 1, 99, 99}
		for e = 0; e < 128; e++ {
			w := at(c+3) | at(c+2)<<8 | at(c+1)<<16 | at(c)<<24
			w <<= h
			p, j := 0, int32(15-v)
			if w != 0 {
				for w&math.MinInt32 == 0 && int32(p) < j {
					w <<= 1
					p++
				}
			}
			if int32(p) < j {
				j = int32(p)
				p++
				w <<= 1
			} else {
				j = w >> 24 & 255
				p += 8
				w <<= 8
			}
			n := 0
			if j >= s[v] {
				n++
			}
			if j >= s[v-1] {
				n++
			}
			if n > v-1 {
				n = v - 1
			}
			r := (w >> 16 & 65535) >> (17 - v) & (-1 << n)
			r += j << (v - 1)
			if w&(1<<(32-v+n)) != 0 {
				r |= 1<<n - 1
				r = ^r
			}
			for h += p + v - n; h >= 8; h -= 8 {
				c++
			}
			var sum int64
			for i := 0; i < 20; i++ {
				sum += int64(d.J[i]) * int64(d.A[i])
			}
			pr := int32(sum)
			if pr >= 0 {
				pr >>= 12
			} else {
				pr = (pr + 4095) >> 12
			}
			k := r*d.ia + d.ia/2
			sh := k >> 4
			for i := 19; i >= 0; i-- {
				d.J[i] += -(d.J[i] >> 7) + int32(int64(d.A[i])*int64(sh))>>f
				if i == 0 {
					break
				}
				d.A[i] = d.A[i-1]
			}
			d.A[0] = pr + k
			y := d.A[0] + d.M>>4
			if d.conv&16 == 16 {
				d.M = 0
			} else {
				d.M += (d.A[0] << 4) >> 3
			}
			d.out = append(d.out, int16(y))
		}
		if h == 0 {
			c--
		}
	}
}

type websdrADPCMSignal struct {
	name string
	pcm  []int16
}

func websdrADPCMSignals(n int) []websdrADPCMSignal {
	rng := rand.New(rand.NewSource(1))
	gen := func(f func(i int) float64) []int16 {
		out := make([]int16, n)
		for i := range out {
			out[i] = int16(math.Max(-32768, math.Min(32767, math.Round(f(i)))))
		}
		return out
	}
	const rate = 8000.0
	tone := func(hz, dBFS float64) func(int) float64 {
		a := 32767 * math.Pow(10, dBFS/20)
		return func(i int) float64 { return a * math.Sin(2*math.Pi*hz*float64(i)/rate) }
	}
	var lp float64
	return []websdrADPCMSignal{
		{"silence", make([]int16, n)},
		{"tone -20dBFS", gen(tone(700, -20))},
		{"tone -3dBFS", gen(tone(1500, -3))},
		{"two tones", gen(func(i int) float64 { return tone(600, -26)(i) + tone(2100, -26)(i) })},
		{"noise -30dBFS", gen(func(int) float64 { return rng.NormFloat64() * 32767 * math.Pow(10, -30.0/20) })},
		{"speech-like", gen(func(i int) float64 {
			lp += 0.3 * (rng.NormFloat64()*6000 - lp)
			env := 0.5 + 0.5*math.Sin(2*math.Pi*3*float64(i)/rate)
			return lp * env
		})},
		{"silence then loud", gen(func(i int) float64 {
			if i < n/2 {
				return 0
			}
			return tone(1000, -1)(i)
		})},
		{"full-scale square", gen(func(i int) float64 {
			if (i/9)%2 == 0 {
				return 32767
			}
			return -32768
		})},
		{"full-scale noise", gen(func(int) float64 { return float64(rng.Intn(65536) - 32768) })},
	}
}

// websdrADPCMEncodeSignal codes pcm in uneven chunks, as radiod packets arrive, and
// returns the messages and the PCM the encoder expects the client to play.
func websdrADPCMEncodeSignal(enc *websdrADPCMEncoder, pcm []int16, smeter int) ([][]byte, []int16) {
	var recon []int16
	enc.recon = &recon
	var msgs [][]byte
	for i, chunk := 0, 0; i < len(pcm); i += chunk {
		chunk = min(len(pcm)-i, 97+(i%5)*61)
		msgs = append(msgs, enc.Encode(nil, pcm[i:i+chunk], smeter))
	}
	return msgs, recon
}

func websdrADPCMSNR(ref, got []int16) float64 {
	var sig, noise float64
	for i := range ref {
		d := float64(ref[i]) - float64(got[i])
		sig += float64(ref[i]) * float64(ref[i])
		noise += d * d
	}
	if noise == 0 {
		return math.Inf(1)
	}
	return 10 * math.Log10(sig/noise)
}

func TestWebSDRADPCMRoundTrip(t *testing.T) {
	const n = 128 * 200
	for _, step := range []int{40, 128, 512} {
		for _, integ := range []bool{true, false} {
			for _, sig := range websdrADPCMSignals(n) {
				enc := newWebSDRADPCMEncoder(step)
				enc.SetRate(8000)
				enc.SetIntegrator(integ)
				msgs, recon := websdrADPCMEncodeSignal(enc, sig.pcm, 900)

				var dec websdrADPCMRefDecoder
				var bytesOut int
				for _, m := range msgs {
					dec.message(m)
					bytesOut += len(m)
				}
				if len(dec.out) != n || len(recon) != n {
					t.Fatalf("step %d integ %v %s: decoded %d, expected %d, want %d samples",
						step, integ, sig.name, len(dec.out), len(recon), n)
				}
				for i := range recon {
					if recon[i] != dec.out[i] {
						t.Fatalf("step %d integ %v %s: sample %d decodes to %d, encoder expected %d",
							step, integ, sig.name, i, dec.out[i], recon[i])
					}
				}
				snr := websdrADPCMSNR(sig.pcm, recon)
				t.Logf("step %3d integ %-5v %-18s %5.2f bits/sample  SNR %6.1f dB",
					step, integ, sig.name, float64(bytesOut*8)/n, snr)

				// Quantisation noise is a fixed floor of about step/sqrt(12) in sample
				// units: 37 for step 128, against 2317 rms for a -20 dBFS tone, 36 dB.
				if sig.name == "tone -20dBFS" && step == 128 && snr < 34 {
					t.Errorf("integ %v: tone SNR %.1f dB, want >= 34", integ, snr)
				}
				// A block never costs more than A-law's 129 bytes; the rest is the
				// S-meter each message carries.
				if bps := float64(bytesOut*8) / n; bps > 8.3 {
					t.Errorf("step %d integ %v %s: %.2f bits/sample, more than A-law", step, integ, sig.name, bps)
				}
				if sig.name == "silence" && snr != math.Inf(1) {
					t.Errorf("step %d integ %v: silence is not silent (SNR %.1f)", step, integ, snr)
				}
			}
		}
	}
}

// Plays the encoder's output into PA3FWM's own client, unmodified, and requires it to
// decode exactly what the encoder predicted.
func TestWebSDRADPCMOriginalClient(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed")
	}
	const n = 128 * 150
	for _, integ := range []bool{true, false} {
		var stream bytes.Buffer
		var want []int16
		enc := newWebSDRADPCMEncoder(128)
		enc.SetRate(8000)
		enc.SetIntegrator(integ)
		for i, sig := range websdrADPCMSignals(n) {
			enc.SetFilter(byte(i % 4))
			msgs, recon := websdrADPCMEncodeSignal(enc, sig.pcm, websdrADPCMSMeter(-73.4))
			want = append(want, recon...)
			for _, m := range msgs {
				_ = binary.Write(&stream, binary.LittleEndian, uint32(len(m)))
				stream.Write(m)
			}
			// Mute between signals, as squelch would.
			var mute []int16
			enc.recon = &mute
			m := enc.Silence(nil, 300)
			want = append(want, mute...)
			_ = binary.Write(&stream, binary.LittleEndian, uint32(len(m)))
			stream.Write(m)
		}

		cmd := exec.Command(node, "testdata/websdr_adpcm_harness.js", "websdr/websdr-sound-adpcm.js")
		cmd.Stdin = &stream
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil {
			t.Fatalf("harness: %v\n%s", err, stderr.String())
		}
		var res struct {
			PCM    string `json:"pcm"`
			SMeter int    `json:"smeter"`
			Rate   int    `json:"rate"`
			URL    string `json:"url"`
		}
		if err := json.Unmarshal(out, &res); err != nil {
			t.Fatalf("harness output: %v", err)
		}
		raw, _ := base64.StdEncoding.DecodeString(res.PCM)
		got := make([]int16, len(raw)/2)
		_ = binary.Read(bytes.NewReader(raw), binary.LittleEndian, got)

		if len(got) != len(want) {
			t.Fatalf("integ %v: client decoded %d samples, encoder expected %d", integ, len(got), len(want))
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("integ %v: sample %d: client decoded %d, encoder expected %d", integ, i, got[i], want[i])
			}
		}
		if res.Rate != 8000 {
			t.Errorf("client rate %d, want 8000", res.Rate)
		}
		// websdr-base.js shows smeter()/100 - 127 dBFS.
		if dB := float64(res.SMeter)/100 - 127; math.Abs(dB-(-73.4)) > 0.05 {
			t.Errorf("client S-meter reads %.2f dBFS, want -73.4", dB)
		}
		t.Logf("integ %v: %d samples bit-exact through the original client", integ, len(got))
	}
}

func TestWebSDRALaw(t *testing.T) {
	for b := 0; b < 256; b++ {
		if got := websdrALawEncode(websdrALawDecode(byte(b))); got != byte(b) {
			t.Errorf("A-law %#02x decodes to %d, which encodes to %#02x", b, websdrALawDecode(byte(b)), got)
		}
	}
	// The decoder's 0x80 table, first and last entries of each sign half.
	for b, want := range map[byte]int16{0x00: -5504, 0x7F: -848, 0x80: 5504, 0xFF: 848, 0xD5: 8, 0x55: -8} {
		if got := websdrALawDecode(b); got != want {
			t.Errorf("A-law %#02x = %d, want %d", b, got, want)
		}
	}
	// Every input lands on the nearest level of its segment.
	for x := -32768; x <= 32767; x++ {
		got := int(websdrALawDecode(websdrALawEncode(int16(x))))
		d := got - x
		if d < 0 {
			d = -d
		}
		if d > 1024 || (x > -64 && x < 64 && d > 8) {
			t.Fatalf("A-law %d reconstructs as %d", x, got)
		}
	}
}

func TestWebSDRADPCMFilterFor(t *testing.T) {
	for _, c := range []struct {
		lo, hi float64
		want   byte
	}{
		{-400, 400, websdrADPCMFilter1k0},   // CW
		{300, 2400, websdrADPCMFilter2k6},   // narrow SSB
		{300, 2700, websdrADPCMFilter3k8},   // USB
		{-2700, -300, websdrADPCMFilter3k8}, // LSB
		{-4500, 4500, websdrADPCMFilter6k1}, // AM
	} {
		if got := websdrADPCMFilterFor(c.lo, c.hi); got != c.want {
			t.Errorf("passband %v..%v Hz: filter %d, want %d", c.lo, c.hi, got, c.want)
		}
	}
}

func TestWebSDRADPCMHeaders(t *testing.T) {
	tone := websdrADPCMSignals(128)[1].pcm
	enc := newWebSDRADPCMEncoder(128)
	enc.SetRate(12000)
	m := enc.Encode(nil, tone[:50], websdrADPCMSMeter(-127))
	// S-meter, rate, step, conversion; 50 samples is short of a block so no audio.
	if want := []byte{0xF0, 0, 0x81, 0x2E, 0xE0, 0x82, 0, 128, 0x83, 0}; !bytes.Equal(m, want) {
		t.Fatalf("first message % x, want % x", m, want)
	}
	// Nothing changed, so no headers; the held 50 samples and 78 more make the first
	// block, which has to tell the decoder its mode.
	m = enc.Encode(nil, tone[50:], -1)
	if len(m) == 0 || m[0] < 0x90 || m[0] > 0xDF {
		t.Fatalf("second message % x does not open with a mode-setting ADPCM block", m)
	}
	// Digital silence is one byte per block.
	if m = enc.Encode(nil, make([]int16, 256), -1); !bytes.Equal(m, []byte{0x84, 0x84}) {
		t.Fatalf("silence % x, want 84 84", m)
	}
	enc.SetFilter(websdrADPCMFilter1k0)
	enc.SetRate(24000)
	m = enc.Encode(nil, nil, -1)
	if want := []byte{0x81, 0x5D, 0xC0, 0x83, 2}; !bytes.Equal(m, want) {
		t.Fatalf("after changes % x, want % x", m, want)
	}
}

// /websdr-sound.js is our Opus client unless websdr_adpcm_audio is set.
func TestWebSDRServeSoundJS(t *testing.T) {
	for adpcm, file := range map[bool]string{
		false: "websdr/websdr-sound.js",
		true:  "websdr/websdr-sound-adpcm.js",
	} {
		h := &WebSDRHandler{sessions: &SessionManager{}, config: &Config{}}
		h.config.Server.WebSDRADPCMAudio = adpcm
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", "/websdr-sound.js", nil))
		want, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), want) {
			t.Errorf("adpcm %v: got %d, %d bytes; want %s", adpcm, rec.Code, rec.Body.Len(), file)
		}
	}
}

// Drives streamADPCMAudio over a real websocket: radiod's big-endian packets in,
// messages the client decodes out, with the passband choosing the filter and mute
// sending silence.
func TestWebSDRStreamADPCMAudio(t *testing.T) {
	tone := websdrADPCMSignals(1200)[1].pcm // 1200 samples, not a whole number of blocks
	pcm := make([]byte, 2*len(tone))
	for i, x := range tone {
		binary.BigEndian.PutUint16(pcm[2*i:], uint16(x))
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websdrUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		h := &WebSDRHandler{sessions: &SessionManager{}, config: &Config{}}
		c := newWebSDRConn(conn, h, "127.0.0.1")
		c.loKHz, c.hiKHz = 0.3, 2.7
		c.session = &Session{AudioChan: make(chan AudioPacket, 4), Done: make(chan struct{})}
		c.session.AudioChan <- AudioPacket{PCMData: pcm, SampleRate: 12000, Channels: 1}
		c.session.AudioChan <- AudioPacket{PCMData: pcm, SampleRate: 12000, Channels: 2} // IQ: dropped
		go func() {
			// Mute once the first two have been taken, then send a third.
			time.Sleep(50 * time.Millisecond)
			c.mu.Lock()
			c.mute = 1
			c.mu.Unlock()
			c.session.AudioChan <- AudioPacket{PCMData: pcm, SampleRate: 12000, Channels: 1}
			time.Sleep(200 * time.Millisecond)
			close(c.session.Done)
		}()
		c.streamADPCMAudio(make(chan struct{}))
		conn.Close()
	}))
	defer srv.Close()

	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer ws.Close()
	var d websdrADPCMRefDecoder
	msgs := 0
	_ = ws.SetReadDeadline(time.Now().Add(2 * time.Second))
	for {
		_, m, err := ws.ReadMessage()
		if err != nil {
			break
		}
		d.message(m)
		msgs++
	}
	if msgs != 2 {
		t.Fatalf("%d messages, want 2 (the IQ packet sends nothing)", msgs)
	}
	if d.C != 12000 || d.ia != websdrADPCMStep || d.conv != websdrADPCMFilter3k8 {
		t.Errorf("rate %d step %d conv %#x, want 12000, %d, filter 0 with the integrator on", d.C, d.ia, d.conv, websdrADPCMStep)
	}
	// 1200 samples make 9 blocks, holding 48; muted, those and the next packet go
	// out as 10 silent blocks.
	if len(d.out) != 19*128 {
		t.Fatalf("decoded %d samples, want %d", len(d.out), 19*128)
	}
	if snr := websdrADPCMSNR(tone[:9*128], d.out[:9*128]); snr < 30 {
		t.Errorf("tone SNR %.1f dB", snr)
	}
	for i, x := range d.out[9*128:] {
		if x != 0 {
			t.Fatalf("muted sample %d is %d", i, x)
		}
	}
}
