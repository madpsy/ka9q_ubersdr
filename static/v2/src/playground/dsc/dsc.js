// Digital Selective Calling (ITU-R M.493), MF/HF: 100 baud FSK, 170 Hz
// shift, the maritime distress and calling system on 2187.5, 4207.5, 6312,
// 8414.5, 12577 and 16804.5 kHz.
//
// A port of ubersdr_dsc (~/repos/ubersdr_dsc/src/dsc_rx.cpp, dsc.cpp), itself
// Jon Beniston's DSC decoder from SDRangel (Copyright (C) 2023 Jon Beniston,
// M7RCE; GPL-3.0-or-later, as this project is). Kept a transliteration on
// purpose, as that port was kept one of SDRangel's: a mistuned DSC decoder
// emits plausible traffic rather than nothing, on a distress band.
//
// The pieces, in the order a signal meets them:
//
//   DscDemod     IQ with the two tones either side of 0 Hz (±85 Hz) to bits:
//                each tone mixed to DC and low-passed at 110 Hz (a 301-tap
//                windowed sinc), its magnitude against a moving maximum over
//                8 bits — W7AY's automatic threshold correction — the bit the
//                larger, the clock pulled a quarter of the way on each rising
//                edge. Phasing found by an exact 30-bit match; then every 10
//                bits a symbol.
//   DscDecoder   symbols to the message: each is 7 information bits (sent
//                least significant first) and a 3-bit count of the zeros among
//                them, and each is sent twice, four symbols apart (DX and RX),
//                the copy without a detected error kept.
//   DscMessage   the message's fields: format, address (or area), category,
//                self ID, telecommands, distress nature and position,
//                frequencies or channels, number, time, end of sequence, and
//                the error-check character.
//
// The rate must be a whole multiple of 1 kHz (SDRangel's constants are at 1
// kHz), so the tone table closes and a bit is a whole number of samples; at
// any other rate nothing is demodulated, as the C++ refuses it.

const BAUD = 100;
const SHIFT = 170;
const EXP_LENGTH_1K = 600; // 51 cycles of 85 Hz at 1 kHz
const MAX_BYTES = 40;

// ── the symbol decoder (DSCDecoder) ─────────────────────────────────────────

export const PHASING_PATTERNS = [
    [0b101111100111110110011011111001, 9], // 125 111 125
    [0b111101100110111110010111011010, 8], // 111 125 110
    [0b101111100101110110101011111001, 7], // 125 110 125
    [0b011101101010111110011011011010, 6], // 110 125 109
    [0b101111100110110110101011111001, 5], // 125 109 125
    [0b101101101010111110010011011011, 4], // 109 125 108
    [0b101111100100110110111011111001, 3], // 125 108 125
    [0b001101101110111110011101011010, 2], // 108 125 107
    [0b101111100111010110101011111001, 1], // 125 107 125
    [0b110101101010111110010101011011, 0], // 107 125 106
];
// Phasing still expected after a pattern, by its offset (125 111 125 found already).
const EXPECTED = [110, 125, 109, 125, 108, 125, 107, 125, 106];

export const END_OF_SIGNAL = { 117: 'Req ACK', 122: 'ACK', 127: 'EOS' };

const reverse8 = (b) => {
    let x = b & 0xff;
    x = ((x & 0xf0) >> 4) | ((x & 0x0f) << 4);
    x = ((x & 0xcc) >> 2) | ((x & 0x33) << 2);
    x = ((x & 0xaa) >> 1) | ((x & 0x55) << 1);
    return x;
};
const popcount = (x) => { let c = 0; while (x) { c += x & 1; x >>>= 1; } return c; };

/** 10 bits (first received most significant) to a symbol, or -1 if its check fails. */
export function bitsToSymbol(bits) {
    const data = reverse8((bits >> 3) & 0xff) >> 1;
    const zeros = 7 - popcount(data);
    return zeros === (bits & 0x7) ? data : -1;
}

/** A symbol to its 10 bits, the inverse of bitsToSymbol: for tests and transmitters. */
export function symbolToBits(sym) {
    const info = reverse8(sym << 1) & 0x7f;
    return (info << 3) | (7 - popcount(sym & 0x7f));
}

export class DscDecoder {
    constructor() { this.init(0); }

    init(offset) {
        if (offset === 0) this.state = 'fillDx';
        else { this.phaseIdx = offset; this.state = 'phasing'; }
        this.idx = 0;
        this.errors = 0;
        this.bytes = [];
        this.buf = [0, 0, 0];
    }

    selectSymbol(dx, rx) {
        let s;
        if (dx !== -1) { s = dx; if (dx !== rx) this.errors++; }
        else if (rx !== -1) { s = rx; this.errors++; }
        else { s = 0x2a; this.errors += 2; } // '*': both copies in error
        this.bytes.push(s & 0xff);
        return s;
    }

    /** One symbol; true when the message is complete (or overlong). */
    decodeSymbol(symbol) {
        switch (this.state) {
            case 'phasing':
                if (symbol !== EXPECTED[9 - this.phaseIdx]) this.errors++;
                this.phaseIdx--;
                if (this.phaseIdx === 0) this.state = 'fillDx';
                return false;
            case 'fillDx':
                this.buf[this.idx++] = symbol;
                if (this.idx === 3) { this.state = 'rx'; this.idx = 0; } else this.state = 'fillRx';
                return false;
            case 'fillRx':
                if ((this.idx === 1 && symbol !== 106) || (this.idx === 2 && symbol !== 105)) this.errors++;
                this.state = 'fillDx';
                return false;
            case 'rx': {
                const a = this.selectSymbol(this.buf[this.idx], symbol);
                this.state = END_OF_SIGNAL[a] ? 'dxEos' : 'dx';
                if (this.bytes.length > MAX_BYTES) { this.state = 'noEos'; return true; }
                return false;
            }
            case 'dx':
                this.buf[this.idx] = symbol;
                this.idx = (this.idx + 1) % 3;
                this.state = 'rx';
                return false;
            case 'dxEos':
                this.buf[this.idx] = symbol;
                this.idx = (this.idx + 1) % 3;
                this.state = 'rxEos';
                return false;
            case 'rxEos':
                this.selectSymbol(this.buf[this.idx], symbol);
                this.state = 'done';
                return true;
            default:
                return false;
        }
    }

    decodeBits(bits) { return this.decodeSymbol(bitsToSymbol(bits)); }
}

// ── the message (DSCMessage) ────────────────────────────────────────────────

export const FORMATS = { 102: 'Geographic call', 112: 'Distress alert', 114: 'Group call', 116: 'All ships', 120: 'Selective call', 123: 'Automatic call' };
export const CATEGORIES = { 100: 'Routine', 108: 'Safety', 110: 'Urgency', 112: 'Distress' };
export const TELECOMMAND1 = {
    100: 'F3E (FM speech)/G3E (phase modulated speech) all modes telephony',
    101: 'F3E (FM speech)/G3E (phase modulated speech) duplex telephony',
    103: 'Polling', 104: 'Unable to comply', 105: 'End of call', 106: 'Data', 109: 'J3E (SSB) telephony',
    110: 'Distress acknowledgement', 112: 'Distress alert relay', 113: 'F1B (FSK) J2B (FSK via SSB) TTY FEC',
    115: 'F1B (FSK) J2B (FSK via SSB) TTY AQR', 118: 'Test', 121: 'Position update', 126: 'No information',
};
export const TELECOMMAND2 = {
    100: 'No reason', 101: 'Congestion at switching centre', 102: 'Busy', 103: 'Queue indication', 104: 'Station barred',
    105: 'No operator available', 106: 'Operator temporarily unavailable', 107: 'Equipment disabled',
    108: 'Unable to use proposed channel', 109: 'Unable to use proposed mode',
    110: 'Ships and aircraft of States not parties to an armed conflict', 111: 'Medical transports',
    112: 'Pay-phone/public call office', 113: 'Facsimile', 126: 'No information',
};
export const DISTRESS_NATURE = {
    100: 'Fire, explosion', 101: 'Flooding', 102: 'Collision', 103: 'Grounding', 104: 'Listing', 105: 'Sinking',
    106: 'Adrift', 107: 'Undesignated', 108: 'Abandoning ship', 109: 'Piracy, armed attack', 110: 'Man overboard', 112: 'EPIRB',
};

const digits = (data, at, len) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String(data[at + i] ?? 0).padStart(2, '0');
    return s;
};

// The first nine digits are the MMSI; a tenth other than 0 is ITU-R M.1080's.
const address = (a) => (a.length >= 10 && a[9] !== '0' ? `${a.slice(0, 9)}-${a[9]}` : a.slice(0, 9));

const coordsDeg = (lat, lon) => {
    const ns = lat >= 0 ? lat + '°N' : -lat + '°S';
    const ew = lon >= 0 ? lon + '°E' : -lon + '°W';
    return ns + ' ' + ew;
};

// A position: ten digits — quadrant, latitude degrees and minutes (2 + 2),
// longitude degrees and minutes (3 + 2). The C++ takes the longitude from
// digits 1–6, over the latitude, which gives 513° for 001°15'; read here from
// where M.493 puts it.
function coords(c) {
    if (c === '9999999999') return 'Not available';
    let lat = `${c.slice(1, 3)}°${c.slice(3, 5)}'`;
    let lon = `${c.slice(5, 8)}°${c.slice(8, 10)}'`;
    switch (c[0]) {
        case '0': lat += 'N'; lon += 'E'; break;
        case '1': lat += 'N'; lon += 'W'; break;
        case '2': lat += 'S'; lon += 'E'; break;
        case '3': lat += 'S'; lon += 'W'; break;
        default: break;
    }
    return `${lat} ${lon}`;
}

function frequency(data, at) {
    let idx = at;
    if (data[idx] === 126 && data[idx + 1] === 126 && data[idx + 2] === 126) return { idx: idx + 3 };
    let s = digits(data, idx, 3);
    idx += 3;
    if (s[0] === '4') { s += digits(data, idx, 1); idx++; }
    if (s[0] === '0' || s[0] === '1' || s[0] === '2') return { idx, hz: Number(s) * 100 };
    if (s[0] === '3') return { idx, channel: `CH${s.slice(1)}` };
    if (s[0] === '4') return { idx, hz: Number(s.slice(1)) * 10 };
    if (s[0] === '9') return { idx, channel: `CH${s.slice(2)}VHF` };
    return { idx };
}

/** A received message's fields, as DSCMessage::decode reads them. */
export function decodeMessage(data) {
    const m = { data: data.slice() };
    let idx = 0;
    m.format = data[idx++];
    m.formatMatch = m.format === data[idx++];
    if (m.format !== 112) {
        if (m.format !== 116) {
            let a = digits(data, idx, 5);
            idx += 5;
            if (m.format === 120) a = address(a);
            else if (m.format === 102) {
                const sector = a[0];
                let lat = Number(a[1]) * 10 + Number(a[2]);
                let lon = Number(a[3]) * 100 + Number(a[4]) * 10 + Number(a[5]);
                if (sector === '1') lon = -lon;
                else if (sector === '2') lat = -lat;
                else if (sector === '3') { lon = -lon; lat = -lat; }
                const dLat = Number(a[6]) * 10 + Number(a[7]);
                const dLon = Number(a[8]) * 10 + Number(a[9]);
                a = `${coordsDeg(lat, lon)} - ${coordsDeg(lat + dLat, lon + dLon)}`;
            }
            m.address = a;
        }
        m.category = data[idx++];
    } else {
        m.category = null;
    }
    m.selfId = address(digits(data, idx, 5));
    idx += 5;
    const distressCat = m.category === 112;
    if (m.format !== 112) {
        m.telecommand1 = data[idx++];
        if (!distressCat) m.telecommand2 = data[idx++];
    }
    if (distressCat) { m.distressId = address(digits(data, idx, 5)); idx += 5; }
    if (m.format === 112) {
        m.distressNature = data[idx++];
        m.position = coords(digits(data, idx, 5));
        idx += 5;
    } else if (m.category != null && !distressCat) {
        if (data[idx] === 55) {
            m.position = coords(digits(data, idx, 5));
            idx += 5;
        } else {
            const f1 = frequency(data, idx);
            idx = f1.idx;
            if (f1.hz) m.rxHz = f1.hz;
            if (f1.channel) m.rxChannel = f1.channel;
            if (m.format !== 123) {
                const f2 = frequency(data, idx);
                idx = f2.idx;
                if (f2.hz) m.txHz = f2.hz;
                if (f2.channel) m.txChannel = f2.channel;
            }
        }
    }
    if (m.format === 123) {
        const oddEven = data[idx++];
        const len = data.length - idx - 2;
        let num = digits(data, idx, Math.max(0, len));
        idx += Math.max(0, len);
        if (oddEven === 105) num = num.slice(1);
        m.number = num;
    }
    if (m.format === 112 || distressCat) {
        const t = digits(data, idx, 2);
        idx += 2;
        if (t !== '8888') m.time = `${t.slice(0, 2)}:${t.slice(2, 4)}`;
        m.subsequent = data[idx++];
    }
    m.eos = data[idx++];
    m.ecc = data[idx++];
    // The check character: every information symbol after the first format
    // specifier, up to and not including the last (which is the check itself).
    let ecc = 0;
    for (let i = 1; i < data.length - 1; i++) ecc ^= data[i];
    m.eccOk = ecc === m.ecc;
    m.valid = !!FORMATS[m.format]
        && (m.category == null || !!CATEGORIES[m.category])
        && (m.telecommand1 == null || !!TELECOMMAND1[m.telecommand1])
        && (m.telecommand2 == null || !!TELECOMMAND2[m.telecommand2])
        && (m.distressNature == null || !!DISTRESS_NATURE[m.distressNature])
        && !!END_OF_SIGNAL[m.eos]
        && !data.includes(0xff)
        && data.length < MAX_BYTES
        && m.eccOk;
    return m;
}

const named = (table, v) => (table[v] != null ? table[v] : `Unknown (${v})`);

/** A message as one line, as DSCMessage::toString writes it. */
export function messageText(m, sep = ' · ') {
    const s = [`Format specifier: ${named(FORMATS, m.format)}`];
    if (m.address != null) s.push(`Address: ${m.address}`);
    if (m.category != null) s.push(`Category: ${named(CATEGORIES, m.category)}`);
    s.push(`Self Id: ${m.selfId}`);
    if (m.telecommand1 != null) s.push(`Telecommand 1: ${named(TELECOMMAND1, m.telecommand1)}`);
    if (m.telecommand2 != null) s.push(`Telecommand 2: ${named(TELECOMMAND2, m.telecommand2)}`);
    if (m.distressId != null) s.push(`Distress Id: ${m.distressId}`);
    if (m.distressNature != null) {
        s.push(`Distress nature: ${named(DISTRESS_NATURE, m.distressNature)}`);
        s.push(`Distress coordinates: ${m.position}`);
    } else if (m.position != null) s.push(`Position: ${m.position}`);
    if (m.rxHz) s.push(`RX Frequency: ${m.rxHz}Hz`);
    if (m.rxChannel) s.push(`RX Channel: ${m.rxChannel}`);
    if (m.txHz) s.push(`TX Frequency: ${m.txHz}Hz`);
    if (m.txChannel) s.push(`TX Channel: ${m.txChannel}`);
    if (m.number != null) s.push(`Phone Number: ${m.number}`);
    if (m.time) s.push(`Time: ${m.time}`);
    if (m.subsequent != null) s.push(`Subsequent comms: ${named(TELECOMMAND1, m.subsequent)}`);
    return s.join(sep);
}

// ── the demodulator (dsc_rx / DSCDemodSink) ─────────────────────────────────

/** SDRangel's generateLowPassFilter: odd taps, windowed sinc, Blackman, unity at DC. Full length. */
export function sdrangelLowpass(nTaps, fs, cutoff) {
    const n = nTaps | 1;
    const wc = (2 * Math.PI * cutoff) / fs;
    const half = Math.floor(n / 2) + 1;
    const h = new Float64Array(half);
    for (let i = 0; i < half; i++) {
        const k = i - (n - 1) / 2;
        h[i] = i === half - 1 ? wc / Math.PI : Math.sin(k * wc) / (k * Math.PI);
        h[i] *= 0.42 + 0.5 * Math.cos((2 * Math.PI * k) / n) + 0.08 * Math.cos((4 * Math.PI * k) / n);
    }
    let sum = 0;
    for (let i = 0; i < half - 1; i++) sum += 2 * h[i];
    sum += h[half - 1];
    const taps = new Float64Array(n);
    for (let i = 0; i < half; i++) { taps[i] = h[i] / sum; taps[n - 1 - i] = h[i] / sum; }
    return taps;
}

/** The largest of the last `size` values, kept as a falling deque so each push is O(1). */
class MovingMaximum {
    constructor(size) {
        this.size = size;
        this.vals = new Float64Array(size + 1);
        this.at = new Float64Array(size + 1);
        this.head = 0;
        this.len = 0;
        this.count = 0;
        this.cap = size + 1;
    }

    push(v) {
        while (this.len > 0 && this.vals[(this.head + this.len - 1) % this.cap] <= v) this.len--;
        const i = (this.head + this.len) % this.cap;
        this.vals[i] = v;
        this.at[i] = this.count;
        this.len++;
        if (this.at[this.head] <= this.count - this.size) { this.head = (this.head + 1) % this.cap; this.len--; }
        this.count++;
    }

    max() { return this.len ? this.vals[this.head] : 0; }
}

/** A complex FIR on I and Q, newest sample last. */
class ComplexTaps {
    constructor(taps) {
        this.taps = taps;
        this.n = taps.length;
        this.bi = new Float64Array(this.n * 2);
        this.bq = new Float64Array(this.n * 2);
        this.pos = 0;
    }

    push(re, im) {
        const { n, bi, bq } = this;
        bi[this.pos] = re; bi[this.pos + n] = re;
        bq[this.pos] = im; bq[this.pos + n] = im;
        this.pos = this.pos + 1 === n ? 0 : this.pos + 1;
        let i = 0;
        let q = 0;
        const p = this.pos;
        for (let t = 0; t < n; t++) { i += this.taps[t] * bi[p + t]; q += this.taps[t] * bq[p + t]; }
        return Math.hypot(i, q);
    }
}

export class DscDemod {
    /**
     * `onMessage(message, errors, rssiDb)` for each one decoded. `centreHz` is
     * where between the tones the dial is: 0 when tuned to the DSC frequency.
     */
    constructor(sampleRate, onMessage, centreHz = 0) {
        this.supported = sampleRate > 0 && sampleRate % 1000 === 0;
        this.onMessage = onMessage;
        this.sampleRate = sampleRate;
        if (!this.supported) return;
        const scale = sampleRate / 1000;
        this.spb = sampleRate / BAUD;
        this.expLen = EXP_LENGTH_1K * scale;
        this.exp = new Float64Array(this.expLen * 2);
        const step = (2 * Math.PI * (SHIFT / 2)) / sampleRate;
        let f = 0;
        for (let i = 0; i < this.expLen; i++) {
            this.exp[2 * i] = Math.cos(f);
            this.exp[2 * i + 1] = Math.sin(f);
            f += step;
            if (f >= 2 * Math.PI) f -= 2 * Math.PI;
        }
        // A dial off the centre: the IQ brought back to it first.
        this.centre = centreHz;
        this.cw = Math.cos((-2 * Math.PI * centreHz) / sampleRate);
        this.sw = Math.sin((-2 * Math.PI * centreHz) / sampleRate);
        this.rc = 1; this.rs = 0; this.rn = 0;
        const taps = sdrangelLowpass(301, sampleRate, BAUD * 1.1);
        this.lpfMark = new ComplexTaps(taps);
        this.lpfSpace = new ComplexTaps(taps);
        this.maxMark = new MovingMaximum(this.spb * 8);
        this.maxSpace = new MovingMaximum(this.spb * 8);
        this.decoder = new DscDecoder();
        this.markEnv = 0;
        this.spaceEnv = 0;
        this.init();
    }

    init() {
        this.expIdx = 0;
        this.bits = 0;
        this.bitCount = 0;
        this.gotSop = false;
        this.clock = -this.spb / 2;
        this.data = false;
        this.dataPrev = false;
        this.rssiSum = 0;
        this.rssiCount = 0;
    }

    process(re, im, n) {
        if (!this.supported) return;
        for (let k = 0; k < n; k++) {
            let x = re[k];
            let y = im[k];
            if (this.centre) {
                const xr = x * this.rc - y * this.rs;
                y = x * this.rs + y * this.rc;
                x = xr;
                const c = this.rc * this.cw - this.rs * this.sw;
                this.rs = this.rc * this.sw + this.rs * this.cw;
                this.rc = c;
                if (++this.rn % 1024 === 0) { const mg = Math.hypot(this.rc, this.rs); this.rc /= mg; this.rs /= mg; }
            }
            this.sample(x, y);
        }
    }

    sample(x, y) {
        if (this.gotSop) { this.rssiSum += x * x + y * y; this.rssiCount++; }
        const ec = this.exp[2 * this.expIdx];
        const es = this.exp[2 * this.expIdx + 1];
        this.expIdx = (this.expIdx + 1) % this.expLen;
        // corr1 = x·e (mark), corr2 = x·conj(e) (space)
        const abs1 = this.lpfMark.push(x * ec - y * es, x * es + y * ec);
        const abs2 = this.lpfSpace.push(x * ec + y * es, y * ec - x * es);
        this.maxMark.push(abs1);
        this.maxSpace.push(abs2);
        const env1 = this.maxMark.max();
        const env2 = this.maxSpace.max();
        this.markEnv = env1;
        this.spaceEnv = env2;
        const biased = (abs1 - 0.5 * env1) - (abs2 - 0.5 * env2);
        this.dataPrev = this.data;
        this.data = biased > 0;
        if (this.data && !this.dataPrev) this.clock -= this.clock * 0.25;
        this.clock += 1;
        if (this.clock >= this.spb / 2 - 1) {
            this.receiveBit(this.data);
            this.clock -= this.spb;
        }
    }

    receiveBit(bit) {
        this.bits = ((this.bits << 1) | (bit ? 1 : 0)) >>> 0;
        this.bitCount++;
        if (!this.gotSop) {
            if (this.bitCount === 30) {
                this.bitCount--;
                const pat = this.bits & 0x3fffffff;
                for (const [p, offset] of PHASING_PATTERNS) {
                    if (pat === p) {
                        this.decoder.init(offset);
                        this.gotSop = true;
                        this.bitCount = 0;
                        this.rssiSum = 0;
                        this.rssiCount = 0;
                        break;
                    }
                }
            }
        } else if (this.bitCount === 10) {
            if (this.decoder.decodeBits(this.bits & 0x3ff)) {
                const rssi = this.rssiCount && this.rssiSum > 0 ? 10 * Math.log10(this.rssiSum / this.rssiCount) : -100;
                if (this.onMessage) this.onMessage(decodeMessage(this.decoder.bytes), this.decoder.errors, rssi);
                this.init();
            }
            this.bitCount = 0;
        }
    }
}
