package main

import (
	"encoding/binary"
	"math"
	"time"
)

// Spectrum wire protocol version 2
// ================================
//
// Version 1 sends one of two frame shapes: a full frame of one byte per bin, or
// a delta listing every changed bin as [index uint16, value uint8]. Measured
// against a live receiver at 1024 bins and 10 frames a second, that comes to
// about 11.1 kB/s -- and most of it is spent badly.
//
// WHAT WAS WRONG WITH VERSION 1
// -----------------------------
// 1. The delta usually costs MORE than the full frame it avoids. Three bytes a
//    change means a delta only wins below 341 changes out of 1024, but the
//    server only falls back to a full frame at 80% (819). Between those two
//    figures it sends a bigger packet than it needed to, and measurement says
//    that is where it usually sits: 35% of bins change in a typical frame, and
//    roughly 63% of delta frames came out larger than a full frame.
//
// 2. Two of every three delta bytes are the index. A one-bit-per-bin mask says
//    the same thing in 128 bytes flat for 1024 bins, and wins above 64 changes.
//
// 3. The 8-bit code spans 256 dB, at 1 dB a step. The bins actually occupy
//    about 90 dB, so more than half the range was never reachable while the
//    resolution was coarser than it needed to be.
//
// 4. The conversion truncated rather than rounded, biasing every reading up to
//    a decibel low.
//
// 5. A bin at 0 dBFS or above encoded as uint8(0+256), which wraps to 0 and
//    decodes as -256 dB -- the brightest possible input rendering as the
//    darkest possible output.
//
// 6. There was no sequence number and no keyframe. The server updates its
//    record of what the client holds BEFORE the send, and the send is a
//    non-blocking write that drops the frame when the client is slow, so a
//    dropped delta desynchronised those bins permanently. Nothing detected it
//    and nothing corrected it until a bin-count change or an 80%-change frame
//    happened by luck.
//
// WHAT VERSION 2 DOES
// -------------------
//
//	[magic "SPEC"]        4   unchanged, so a receiver can still sort frames
//	[version = 2]         1
//	[flags]               1   0x05 full, 0x06 delta
//	[sequence uint16]     2   increments per frame; lets a client see a gap
//	[timestamp uint64]    8   nanoseconds, as version 1 actually sent
//	[centreFreq uint64]   8
//	                     24
//
//	full  0x05: [refCentiDB int16][stepCentiDB uint8][binCount × uint8]
//	delta 0x06: [mask ⌈bins/8⌉ bytes][value uint8 × bits set in mask]
//
// The scale travels with each full frame rather than being fixed, because the
// values move with the receiver's gain settings (Spectrum.GainDB and the
// per-frequency LUT) and a hardcoded window would clip on somebody's
// configuration. Deriving it from the data cannot clip on anyone's:
//
//	dB = refCentiDB/100 + code × stepCentiDB/100
//
// A delta frame carries no scale: it refers to whatever the last full frame
// established, which is why the scale may only change on a full frame.
//
// Measured on real frames, this is about 2.15x smaller than version 1 on the
// same content, taking a 1024-bin 10 Hz stream from ~11.1 to ~5.2 kB/s.

const (
	// SpectrumV2Version is the value in the header's version byte.
	SpectrumV2Version = 2

	// Frame types. Distinct from version 1's 0x01-0x04 so a mis-routed frame
	// fails a flags check rather than being read as the wrong shape.
	SpectrumV2FlagFull  = 0x05
	SpectrumV2FlagDelta = 0x06

	// spectrumV2HeaderSize is the fixed part of every frame.
	spectrumV2HeaderSize = 24

	// spectrumV2KeyframeInterval is how many frames may pass before a full one
	// is sent regardless of how little changed.
	//
	// This is what makes a dropped frame self-healing. The write is
	// non-blocking and drops when a slow client's buffer is full, so without a
	// keyframe those bins would stay wrong until something else forced a full
	// frame. At 10 frames a second this is a five second worst case, and it
	// costs roughly one full frame in fifty -- about 2% -- which is far less
	// than version 1 wasted on oversized deltas.
	spectrumV2KeyframeInterval = 50

	// Quantisation bounds. A step is expressed in centidecibels so the scale
	// can be sent in one byte; half a decibel is finer than the display
	// resolves and comfortably covers the ~90 dB the bins occupy.
	spectrumV2MinStepCentiDB = 25  // 0.25 dB
	spectrumV2MaxStepCentiDB = 255 // 2.55 dB, only reached by an absurd span
	spectrumV2DefaultStep    = 50  // 0.5 dB

	// spectrumV2ScaleMarginDB is how far beyond the observed range a scale
	// reaches, so that ordinary movement between keyframes does not saturate.
	spectrumV2ScaleMarginDB = 6.0
)

// spectrumV2Scale is the mapping between decibels and 8-bit codes for one
// full frame and the deltas that follow it.
type spectrumV2Scale struct {
	refCentiDB  int16
	stepCentiDB uint8
}

// spectrumV2ChooseScale derives a scale from the data, so that the whole range
// present is representable whatever the receiver's gain settings are.
//
// The reference is the floor rounded down and the step is whatever spreads the
// observed span across the 255 codes available, never finer than 0.25 dB
// (pointless, the source is noisier than that) and never coarser than needed.
func spectrumV2ChooseScale(data []float32) spectrumV2Scale {
	if len(data) == 0 {
		return spectrumV2Scale{refCentiDB: -12800, stepCentiDB: spectrumV2DefaultStep}
	}
	lo, hi := float64(data[0]), float64(data[0])
	for _, v := range data {
		f := float64(v)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			continue
		}
		if f < lo {
			lo = f
		}
		if f > hi {
			hi = f
		}
	}
	if math.IsNaN(lo) || math.IsInf(lo, 0) {
		lo = -128
	}
	if math.IsNaN(hi) || math.IsInf(hi, 0) || hi < lo {
		hi = lo
	}

	// Margin at each end, because this scale is not re-derived until the next
	// full frame and the signal keeps moving in between. Too little and a
	// carrier that grows over the following seconds saturates against a stale
	// range; too much and resolution is wasted on decibels nothing occupies.
	// Six either side covers ordinary fading without costing a step: at a
	// typical 90 dB span it is the difference between a 0.40 and a 0.45 dB
	// step. A signal that outgrows even that forces a new full frame, so the
	// margin is a tuning choice rather than a correctness one.
	lo -= spectrumV2ScaleMarginDB
	hi += spectrumV2ScaleMarginDB

	refCenti := math.Floor(lo * 100)
	if refCenti < math.MinInt16 {
		refCenti = math.MinInt16
	}
	if refCenti > math.MaxInt16 {
		refCenti = math.MaxInt16
	}

	span := (hi - lo) * 100
	step := math.Ceil(span / 255)
	if step < spectrumV2MinStepCentiDB {
		step = spectrumV2MinStepCentiDB
	}
	if step > spectrumV2MaxStepCentiDB {
		step = spectrumV2MaxStepCentiDB
	}
	return spectrumV2Scale{refCentiDB: int16(refCenti), stepCentiDB: uint8(step)}
}

// encode converts a decibel reading to its code.
//
// Rounds to nearest rather than truncating -- version 1 truncated, which biased
// every reading up to a step low -- and clamps at both ends, so a value at or
// above the top of the range saturates instead of wrapping to the bottom the
// way version 1's did.
func (s spectrumV2Scale) encode(db float32) uint8 {
	f := float64(db)
	if math.IsNaN(f) {
		return 0
	}
	code := math.Round((f*100 - float64(s.refCentiDB)) / float64(s.stepCentiDB))
	if code < 0 {
		return 0
	}
	if code > 255 {
		return 255
	}
	return uint8(code)
}

// encodeInto converts a whole frame to codes -- matching encode exactly, bin
// for bin -- in a single pass with the scale constants hoisted out of the loop.
//
// When trackMisfit is set it also reports whether any finite reading landed
// outside the scale, judged on the value before rounding. A scale is derived
// once per full frame and then used by every delta that follows, so the signal
// can outgrow it -- a carrier rising 10 dB over the next few seconds would
// otherwise clamp at 255 and read as a flat ceiling. The encoder checks this
// and re-keys instead, which is the only way the error stays bounded rather
// than depending on how long ago the last keyframe was. Non-finite readings
// are excluded: encode already pins them, and they are not a reason to re-key
// every frame.
func (s spectrumV2Scale) encodeInto(codes []uint8, data []float32, trackMisfit bool) (misfit bool) {
	ref := float64(s.refCentiDB)
	step := float64(s.stepCentiDB)
	for i, v := range data {
		f := float64(v)
		if math.IsNaN(f) {
			codes[i] = 0
			continue
		}
		c := (f*100 - ref) / step
		if trackMisfit && !math.IsInf(f, 0) && (c < 0 || c > 255) {
			misfit = true
		}
		r := math.Round(c)
		if r < 0 {
			codes[i] = 0
		} else if r > 255 {
			codes[i] = 255
		} else {
			codes[i] = uint8(r)
		}
	}
	return misfit
}

// decode is the inverse, provided for tests and for any Go client.
func (s spectrumV2Scale) decode(code uint8) float32 {
	return float32((float64(s.refCentiDB) + float64(code)*float64(s.stepCentiDB)) / 100)
}

// spectrumV2State is the per-session encoder state.
type spectrumV2State struct {
	scale     spectrumV2Scale
	previous  []uint8
	sequence  uint16
	sinceFull int

	// forceFull is set when the last frame did not reach the client, so the
	// next one re-states everything rather than describing a change from
	// something the client never received.
	forceFull bool

	// Scratch reused frame to frame, so the encoder allocates nothing but the
	// packet itself -- which has to be fresh each time because the write queue
	// retains it. codesBuf becomes previous on commit (a swap, not a copy);
	// mask and values live only for the duration of one encode.
	codesBuf  []uint8
	maskBuf   []byte
	valuesBuf []uint8
}

// spectrumV2Encode builds one frame.
//
// Returns the packet and whether it was a full frame, so the caller can record
// what the client will hold -- but only once the send has actually succeeded.
// Version 1 recorded it first, which is what made a dropped frame permanent.
func spectrumV2Encode(st *spectrumV2State, data []float32, timestampNanos uint64, centreFreq uint64, deltaThresholdDB float64) (packet []byte, full bool, codes []uint8) {
	n := len(data)
	st.sequence++

	// A full frame is required when there is nothing to describe a change
	// from, when the bin count moves, when a send was lost, and periodically
	// so that any disagreement has a bounded lifetime.
	full = st.previous == nil || len(st.previous) != n ||
		st.forceFull || st.sinceFull >= spectrumV2KeyframeInterval

	scale := st.scale
	if full {
		scale = spectrumV2ChooseScale(data)
	}
	if cap(st.codesBuf) < n {
		st.codesBuf = make([]uint8, n)
	}
	codes = st.codesBuf[:n]

	// One pass encodes every bin and notices at the same time whether any
	// finite reading landed outside the scale. A scale that no longer covers
	// the data has to be replaced, and only a full frame may carry a new one.
	misfit := scale.encodeInto(codes, data, !full)
	if !full && misfit {
		full = true
		scale = spectrumV2ChooseScale(data)
		scale.encodeInto(codes, data, false)
	}

	// A delta only pays for itself while few bins have moved. The mask costs
	// ⌈n/8⌉ bytes whatever happens, plus one byte per change, against n bytes
	// for the full frame -- so the break-even is at seven eighths of the bins,
	// and below that a delta is always the smaller of the two. Version 1's
	// equivalent break-even was a third, which is why its threshold mattered so
	// much and this one barely does.
	var mask []byte
	var values []uint8
	if !full {
		maskLen := (n + 7) / 8
		if cap(st.maskBuf) < maskLen {
			st.maskBuf = make([]byte, maskLen)
		}
		mask = st.maskBuf[:maskLen]
		for i := range mask {
			mask[i] = 0
		}
		if cap(st.valuesBuf) < n {
			st.valuesBuf = make([]uint8, 0, n)
		}
		values = st.valuesBuf[:0]
		// The codes are integers, so "moved by more than the threshold" is an
		// integer comparison: for integer d, d > x ⇔ d ≥ ⌊x⌋+1. That keeps
		// the per-bin work free of float conversions and math.Abs calls.
		minDiff := int(math.Floor(deltaThresholdDB*100/float64(scale.stepCentiDB))) + 1
		prev := st.previous
		for i := 0; i < n; i++ {
			d := int(codes[i]) - int(prev[i])
			if d < 0 {
				d = -d
			}
			if d >= minDiff {
				mask[i>>3] |= 1 << (uint(i) & 7)
				values = append(values, codes[i])
			} else {
				// Unsent bins keep the value the client already has, so the
				// comparison next time is against what it holds rather than
				// against the truth. That bounds the error at the threshold
				// instead of letting it drift.
				codes[i] = prev[i]
			}
		}
		if maskLen+len(values) >= n {
			full = true
			scale = spectrumV2ChooseScale(data)
			scale.encodeInto(codes, data, false)
		}
	}

	if full {
		packet = make([]byte, spectrumV2HeaderSize+3+n)
	} else {
		packet = make([]byte, spectrumV2HeaderSize+len(mask)+len(values))
	}
	copy(packet[0:4], []byte{'S', 'P', 'E', 'C'})
	packet[4] = SpectrumV2Version
	if full {
		packet[5] = SpectrumV2FlagFull
	} else {
		packet[5] = SpectrumV2FlagDelta
	}
	binary.LittleEndian.PutUint16(packet[6:8], st.sequence)
	binary.LittleEndian.PutUint64(packet[8:16], timestampNanos)
	binary.LittleEndian.PutUint64(packet[16:24], centreFreq)

	off := spectrumV2HeaderSize
	if full {
		binary.LittleEndian.PutUint16(packet[off:], uint16(scale.refCentiDB))
		packet[off+2] = scale.stepCentiDB
		copy(packet[off+3:], codes)
	} else {
		copy(packet[off:], mask)
		copy(packet[off+len(mask):], values)
	}

	st.scale = scale
	return packet, full, codes
}

// spectrumV2Commit records what the client now holds. The caller invokes it
// only after the frame has actually been queued for the socket; if the send was
// dropped it calls spectrumV2Dropped instead.
//
// codes must be the slice the immediately preceding spectrumV2Encode returned:
// it is the state's own scratch buffer, so committing is a swap with previous
// rather than a kilobyte copy every frame.
func spectrumV2Commit(st *spectrumV2State, codes []uint8, full bool) {
	st.previous, st.codesBuf = codes, st.previous
	st.forceFull = false
	if full {
		st.sinceFull = 0
	} else {
		st.sinceFull++
	}
}

// spectrumV2Dropped marks that a frame never reached the client, so the next
// one must re-state everything.
func spectrumV2Dropped(st *spectrumV2State) { st.forceFull = true }

// sendSpectrumV2 builds and queues one version 2 frame.
//
// The order here is the point. Version 1 recorded what the client would hold
// and then attempted the send, so a frame dropped by the non-blocking write
// left the server describing changes from a state the client never reached --
// permanently, since nothing detected it. This commits only on a successful
// queue, and marks the stream for a full frame when the queue refuses.
func (swsh *UserSpectrumWebSocketHandler) sendSpectrumV2(conn *wsConn, session *Session, spectrumData []float32, state *spectrumState) error {
	deltaThreshold := swsh.sessions.config.Spectrum.DeltaThresholdDB

	session.mu.RLock()
	centreFreq := session.Frequency
	session.mu.RUnlock()

	state.mu.Lock()
	packet, full, codes := spectrumV2Encode(&state.v2, spectrumData,
		uint64(time.Now().UnixNano()), centreFreq, deltaThreshold)
	state.mu.Unlock()

	if !conn.writeSpectrumBinary(packet) {
		// The client is too slow and this frame is gone. Say so, so the next
		// one re-states everything rather than describing a change from
		// something that never arrived.
		state.mu.Lock()
		spectrumV2Dropped(&state.v2)
		state.mu.Unlock()
		return nil
	}

	state.mu.Lock()
	spectrumV2Commit(&state.v2, codes, full)
	state.mu.Unlock()

	session.AddWaterfallBytes(uint64(len(packet)))
	return nil
}
