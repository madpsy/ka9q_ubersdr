package hpsdr

import (
	"encoding/binary"
	"testing"
)

// Protocol 2 packet codecs, byte by byte. Every offset here is one a client
// reads, and a wrong one does not fail -- it tunes the wrong DDC, reports the
// wrong rate, or plays a mirrored spectrum.

func TestP2DiscoveryDetection(t *testing.T) {
	d := make([]byte, 60)
	d[4] = 0x02
	if !IsP2Discovery(d) {
		t.Fatal("discovery not recognised")
	}
	d[0] = 1
	if IsP2Discovery(d) {
		t.Fatal("nonzero sequence accepted as discovery")
	}
	if IsP2Discovery(make([]byte, 59)) || IsP2Discovery(append(make([]byte, 60), 0)) {
		t.Fatal("wrong length accepted")
	}
	g := make([]byte, 60)
	g[0] = 5
	if !IsP2General(g) || IsP2Discovery(g) {
		t.Fatal("general packet misclassified")
	}
}

func TestP2DiscoveryReply(t *testing.T) {
	mac := [6]byte{1, 2, 3, 4, 5, 6}
	r := P2DiscoveryReply(false, mac, DeviceHermesLite, 4, RateMask([]int{48, 96}))
	if len(r) != 60 || binary.BigEndian.Uint32(r) != 0 {
		t.Fatalf("reply % x", r[:8])
	}
	if r[4] != 2 || string(r[5:11]) != string(mac[:]) || r[11] != 6 || r[12] != 38 {
		t.Fatalf("status %d mac % x device %d proto %d", r[4], r[5:11], r[11], r[12])
	}
	if r[13] != 62 || r[20] != 4 || r[21] != 1 || r[22] != 0x03 {
		t.Fatalf("fw %d rx %d adc %d rates %#x", r[13], r[20], r[21], r[22])
	}
	r = P2DiscoveryReply(true, mac, DeviceHermes, 10, 0x0f)
	if r[4] != 3 || r[11] != 1 || r[13] != 18 || r[20] != 10 || r[22] != 0x0f {
		t.Fatalf("busy Hermes reply wrong: % x", r[:23])
	}
}

func TestRateMask(t *testing.T) {
	cases := map[byte][]int{
		0x0f: {48, 96, 192, 384},
		0x01: {48},
		0x0c: {384, 192},
		0x00: {12, 500},
	}
	for want, rates := range cases {
		if got := RateMask(rates); got != want {
			t.Errorf("RateMask(%v) = %#x, want %#x", rates, got, want)
		}
	}
}

func TestParseGeneral(t *testing.T) {
	g := make([]byte, 60)
	binary.BigEndian.PutUint32(g, 7)
	g[37] = 0x08
	g[23] = 1
	binary.BigEndian.PutUint16(g[24:], 256)
	g[26], g[27], g[28] = 16, 2, 32
	p := ParseGeneral(g)
	if p.Seq != 7 || !p.PhaseWord() || p.PortOverride {
		t.Fatalf("%+v", p)
	}
	if !p.WidebandEnable || p.WidebandLen != 256 || p.WidebandSize != 16 || p.WidebandRate != 2 || p.WidebandPPF != 32 {
		t.Fatalf("wideband %+v", p)
	}
	for _, off := range []int{5, 22} {
		g2 := make([]byte, 60)
		g2[off] = 1
		if !ParseGeneral(g2).PortOverride {
			t.Errorf("port override at byte %d missed", off)
		}
	}
	g3 := make([]byte, 60)
	g3[23] = 1 // wideband enable is not a port override
	if ParseGeneral(g3).PortOverride || ParseGeneral(g3).PhaseWord() {
		t.Fatal("byte 23 read as a port override, or phase word from nothing")
	}
}

func hpPacket(run bool, words ...uint32) []byte {
	b := make([]byte, 1444)
	binary.BigEndian.PutUint32(b, 42)
	if run {
		b[4] = 1
	}
	for i, w := range words {
		binary.BigEndian.PutUint32(b[9+4*i:], w)
	}
	return b
}

func TestParseHighPriority(t *testing.T) {
	hp, err := ParseHighPriority(hpPacket(true, 7_100_000, 14_074_000, 0), 3, false)
	if err != nil {
		t.Fatal(err)
	}
	if !hp.Run || hp.Seq != 42 || hp.Freq[0] != 7_100_000 || hp.Freq[1] != 14_074_000 || hp.Freq[2] != 0 {
		t.Fatalf("%+v", hp)
	}
	// Only numRx DDCs are read.
	hp, _ = ParseHighPriority(hpPacket(false, 1, 2, 3), 2, false)
	if hp.Run || hp.Freq[2] != 0 {
		t.Fatalf("read past numRx: %+v", hp)
	}
	if _, err := ParseHighPriority(make([]byte, 1443), 1, false); err == nil {
		t.Fatal("short packet accepted")
	}
}

// Phase words: freq * 2^32 / 122.88 MHz, rounded. Bit 31 set is a frequency
// above 61.44 MHz, never a negative one.
func TestPhaseWords(t *testing.T) {
	for _, hz := range []int64{7_074_000, 14_074_000, 1_000, 29_999_999, 61_440_000, 100_000_000} {
		word := uint32((float64(hz)*4294967296.0)/DDCClockHz + 0.5)
		hp, _ := ParseHighPriority(hpPacket(true, word), 1, true)
		if d := hp.Freq[0] - hz; d < -1 || d > 1 {
			t.Errorf("%d Hz: phase word %#x decoded to %d", hz, word, hp.Freq[0])
		}
		if hp.Freq[0] < 0 {
			t.Errorf("%d Hz decoded negative", hz)
		}
	}
	if got := PhaseWordToHz(0x80000000); got != 61_440_000 {
		t.Fatalf("0x80000000 -> %d", got)
	}
}

func ddcPacket() []byte {
	b := make([]byte, 1444)
	binary.BigEndian.PutUint32(b, 9)
	return b
}

func TestParseDDCSpecific(t *testing.T) {
	b := ddcPacket()
	// Enables for DDC0, DDC3 and DDC9: bit i%8 of byte 7+i/8.
	b[7] = 1<<0 | 1<<3
	b[8] = 1 << 1
	binary.BigEndian.PutUint16(b[18+6*0:], 192)
	binary.BigEndian.PutUint16(b[18+6*3:], 48)
	binary.BigEndian.PutUint16(b[18+6*9:], 1536) // beyond 384
	d, err := ParseDDCSpecific(b, 10)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		want := i == 0 || i == 3 || i == 9
		if d.Enable[i] != want {
			t.Errorf("DDC%d enable %v", i, d.Enable[i])
		}
	}
	if d.RateKHz[0] != 192 || d.RateKHz[3] != 48 || d.RateKHz[9] != 384 || d.RateKHz[1] != 0 {
		t.Fatalf("rates %v", d.RateKHz)
	}
	if len(d.Clamped) != 1 || d.Clamped[0] != 9 {
		t.Fatalf("clamped %v", d.Clamped)
	}
	if d.Synced != -1 || d.Seq != 9 {
		t.Fatalf("synced %d seq %d", d.Synced, d.Seq)
	}
	// Only numRx are read, so DDC9's bit is invisible to a 4-DDC bridge.
	d, _ = ParseDDCSpecific(b, 4)
	if d.Enable[9] || len(d.Clamped) != 0 {
		t.Fatal("read past numRx")
	}
	b[1363+2] = 0x05
	d, _ = ParseDDCSpecific(b, 4)
	if d.Synced != 2 || d.SyncedByte != 5 {
		t.Fatalf("sync %d %#x", d.Synced, d.SyncedByte)
	}
	if _, err := ParseDDCSpecific(make([]byte, 60), 1); err == nil {
		t.Fatal("short packet accepted")
	}
}

// IQ packet: header, then imaginary part first in each six bytes, 24-bit BE
// two's complement, truncated toward zero like C's (int) cast.
func TestBuildP2IQ(t *testing.T) {
	iq := make([]float32, 2*P2SamplesPerPacket)
	for i := 0; i < P2SamplesPerPacket; i++ {
		iq[2*i] = float32(i) + 0.9    // re: truncates down
		iq[2*i+1] = -float32(i) - 0.9 // im: truncates toward zero
	}
	iq[0], iq[1] = 8388607, -8388608 // the 24-bit extremes
	buf := make([]byte, 1444)
	BuildP2IQ(buf, 0xDEADBEEF, iq)
	if binary.BigEndian.Uint32(buf) != 0xDEADBEEF {
		t.Fatal("sequence")
	}
	for _, v := range buf[4:12] {
		if v != 0 {
			t.Fatal("timestamp not zero")
		}
	}
	if binary.BigEndian.Uint16(buf[12:]) != 24 || binary.BigEndian.Uint16(buf[14:]) != 238 {
		t.Fatalf("bits %d samples %d", binary.BigEndian.Uint16(buf[12:]), binary.BigEndian.Uint16(buf[14:]))
	}
	if get24(buf[16:]) != -8388608 || get24(buf[19:]) != 8388607 {
		t.Fatalf("extremes: I %d Q %d", get24(buf[16:]), get24(buf[19:]))
	}
	for i := 1; i < P2SamplesPerPacket; i++ {
		p := buf[16+6*i:]
		if get24(p) != int32(-i) || get24(p[3:]) != int32(i) {
			t.Fatalf("sample %d: I %d Q %d", i, get24(p), get24(p[3:]))
		}
	}
}

func TestStatusAndMic(t *testing.T) {
	s := BuildP2Status(3)
	if len(s) != 60 || binary.BigEndian.Uint32(s) != 3 {
		t.Fatal("status packet")
	}
	for _, v := range s[4:] {
		if v != 0 {
			t.Fatal("status telemetry not zero")
		}
	}
	m := BuildP2Mic(0x01020304)
	if len(m) != 132 || binary.BigEndian.Uint32(m) != 0x01020304 {
		t.Fatal("mic packet")
	}
}

func TestWideband(t *testing.T) {
	for asked, want := range map[int]int{0: 512, 63: 512, 64: 64, 256: 256, 512: 512, 1024: 512, 100: 512} {
		if got := WidebandPacketLen(asked); got != want {
			t.Errorf("WidebandPacketLen(%d) = %d, want %d", asked, got, want)
		}
	}
	sweep := make([]byte, WidebandSweepBytes)
	for i := range sweep {
		sweep[i] = byte(i)
	}
	pkts := BuildWideband(sweep, 256)
	if len(pkts) != 64 {
		t.Fatalf("%d packets", len(pkts))
	}
	for n, p := range pkts {
		if len(p) != 516 || binary.BigEndian.Uint32(p) != uint32(n) {
			t.Fatalf("packet %d: len %d seq %d", n, len(p), binary.BigEndian.Uint32(p))
		}
		// Byte-swapped from the file's little-endian samples.
		src := sweep[n*512:]
		if p[4] != src[1] || p[5] != src[0] || p[515] != src[510] {
			t.Fatalf("packet %d not byte-swapped", n)
		}
	}
}

func TestScaleForKHz(t *testing.T) {
	for khz, want := range map[int]float32{48: 8000, 96: 6000, 192: 4000, 384: 2828, 12: 4000} {
		if got := ScaleForKHz(khz); got != want {
			t.Errorf("ScaleForKHz(%d) = %v", khz, got)
		}
	}
}
