package main

import (
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/opus"
)

// TestServerEncoderRebuild retunes in place at the protocol level, bypassing the
// client's reconnect entirely, to check the server rebuilds its Opus encoder.
func TestServerEncoderRebuild(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("needs UBERSDR_TEST_SERVER")
	}
	host, secure := parseServer(target, false)

	sp, _ := NewClient(host, secure, "")
	if err := sp.CheckConnection(); err != nil {
		t.Fatal(err)
	}
	q := url.Values{}
	q.Set("user_session_id", sp.sessionID)
	q.Set("format", "opus")
	q.Set("version", "2")
	q.Set("frequency", "7100000")
	q.Set("mode", "lsb")
	scheme := "ws"
	if secure {
		scheme = "wss"
	}
	d := *websocket.DefaultDialer
	d.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	conn, _, err := d.Dial(fmt.Sprintf("%s://%s/ws?%s", scheme, host, q.Encode()), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	dec := opus.NewDecoder()
	out := make([]int16, 48000)

	// Frame durations by Opus config, RFC 6716 Table 2.
	frameMs := map[byte]float64{
		0: 10, 1: 20, 2: 40, 3: 60, 4: 10, 5: 20, 6: 40, 7: 60,
		8: 10, 9: 20, 10: 40, 11: 60, 12: 10, 13: 20, 14: 10, 15: 20,
	}

	observe := func(label string, seconds float64) {
		start := time.Now()
		pkts, samples := 0, 0
		tocs := map[byte]int{}
		var srcRate uint32
		for time.Since(start) < time.Duration(seconds*float64(time.Second)) {
			conn.SetReadDeadline(time.Now().Add(3 * time.Second))
			mt, data, err := conn.ReadMessage()
			if err != nil || mt != websocket.BinaryMessage || len(data) <= 21 {
				continue
			}
			pkts++
			srcRate = binary.LittleEndian.Uint32(data[8:12])
			tocs[data[21]]++
			if n, err := dec.DecodeToInt16(data[21:], out); err == nil {
				samples += n
			}
		}
		el := time.Since(start).Seconds()
		var toc byte
		for k := range tocs {
			toc = k
		}
		cfg := toc >> 3
		speed := float64(samples) / el / 48000
		t.Logf("%-22s src %5d Hz | %.0f pkt/s | TOC 0x%02x cfg %2d = %.0f ms | %.2fx real time",
			label, srcRate, float64(pkts)/el, toc, cfg, frameMs[cfg], speed)
		if speed < 0.9 || speed > 1.1 {
			t.Errorf("%s: %.2fx real time", label, speed)
		}
	}

	retune := func(mode string, low, high int) {
		cmd := map[string]interface{}{"type": "tune", "frequency": 7100000,
			"mode": mode, "bandwidthLow": low, "bandwidthHigh": high}
		b, _ := json.Marshal(cmd)
		t.Logf("-> %s", b)
		conn.WriteJSON(cmd)

		// Keep reading while the change takes effect. Sleeping instead would
		// let packets queue in the socket buffer, and draining that backlog
		// afterwards reads far faster than real time and inflates the result.
		settle := time.Now()
		for time.Since(settle) < 1500*time.Millisecond {
			conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			conn.ReadMessage()
		}
	}

	observe("LSB at connect", 2.5)
	retune("am", -5000, 5000)
	observe("AM after in-place tune", 2.5)
	retune("usb", 50, 2700)
	observe("USB after in-place tune", 2.5)
	retune("nfm", -5000, 5000)
	observe("NFM after in-place tune", 2.5)
	retune("cwl", -200, 200)
	observe("CWL after in-place tune", 2.5)
}
