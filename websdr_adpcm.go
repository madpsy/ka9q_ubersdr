package main

// websdr_adpcm.go — the audio format PA3FWM's own websdr-sound.js decodes.
//
// The emulation normally streams Opus to our replacement websdr-sound.js. With
// server.websdr_adpcm_audio: true it serves PA3FWM's original client instead
// (websdr/websdr-sound-adpcm.js, under the name websdr-sound.js) and this encoder
// produces the format that client decodes.
//
// The format is defined by the decoder, so everything below mirrors that decoder's
// arithmetic exactly. A message is a run of tagged items:
//
//	0xF0|hi, lo         S-meter, 12 bits (the client reports it ×10)
//	0x80 + 128 bytes    128 samples of A-law; resets the predictor
//	0x81 hi lo          sample rate in Hz (0 makes the client stop)
//	0x82 hi lo          ADPCM step size
//	0x83 c              conversion: low nibble picks the client's output low-pass,
//	                    0x10 turns the integrator off and the adaptation shift to 12
//	0x84                128 samples of silence; resets the predictor
//	0x90..0xDF          ADPCM block of 128 samples in mode 14-(b>>4), bits start at bit 4
//	0x00..0x7F          ADPCM block of 128 samples in the previous mode, bits start at bit 1
//
// The 2025 client adds 0x85 (AM-sync frequency, 6 bytes), 0x86 (resync) and 0x87
// (server time, 6 bytes); the decoding is unchanged and this encoder sends none of them.
//
// A live server (websdr.ewi.utwente.nl, 2026-10-01, 14074 kHz USB) sends rate 7119,
// step 40 and conversion 0x10 (filter 0, integrator off), with audio near -21 dBFS
// rms, at 43 kbps. Re-encoding its decoded audio with those settings here gives the
// same bytes until the first block where the two pick a different mode, and 0.3%
// fewer bytes overall.
//
// An ADPCM block codes each sample as the residual after a 20-tap adaptive predictor,
// in units of the step, with a unary/escape quotient, a mantissa that loses its low
// bits as the quotient grows, and a sign. The encoder keeps its own copy of the
// decoder's state and updates it from what the decoder will reconstruct, never from
// the input, so the two cannot drift.

import (
	"math"
	"net/http"
)

const (
	websdrADPCMBlock = 128 // samples per coded block, fixed by the decoder

	websdrADPCMConvNoIntegrator = 0x10
)

// The client's four output low-passes, selected by the low nibble of 0x83. They run
// at the browser's rate after the client upsamples, so their cutoffs are in Hz
// whatever rate we send; these are their measured -3 dB points.
const (
	websdrADPCMFilter3k8 = 0 // 3844 Hz
	websdrADPCMFilter2k6 = 1 // 2623 Hz
	websdrADPCMFilter1k0 = 2 // 964 Hz
	websdrADPCMFilter6k1 = 3 // 6095 Hz
)

// websdrADPCMShrink is the decoder's table of quotients at which the mantissa loses
// a bit, indexed by mode.
var websdrADPCMShrink = [8]int32{999, 999, 8, 4, 2, 1, 99, 99}

// websdrADPCMFilterFor picks the narrowest client low-pass that still passes the
// passband edge furthest from the carrier. Anything wider than 6.1 kHz is cut there:
// the original format has no wider filter.
func websdrADPCMFilterFor(loHz, hiHz float64) byte {
	edge := math.Max(math.Abs(loHz), math.Abs(hiHz))
	switch {
	case edge <= 964:
		return websdrADPCMFilter1k0
	case edge <= 2623:
		return websdrADPCMFilter2k6
	case edge <= 3844:
		return websdrADPCMFilter3k8
	default:
		return websdrADPCMFilter6k1
	}
}

// websdrADPCMState is the decoder state the encoder mirrors.
type websdrADPCMState struct {
	coef [20]int32 // adaptive predictor taps
	hist [20]int32 // reconstructed history, newest first
	acc  int32     // integrator; output = hist[0] + acc>>4
}

func (s *websdrADPCMState) reset() { *s = websdrADPCMState{} }

// predict is the decoder's prediction for the next sample. The sum is taken modulo
// 2^32 and divided by 4096 rounding toward zero, as the decoder does.
func (s *websdrADPCMState) predict() int32 {
	var sum int64
	for i := range s.coef {
		sum += int64(s.coef[i]) * int64(s.hist[i])
	}
	p := int32(sum)
	if p >= 0 {
		return p >> 12
	}
	return (p + 4095) >> 12
}

// update applies one decoded residual r (in steps) and returns the sample the
// decoder writes, before its int16 store.
func (s *websdrADPCMState) update(pred, r, step int32, conv byte) int32 {
	shift := uint(14)
	if conv&websdrADPCMConvNoIntegrator != 0 {
		shift = 12
	}
	q := r*step + step/2
	adapt := q >> 4
	for i := 19; i >= 0; i-- {
		s.coef[i] += -(s.coef[i] >> 7) + int32(int64(s.hist[i])*int64(adapt))>>shift
		if i == 0 {
			break
		}
		s.hist[i] = s.hist[i-1]
	}
	s.hist[0] = pred + q
	out := s.hist[0] + s.acc>>4
	if conv&websdrADPCMConvNoIntegrator != 0 {
		s.acc = 0
	} else {
		s.acc += (s.hist[0] << 4) >> 3
	}
	return out
}

// websdrADPCMCode is how residual r is written in mode w, and what the decoder will
// read back. ok is false when the quotient does not fit the 8-bit escape.
func websdrADPCMCode(r int32, w int) (code uint32, bits int, decoded int32, ok bool) {
	mag := r ^ (r >> 31) // ones' complement magnitude, as the decoder signs it
	k := mag >> (w - 1)
	if k > 255 {
		return 0, 0, 0, false
	}
	m := 0
	if k >= websdrADPCMShrink[w] {
		m++
	}
	if k >= websdrADPCMShrink[w-1] {
		m++
	}
	if m > w-1 {
		m = w - 1
	}
	mant := uint32(mag&(1<<(w-1)-1)) >> m

	// Quotient: k zeros then a 1, or past 15-w zeros an escape and 8 bits of k.
	if limit := int32(15 - w); k < limit {
		code, bits = 1, int(k)+1
	} else {
		code, bits = uint32(k), int(limit)+8
	}
	code = code<<(w-1-m) | mant
	code <<= 1
	if r < 0 {
		code |= 1
	}
	bits += w - m

	decoded = k<<(w-1) + int32(mant)<<m
	if r < 0 {
		decoded = ^(decoded | (1<<m - 1))
	}
	return code, bits, decoded, true
}

// websdrADPCMQuantise picks the residual whose reconstruction lands closest to e
// (the wanted value of r*step + step/2) and is representable in mode w.
func websdrADPCMQuantise(e, step int32, w int) (code uint32, bits int, decoded int32, ok bool) {
	// Near the rounding point of each grid the decoder keeps (multiples of 1, 2, 4
	// steps), so try each and keep the closest that survives encoding.
	bestErr := int64(-1)
	for m := int32(0); m <= 2; m++ {
		g := step << m
		r := floorDiv(e-step/2+g/2, g) << m
		for _, cand := range [2]int32{r, r + 1<<m} {
			c, n, d, good := websdrADPCMCode(cand, w)
			if !good {
				continue
			}
			diff := int64(e) - int64(d*step+step/2)
			if diff < 0 {
				diff = -diff
			}
			if bestErr < 0 || diff < bestErr {
				bestErr, code, bits, decoded, ok = diff, c, n, d, true
			}
		}
	}
	return
}

func floorDiv(a, b int32) int32 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

// websdrADPCMBits appends a big-endian bitstream to a byte slice.
type websdrADPCMBits struct {
	buf  []byte
	used int // bits used in the last byte, 0 = start a new byte
}

func (b *websdrADPCMBits) write(code uint32, n int) {
	for n > 0 {
		if b.used == 0 {
			b.buf = append(b.buf, 0)
		}
		take := min(8-b.used, n)
		chunk := byte(code>>(n-take)) & (1<<take - 1)
		b.buf[len(b.buf)-1] |= chunk << (8 - b.used - take)
		b.used = (b.used + take) % 8
		n -= take
	}
}

// websdrADPCMEncoder turns a PCM stream into /~~stream messages for one client.
type websdrADPCMEncoder struct {
	state websdrADPCMState
	mode  int // last mode the decoder was told; 0 = none yet
	step  int32
	conv  byte

	rate         int
	sentRate     int
	sentStep     bool
	sentConv     bool
	sentConvByte byte

	pending []int16 // samples waiting for a full block

	// recon, when non-nil, collects every sample the decoder will output, so tests
	// can compare it with the real decoder.
	recon *[]int16
}

// newWebSDRADPCMEncoder returns an encoder with ADPCM step size step: the quantiser
// resolution in sample units, so quality and bitrate both fall as it rises. It must
// be even, as the decoder halves it in floating point.
func newWebSDRADPCMEncoder(step int) *websdrADPCMEncoder {
	if step < 2 {
		step = 2
	}
	step &^= 1
	return &websdrADPCMEncoder{step: int32(min(step, 0xFFFE)), conv: websdrADPCMFilter3k8}
}

// SetRate sets the sample rate of the PCM that follows. The client resamples to the
// browser's rate but only upsamples, so it must not exceed 44.1 kHz.
func (e *websdrADPCMEncoder) SetRate(hz int) {
	if hz < 0 {
		hz = 0
	}
	if hz > 0xFFFF {
		hz = 0xFFFF
	}
	e.rate = hz
}

// SetFilter selects the client's output low-pass (websdrADPCMFilter*).
func (e *websdrADPCMEncoder) SetFilter(f byte) { e.conv = e.conv&^0x0F | f&0x0F }

// SetIntegrator turns the decoder's integrator on (the default) or off.
func (e *websdrADPCMEncoder) SetIntegrator(on bool) {
	if on {
		e.conv &^= websdrADPCMConvNoIntegrator
	} else {
		e.conv |= websdrADPCMConvNoIntegrator
	}
}

// websdrADPCMSMeter converts a baseband power in dBFS to the S-meter tag value. The
// client reports tag*10 and websdr-base.js shows that as value/100 - 127 dBFS.
func websdrADPCMSMeter(dBFS float32) int {
	if dBFS < -127 {
		dBFS = -127
	}
	if dBFS > 0 {
		dBFS = 0
	}
	return int((dBFS+127)*10 + 0.5)
}

// appendHeaders writes the tags whose value changed since they were last sent.
func (e *websdrADPCMEncoder) appendHeaders(dst []byte) []byte {
	if e.rate != e.sentRate {
		dst = append(dst, 0x81, byte(e.rate>>8), byte(e.rate))
		e.sentRate = e.rate
	}
	if !e.sentStep {
		dst = append(dst, 0x82, byte(e.step>>8), byte(e.step))
		e.sentStep = true
	}
	if !e.sentConv || e.sentConvByte != e.conv {
		dst = append(dst, 0x83, e.conv)
		e.sentConv, e.sentConvByte = true, e.conv
	}
	return dst
}

// Encode appends to dst the message carrying pcm, with an S-meter reading (pass a
// negative smeter to leave it out). Samples short of a whole block are held for the
// next call, so a message may carry no audio.
func (e *websdrADPCMEncoder) Encode(dst []byte, pcm []int16, smeter int) []byte {
	if smeter >= 0 {
		smeter = min(smeter, 0xFFF)
		dst = append(dst, 0xF0|byte(smeter>>8), byte(smeter))
	}
	dst = e.appendHeaders(dst)
	e.pending = append(e.pending, pcm...)
	done := 0
	for ; len(e.pending)-done >= websdrADPCMBlock; done += websdrADPCMBlock {
		dst = e.encodeBlock(dst, e.pending[done:done+websdrADPCMBlock])
	}
	e.pending = e.pending[:copy(e.pending, e.pending[done:])]
	return dst
}

// Silence appends blocks of silence covering n samples (rounded up to whole blocks,
// counting any samples held from Encode), for mute and squelch. It costs one byte
// per block and resets the predictor on both ends.
func (e *websdrADPCMEncoder) Silence(dst []byte, n int) []byte {
	dst = e.appendHeaders(dst)
	n += len(e.pending)
	e.pending = e.pending[:0]
	for ; n > 0; n -= websdrADPCMBlock {
		dst = e.silentBlock(dst)
	}
	return dst
}

func (e *websdrADPCMEncoder) silentBlock(dst []byte) []byte {
	e.state.reset()
	if e.recon != nil {
		*e.recon = append(*e.recon, make([]int16, websdrADPCMBlock)...)
	}
	return append(dst, 0x84)
}

// encodeBlock codes one block in whichever mode is shortest, or as A-law when that
// is shorter still or no mode can carry it (a transient beyond the escape, or one
// whose reconstruction would wrap the decoder's int16 output). Loud audio is where
// A-law wins: the decoder's predictor adapts in proportion to the signal, and near
// full scale it overshoots.
func (e *websdrADPCMEncoder) encodeBlock(dst []byte, pcm []int16) []byte {
	// ADPCM cannot code zero (every residual lands at r*step + step/2), so digital
	// silence would come out as hiss. It is one byte this way, and exact.
	silent := true
	for _, x := range pcm {
		if x != 0 {
			silent = false
			break
		}
	}
	if silent {
		return e.silentBlock(dst)
	}

	var (
		best      []byte
		bestState websdrADPCMState
		bestMode  int
		bestOut   [websdrADPCMBlock]int16
		out       [websdrADPCMBlock]int16
	)
	for w := 1; w <= 5; w++ {
		st := e.state
		bits := websdrADPCMBits{}
		if w == e.mode {
			bits.write(0, 1)
		} else {
			bits.write(uint32(14-w), 4)
		}
		ok := true
		for i, x := range pcm {
			pred := st.predict()
			want := int32(x) - pred - st.acc>>4
			code, n, r, good := websdrADPCMQuantise(want, e.step, w)
			if !good {
				ok = false
				break
			}
			y := st.update(pred, r, e.step, e.conv)
			if y != int32(int16(y)) {
				ok = false
				break
			}
			bits.write(code, n)
			out[i] = int16(y)
		}
		if ok && (best == nil || len(bits.buf) < len(best)) {
			best, bestState, bestMode, bestOut = bits.buf, st, w, out
		}
	}
	if best == nil || len(best) > 1+websdrADPCMBlock {
		return e.encodeALaw(dst, pcm)
	}
	e.state, e.mode = bestState, bestMode
	if e.recon != nil {
		*e.recon = append(*e.recon, bestOut[:]...)
	}
	return append(dst, best...)
}

func (e *websdrADPCMEncoder) encodeALaw(dst []byte, pcm []int16) []byte {
	dst = append(dst, 0x80)
	for _, x := range pcm {
		b := websdrALawEncode(x)
		dst = append(dst, b)
		if e.recon != nil {
			*e.recon = append(*e.recon, websdrALawDecode(b))
		}
	}
	e.state.reset()
	return dst
}

// websdrALawDecode is G.711 A-law, which is what the decoder's 0x80 table holds.
func websdrALawDecode(a byte) int16 {
	a ^= 0x55
	t := int16(a&0x0F) << 4
	seg := (a & 0x70) >> 4
	if seg == 0 {
		t += 8
	} else {
		t = (t + 0x108) << (seg - 1)
	}
	if a&0x80 != 0 {
		return t
	}
	return -t
}

// websdrALawEncode is G.711 A-law. It truncates into a segment cell, and the
// decoder reconstructs at the cell centre.
func websdrALawEncode(x int16) byte {
	sign := byte(0x80)
	v := int32(x)
	if v < 0 {
		sign = 0
		v = -v - 1 // keeps -32768 in range and matches the decoder's levels
	}
	v >>= 3 // 13-bit magnitude
	var seg byte
	for seg = 0; seg < 7 && v >= 32<<seg; seg++ {
	}
	var mant byte
	if seg == 0 {
		mant = byte(v >> 1)
	} else {
		mant = byte(v>>seg) & 0x0F
	}
	return (sign | seg<<4 | mant) ^ 0x55
}

// websdrADPCMStep is the step size sent to clients: the finest a live WebSDR uses,
// about 37 dB SNR on normal levels at 6-7 bits/sample.
const websdrADPCMStep = 40

// adpcmAudio reports whether WebSDR clients get PA3FWM's original client and its
// ADPCM stream rather than ours and Opus, the default.
func (h *WebSDRHandler) adpcmAudio() bool {
	return h.config.Server.WebSDRADPCMAudio
}

// serveSoundJS serves whichever sound client matches the stream. The page loads it
// by the fixed name websdr-sound.js, so the choice is made here.
func (h *WebSDRHandler) serveSoundJS(w http.ResponseWriter, r *http.Request) {
	name := "websdr-sound.js"
	if h.adpcmAudio() {
		name = "websdr-sound-adpcm.js"
	}
	filePath := h.findStaticFile(name)
	if filePath == "" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/javascript")
	http.ServeFile(w, r, filePath)
}

// streamADPCMAudio streams audio in the original WebSDR format, one message per
// radiod packet.
func (c *websdrConn) streamADPCMAudio(done <-chan struct{}) {
	enc := newWebSDRADPCMEncoder(websdrADPCMStep)
	var msg []byte
	for {
		select {
		case <-done:
			return
		case <-c.session.Done:
			return
		case pkt, ok := <-c.session.AudioChan:
			if !ok {
				return
			}
			c.mu.RLock()
			muted := c.mute != 0
			loKHz, hiKHz := c.loKHz, c.hiKHz
			c.mu.RUnlock()

			smeter := -1
			if rc := c.handler.sessions.radiod; rc != nil {
				if cs := rc.GetChannelStatus(c.session.SSRC); cs != nil {
					smeter = websdrADPCMSMeter(cs.BasebandPower)
				}
			}

			sampleRate := pkt.SampleRate
			if sampleRate <= 0 {
				sampleRate = c.handler.config.Audio.DefaultSampleRate
			}
			if pkt.Channels > 1 { // IQ; no WebSDR mode asks for it, and ADPCM is mono
				continue
			}
			enc.SetRate(sampleRate)
			enc.SetFilter(websdrADPCMFilterFor(loKHz*1000, hiKHz*1000))

			samples := len(pkt.PCMData) / 2
			if muted {
				msg = enc.Silence(msg[:0], samples)
			} else {
				msg = enc.Encode(msg[:0], bytesToInt16Samples(pkt.PCMData), smeter)
			}
			if err := c.sendBinary(msg); err != nil {
				return
			}
			c.session.AddAudioBytes(uint64(len(msg)))
		}
	}
}
