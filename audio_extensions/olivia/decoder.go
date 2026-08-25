package olivia

import (
	"fmt"
	"math"
	"sync"
)

// Olivia MFSK receiver.
//
// A port of Pawel Jalocha's MFSK_Receiver (pj_mfsk.h, as carried by fldigi),
// by way of PhantomSDR-Plus's JavaScript port of the same code. Receive only.
//
// How Olivia works
// ----------------
// Tones tones spaced Bandwidth/Tones apart, one tone per symbol, symbol rate
// equal to the tone spacing. A FEC block is SymbolsPerBlock symbols and carries
// log2(Tones) characters of 7 bits. Each character becomes a +/-1 Walsh
// sequence (an inverse Hadamard of a single spike, negated for the upper half
// of the alphabet), scrambled against a fixed 64-bit code at a per-bit-plane
// offset, and laid diagonally across the block's bit planes. Receiving is that
// in reverse: a forward Hadamard turns the soft bits back into a spike whose
// position is the character.
//
// Internals run at a fixed 8 kHz, which is what makes SymbolLen a power of two
// for every tones/bandwidth pair, so the input is resampled first.
//
// There is no preamble, so sync is brute force: run a decoder for every
// (frequency offset x FFT slice) combination, integrate each one's FEC
// signal-to-noise over several blocks, and emit the block from whichever
// (block phase, frequency offset) is winning. That is why Olivia takes a few
// seconds to lock.
//
// Deliberate omissions from the reference
// ---------------------------------------
//   - MFSK_InputProcessor, an adaptive spectral equaliser and coherent
//     interference notcher, is not ported. In the reference it sits in the
//     signal path unconditionally; here the audio reaches the demodulator
//     unprocessed. It improves robustness against carriers inside the passband
//     but is not needed for correct decoding.
//   - RateConverter, a windowed-sinc resampler, is replaced by linear
//     interpolation. UberSDR delivers SSB at 12 kHz against an internal 8 kHz,
//     and the receiver's own filter has already limited the audio to 3 kHz —
//     comfortably under the 4 kHz internal Nyquist — so there is no aliasing
//     path and the only cost is a fraction of a dB of tilt across the tone
//     block. See resample.
//
// Both are recorded rather than hidden because they are the two places this
// decoder is knowingly not the reference.

const (
	internalRate     = 8000 // the reference's fixed internal processing rate
	slicesPerSymbol  = 2    // FFT slices per symbol period
	carrierSepar     = 2    // tone spacing, in FFT bins
	oliviaBitsPerCh  = 7
	oliviaCodeShift  = 13
	oliviaScramble   = uint64(0xE257E6D0291574EC)
	contestiaBitsCh  = 6
	contestiaShift   = 5
	contestiaScramb  = uint64(0xEDB88320)
	syncIntegDefault = 4
	syncMarginDeflt  = 8
)

// SyncThreshold bounds. The reference clamps anything below 3.0 up to 3.0 and
// treats that as the floor. At 3.0 pure noise leaks the occasional block, so
// the default sits just above it; a real signal scores far higher even when
// buried.
const (
	SyncThresholdMin     = 3.0
	SyncThresholdMax     = 15.0
	SyncThresholdDefault = 4.0
)

// Reference span for the reported FEC quality percentage. Fixed rather than
// derived from the squelch, so moving the threshold changes what gets through
// without changing what the meter says about the signal.
const (
	qualityFloor = 3.0
	qualitySpan  = 6.0
)

// Config holds everything the decoder is built from. Every field except
// SyncThreshold is fixed at construction: changing any of the others rebuilds
// every array in the receiver and loses sync, so the extension re-attaches
// instead. SyncThreshold is live — see SetSyncThreshold.
type Config struct {
	Tones           int     // 2..256, rounded down to a power of two
	Bandwidth       int     // 125..2000, rounded down to a power-of-two multiple of 125
	CenterFrequency float64 // Hz, where in the audio passband the tone block sits
	SyncThreshold   float64 // FEC S/N a block must reach before it is printed
	SyncMargin      int     // half-width of the frequency search, in FFT bins
	SyncIntegLen    int     // blocks integrated by the sync filters
	Reverse         bool    // decode an inverted tone block
	Contestia       bool    // Contestia rather than Olivia: 6-bit characters
	EightBit        bool    // honour the 127-prefix escape for characters > 126
}

// DefaultConfig is Olivia 8/250 centred at 1000 Hz, which is what the panel
// opens on.
//
// The references disagree — fldigi ships 8/500, PhantomSDR-Plus 8/250, sdr-j
// 32/1000 — so this follows the published calling frequencies, which are 8/250,
// and agrees with PhantomSDR. Everything else here is fldigi's: the tune margin
// of 8, the integration period of 4, and the 8-bit escape on.
func DefaultConfig() Config {
	return Config{
		Tones:           8,
		Bandwidth:       250,
		CenterFrequency: 1000,
		SyncThreshold:   SyncThresholdDefault,
		SyncMargin:      syncMarginDeflt,
		SyncIntegLen:    syncIntegDefault,
		// On, as fldigi has it (OLIVIA8BIT defaults true). A sender that does
		// not use the escape never emits 127, so honouring it costs nothing;
		// ignoring it turns every extended character into a stray 127 followed
		// by the wrong letter.
		EightBit: true,
	}
}

// Geometry is what the configuration worked out to. The bandwidth and tone
// count are quantised, and the sync margin can be clamped by how low in the
// passband the tone block sits, so this is reported back to the client rather
// than left for it to guess.
type Geometry struct {
	Tones         int
	Bandwidth     int
	BitsPerSymbol int
	SymbolLen     int
	SymbolSepar   int
	FirstCarrier  int
	SyncMargin    int
	FreqOffsets   int
	BlockPhases   int
	BaudRate      float64
	BlockPeriod   float64
	CharsPerSec   float64
}

// softDecoder is one candidate (slice, frequency offset). It holds a sliding
// window of one block's worth of soft bits and re-decodes the whole block on
// every symbol.
type softDecoder struct {
	bitsPerSymbol   int
	symbolsPerBlock int
	codeShift       int
	scrambleSign    []int8
	inputBuffer     []float64
	fhtBuf          []float64
	outputBlock     []uint8
	inputPtr        int
	signal          float64
	noiseEnergy     float64
}

func newSoftDecoder(bitsPerSymbol, symbolsPerBlock, codeShift int, scrambleSign []int8) *softDecoder {
	return &softDecoder{
		bitsPerSymbol:   bitsPerSymbol,
		symbolsPerBlock: symbolsPerBlock,
		codeShift:       codeShift,
		scrambleSign:    scrambleSign,
		inputBuffer:     make([]float64, symbolsPerBlock*bitsPerSymbol),
		fhtBuf:          make([]float64, symbolsPerBlock),
		outputBlock:     make([]uint8, bitsPerSymbol),
	}
}

func (d *softDecoder) input(symbol []float64) {
	for b := 0; b < d.bitsPerSymbol; b++ {
		d.inputBuffer[d.inputPtr] = symbol[b]
		d.inputPtr++
	}
	if d.inputPtr >= len(d.inputBuffer) {
		d.inputPtr -= len(d.inputBuffer)
	}
}

// decodeCharacter undoes the scrambling and the diagonal interleave for one bit
// plane, then Hadamard-transforms it back into a spike whose position is the
// character.
//
// This is MFSK_SoftDecoder::DecodeCharacter, and every step of it is part of
// the code rather than of the implementation: the walk through the input
// buffer, the per-bit-plane code offset, the rotation, and the sign of the peak
// selecting the upper half of the alphabet. None of it can be rearranged.
func (d *softDecoder) decodeCharacter(freqBit int) {
	n := d.symbolsPerBlock
	bps := d.bitsPerSymbol
	buf := d.inputBuffer
	mask := n - 1

	ptr := d.inputPtr
	rotate := freqBit
	codeBit := (freqBit * d.codeShift) & mask

	for t := 0; t < n; t++ {
		bit := buf[ptr+rotate]
		if d.scrambleSign[codeBit] < 0 {
			d.fhtBuf[t] = -bit
		} else {
			d.fhtBuf[t] = bit
		}
		codeBit = (codeBit + 1) & mask
		rotate++
		if rotate >= bps {
			rotate -= bps
		}
		ptr += bps
		if ptr >= len(buf) {
			ptr -= len(buf)
		}
	}

	fht(d.fhtBuf, n)

	peak, peakPos, sqrSum := 0.0, 0, 0.0
	for t := 0; t < n; t++ {
		s := d.fhtBuf[t]
		sqrSum += s * s
		if math.Abs(s) > math.Abs(peak) {
			peak, peakPos = s, t
		}
	}

	char := peakPos
	if peak < 0 {
		char += n
	}
	sqrSum -= peak * peak

	d.outputBlock[freqBit] = uint8(char)
	d.noiseEnergy += sqrSum / float64(n-1)
	d.signal += math.Abs(peak)
}

func (d *softDecoder) process() {
	d.signal = 0
	d.noiseEnergy = 0
	for b := 0; b < d.bitsPerSymbol; b++ {
		d.decodeCharacter(b)
	}
	d.signal /= float64(d.bitsPerSymbol)
	d.noiseEnergy /= float64(d.bitsPerSymbol)
}

// Decoder is the receiver. Feed it PCM with Feed; decoded characters arrive
// through the OnChar callback.
type Decoder struct {
	mu sync.Mutex

	cfg        Config
	geom       Geometry
	inputRate  int
	bitsPerCh  int
	codeShift  int
	scrambleSg []int8

	// Demodulator
	plan         *fftPlan
	shape        []float64
	inpTap       []float64
	inpTapPtr    int
	wrapMask     int
	fftRe, fftIm []float64
	energy       [slicesPerSymbol][]float64

	symbolsPerBlock int
	carriers        int
	symbolSepar2    int
	decodeMargin    int
	decodeWidth     int
	scanFirst       int
	scanStep        int
	freqOffsets     int
	blockPhases     int

	// Sync search
	decoders []*softDecoder
	pipe     [][][]uint8
	pipePtr  []int
	symbol   []float64

	sigOut1, sigOut2, sigOut []float64
	nseOut1, nseOut2, nseOut []float64
	syncFilterWeight         float64

	blockPhase         int
	syncBestSignal     float64
	syncBestBlockPhase int
	syncBestFreqOffset int
	syncSNR            float64
	synced             bool

	// Resampler
	resampleStep float64
	resPhase     float64
	resPrev      float64
	symbolBuf    []float64
	symbolFill   int

	// Output
	escape bool
	lastCR bool

	// OnChar receives every decoded character. Set before the first Feed.
	OnChar func(rune)
}

func ilog2(v int) int {
	n := 0
	for v > 1 {
		v >>= 1
		n++
	}
	return n
}

// New builds a decoder for the given configuration and input sample rate.
func New(cfg Config, inputRate int) (*Decoder, error) {
	if inputRate <= 0 {
		return nil, fmt.Errorf("invalid sample rate %d", inputRate)
	}
	if cfg.Tones < 2 || cfg.Tones > 256 {
		return nil, fmt.Errorf("tones must be 2..256, got %d", cfg.Tones)
	}
	if cfg.Bandwidth < 125 || cfg.Bandwidth > 2000 {
		return nil, fmt.Errorf("bandwidth must be 125..2000 Hz, got %d", cfg.Bandwidth)
	}
	if cfg.CenterFrequency <= 0 || cfg.CenterFrequency > float64(inputRate)/2 {
		return nil, fmt.Errorf("centre frequency must be 1..%d Hz, got %.1f",
			inputRate/2, cfg.CenterFrequency)
	}
	if cfg.SyncMargin <= 0 {
		cfg.SyncMargin = syncMarginDeflt
	}
	if cfg.SyncIntegLen <= 0 {
		cfg.SyncIntegLen = syncIntegDefault
	}
	d := &Decoder{cfg: cfg, inputRate: inputRate}
	if err := d.preset(); err != nil {
		return nil, err
	}
	return d, nil
}

// preset derives every array in the receiver from the configuration. This is
// MFSK_Receiver::Preset plus MFSK_Demodulator::Preset, which the reference
// keeps apart only because the demodulator is reusable on its own.
func (d *Decoder) preset() error {
	cfg := &d.cfg

	// Tones and bandwidth are rounded down to what the modulation can actually
	// express, exactly as the reference does, and reported back afterwards.
	bps := ilog2(cfg.Tones)
	cfg.Tones = 1 << bps
	bwExp := ilog2(cfg.Bandwidth / 125)
	cfg.Bandwidth = (1 << bwExp) * 125

	d.carriers = 1 << bps

	if cfg.Contestia {
		d.bitsPerCh = contestiaBitsCh
		d.codeShift = contestiaShift
	} else {
		d.bitsPerCh = oliviaBitsPerCh
		d.codeShift = oliviaCodeShift
	}
	d.symbolsPerBlock = 1 << (d.bitsPerCh - 1)

	scramble := oliviaScramble
	if cfg.Contestia {
		scramble = contestiaScramb
	}
	// Expanded once into per-position signs so the hot path never touches
	// 64-bit shifts.
	d.scrambleSg = make([]int8, d.symbolsPerBlock)
	for b := 0; b < d.symbolsPerBlock; b++ {
		if (scramble>>(uint(b)&63))&1 != 0 {
			d.scrambleSg[b] = -1
		} else {
			d.scrambleSg[b] = 1
		}
	}

	// SymbolLen keeps 2*internalRate/SymbolLen equal to the tone spacing for
	// every tones/bandwidth pair, which is what makes it a power of two.
	symbolLen := 1 << uint(bps+7-bwExp)
	symbolSepar := symbolLen / 2
	d.symbolSepar2 = symbolSepar / 2
	d.wrapMask = symbolLen - 1

	// The reference centres the tone block on the dial by backing off half the
	// bandwidth, less half a tone, then converts to an FFT bin index. Reverse
	// tuning puts the block the other side of the dial.
	fcOffset := float64(cfg.Bandwidth) * (1 - 0.5/float64(d.carriers)) / 2
	if cfg.Reverse {
		fcOffset = -fcOffset
	}
	mult := (cfg.CenterFrequency - fcOffset) / 500.0
	firstCarrier := int(float64(symbolLen/16)*mult) + 1
	if firstCarrier < 1 {
		firstCarrier = 1
	}

	d.decodeMargin = cfg.SyncMargin
	if d.decodeMargin > firstCarrier {
		d.decodeMargin = firstCarrier
	}
	d.decodeWidth = (d.carriers*carrierSepar - 1) + 2*d.decodeMargin
	d.freqOffsets = 2*d.decodeMargin + 1
	d.blockPhases = slicesPerSymbol * d.symbolsPerBlock

	// Which way the energy scan walks, and where it starts. Reverse runs
	// downwards from FirstCarrier itself rather than upwards from
	// FirstCarrier - DecodeMargin; that asymmetry is the reference's, and it
	// pairs with the sign flip applied to fcOffset above.
	if cfg.Reverse {
		d.scanFirst = firstCarrier
		d.scanStep = -1
	} else {
		d.scanFirst = firstCarrier - d.decodeMargin
		d.scanStep = 1
	}

	// The tone block plus its search margin has to fit inside the half spectrum
	// a real transform produces. Anything else would read bins that are the
	// mirror of the signal rather than the signal.
	scanLast := d.scanFirst + d.scanStep*(d.decodeWidth-1)
	lo, hi := d.scanFirst, scanLast
	if lo > hi {
		lo, hi = hi, lo
	}
	if lo < 0 || hi > symbolLen/2 {
		return fmt.Errorf("Olivia %d/%d at %.0f Hz does not fit the passband "+
			"(needs FFT bins %d..%d of 0..%d) — retune or use a narrower mode",
			cfg.Tones, cfg.Bandwidth, cfg.CenterFrequency, lo, hi, symbolLen/2)
	}

	d.plan = newFFTPlan(symbolLen)

	// Symbol shape: MFSK_SymbolFreqShape is {1, 1}, which works out to a Hann
	// window scaled by 1/SymbolLen.
	d.shape = make([]float64, symbolLen)
	for t := 0; t < symbolLen; t++ {
		d.shape[t] = (1 - math.Cos(2*math.Pi*float64(t)/float64(symbolLen))) / float64(symbolLen)
	}

	d.inpTap = make([]float64, symbolLen)
	d.inpTapPtr = 0
	d.fftRe = make([]float64, symbolLen)
	d.fftIm = make([]float64, symbolLen)
	for s := 0; s < slicesPerSymbol; s++ {
		d.energy[s] = make([]float64, d.decodeWidth)
	}

	d.symbol = make([]float64, bps)

	d.decoders = make([]*softDecoder, slicesPerSymbol*d.freqOffsets)
	for i := range d.decoders {
		d.decoders[i] = newSoftDecoder(bps, d.symbolsPerBlock, d.codeShift, d.scrambleSg)
	}

	// pipe[blockPhase] is a SyncIntegLen-deep ring of decoded blocks, one block
	// per frequency offset, each block being bps characters.
	d.pipe = make([][][]uint8, d.blockPhases)
	d.pipePtr = make([]int, d.blockPhases)
	for p := 0; p < d.blockPhases; p++ {
		slots := make([][]uint8, cfg.SyncIntegLen)
		for s := range slots {
			slots[s] = make([]uint8, d.freqOffsets*bps)
		}
		d.pipe[p] = slots
	}

	filters := d.blockPhases * d.freqOffsets
	d.sigOut1 = make([]float64, filters)
	d.sigOut2 = make([]float64, filters)
	d.sigOut = make([]float64, filters)
	d.nseOut1 = make([]float64, filters)
	d.nseOut2 = make([]float64, filters)
	d.nseOut = make([]float64, filters)
	d.syncFilterWeight = 1.0 / float64(cfg.SyncIntegLen)

	d.blockPhase = 0
	d.syncBestSignal = 0
	d.syncBestBlockPhase = 0
	d.syncBestFreqOffset = 0
	d.syncSNR = 0
	d.synced = false

	d.resampleStep = float64(internalRate) / float64(d.inputRate)
	d.resPhase = 0
	d.resPrev = 0
	d.symbolBuf = make([]float64, symbolSepar)
	d.symbolFill = 0
	d.escape = false
	d.lastCR = false

	if cfg.SyncThreshold < SyncThresholdMin {
		cfg.SyncThreshold = SyncThresholdMin
	}
	if cfg.SyncThreshold > SyncThresholdMax {
		cfg.SyncThreshold = SyncThresholdMax
	}

	d.geom = Geometry{
		Tones:         cfg.Tones,
		Bandwidth:     cfg.Bandwidth,
		BitsPerSymbol: bps,
		SymbolLen:     symbolLen,
		SymbolSepar:   symbolSepar,
		FirstCarrier:  firstCarrier,
		SyncMargin:    d.decodeMargin,
		FreqOffsets:   d.freqOffsets,
		BlockPhases:   d.blockPhases,
		BaudRate:      float64(internalRate) / float64(symbolSepar),
		BlockPeriod:   float64(d.symbolsPerBlock*symbolSepar) / float64(internalRate),
		CharsPerSec: float64(bps) * float64(internalRate) /
			float64(d.symbolsPerBlock*symbolSepar),
	}
	return nil
}

// Geometry reports what the configuration worked out to.
func (d *Decoder) Geometry() Geometry {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.geom
}

// SetSyncThreshold changes the squelch. This is the one setting that takes
// effect without a rebuild, so it can be dragged while decoding without losing
// a lock that took seconds to acquire.
func (d *Decoder) SetSyncThreshold(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		v = SyncThresholdDefault
	}
	if v < SyncThresholdMin {
		v = SyncThresholdMin
	}
	if v > SyncThresholdMax {
		v = SyncThresholdMax
	}
	d.mu.Lock()
	d.cfg.SyncThreshold = v
	d.mu.Unlock()
	return v
}

// SyncThreshold reports the current squelch setting.
func (d *Decoder) SyncThreshold() float64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.cfg.SyncThreshold
}

// Status is a snapshot of how the decoder is getting on.
type Status struct {
	Synced   bool
	SNR      float64 // the raw FEC signal-to-noise ratio the squelch compares against
	SNRdB    float64 // the same, in dB, clamped to a range worth drawing
	Quality  int     // 0..100 against a fixed reference span
	OffsetHz float64 // frequency error the sync search has settled on
	CenterHz float64 // where the tone block actually is
}

// Status reports the current lock state. Safe to call from another goroutine.
func (d *Decoder) Status() Status {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.statusLocked()
}

func (d *Decoder) statusLocked() Status {
	offset := d.frequencyOffsetLocked()
	snrDB := 0.0
	if d.syncSNR > 0 {
		snrDB = math.Max(0, math.Min(40, 20*math.Log10(d.syncSNR)))
	}
	q := int(math.Round((d.syncSNR - qualityFloor) / qualitySpan * 100))
	if q < 0 {
		q = 0
	}
	if q > 100 {
		q = 100
	}
	return Status{
		Synced:   d.synced,
		SNR:      d.syncSNR,
		SNRdB:    snrDB,
		Quality:  q,
		OffsetHz: offset,
		CenterHz: d.cfg.CenterFrequency + offset,
	}
}

func (d *Decoder) frequencyOffsetLocked() float64 {
	binHz := float64(internalRate) / float64(d.geom.SymbolLen)
	return float64(d.syncBestFreqOffset-d.freqOffsets/2) * binHz
}

// Feed pushes PCM samples in. Samples are int16 at the rate the decoder was
// built with; they are resampled to the internal 8 kHz on the way through.
func (d *Decoder) Feed(pcm []int16) {
	if len(pcm) == 0 {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, s := range pcm {
		d.resample(float64(s) / 32768.0)
	}
}

// Flush drains the synchroniser by pushing silence through it.
//
// A decoded block leaves the pipe SyncIntegLen block periods after it arrived —
// the sync filters have to integrate over that long before the block they
// describe has fully settled — so at the end of a transmission the last several
// blocks are still inside the decoder. The reference has the same method and
// pushes the same amount of silence: two full pipe depths, which is enough to
// walk every block phase past its readout point.
//
// A live receiver never needs this, because the audio does not stop. It matters
// when a recording ends, and it is what the tests use to get the tail of a
// message out.
func (d *Decoder) Flush() {
	d.mu.Lock()
	defer d.mu.Unlock()
	n := d.geom.SymbolSepar * d.symbolsPerBlock * d.cfg.SyncIntegLen * 2
	for i := 0; i < n; i++ {
		d.pushSample(0)
	}
}

// resample steps the internal 8 kHz clock forward by one input sample, emitting
// however many output samples that crossed.
//
// Linear interpolation. See the note at the top of the file for why that is
// enough here: SSB reaches this decoder band-limited to 3 kHz against a 4 kHz
// internal Nyquist, so there is nothing to alias, and the interpolation's tilt
// across a 1 kHz tone block is a few tenths of a dB against a soft demapper
// that normalises every symbol by its own total energy.
func (d *Decoder) resample(x float64) {
	d.resPhase += d.resampleStep
	for d.resPhase >= 1 {
		d.resPhase--
		u := 1 - d.resPhase
		d.pushSample(d.resPrev + (x-d.resPrev)*u)
	}
	d.resPrev = x
}

func (d *Decoder) pushSample(x float64) {
	d.symbolBuf[d.symbolFill] = x
	d.symbolFill++
	if d.symbolFill < len(d.symbolBuf) {
		return
	}
	d.symbolFill = 0
	d.processSymbol(d.symbolBuf)
}

// demodulate turns one symbol period of audio into two FFT slices half a symbol
// apart, which is what gives two decision opportunities per symbol.
//
// Both slices ride in one transform: slice 0 in the real part, slice 1 in the
// imaginary part, pulled apart afterwards by separEnergy. Each read loop walks
// exactly SymbolLen taps, so it returns the tap pointer to where it started and
// only the write loops advance it.
func (d *Decoder) demodulate(input []float64) {
	n := d.geom.SymbolLen

	for i := 0; i < d.symbolSepar2; i++ {
		d.inpTap[d.inpTapPtr] = input[i]
		d.inpTapPtr = (d.inpTapPtr + 1) & d.wrapMask
	}
	p := d.inpTapPtr
	for t := 0; t < n; t++ {
		d.fftRe[t] = d.inpTap[p] * d.shape[t]
		p = (p + 1) & d.wrapMask
	}

	for i := d.symbolSepar2; i < len(d.symbolBuf); i++ {
		d.inpTap[d.inpTapPtr] = input[i]
		d.inpTapPtr = (d.inpTapPtr + 1) & d.wrapMask
	}
	p = d.inpTapPtr
	for t := 0; t < n; t++ {
		d.fftIm[t] = d.inpTap[p] * d.shape[t]
		p = (p + 1) & d.wrapMask
	}

	d.plan.transform(d.fftRe, d.fftIm)

	// Energies for the tone block plus the frequency search margin either side.
	e0, e1 := d.energy[0], d.energy[1]
	freq := d.scanFirst
	for i := 0; i < d.decodeWidth; i++ {
		e0[i], e1[i] = separEnergy(d.fftRe, d.fftIm, n, freq)
		freq += d.scanStep
	}
}

// softDecode demaps one slice at one frequency offset into bitsPerSymbol soft
// bits. Faithful to MFSK_Demodulator::SoftDecode, including squaring the bin
// energy and the Gray-to-binary mapping of the tone index.
func (d *Decoder) softDecode(symbol []float64, slice, freqOffset int) {
	bps := d.geom.BitsPerSymbol
	for b := 0; b < bps; b++ {
		symbol[b] = 0
	}

	e := d.energy[slice]
	base := d.decodeMargin + freqOffset
	total := 0.0
	freq := 0

	for idx := 0; idx < d.carriers; idx++ {
		symbIdx := binaryCode(uint8(idx))
		energy := e[base+freq]
		energy *= energy
		total += energy
		for b := 0; b < bps; b++ {
			if symbIdx&(1<<uint(b)) != 0 {
				symbol[b] -= energy
			} else {
				symbol[b] += energy
			}
		}
		freq += carrierSepar
	}

	if total > 0 {
		for b := 0; b < bps; b++ {
			symbol[b] /= total
		}
	}
}

// processSymbol runs the whole sync search for one symbol period: every
// (slice, frequency offset) candidate is decoded and its FEC signal and noise
// integrated, the winning (block phase, frequency offset) is tracked, and half
// a block after the winner the block that has fully integrated is read out.
func (d *Decoder) processSymbol(input []float64) {
	d.demodulate(input)

	bps := d.geom.BitsPerSymbol
	offsets := d.freqOffsets
	decIdx := 0

	for slice := 0; slice < slicesPerSymbol; slice++ {
		phase := d.blockPhase
		filterBase := phase * offsets
		slot := d.pipe[phase][d.pipePtr[phase]]

		bestSliceSignal := 0.0
		bestSliceOffset := 0

		for off := 0; off < offsets; off++ {
			d.softDecode(d.symbol, slice, off-(offsets>>1))

			dec := d.decoders[decIdx]
			decIdx++
			dec.input(d.symbol)
			dec.process()
			copy(slot[off*bps:(off+1)*bps], dec.outputBlock)

			fi := filterBase + off
			lowPass3(d.nseOut1, d.nseOut2, d.nseOut, fi, dec.noiseEnergy, d.syncFilterWeight, lowPass3Feedback)
			lowPass3(d.sigOut1, d.sigOut2, d.sigOut, fi, dec.signal, d.syncFilterWeight, lowPass3Feedback)

			if sig := d.sigOut[fi]; sig > bestSliceSignal {
				bestSliceSignal = sig
				bestSliceOffset = off
			}
		}

		d.pipePtr[phase] = (d.pipePtr[phase] + 1) % d.cfg.SyncIntegLen

		if phase == d.syncBestBlockPhase {
			d.syncBestSignal = bestSliceSignal
			d.syncBestFreqOffset = bestSliceOffset
		} else if bestSliceSignal > d.syncBestSignal {
			d.syncBestSignal = bestSliceSignal
			d.syncBestBlockPhase = phase
			d.syncBestFreqOffset = bestSliceOffset
		}

		dist := phase - d.syncBestBlockPhase
		if dist < 0 {
			dist += d.blockPhases
		}

		if dist == d.blockPhases>>1 {
			// The noise term is taken from the last frequency offset of this
			// block phase, not from the winning one.
			//
			// The reference reads one element *past* the row here — its pointer
			// has been walked across every offset and is never reset — which
			// lands on the first filter of the next block phase, or past the
			// whole buffer on the last phase. That is an out-of-bounds read in
			// both fldigi and sdr-j; the JavaScript port reads the last valid
			// element of the row instead, and this follows it. The two differ
			// only in which of a set of filters all integrating the same noise
			// is sampled, which is why nobody has noticed in twenty years, and
			// the published squelch values were calibrated against it.
			noise := math.Sqrt(d.nseOut[filterBase+offsets-1])
			if noise == 0 {
				d.syncSNR = 0
			} else {
				d.syncSNR = d.syncBestSignal / noise
			}

			if d.syncSNR >= d.cfg.SyncThreshold {
				d.synced = true
				bestPipe := d.pipe[d.syncBestBlockPhase]
				best := bestPipe[d.pipePtr[d.syncBestBlockPhase]]
				at := d.syncBestFreqOffset * bps
				for c := 0; c < bps; c++ {
					d.emit(best[at+c])
				}
			} else {
				d.synced = false
			}

			if d.syncSNR > 100 {
				d.syncSNR = 0
			}
		}

		d.blockPhase++
		if d.blockPhase >= d.blockPhases {
			d.blockPhase -= d.blockPhases
		}
	}
}

// emit turns one decoded character code into text.
//
// The reference drops everything at or below 7 and passes the rest through,
// with an optional escape — character 127 prefixes the next one to mean it plus
// 128 — that is off by default. That filter is kept; what is added is folding
// CR, LF and CRLF to a single newline, because the consumer here is a scrolling
// console rather than a teleprinter and a bare CR would otherwise be invisible.
func (d *Decoder) emit(code uint8) {
	if d.cfg.EightBit {
		if d.escape {
			d.escape = false
			d.deliver(rune(int(code) + 128))
			return
		}
		if code == 127 {
			d.escape = true
			return
		}
	}
	if code <= 7 {
		return
	}
	switch code {
	case 13:
		d.lastCR = true
		d.deliver('\n')
		return
	case 10:
		// A LF straight after a CR is the second half of one line ending.
		if d.lastCR {
			d.lastCR = false
			return
		}
		d.deliver('\n')
		return
	}
	d.lastCR = false
	d.deliver(rune(code))
}

func (d *Decoder) deliver(r rune) {
	if d.OnChar != nil {
		d.OnChar(r)
	}
}
