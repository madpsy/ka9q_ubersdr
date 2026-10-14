package main

// Frozen copies of the spectrogram render path as it was before it was
// optimised, so spectrogram_render_test.go can require byte-identical PNGs and
// identical auto ranges from the current code. Do not "fix" these.

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"math"
	"sort"
)

func refPaletteColour(palette string, db, dbMin, dbMax float32) color.NRGBA {
	t := (db - dbMin) / (dbMax - dbMin)
	if t < 0 {
		t = 0
	}
	if t > 1 {
		t = 1
	}
	idx := int(t * 255.0)
	if idx > 255 {
		idx = 255
	}
	var lut *[256][3]uint8
	switch palette {
	case "plasma":
		lut = &plasmaLUT
	case "jet":
		lut = &jetLUT
	default:
		lut = &viridisLUT
	}
	return color.NRGBA{lut[idx][0], lut[idx][1], lut[idx][2], 255}
}

func refAutoRangeRowsSlice(rows [][]float32, startBin, endBin int, configMin, configMax float32) (float32, float32) {
	// Collect a sample of valid values — cap at 500 k to keep memory bounded
	const maxSamples = 500_000
	binCount := 0
	if len(rows) > 0 {
		binCount = len(rows[0])
	}
	// Normalise bin bounds
	if startBin < 0 {
		startBin = 0
	}
	if endBin <= 0 || endBin > binCount {
		endBin = binCount
	}
	if startBin >= endBin {
		startBin = 0
		endBin = binCount
	}
	valid := make([]float32, 0, min(len(rows)*(endBin-startBin), maxSamples))
	for _, row := range rows {
		if len(row) < endBin {
			continue // skip malformed rows
		}
		for _, v := range row[startBin:endBin] {
			if math.IsInf(float64(v), -1) || math.IsNaN(float64(v)) {
				continue
			}
			valid = append(valid, v)
			if len(valid) >= maxSamples {
				goto done
			}
		}
	}
done:
	if len(valid) < 10 {
		return configMin, configMax
	}
	refSortFloat32Slice(valid)
	// Use P5 for floor (noise floor estimate) and the actual maximum + 3 dB for ceiling.
	// Adding headroom above the true maximum ensures the strongest signals never clip to
	// palette index 255 (dark maroon in Jet, which appears black on dark backgrounds).
	p5idx := len(valid) * 5 / 100
	if p5idx >= len(valid) {
		p5idx = len(valid) - 1
	}
	dbMin := valid[p5idx]
	dbMax := valid[len(valid)-1] + 3 // actual max + 3 dB headroom
	// Ensure a minimum 10 dB spread to avoid degenerate images
	if dbMax-dbMin < 10 {
		dbMax = dbMin + 10
	}
	return dbMin, dbMax
}

func refRenderRowsAsPNGSlice(rows [][]float32, palette string, dbMin, dbMax float32, binCount int, startBin, endBin int) []byte {
	rowCount := len(rows)
	if rowCount == 0 {
		return nil
	}
	// Normalise bin bounds
	if startBin < 0 {
		startBin = 0
	}
	if endBin <= 0 || endBin > binCount {
		endBin = binCount
	}
	if startBin >= endBin {
		startBin = 0
		endBin = binCount
	}
	width := endBin - startBin
	img := image.NewNRGBA(image.Rect(0, 0, width, rowCount))
	black := color.NRGBA{0, 0, 0, 255}

	for y, row := range rows {
		if len(row) < endBin {
			continue // skip malformed rows
		}
		for x, val := range row[startBin:endBin] {
			if math.IsInf(float64(val), -1) || math.IsNaN(float64(val)) {
				img.SetNRGBA(x, y, black)
			} else {
				img.SetNRGBA(x, y, refPaletteColour(palette, val, dbMin, dbMax))
			}
		}
	}

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil
	}
	return buf.Bytes()
}

func refSortFloat32Slice(s []float32) {
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
}
