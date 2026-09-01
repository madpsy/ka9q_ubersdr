package main

import (
	"context"
	"encoding/binary"
	"io"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestLivePCMv4Stream reads a real receiver's version 4 stream, in both formats,
// and checks that every frame decodes.
//
// The golden-fixture tests prove the decoder agrees with the encoder in this
// repository. This proves the connect and the frame routing work against a
// server as deployed: that asking for version 4 is accepted, that the frames
// which come back are the shape the routing expects, and that the headers keep
// parsing over a run long enough to cross several resynchronisations.
//
// A receiver older than 0.1.63 cannot serve version 4 and there is nothing here
// to check against one, so the test skips rather than failing when it meets one.
//
// Skipped unless UBERSDR_TEST_SERVER is set, e.g.
//
//	UBERSDR_TEST_SERVER=http://m9psy.tunnel.ubersdr.org go test -run TestLivePCMv4Stream -v
func TestLivePCMv4Stream(t *testing.T) {
	target := os.Getenv("UBERSDR_TEST_SERVER")
	if target == "" {
		t.Skip("set UBERSDR_TEST_SERVER to run the live version 4 stream test")
	}

	for _, format := range []AudioFormat{FormatPCMZstd, FormatOpus} {
		name := "pcm-zstd"
		if format == FormatOpus {
			name = "opus"
		}
		t.Run(name, func(t *testing.T) {
			client := NewRadioClient()
			client.BaseURL = target
			client.Password = os.Getenv("UBERSDR_TEST_PASSWORD")
			client.Frequency = 9410000
			client.Mode = "am"
			client.BandwidthLow = -4000
			client.BandwidthHigh = 4000
			client.Format = format

			// The server authorises a session on /connection before it will
			// serve one on the socket, exactly as runLoop does.
			cr, err := client.checkConnectionAllowed()
			if err != nil {
				t.Fatalf("/connection: %v", err)
			}
			if !cr.Allowed {
				t.Skip("server declined the connection")
			}

			wsURL, err := client.buildWSURL()
			if err != nil {
				t.Fatalf("buildWSURL: %v", err)
			}

			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()

			headers := http.Header{}
			headers.Set("User-Agent", "UberSDR-Audio/1.0")
			conn, resp, err := websocket.DefaultDialer.DialContext(ctx, wsURL, headers)
			if err != nil {
				// From 0.1.63 a server refuses a version it cannot serve, with
				// the reason in a 400.
				if resp != nil && resp.StatusCode == http.StatusBadRequest {
					body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
					resp.Body.Close()
					t.Skipf("server refused version %d: %s", pcmProtocolVersion, body)
				}
				t.Fatalf("dial: %v", err)
			}
			defer conn.Close()

			pcmV4 := NewPCMv4StreamDecoder()
			opusV4 := NewPCMv4HeaderDecoder()

			// Opus frames are decoded for real, not just parsed. A header read
			// one byte short still yields a plausible sample rate, and only
			// libopus rejecting the packet would show it.
			var opusDec *opusDecoder
			defer func() {
				if opusDec != nil {
					opusDec.Close()
				}
			}()
			var peak int16

			// Long enough to cross several five-second resynchronisations, and
			// then some: a predictor left out of step decodes on regardless, so
			// what this is really watching for is a header that stops parsing.
			var pcmFrames, opusFrames, samples int
			deadline := time.Now().Add(20 * time.Second)
			for time.Now().Before(deadline) {
				conn.SetReadDeadline(time.Now().Add(10 * time.Second))
				kind, data, err := conn.ReadMessage()
				if err != nil {
					t.Fatalf("read after %d frames: %v", pcmFrames+opusFrames, err)
				}
				if kind != websocket.BinaryMessage {
					continue
				}

				switch {
				case PCMv4IsHeader(data):
					pcmLE, rate, ch, _, _, err := pcmV4.DecodePacketLE(data)
					if err != nil {
						t.Fatalf("pcm frame %d: %v", pcmFrames, err)
					}
					if rate <= 0 || ch <= 0 || len(pcmLE) == 0 {
						t.Fatalf("pcm frame %d: %d Hz, %d ch, %d bytes", pcmFrames, rate, ch, len(pcmLE))
					}
					pcmFrames++
					samples += len(pcmLE) / 2
					for i := 0; i+1 < len(pcmLE); i += 2 {
						v := int16(binary.LittleEndian.Uint16(pcmLE[i:]))
						if v > peak {
							peak = v
						}
					}
				case isZstdFrame(data):
					// Servers before 0.1.63 clamp the requested version to 1-3
					// and silently serve version 1 rather than refusing, which
					// is the case noteLegacyStream exists for. There is no
					// version 4 stream to check against such a receiver.
					t.Skip("server predates version 4: it served a zstd frame")
				default:
					f, err := parseOpusFrame(data, opusV4)
					if err != nil {
						if opusFrames == 0 {
							t.Skipf("server predates version 4: %v", err)
						}
						t.Fatalf("opus frame %d: %v", opusFrames, err)
					}
					if f.sampleRate <= 0 || f.channels <= 0 || len(f.opus) == 0 {
						t.Fatalf("opus frame %d: %d Hz, %d ch, %d bytes", opusFrames, f.sampleRate, f.channels, len(f.opus))
					}
					pcm, err := decodeOpusFrame(f, &opusDec)
					if err != nil {
						t.Fatalf("opus frame %d: decode: %v", opusFrames, err)
					}
					if len(pcm) == 0 {
						t.Fatalf("opus frame %d: decoded to nothing", opusFrames)
					}
					for i := 0; i+1 < len(pcm); i += 2 {
						v := int16(binary.LittleEndian.Uint16(pcm[i:]))
						if v > peak {
							peak = v
						}
					}
					opusFrames++
					samples += len(pcm) / 2
				}

				if pcmFrames+opusFrames >= 600 {
					break
				}
			}

			t.Logf("%s: %d lossless frames, %d opus frames, ~%.1f s of audio, peak %d",
				name, pcmFrames, opusFrames, float64(samples)/12000, peak)
			if pcmFrames+opusFrames < 50 {
				t.Fatalf("only %d frames arrived", pcmFrames+opusFrames)
			}
			if format == FormatPCMZstd && pcmFrames == 0 {
				t.Fatal("no lossless frames on a pcm-zstd session")
			}
			// A decoder out of step with the encoder, or one silently returning
			// zeros, would pass everything above. Twelve seconds of a real
			// receiver is never digital silence.
			if peak == 0 {
				t.Fatal("every sample decoded to zero")
			}
		})
	}
}
