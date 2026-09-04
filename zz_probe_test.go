package main

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Live probe: connect to a server exactly as the HPSDR bridge does and report
// what the link actually carries, per five seconds.
func TestZZProbe(t *testing.T) {
	base := os.Getenv("PROBE_URL")
	if base == "" {
		t.Skip("set PROBE_URL")
	}
	freq := os.Getenv("PROBE_FREQ")
	mode := os.Getenv("PROBE_MODE")
	margin := os.Getenv("PROBE_MARGIN")
	secs := 150
	if v := os.Getenv("PROBE_SECS"); v != "" {
		fmt.Sscan(v, &secs)
	}

	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	sess := h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]

	resp, err := http.Post(base+"/connection", "application/json",
		bytes.NewReader([]byte(fmt.Sprintf(`{"user_session_id":%q,"password":""}`, sess))))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	q := fmt.Sprintf("/ws?frequency=%s&mode=%s&user_session_id=%s&format=pcm-zstd&version=4",
		freq, mode, sess)
	if margin != "" {
		q += "&min_margin=" + margin
	}
	u := "ws" + base[4:] + q
	t.Log("connecting", u)
	c, _, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	var dump *os.File
	if d := os.Getenv("PROBE_DUMP"); d != "" {
		var err error
		dump, err = os.Create(d)
		if err != nil {
			t.Fatal(err)
		}
		defer dump.Close()
	}

	dec := NewPCMv4StreamDecoder()
	hdr := NewPCMv4HeaderDecoder()
	_ = hdr

	start := time.Now()
	mark := start
	var bytesAcc, pkts, samps int64
	var shiftSum, shiftN, escapes int64
	var minShift, maxShift = 99, -1
	lastRate := 0
	for time.Since(start) < time.Duration(secs)*time.Second {
		c.SetReadDeadline(time.Now().Add(10 * time.Second))
		typ, msg, err := c.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		if typ != websocket.BinaryMessage {
			if len(msg) < 300 {
				t.Log("text:", string(msg))
			}
			continue
		}
		bytesAcc += int64(len(msg))
		pkts++
		h, sm, err := dec.DecodePacket(msg)
		if err != nil {
			t.Log("decode:", err)
			continue
		}
		if h.Escape {
			escapes++
		}
		if dump != nil {
			buf := make([]byte, len(sm)*2)
			for i, v := range sm {
				binary.LittleEndian.PutUint16(buf[2*i:], uint16(v))
			}
			dump.Write(buf)
		}
		samps += int64(h.SampleCount)
		lastRate = h.SampleRate
		if h.Profile == PredProfileIQScaled && !h.Silent {
			// recover the shift: re-decode header for the offset
			_, off, _ := hdr.Decode(msg)
			if off < len(msg) {
				s := int(msg[off])
				shiftSum += int64(s)
				shiftN++
				if s < minShift {
					minShift = s
				}
				if s > maxShift {
					maxShift = s
				}
			}
		}
		if time.Since(mark) >= 5*time.Second {
			el := time.Since(mark).Seconds()
			avgShift := 0.0
			if shiftN > 0 {
				avgShift = float64(shiftSum) / float64(shiftN)
			}
			t.Logf("t=%5.1fs %8.1f kbps  pkts/s=%5.0f  bits/sample=%5.2f  rate=%d  shift avg=%.2f min=%d max=%d  escape=%d",
				time.Since(start).Seconds(),
				float64(bytesAcc)*8/1000/el,
				float64(pkts)/el, float64(bytesAcc)*8/float64(samps), lastRate,
				avgShift, minShift, maxShift, escapes)
			bytesAcc, pkts, samps, shiftSum, shiftN, escapes = 0, 0, 0, 0, 0, 0
			minShift, maxShift = 99, -1
			mark = time.Now()
		}
	}
}
