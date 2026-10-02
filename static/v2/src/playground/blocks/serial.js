// A serial port: text, numbers and the handshake lines, in and out.
//
// The port itself is the page's — a worker cannot ask the operator to pick one,
// and Web Serial is not everywhere — so this block is the graph's half only
// (playground/serialLink.js is the page's). Like Text to speech it hands on,
// each packet, what is to go out; and what came in is handed to it before each
// packet (feed), which it puts on its outputs.
//
// Where there is no port — a browser without Web Serial, a page that is not
// https, nobody has picked one — the page simply never feeds it and drops what
// it hands on. The block runs as if the port were quiet, and the rest of the
// graph never knows. Nothing about it is an error.
//
// ── In ──────────────────────────────────────────────────────────────────────
//
//   text    messages to send. Text as it is — a decoder sends a character at
//           a time, and adding a line ending to each would break every word —
//           anything else (a scope's readings, a detector's events) as a JSON
//           line, for whatever is on the other end to log, or not at all.
//   key     a key level (On-off detector, Morse encoder, Threshold): DTR or
//           RTS follow it, switched at the sample it changes, not the packet.
//   value   a control, written as a line: so many places, a prefix, the ending.
//   DTR and RTS are settings too, so either can take a control input like any
//   other — Squelch's `open` on RTS is PTT.
//
// ── Out ─────────────────────────────────────────────────────────────────────
//
//   text    what arrived: line by line, or as it came
//   value   the first number in each line that arrived
//   key     one of the input handshake lines as a 0/1 level — a straight key
//           or a paddle on CTS, for a Morse decoder or a scope
//   cts, dsr, dcd, ri    each input line as a control, sent when it changes

import { CONTROL, MESSAGE, REAL, emitControl } from '../block.js';

export const SERIAL_BAUDS = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
export const SERIAL_ENDINGS = { none: '', lf: '\n', crlf: '\r\n', cr: '\r' };
export const SERIAL_IN_LINES = ['cts', 'dsr', 'dcd', 'ri'];

// The most received text one packet hands on, so a flood from the port cannot
// grow a message without end.
const RX_MAX_CHARS = 64 * 1024;

const choice = (label, def, options) => ({ kind: 'choice', label, default: def, options });

/** A value written as a line's text: rounded as asked, and tidy. */
export function serialNumber(v, decimals) {
    if (!Number.isFinite(v)) return '';
    if (decimals === 'auto' || decimals == null) return String(Number(v.toPrecision(10)));
    const s = v.toFixed(Number(decimals));
    return /^-0(\.0+)?$/.test(s) ? s.slice(1) : s;
}

/** The first number in a line of text, or null. */
export function firstNumber(text) {
    const m = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(String(text));
    if (!m) return null;
    const v = Number(m[0]);
    return Number.isFinite(v) ? v : null;
}

export const SerialPortBlock = {
    type: 'serial-port',
    label: 'Serial port',
    category: 'Devices',
    summary: 'A serial port on this computer: text, numbers and the DTR/RTS/CTS lines in and out — for a terminal, an Arduino, a keying or PTT interface, a paddle. Chrome and Edge, over https, or the desktop app.',
    inputs: [
        { name: 'text', kind: MESSAGE, optional: true },
        { name: 'key', kind: REAL, optional: true, audio: false },
        { name: 'value', kind: CONTROL, optional: true },
    ],
    outputs: [
        { name: 'text', kind: MESSAGE },
        { name: 'value', kind: CONTROL },
        { name: 'key', kind: REAL, audio: false },
        ...SERIAL_IN_LINES.map((l) => ({ name: l, kind: CONTROL })),
    ],
    activity: 'Sending or receiving',
    params: {
        // The port: how it talks. Changing these reopens it.
        baud: choice('Baud', 9600, [...SERIAL_BAUDS.map((b) => ({ value: b, label: String(b) })), { value: 'custom', label: 'Other…' }]),
        customBaud: { kind: 'number', label: 'Baud (other)', default: 9600, min: 50, max: 4000000, step: 1, control: false, showIf: (p) => p.baud === 'custom' },
        dataBits: choice('Data bits', 8, [{ value: 7, label: '7' }, { value: 8, label: '8' }]),
        parity: choice('Parity', 'none', [{ value: 'none', label: 'None' }, { value: 'even', label: 'Even' }, { value: 'odd', label: 'Odd' }]),
        stopBits: choice('Stop bits', 1, [{ value: 1, label: '1' }, { value: 2, label: '2' }]),
        flow: choice('Flow control', 'none', [{ value: 'none', label: 'None' }, { value: 'hardware', label: 'Hardware (RTS/CTS)' }]),
        // Text, both ways.
        encoding: choice('Encoding', 'utf-8', [
            { value: 'utf-8', label: 'UTF-8' },
            { value: 'ascii', label: 'ASCII (7-bit)' },
            { value: 'latin1', label: 'Latin-1' },
            { value: 'hex', label: 'Hex bytes' },
        ]),
        ending: choice('Line ending (sent)', 'lf', [
            { value: 'none', label: 'None' }, { value: 'lf', label: 'LF (\\n)' }, { value: 'crlf', label: 'CR LF (\\r\\n)' }, { value: 'cr', label: 'CR (\\r)' },
        ]),
        others: choice('Other messages', 'json', [{ value: 'json', label: 'Send as JSON lines' }, { value: 'skip', label: 'Do not send' }]),
        receive: choice('Received text', 'lines', [{ value: 'lines', label: 'A line at a time' }, { value: 'chunks', label: 'As it arrives' }]),
        // Values written from the value input.
        decimals: choice('Value decimals', 'auto', [{ value: 'auto', label: 'As it comes' }, ...[0, 1, 2, 3, 4, 5, 6].map((d) => ({ value: d, label: String(d) }))]),
        prefix: { kind: 'text', label: 'Value prefix', default: '', max: 32 },
        // The handshake lines.
        dtr: { kind: 'bool', label: 'DTR', default: false, live: true },
        rts: { kind: 'bool', label: 'RTS', default: false, live: true },
        keyLine: choice('Key input drives', 'dtr', [{ value: 'none', label: 'Nothing' }, { value: 'dtr', label: 'DTR' }, { value: 'rts', label: 'RTS' }]),
        keyIn: choice('Key output follows', 'cts', SERIAL_IN_LINES.map((l) => ({ value: l, label: l.toUpperCase() }))),
        invertKeyIn: { kind: 'bool', label: 'Invert key output', default: false, live: true },
    },
    create() {
        let p = {};
        let rate = 12000;
        // Going out, this packet.
        let tx = '';
        let edges = [];
        let keyed = null;
        let seenValue = -1;
        // Come in, waiting for the next packet.
        let rxText = [];
        let rxValues = [];
        let rxSignals = [];
        // The input lines as they stand, and as last put on the outputs.
        let lines = { cts: false, dsr: false, dcd: false, ri: false };
        const said = { cts: null, dsr: null, dcd: null, ri: null };
        let partial = '';
        let busy = false;
        const keyOf = () => (lines[p.keyIn || 'cts'] ? 1 : 0) ^ (p.invertKeyIn ? 1 : 0);
        return {
            configure(params, r) { p = params; rate = r || rate; },
            reset() {
                tx = ''; edges = []; keyed = null; seenValue = -1;
                rxText = []; rxValues = []; rxSignals = []; partial = '';
                lines = { cts: false, dsr: false, dcd: false, ri: false };
                for (const l of SERIAL_IN_LINES) said[l] = null;
            },
            /**
             * What came in since the last packet, from the page: `{ text,
             * signals }` — text as it arrived (chunks, already decoded), and
             * each change of the input lines with how far into the packet it
             * fell (0 to 1).
             */
            feed(data) {
                if (!data) return;
                if (data.text) rxText.push(...data.text);
                if (data.signals) rxSignals.push(...data.signals);
            },
            // This packet's going-out, for the page; and whether it was busy,
            // for the card's dot.
            read() { return { tx, edges, key: keyed, dtr: !!p.dtr, rts: !!p.rts, keyLine: p.keyLine }; },
            activity() {
                const was = busy;
                busy = false;
                return was ? 1 : 0;
            },
            process(ins, outs, n) {
                // ── going out ──
                tx = '';
                edges = [];
                const end = SERIAL_ENDINGS[p.ending] ?? '\n';
                const text = ins[0];
                if (text && text.list) {
                    for (const m of text.list) {
                        if (!m) continue;
                        if (m.type === 'text' && typeof m.text === 'string') tx += m.text;
                        else if (p.others !== 'skip') tx += `${JSON.stringify(m)}${end}`;
                    }
                }
                const value = ins[2];
                if (value && value.seq !== seenValue && value.value != null) {
                    seenValue = value.seq;
                    const s = serialNumber(Number(value.value), p.decimals);
                    if (s) tx += `${p.prefix || ''}${s}${end}`;
                }
                const key = ins[1];
                if (key && key.re) {
                    const x = key.re;
                    const m = key.n != null ? key.n : n;
                    for (let k = 0; k < m; k++) {
                        const on = x[k] >= 0.5;
                        if (keyed === null || on !== !!keyed) {
                            edges.push({ at: k / rate, on });
                            keyed = on ? 1 : 0;
                        }
                    }
                } else {
                    keyed = null;
                }

                // ── come in ──
                if (rxText.length) {
                    let got = rxText.join('');
                    rxText = [];
                    if (got.length > RX_MAX_CHARS) got = got.slice(-RX_MAX_CHARS);
                    const outText = outs[0];
                    if (p.receive === 'chunks') {
                        if (outText && outText.list) outText.list.push({ type: 'text', text: got });
                        const v = firstNumber(got);
                        if (v != null) rxValues.push(v);
                    } else {
                        // A line at a time, each with its ending, so a console
                        // shows it as it was; what is left waits for its end.
                        const all = partial + got;
                        const parts = all.split(/\r\n|\n|\r/);
                        partial = parts.pop();
                        if (partial.length > RX_MAX_CHARS) partial = partial.slice(-RX_MAX_CHARS);
                        for (const line of parts) {
                            if (outText && outText.list) outText.list.push({ type: 'text', text: `${line}\n` });
                            const v = firstNumber(line);
                            if (v != null) rxValues.push(v);
                        }
                    }
                    busy = true;
                }
                if (rxValues.length) {
                    if (outs[1]) emitControl(outs[1], rxValues[rxValues.length - 1]);
                    rxValues = [];
                }
                // The key output: the chosen line, held, changing at the point
                // in the packet each change came.
                const keyOut = outs[2] && outs[2].re;
                let level = keyOf();
                let from = 0;
                const changes = rxSignals.slice().sort((a, b) => a.frac - b.frac);
                rxSignals = [];
                for (const c of changes) {
                    const to = Math.max(from, Math.min(n, Math.floor((c.frac || 0) * n)));
                    if (keyOut) for (let k = from; k < to; k++) keyOut[k] = level;
                    from = to;
                    lines = { ...lines, ...c.lines };
                    level = keyOf();
                }
                if (keyOut) for (let k = from; k < n; k++) keyOut[k] = level;
                SERIAL_IN_LINES.forEach((l, i) => {
                    const now = lines[l] ? 1 : 0;
                    if (now !== said[l] && outs[3 + i]) {
                        said[l] = now;
                        emitControl(outs[3 + i], now);
                    }
                });
                if (tx) busy = true;
                return n;
            },
        };
    },
};
