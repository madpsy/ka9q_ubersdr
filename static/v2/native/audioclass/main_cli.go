//go:build !(js && wasm)

// main_cli.go — the same classifier as a command, for checking it on
// recordings before believing what the page says:
//
//	go run ./static/v2/native/audioclass -model mn05_as_mAP_443.pt rec.wav ...
//
// Each WAV (16-bit PCM, any rate, mixed to mono) is cut into back-to-back
// windows and each window's verdict printed — v, m, n or s for voice, music,
// noise and silent — followed by the share of each.
package main

import (
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	modelPath := flag.String("model", "", "EfficientAT .pt file (mn05_as_mAP_443.pt)")
	name := flag.String("name", "mn05", "which model the file is: mn05, mn10 or mn20")
	window := flag.Float64("window", 5, "window length, seconds")
	flag.Parse()
	width, ok := eatWidths[*name]
	if *modelPath == "" || !ok || flag.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: audioclass -model file.pt [-name mn05] [-window 5] rec.wav ...")
		os.Exit(2)
	}
	pt, err := os.ReadFile(*modelPath)
	if err != nil {
		fatal(err)
	}
	m, err := loadEfficientAT(pt, *name, width, 1)
	if err != nil {
		fatal(err)
	}
	for _, path := range flag.Args() {
		x, rate, err := readWAVMono(path)
		if err != nil {
			fatal(fmt.Errorf("%s: %w", path, err))
		}
		x = resample(x, rate, eatRate)
		n := int(*window * eatRate)
		var marks strings.Builder
		count := map[string]int{}
		for off := 0; off+n <= len(x); off += n {
			r := classifyWindow(m, x[off:off+n])
			marks.WriteByte(r.Label[0])
			count[r.Label]++
		}
		total := marks.Len()
		if total == 0 {
			fmt.Printf("%s: shorter than one window\n", filepath.Base(path))
			continue
		}
		pct := func(l string) float64 { return 100 * float64(count[l]) / float64(total) }
		fmt.Printf("%s: %s  voice %.0f%% music %.0f%% noise %.0f%% silent %.0f%%\n",
			filepath.Base(path), marks.String(), pct("voice"), pct("music"), pct("noise"), pct("silent"))
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

// readWAVMono reads a 16-bit PCM WAV, mixed to mono, as float32 in -1..1.
func readWAVMono(path string) ([]float32, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	var riff [12]byte
	if _, err := io.ReadFull(f, riff[:]); err != nil {
		return nil, 0, err
	}
	if string(riff[0:4]) != "RIFF" || string(riff[8:12]) != "WAVE" {
		return nil, 0, errors.New("not a WAV file")
	}
	var rate, channels, bits int
	for {
		var hdr [8]byte
		if _, err := io.ReadFull(f, hdr[:]); err != nil {
			return nil, 0, errors.New("no data chunk")
		}
		size := int64(binary.LittleEndian.Uint32(hdr[4:]))
		switch string(hdr[0:4]) {
		case "fmt ":
			b := make([]byte, size)
			if _, err := io.ReadFull(f, b); err != nil {
				return nil, 0, err
			}
			if binary.LittleEndian.Uint16(b[0:]) != 1 {
				return nil, 0, errors.New("not PCM")
			}
			channels = int(binary.LittleEndian.Uint16(b[2:]))
			rate = int(binary.LittleEndian.Uint32(b[4:]))
			bits = int(binary.LittleEndian.Uint16(b[14:]))
		case "data":
			if bits != 16 || channels < 1 {
				return nil, 0, fmt.Errorf("want 16-bit PCM, got %d-bit, %d channels", bits, channels)
			}
			// A recorder still writing leaves the size at zero or past the end.
			raw, err := io.ReadAll(io.LimitReader(f, sizeOrAll(size)))
			if err != nil {
				return nil, 0, err
			}
			frames := len(raw) / (2 * channels)
			out := make([]float32, frames)
			for i := range out {
				var v float32
				for c := 0; c < channels; c++ {
					v += float32(int16(binary.LittleEndian.Uint16(raw[2*(i*channels+c):]))) / 32768
				}
				out[i] = v / float32(channels)
			}
			return out, rate, nil
		default:
			if _, err := f.Seek(size+size&1, io.SeekCurrent); err != nil {
				return nil, 0, err
			}
		}
	}
}

func sizeOrAll(size int64) int64 {
	if size <= 0 {
		return 1 << 40
	}
	return size
}
