package main

import (
	"context"
	"encoding/binary"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Temporary probe: the server's SSTV extension on 14.230 USB, every picture
// and callsign it reports logged, and the audio saved as a WAV beside it.
func TestZZSSTVProbe(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("set UBERSDR_TEST_SERVER")
	}
	mins, _ := strconv.Atoi(os.Getenv("PROBE_MINUTES"))
	if mins == 0 {
		mins = 2
	}
	out := os.Getenv("PROBE_WAV")
	host, secure := parseServer(target, false)
	sp, err := NewClient(host, secure, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := sp.CheckConnection(); err != nil {
		t.Fatalf("/connection: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(mins)*time.Minute+30*time.Second)
	defer cancel()

	ac := NewAudioClient(host, secure, "", sp.sessionID)
	ac.SetTuning(14_230_000, "usb", 50, 2700)
	go ac.Run(ctx)

	// Wait for audio before attaching: the extension taps a running session.
	var wav []int16
	rate := 0
	select {
	case p := <-ac.PCM:
		wav = append(wav, p.Samples...)
		rate = p.Rate
	case <-time.After(20 * time.Second):
		t.Fatal("no audio")
	}

	scheme := "ws"
	if secure {
		scheme = "wss"
	}
	u := url.URL{Scheme: scheme, Host: host, Path: "/ws/dxcluster", RawQuery: "user_session_id=" + sp.sessionID}
	d := websocket.Dialer{NetDialContext: dialFunc()}
	conn, _, err := d.DialContext(ctx, u.String(), nil)
	if err != nil {
		t.Fatalf("dxcluster dial: %v", err)
	}
	defer conn.Close()
	if err := conn.WriteJSON(map[string]interface{}{
		"type": "audio_extension_attach", "extension_name": "sstv",
		"params": map[string]interface{}{"auto_sync": true, "decode_fsk_id": true, "adaptive": true},
	}); err != nil {
		t.Fatal(err)
	}
	t0 := time.Now()
	stamp := func() string { return fmt.Sprintf("%6.1fs", time.Since(t0).Seconds()) }

	go func() {
		for {
			mt, b, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if mt == websocket.TextMessage {
				if len(b) > 200 {
					b = b[:200]
				}
				fmt.Printf("%s text %s\n", stamp(), b)
				continue
			}
			if len(b) == 0 {
				continue
			}
			switch b[0] {
			case 0x02:
				if len(b) >= 4 && int(b[3]) <= len(b)-4 {
					fmt.Printf("%s MODE %s\n", stamp(), b[4:4+int(b[3])])
				}
			case 0x07:
				fmt.Printf("%s START %dx%d\n", stamp(), binary.BigEndian.Uint32(b[1:]), binary.BigEndian.Uint32(b[5:]))
			case 0x05:
				fmt.Printf("%s COMPLETE %d\n", stamp(), binary.BigEndian.Uint32(b[1:]))
			case 0x06:
				fmt.Printf("%s CALLSIGN %q\n", stamp(), b[2:2+int(b[1])])
			case 0x03:
				if len(b) >= 4 {
					n := int(binary.BigEndian.Uint16(b[2:]))
					if n <= len(b)-4 {
						fmt.Printf("%s status %s\n", stamp(), b[4:4+n])
					}
				}
			}
		}
	}()

	end := time.After(time.Duration(mins) * time.Minute)
loop:
	for {
		select {
		case p := <-ac.PCM:
			wav = append(wav, p.Samples...)
		case <-ac.Level:
		case <-ac.Status:
		case <-end:
			break loop
		case <-ctx.Done():
			break loop
		}
	}
	if out != "" {
		writeWav(t, out, wav, rate)
		fmt.Printf("saved %.0f s at %d Hz to %s\n", float64(len(wav))/float64(rate), rate, out)
	}
}

func writeWav(t *testing.T, path string, s []int16, rate int) {
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	h := make([]byte, 44)
	copy(h, "RIFF")
	binary.LittleEndian.PutUint32(h[4:], uint32(36+2*len(s)))
	copy(h[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(h[16:], 16)
	binary.LittleEndian.PutUint16(h[20:], 1)
	binary.LittleEndian.PutUint16(h[22:], 1)
	binary.LittleEndian.PutUint32(h[24:], uint32(rate))
	binary.LittleEndian.PutUint32(h[28:], uint32(rate*2))
	binary.LittleEndian.PutUint16(h[32:], 2)
	binary.LittleEndian.PutUint16(h[34:], 16)
	copy(h[36:], "data")
	binary.LittleEndian.PutUint32(h[40:], uint32(2*len(s)))
	f.Write(h)
	binary.Write(f, binary.LittleEndian, s)
}
