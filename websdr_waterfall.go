package main

import "math"

// websdr_waterfall.go — WebSDR waterfall row encoder
//
// Implements format 9 (§4.3) and format 10 (§4.4) row encoding from the
// VertexSDR frontend-protocol-spec.md, plus the init frames (§4.2) and
// escape rule (§4.5).

// ─────────────────────────────────────────────────────────────────────────────
// Huffman symbol tables (§4.3)
// ─────────────────────────────────────────────────────────────────────────────

// wfSymbol holds a Huffman code for one residual value r.
type wfSymbol struct {
	r     int
	bits  int // code word (MSB-aligned in the low bits)
	nbits int
}

// table0 — 17 symbols (m=0)
var wfTable0 = []wfSymbol{
	{0, 0b0, 1},
	{1, 0b100, 3},
	{-1, 0b101, 3},
	{3, 0b110, 3},
	{-3, 0b1110, 4},
	{5, 0b1111000, 7},
	{7, 0b1111001, 7},
	{-5, 0b1111100, 7},
	{-7, 0b1111101, 7},
	{9, 0b11110100, 8},
	{11, 0b11110101, 8},
	{13, 0b11110110, 8},
	{15, 0b11110111, 8},
	{-9, 0b11111100, 8},
	{-11, 0b11111101, 8},
	{-13, 0b11111110, 8},
	{-15, 0b11111111, 8},
}

// table1 — 3 symbols (m=1)
var wfTable1 = []wfSymbol{
	{0, 0b0, 1},
	{1, 0b10, 2},
	{-1, 0b11, 2},
}

// table2 — 15 symbols (m=2)
var wfTable2 = []wfSymbol{
	{0, 0b0, 1},
	{3, 0b100, 3},
	{-3, 0b101, 3},
	{5, 0b110, 3},
	{-5, 0b1110, 4},
	{7, 0b1111000, 7},
	{9, 0b1111001, 7},
	{11, 0b1111010, 7},
	{-7, 0b1111100, 7},
	{-9, 0b1111101, 7},
	{-11, 0b1111110, 7},
	{13, 0b11110110, 8},
	{15, 0b11110111, 8},
	{-13, 0b11111110, 8},
	{-15, 0b11111111, 8},
}

var wfTables = [3][]wfSymbol{wfTable0, wfTable1, wfTable2}

// rValues returns the set of r values available in table m.
func rValues(m int) []int {
	syms := wfTables[m]
	rs := make([]int, len(syms))
	for i, s := range syms {
		rs[i] = s.r
	}
	return rs
}

// encodeSymbol writes the Huffman code for residual r in table m into bw.
// Falls back to a single 0 bit if r is not in the table.
func encodeSymbol(bw *wfBitWriter, m, r int) {
	for _, s := range wfTables[m] {
		if s.r == r {
			bw.writeBits(s.bits, s.nbits)
			return
		}
	}
	// Fallback: write 0 bit
	bw.writeBits(0, 1)
}

// ─────────────────────────────────────────────────────────────────────────────
// Format 9 encoder (§4.3)
// ─────────────────────────────────────────────────────────────────────────────

// WebSDRWaterfallState holds per-connection waterfall encoder state.
type WebSDRWaterfallState struct {
	prevRow [1024]byte // initialised to 0x08
	prevN   [1024]byte // format 10 run-length counters (initialised to 0x00)
	format  int        // 9 or 10
}

// NewWebSDRWaterfallState creates a fresh waterfall state for the given format.
func NewWebSDRWaterfallState(format int) *WebSDRWaterfallState {
	s := &WebSDRWaterfallState{format: format}
	for i := range s.prevRow {
		s.prevRow[i] = 0x08
	}
	return s
}

// Reset reinitialises the state (called when band/zoom/width changes).
func (s *WebSDRWaterfallState) Reset() {
	for i := range s.prevRow {
		s.prevRow[i] = 0x08
	}
	for i := range s.prevN {
		s.prevN[i] = 0x00
	}
}

// EncodeRow encodes one waterfall row (src must be exactly width pixels, 0–255).
// Returns the wire bytes including the escape prefix if needed (§4.5).
func (s *WebSDRWaterfallState) EncodeRow(src []byte) []byte {
	width := len(src)
	if width > 1024 {
		width = 1024
	}

	bw := &wfBitWriter{}
	m := 0 // current symbol table index

	if s.format == 10 {
		s.encodeRowF10(bw, src, width, &m)
	} else {
		s.encodeRowF9(bw, src, width, &m)
	}

	raw := bw.bytes()

	// Escape rule (§4.5): if first byte is 0xFF, prepend an extra 0xFF
	if len(raw) > 0 && raw[0] == 0xFF {
		escaped := make([]byte, 1+len(raw))
		escaped[0] = 0xFF
		copy(escaped[1:], raw)
		return escaped
	}
	return raw
}

func (s *WebSDRWaterfallState) encodeRowF9(bw *wfBitWriter, src []byte, width int, m *int) {
	vel := 0 // velocity (slope predictor)

	for k := 0; k < width; k++ {
		target := int(src[k])
		prevP := int(s.prevRow[k])

		r := bestRF9(prevP, vel, target, *m)
		encodeSymbol(bw, *m, r)

		vel += r * 16
		newP := prevP + vel
		if newP < 8 {
			newP = 8
		}
		if newP > 248 {
			newP = 248
		}
		s.prevRow[k] = byte(newP)

		// Update table selection
		switch {
		case r == 0:
			*m = 0
		case r == 1 || r == -1:
			*m = 1
		default:
			*m = 2
		}
	}
}

func (s *WebSDRWaterfallState) encodeRowF10(bw *wfBitWriter, src []byte, width int, m *int) {
	for k := 0; k < width; k++ {
		target := int(src[k])
		prevP := int(s.prevRow[k])
		n := int(s.prevN[k])
		if n > 4 {
			n = 4
		}

		r := bestRF10(prevP, target, *m, n)
		encodeSymbol(bw, *m, r)

		delta := r * 16
		if delta == 16 || delta == -16 {
			delta >>= uint(n)
		}
		newP := prevP + delta
		if newP < 0 {
			newP = 0
		}
		if newP > 255 {
			newP = 255
		}
		s.prevRow[k] = byte(newP)

		// Update n
		if delta == 0 {
			n++
			if n > 4 {
				n = 4
			}
		} else {
			n = 0
		}
		s.prevN[k] = byte(n)

		// Update table selection
		switch {
		case r == 0:
			*m = 0
		case r == 1 || r == -1:
			*m = 1
		default:
			*m = 2
		}
	}
}

// bestRF9 finds the r value (from table m) that minimises |new_p - target|
// using the format 9 velocity predictor.
func bestRF9(prevP, vel, target, m int) int {
	bestR := 0
	bestDiff := 1 << 30
	for _, r := range rValues(m) {
		newVel := vel + r*16
		newP := prevP + newVel
		if newP < 8 {
			newP = 8
		}
		if newP > 248 {
			newP = 248
		}
		diff := newP - target
		if diff < 0 {
			diff = -diff
		}
		if diff < bestDiff {
			bestDiff = diff
			bestR = r
		}
	}
	return bestR
}

// bestRF10 finds the r value (from table m) that minimises |new_p - target|
// using the format 10 run-length predictor.
func bestRF10(prevP, target, m, n int) int {
	bestR := 0
	bestDiff := 1 << 30
	for _, r := range rValues(m) {
		delta := r * 16
		if delta == 16 || delta == -16 {
			delta >>= uint(n)
		}
		newP := prevP + delta
		if newP < 0 {
			newP = 0
		}
		if newP > 255 {
			newP = 255
		}
		diff := newP - target
		if diff < 0 {
			diff = -diff
		}
		if diff < bestDiff {
			bestDiff = diff
			bestR = r
		}
	}
	return bestR
}

// ─────────────────────────────────────────────────────────────────────────────
// Init frames (§4.2)
// ─────────────────────────────────────────────────────────────────────────────

// WebSDRWaterfallInitFrames returns the two init frames that must be sent
// before the first row after a connect or parameter reset.
//
//	zoom     — current zoom level (0–N)
//	wfOffset — start pixel offset (little-endian 32-bit)
//	wfWidth  — waterfall pixel width (little-endian 16-bit)
func WebSDRWaterfallInitFrames(zoom, wfOffset, wfWidth int) (frame1, frame2 []byte) {
	// Init Frame 1 — Viewport Config (9 bytes)
	frame1 = []byte{
		0xFF, 0x01,
		byte(zoom & 0x7F),
		byte(wfOffset & 0xFF),
		byte((wfOffset >> 8) & 0xFF),
		byte((wfOffset >> 16) & 0xFF),
		byte((wfOffset >> 24) & 0xFF),
		0x00, 0x00,
	}

	// Init Frame 2 — Width Config (4 bytes)
	frame2 = []byte{
		0xFF, 0x02,
		byte(wfWidth & 0xFF),
		byte((wfWidth >> 8) & 0xFF),
	}
	return
}

// ─────────────────────────────────────────────────────────────────────────────
// Pixel value mapping (§4.6)
// ─────────────────────────────────────────────────────────────────────────────

// WebSDRPixelFromPower converts a float32 power value (from radiod FFT) to a
// 0–255 pixel index using the formula from §4.6.
//
//	gainAdj — per-band floating-point gain adjustment factor
func WebSDRPixelFromPower(power float32, gainAdj float32) byte {
	// Reinterpret float32 bits as uint32
	pu := math.Float32bits(power)
	gainOffset := int(gainAdj*(128.0/3.0)) - 17106
	idx := (int(int16(pu>>16)) + gainOffset) / 13
	if idx < 0 {
		idx = 0
	}
	if idx > 255 {
		idx = 255
	}
	return byte(idx)
}

// ─────────────────────────────────────────────────────────────────────────────
// wfBitWriter — MSB-first bit packing for waterfall rows
// ─────────────────────────────────────────────────────────────────────────────

type wfBitWriter struct {
	buf    []byte
	bitPos int // bits written into current byte (0 = byte not yet started)
}

func (bw *wfBitWriter) writeBits(val, n int) {
	for n > 0 {
		if bw.bitPos == 0 || bw.bitPos == 8 {
			bw.buf = append(bw.buf, 0)
			bw.bitPos = 0
		}
		avail := 8 - bw.bitPos
		take := n
		if take > avail {
			take = avail
		}
		shift := n - take
		bits := (val >> shift) & ((1 << take) - 1)
		bw.buf[len(bw.buf)-1] |= byte(bits << (avail - take))
		bw.bitPos += take
		n -= take
	}
}

func (bw *wfBitWriter) bytes() []byte {
	return bw.buf
}
