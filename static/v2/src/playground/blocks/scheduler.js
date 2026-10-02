// A scheduler: frequencies (and modes, widths, offsets) by the clock — to
// hop the bands with an NCDXF beacon, catch a fax broadcast at its time, or
// step round a net's frequencies.
//
// A schedule is lines of text, one entry each:
//
//     <when>  <frequency>  [mode]  [width=Hz]  [offset=Hz]  [label …]
//
// `when` is either a time into a repeating cycle (`0:10`, `2:30`, `45` — the
// cycle as long as `period`) or a time of day in UTC (`09:30`, `21:45:30`),
// as `kind` says. An entry holds until the next one's time. Or `kind` is
// `dwell` — in turn, `dwell` seconds on each — and the lines have no time at
// all (one given is ignored): a round of NDBs, say. Aligned to the clock, the
// hops fall on whole multiples of `dwell` (:00 and :30 for 30 s), timed by a
// Clock's unix and pps like the rest, and which entry is the time's to say. A `next` input moves on
// at once, whatever the kind of schedule — a squelch closing, a decoder done.
//
// The entries can come from a Frequency list block wired to `list` (Schedule:
// From the list input) rather than this block's own text: lists kept apart
// from when they are visited. The frequency is
// in MHz when it has a point and is under 1000 (14.100), else kHz under
// 100000 (14100), else Hz — or say so (14.1MHz, 14100kHz); a `-` keeps the
// frequency and changes only what follows. Anything after the settings is the
// entry's label. `#` starts a comment.
//
// The time is a Clock's: its `unix` output, wired in, and its `pps` to put
// each change on the second's edge rather than wherever in a packet the
// second's control arrived. Without one, this device's clock.
//
// An entry this receiver cannot tune — outside the instance's tuning range,
// which the page tells this block as it tells the IQ stream — is marked, and
// skipped when its time comes, the one before holding: a band-hopping
// schedule on a receiver without the upper bands just hops the bands it has.
//
// Out: `frequency` (Hz, for an IQ stream's frequency input), `mode` (a
// message naming a mode, for a Demodulator's Mode exposed as an input),
// `width` and `offset` (Hz, controls), `label` (a message, for a console or
// TTS) and `index` (which entry is in force, from 0).

import { CONTROL, MESSAGE, REAL, emitControl } from '../block.js';
import { NCDXF_BANDS, NCDXF_BEACONS } from './beacons.js';

const MODE_WORDS = new Set(['usb', 'lsb', 'am', 'sam', 'ecss', 'fm', 'nfm', 'cw', 'cwu', 'cwl', 'cw-u', 'cw-l', 'iq']);

/** The frequency in a schedule's word, in Hz, or null. */
export function parseScheduleFrequency(word) {
    const m = /^(\d+(?:\.\d+)?)\s*(mhz|khz|hz)?$/i.exec(String(word).trim());
    if (!m) return null;
    const v = Number(m[1]);
    const unit = (m[2] || '').toLowerCase();
    if (unit === 'mhz') return Math.round(v * 1e6);
    if (unit === 'khz') return Math.round(v * 1e3);
    if (unit === 'hz') return Math.round(v);
    if (m[1].includes('.') && v < 1000) return Math.round(v * 1e6);
    if (v < 100000) return Math.round(v * 1e3);
    return Math.round(v);
}

/** A time word in seconds: m:ss, h:mm:ss or plain seconds (`repeat`), or hh:mm[:ss] of the day (`daily`). */
function parseWhen(word, kind) {
    const parts = String(word).split(':');
    if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null;
    const n = parts.map(Number);
    if (kind === 'daily') {
        if (n.length < 2 || n.length > 3 || n[0] > 23 || n[1] > 59 || (n[2] || 0) >= 60) return null;
        return n[0] * 3600 + n[1] * 60 + (n[2] || 0);
    }
    if (n.length === 1) return n[0];
    if (n.length === 2) return n[0] * 60 + n[1];
    if (n.length === 3) return n[0] * 3600 + n[1] * 60 + n[2];
    return null;
}

/** A mode word as the Demodulator names its modes. */
function modeOf(word) {
    const w = word.toLowerCase();
    if (w === 'cw' || w === 'cw-u') return 'cwu';
    if (w === 'cw-l') return 'cwl';
    return w;
}

/**
 * Schedule text to `{ entries, errors }`: entries `{ at, frequency, mode,
 * width, offset, label, line }` sorted by `at` (seconds into the cycle or
 * day), errors `{ line, message }`.
 */
export function parseSchedule(text, kind = 'repeat') {
    const entries = [];
    const errors = [];
    String(text || '').split(/\r?\n/).forEach((raw, i) => {
        const line = raw.replace(/#.*/, '').trim();
        if (!line) return;
        let words = line.split(/\s+/);
        if (kind === 'dwell') {
            // In turn: no times. A line copied with one keeps its place in the order.
            if (words[0].includes(':') && words.length > 1) words = words.slice(1);
            words = [String(entries.length), ...words];
        }
        const at = parseWhen(words[0], kind === 'dwell' ? 'repeat' : kind);
        if (at == null) { errors.push({ line: i + 1, message: `“${words[0]}” is not a ${kind === 'daily' ? 'time of day (hh:mm)' : 'time into the cycle (m:ss)'}` }); return; }
        if (words.length < 2) { errors.push({ line: i + 1, message: 'A frequency (or -) is wanted after the time' }); return; }
        let frequency = null;
        if (words[1] !== '-') {
            frequency = parseScheduleFrequency(words[1]);
            if (frequency == null) { errors.push({ line: i + 1, message: `“${words[1]}” is not a frequency` }); return; }
        }
        const e = { at, frequency, mode: null, width: null, offset: null, label: '', line: i + 1 };
        let k = 2;
        for (; k < words.length; k++) {
            const w = words[k];
            const kv = /^(width|offset)=(-?\d+(?:\.\d+)?)$/i.exec(w);
            if (kv) { e[kv[1].toLowerCase()] = Number(kv[2]); continue; }
            if (e.mode == null && MODE_WORDS.has(w.toLowerCase())) { e.mode = modeOf(w); continue; }
            break;
        }
        e.label = words.slice(k).join(' ');
        entries.push(e);
    });
    entries.sort((a, b) => a.at - b.at);
    return { entries, errors };
}

/**
 * The schedule that follows NCDXF beacon `index` round the five bands: it is
 * on 14.100 in slot `index` of the three-minute cycle, and a band higher each
 * slot after (beacons.js beaconAt). CW, and the beacon's call as the label.
 */
export function ncdxfFollowSchedule(index) {
    const b = NCDXF_BEACONS[index] || NCDXF_BEACONS[0];
    return NCDXF_BANDS.map((band, k) => {
        const at = ((index + k) % 18) * 10;
        return `${Math.floor(at / 60)}:${String(at % 60).padStart(2, '0')} ${(band.khz / 1000).toFixed(3)} cwu ${b.call} ${band.band}`;
    }).join('\n');
}

export const SchedulerBlock = {
    type: 'scheduler',
    label: 'Scheduler',
    category: 'Control',
    summary: 'Frequencies, modes, widths and offsets by the clock — a repeating cycle (hop the bands with an NCDXF beacon), times of day in UTC (a fax broadcast), or in turn, so long on each (a round of NDBs). Its entries typed here or from a Frequency list; a Clock’s unix (and pps) in; frequency out to an IQ stream, mode to a Demodulator.',
    inputs: [
        { name: 'unix', kind: CONTROL, optional: true },
        { name: 'pps', kind: REAL, optional: true, audio: false },
        // Used when Schedule is set to From the list input.
        { name: 'list', kind: MESSAGE, optional: true },
        { name: 'next', kind: CONTROL, optional: true },
    ],
    outputs: [
        { name: 'frequency', kind: CONTROL },
        { name: 'mode', kind: MESSAGE },
        { name: 'width', kind: CONTROL },
        { name: 'offset', kind: CONTROL },
        { name: 'label', kind: MESSAGE },
        { name: 'index', kind: CONTROL },
    ],
    // The page sends this block the receiver's tuning range (workerCore.js).
    wantsTuning: true,
    params: {
        preset: {
            kind: 'choice', label: 'Schedule', default: 'custom', control: false,
            options: [
                { value: 'custom', label: 'As written below' },
                { value: 'input', label: 'From the list input' },
                { value: 'ncdxf', label: 'Follow an NCDXF beacon' },
            ],
        },
        beacon: {
            kind: 'choice', label: 'Beacon', default: 0,
            options: NCDXF_BEACONS.map((b, i) => ({ value: i, label: `${b.call} — ${b.where}` })),
            showIf: (p) => p.preset === 'ncdxf',
        },
        kind: {
            kind: 'choice', label: 'Timing', default: 'repeat', control: false,
            options: [
                { value: 'repeat', label: 'In a cycle', title: 'Each entry at a time into a repeating cycle (m:ss)' },
                { value: 'daily', label: 'Time of day (UTC)', title: 'Each entry at a time of day, UTC (hh:mm)' },
                { value: 'dwell', label: 'In turn', title: 'No times: each entry in turn, so long on each' },
            ],
            showIf: (p) => p.preset !== 'ncdxf',
        },
        period: { kind: 'number', label: 'Cycle', unit: 's', default: 180, min: 1, max: 86400, step: 1, control: false, showIf: (p) => p.preset !== 'ncdxf' && p.kind === 'repeat' },
        dwell: { kind: 'number', label: 'On each', unit: 's', default: 30, min: 1, max: 86400, step: 1, showIf: (p) => p.preset !== 'ncdxf' && p.kind === 'dwell' },
        // In turn, on the clock: each hop at a whole multiple of the time on
        // each (:00 and :30 for 30 s), the entry chosen by the time itself —
        // so it is the same on any receiver keeping good time.
        align: { kind: 'bool', label: 'Aligned to the clock', default: false, control: false, showIf: (p) => p.preset !== 'ncdxf' && p.kind === 'dwell' },
        schedule: {
            kind: 'text', label: 'Entries (time  frequency  [mode]  [width=]  [offset=]  [label])', default: '0:00 14.100 usb\n1:00 18.110 usb\n2:00 21.150 usb', max: 8000, multiline: true,
            showIf: (p) => p.preset === 'custom',
        },
        leadMs: { kind: 'number', label: 'Change early by', unit: 'ms', default: 0, min: 0, max: 5000, step: 10, control: false },
        // Stopped, it sends nothing; started again, it sends the entry in
        // force at once. A switch here and a button on the card, and an input
        // when exposed — a toggle, or a Clock's window, to run it by the clock.
        running: { kind: 'bool', label: 'Running', default: true, live: true },
    },
    activity: 'Running',
    create() {
        let p = {};
        let parsed = { entries: [], errors: [] };
        let kind = 'repeat';
        let period = 180;
        let tuning = null;
        let t = null;            // Unix seconds at the next sample
        let fromClock = false;
        let seen = -1;
        let lastPps = 0;
        let current = -1;        // the entry in force
        let sent = {};           // what each output last sent
        let skipped = '';
        let listText = null;     // entries from a Frequency list, when one is wired
        let wired = false;       // whether one is
        let since = 0;           // when the entry in force began (in turn)
        let seenNext = -1;
        let held = null;         // the clock's entry when `next` moved past it
        let shift = 0;           // moves on by hand, aligned in turn
        const parse = () => {
            const text = p.preset === 'input' ? (listText || '') : p.preset === 'ncdxf' ? ncdxfFollowSchedule(+p.beacon) : p.schedule;
            parsed = parseSchedule(text, kind);
            // Lines that would all read but for wanting times: one plain hint.
            parsed.hint = kind !== 'dwell' && !parsed.entries.length && parsed.errors.length && !parseSchedule(text, 'dwell').errors.length
                ? 'No times on these lines — set Timing to “In turn”, or start each with a time' : '';
            current = -1;
        };
        // The next entry this receiver can tune after `k`, round the list.
        const after = (k) => {
            const es = parsed.entries;
            for (let i = 1; i <= es.length; i++) {
                const j = (k + i + es.length) % es.length;
                if (reachable(es[j])) return j;
            }
            return -1;
        };
        const reachable = (e) => e.frequency == null || !tuning || !(tuning.min > 0 && tuning.max > tuning.min)
            || (e.frequency >= tuning.min && e.frequency <= tuning.max);
        // Seconds into the cycle (or day) at Unix time s.
        const phase = (s) => {
            const len = kind === 'daily' ? 86400 : period;
            return ((s % len) + len) % len;
        };
        // The entry in force at Unix time s: the last at or before its phase
        // (round the cycle to the last of all before the first), skipping
        // those this receiver cannot tune.
        const entryAt = (s) => {
            const es = parsed.entries;
            if (!es.length) return -1;
            const ph = phase(s);
            let k = -1;
            for (let i = 0; i < es.length; i++) if (es[i].at <= ph) k = i;
            if (k < 0) k = es.length - 1;
            for (let tries = 0; tries < es.length; tries++) {
                if (reachable(es[k])) return k;
                k = (k - 1 + es.length) % es.length;
            }
            return -1;
        };
        const send = (outs, i) => {
            const e = parsed.entries[i];
            const emit = (k, name, v) => { if (v != null && outs[k]) { emitControl(outs[k], v); sent[name] = v; } };
            emit(0, 'frequency', e.frequency);
            if (e.mode && outs[1]) { outs[1].list.push({ type: 'text', text: e.mode, value: e.mode }); sent.mode = e.mode; }
            emit(2, 'width', e.width);
            emit(3, 'offset', e.offset);
            if (outs[4]) outs[4].list.push({ type: 'text', text: `${e.label || (e.frequency ? `${(e.frequency / 1e6).toFixed(4)} MHz` : 'Entry ' + (i + 1))}\n` });
            emit(5, 'index', i);
        };
        return {
            configure(params) {
                // Started again: the entry in force sent afresh, the receiver put where the schedule says.
                if (p.running === false && params.running !== false) { current = -1; seenNext = -1; }
                p = params;
                kind = p.preset === 'ncdxf' ? 'repeat' : p.kind;
                period = p.preset === 'ncdxf' ? 180 : Math.max(1, p.period);
                // Sent again in full under the new schedule.
                parse();
            },
            reset() { t = null; seen = -1; seenNext = -1; current = -1; sent = {}; fromClock = false; shift = 0; },
            feed(data) { if (data && data.tuning) tuning = data.tuning; },
            activity() { return p.running !== false && current >= 0 ? 1 : 0; },
            read() {
                const now = t != null ? t : Date.now() / 1000;
                const es = parsed.entries;
                let next = null;
                if (es.length && kind === 'dwell') {
                    const k = current >= 0 ? after(current) : -1;
                    if (k >= 0) next = { index: k, wait: Math.max(0, p.dwell - (now - since)) };
                } else if (es.length) {
                    const ph = phase(now + p.leadMs / 1000);
                    const len = kind === 'daily' ? 86400 : period;
                    let best = null;
                    for (let i = 0; i < es.length; i++) {
                        if (!reachable(es[i])) continue;
                        const wait = ((es[i].at - ph) % len + len) % len || len;
                        if (!best || wait < best.wait) best = { index: i, wait };
                    }
                    next = best;
                }
                return {
                    entries: es.map((e, i) => ({ ...e, reachable: reachable(e), index: i })),
                    errors: parsed.errors,
                    hint: parsed.hint || '',
                    current,
                    next,
                    kind,
                    period,
                    skipped,
                    running: p.running !== false,
                    fromList: p.preset === 'input' && listText != null,
                    listWanted: p.preset === 'input',
                    listWired: wired,
                    // In turn, only how long has passed matters: any clock will do — unless aligned to it.
                    why: fromClock || (kind === 'dwell' && !p.align) ? '' : 'No Clock wired: on this device’s clock',
                };
            },
            process(ins, outs, n, stream) {
                // This packet's length, from the stream (a block of controls
                // has no samples of its own to count).
                const dur = stream && stream.rate > 0 && stream.frames > 0 ? stream.frames / stream.rate : 0.02;
                const u = ins[0];
                const pps = ins[1];
                const list = ins[2];
                const nx = ins[3];
                wired = !!list;
                // Unwired, nothing from it any more.
                if (!list && listText != null) {
                    listText = null;
                    if (p.preset === 'input') parse();
                }
                // A Frequency list's entries, the last it sent — used when the
                // Schedule is From the list input.
                if (list && list.list && list.list.length) {
                    const m = list.list[list.list.length - 1];
                    if (m && typeof m.schedule === 'string' && m.schedule !== listText) {
                        listText = m.schedule;
                        if (p.preset === 'input') parse();
                    }
                }
                // Where in the packet a pulse rose, if one did.
                let edge = null;
                if (pps && pps.re && pps.n > 0) {
                    for (let k = 0; k < pps.n; k++) {
                        const v = pps.re[k];
                        if (v > 0.5 && lastPps <= 0.5) edge = (k / pps.n) * dur;
                        lastPps = v;
                    }
                }
                // The Clock's second, which arrives somewhere in the packet: put
                // on the pulse's edge where there is a pulse, else mid-packet.
                if (u && u.seq !== seen && u.value != null) {
                    seen = u.seq;
                    t = u.value - (edge != null ? edge : dur / 2);
                    fromClock = true;
                } else if (u && !fromClock) {
                    // A Clock wired but not yet heard from: wait for it, rather
                    // than send an entry by this device's clock and another a
                    // moment later — a needless retune.
                    return 0;
                } else if (!fromClock || t == null) {
                    // This device's clock: taken once, then the stream's own
                    // time added to it — taken again only if the two part by
                    // more than a couple of seconds, and never in turn, where
                    // only how long has passed matters (and a file played
                    // faster than real time must still give each its due).
                    const wall = Date.now() / 1000 - dur;
                    if (t == null || ((kind !== 'dwell' || p.align) && Math.abs(wall - t) > 2)) t = wall;
                    fromClock = false;
                }
                const now = t + dur + p.leadMs / 1000;
                if (p.running === false) {
                    // Stopped: the time kept, nothing sent.
                    t += dur;
                    return 0;
                }
                // `next`: move on at once (a new value, after the first seen).
                let move = false;
                if (nx && nx.seq !== seenNext) {
                    if (seenNext !== -1 && nx.value != null) move = true;
                    seenNext = nx.seq;
                }
                if (kind === 'dwell' && p.align) {
                    // The entry is the time's: period number (plus any moves
                    // on by hand) round the entries this receiver can tune.
                    const can = parsed.entries.map((e, i) => (reachable(e) ? i : -1)).filter((i) => i >= 0);
                    if (move) shift++;
                    if (can.length) {
                        const n = Math.floor(now / p.dwell) + shift;
                        const k = can[((n % can.length) + can.length) % can.length];
                        if (k !== current) { current = k; send(outs, k); }
                        since = Math.floor(now / p.dwell) * p.dwell;
                    }
                } else if (kind === 'dwell') {
                    const k = current < 0 ? after(-1) : (move || now - since >= p.dwell) ? after(current) : current;
                    if (k >= 0 && (k !== current || move || now - since >= p.dwell)) {
                        if (k !== current) send(outs, k);
                        current = k;
                        since = now;
                    }
                } else {
                    let k = entryAt(now);
                    // Moved on by hand: the next entry, held until the clock's own next change.
                    if (move && current >= 0) { k = after(current); held = entryAt(now); }
                    else if (held != null && entryAt(now) === held) k = current;
                    else held = null;
                    if (k >= 0 && k !== current) {
                        current = k;
                        send(outs, k);
                    }
                }
                const es = parsed.entries;
                const unreachable = es.filter((e) => !reachable(e)).length;
                skipped = unreachable ? `${unreachable} ${unreachable === 1 ? 'entry is' : 'entries are'} outside this receiver’s range, skipped` : '';
                t += dur;
                return 0;
            },
        };
    },
};

/**
 * A list of frequencies to visit — kept apart from when they are visited, so
 * one Scheduler can work any list, and one list feed more than one. Lines as
 * a Scheduler's, the time left out (or kept, for a Scheduler timing them):
 *
 *     380kHz am offset=400 CBL Campbeltown
 *
 * Sent on (as `{ type: 'schedule', schedule }`) when it changes, and every few
 * seconds besides, so a Scheduler added later has it too — and every entry's
 * name on `labels` (`{ type: 'items', items }`), for a Status board.
 */
export const FrequencyListBlock = {
    type: 'frequency-list',
    label: 'Frequency list',
    category: 'Control',
    summary: 'Frequencies to visit, with their modes, widths, offsets and names — typed, or a preset — for a Scheduler to work through. The list kept apart from when it is visited.',
    // `select`: an entry by its number (from 1) or its name (“DND”, or the whole label).
    inputs: [{ name: 'select', kind: MESSAGE, optional: true }],
    // `labels`: every entry's name, for a Status board to show them all from
    // the start. The rest are the selected entry's, as a Scheduler's are its
    // current one's — so a list can tune the receiver by itself, a preset
    // picker: frequency to an IQ stream, mode to a Demodulator.
    outputs: [
        { name: 'list', kind: MESSAGE },
        { name: 'labels', kind: MESSAGE },
        { name: 'frequency', kind: CONTROL },
        { name: 'mode', kind: MESSAGE },
        { name: 'width', kind: CONTROL },
        { name: 'offset', kind: CONTROL },
        { name: 'label', kind: MESSAGE },
        { name: 'index', kind: CONTROL },
    ],
    params: {
        preset: {
            kind: 'choice', label: 'List', default: 'custom', control: false,
            options: [{ value: 'custom', label: 'As written below' }, { value: 'ncdxf', label: 'An NCDXF beacon’s bands (timed)' }],
        },
        beacon: {
            kind: 'choice', label: 'Beacon', default: 0,
            options: NCDXF_BEACONS.map((b, i) => ({ value: i, label: `${b.call} — ${b.where}` })),
            showIf: (p) => p.preset === 'ncdxf',
        },
        entries: {
            kind: 'text', label: 'Entries (frequency  [mode]  [width=]  [offset=]  [label])', default: '14.100 usb\n18.110 usb\n21.150 usb', max: 8000, multiline: true,
            showIf: (p) => p.preset === 'custom',
        },
        // The entry its frequency, mode, width, offset and label outputs
        // carry — clicked on its card, set here, or chosen by `select`.
        select: { kind: 'number', label: 'Tune to entry', default: 1, min: 1, max: 9999, step: 1, live: true },
    },
    create() {
        let text = '';
        let dirty = true;
        let packets = 0;
        let p = {};
        let entries = [];
        let picked = -1;          // the entry last sent, from 0
        let chosen = null;        // one chosen by `select`, overriding the setting until it next changes
        let lastSetting = null;
        const send = (outs, i) => {
            const e = entries[i];
            if (!e) return;
            if (e.frequency != null && outs[2]) emitControl(outs[2], e.frequency);
            if (e.mode && outs[3]) outs[3].list.push({ type: 'text', text: e.mode, value: e.mode });
            if (e.width != null && outs[4]) emitControl(outs[4], e.width);
            if (e.offset != null && outs[5]) emitControl(outs[5], e.offset);
            if (outs[6]) outs[6].list.push({ type: 'text', text: `${e.label || `${(e.frequency / 1e6).toFixed(4)} MHz`}\n` });
            if (outs[7]) emitControl(outs[7], i + 1);
        };
        // An entry named by a message: its number, or its name's first word or the whole of it.
        const named = (m) => {
            const raw = String((m && (m.value != null ? m.value : m.text)) || '').trim();
            if (/^\d+$/.test(raw)) return Number(raw) - 1;
            const want = raw.toUpperCase().replace(/\s+/g, ' ');
            if (!want) return -1;
            return entries.findIndex((e) => {
                const l = (e.label || '').toUpperCase().replace(/\s+/g, ' ');
                return l === want || l.split(' ')[0] === want;
            });
        };
        return {
            configure(params) {
                p = params;
                const next = p.preset === 'ncdxf' ? ncdxfFollowSchedule(+p.beacon) : String(p.entries || '');
                if (next !== text) { text = next; dirty = true; picked = -1; entries = parseSchedule(text, 'dwell').entries; }
                // The setting moved (a click on the card, say): that wins over a `select` from before.
                if (p.select !== lastSetting) { lastSetting = p.select; chosen = null; }
            },
            reset() { dirty = true; packets = 0; picked = -1; chosen = null; },
            read() {
                const parsed = parseSchedule(text, 'dwell');
                const sel = chosen != null ? chosen : Math.round(p.select) - 1;
                return { count: parsed.entries.length, errors: parsed.errors, entries: parsed.entries, selected: sel >= 0 && sel < parsed.entries.length ? sel : -1 };
            },
            process(ins, outs) {
                const sel = ins[0];
                if (sel && sel.list && sel.list.length) {
                    const i = named(sel.list[sel.list.length - 1]);
                    if (i >= 0 && i < entries.length) chosen = i;
                }
                const want = chosen != null ? chosen : Math.round(p.select) - 1;
                if (want >= 0 && want < entries.length && want !== picked) { picked = want; send(outs, want); }
                if (dirty || ++packets >= 100) {
                    dirty = false;
                    packets = 0;
                    outs[0].list.push({ type: 'schedule', schedule: text });
                    if (outs[1]) {
                        const items = parseSchedule(text, 'dwell').entries.map((e) => e.label || `${(e.frequency / 1e6).toFixed(4)} MHz`);
                        outs[1].list.push({ type: 'items', items, text: items.join('\n') });
                    }
                }
                return 0;
            },
        };
    },
};
