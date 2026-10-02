// A status board: which of a set of things was heard, each time it was
// listened for — NDBs on a round, beacons on a band, stations on a net.
//
// Three inputs say all it needs:
//
//   items     every thing on the board (a Frequency list's labels), so the
//             ones not yet checked show too. Optional: a thing is added the
//             first time it is current.
//   current   what is being listened for now (a Scheduler's label). When it
//             changes, the one before is settled.
//   hit       anything arriving here while a thing is current counts as
//             hearing it (a Text console's matched).
//
// So the board never needs telling "not heard": a thing listened for until
// the next came along with no hit was not heard. Each thing keyed by its
// name's first word (an ident: CBL of "CBL Campbeltown") or the whole name.
//
// Out: a line of text each time a thing is settled ("12:30:00 CBL heard"),
// `heard` (1 or 0, as each is settled) and `summary` ("3 of 5 heard").

import { CONTROL, MESSAGE, emitControl } from '../block.js';

const HISTORY = 12;

export const StatusBlock = {
    type: 'status',
    label: 'Status',
    category: 'Viewers',
    summary: 'Which of a set of things was heard each time it was listened for — NDBs on a round, beacons on a band. What is listened for now from a Scheduler’s label, a hit from a Text console’s matched; when the Scheduler moves on, the last is settled heard or not.',
    inputs: [
        { name: 'items', kind: MESSAGE, optional: true },
        { name: 'current', kind: MESSAGE },
        { name: 'hit', kind: MESSAGE },
        { name: 'unix', kind: CONTROL, optional: true },
    ],
    outputs: [{ name: 'text', kind: MESSAGE }, { name: 'heard', kind: CONTROL }, { name: 'summary', kind: MESSAGE }],
    activity: 'Listening',
    params: {
        keyOn: {
            kind: 'choice', label: 'Things are named by', default: 'word', control: false,
            options: [{ value: 'word', label: 'First word', title: 'An ident: CBL from “CBL Campbeltown”' }, { value: 'all', label: 'Whole name' }],
        },
    },
    create() {
        let p = {};
        const rows = new Map();    // key → { key, name, state, hits, lastHeard, history, heard, checks }
        let current = null;        // the key listened for now
        let clock = null;          // Unix seconds from a Clock, if one is wired
        let seenUnix = -1;
        let lastSummary = '';
        const keyOf = (name) => {
            const n = String(name || '').trim().replace(/\s+/g, ' ');
            return (p.keyOn === 'all' ? n : n.split(' ')[0] || '').toUpperCase();
        };
        const row = (name) => {
            const key = keyOf(name);
            if (!key) return null;
            if (!rows.has(key)) rows.set(key, { key, name: String(name).trim(), state: 'pending', hits: 0, lastHeard: null, history: [], heard: 0, checks: 0 });
            return rows.get(key);
        };
        const now = () => (clock != null ? clock * 1000 : Date.now());
        const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19);
        const settle = (outs) => {
            const r = current && rows.get(current);
            if (!r) return;
            const was = r.hits > 0;
            r.state = was ? 'heard' : 'missed';
            r.checks++;
            if (was) r.heard++;
            r.history.push(was ? 1 : 0);
            if (r.history.length > HISTORY) r.history.shift();
            if (outs[0]) outs[0].list.push({ type: 'text', text: `${hhmmss(now())} ${r.key} ${was ? 'heard' : 'not heard'}\n` });
            if (outs[1]) emitControl(outs[1], was ? 1 : 0);
        };
        const summarise = (outs) => {
            // By each thing's last settled check: one listened for again is
            // still heard (or not) until this round settles it.
            const all = [...rows.values()];
            const settled = all.filter((r) => r.history.length);
            const heard = settled.filter((r) => r.history[r.history.length - 1] === 1).length;
            const text = `${heard} of ${all.length} heard${settled.length < all.length ? ` (${all.length - settled.length} not checked yet)` : ''}`;
            if (text !== lastSummary && outs[2]) { lastSummary = text; outs[2].list.push({ type: 'text', text }); }
        };
        return {
            configure(params) {
                const rekey = p.keyOn !== undefined && p.keyOn !== params.keyOn;
                p = params;
                if (rekey) { rows.clear(); current = null; }
            },
            reset() { rows.clear(); current = null; clock = null; seenUnix = -1; lastSummary = ''; },
            command(name) {
                if (name !== 'clear') return;
                for (const r of rows.values()) Object.assign(r, { state: r.key === current ? 'listening' : 'pending', hits: 0, lastHeard: null, history: [], heard: 0, checks: 0 });
            },
            activity() { return current ? 1 : 0; },
            read() {
                return {
                    current,
                    rows: [...rows.values()].map((r) => ({ ...r, history: r.history.slice() })),
                    summary: lastSummary,
                };
            },
            process(ins, outs) {
                const [items, cur, hit, unix] = ins;
                if (unix && unix.seq !== seenUnix && unix.value != null) { seenUnix = unix.seq; clock = unix.value; }
                // The board's things, in the list's order.
                if (items && items.list && items.list.length) {
                    const m = items.list[items.list.length - 1];
                    const names = Array.isArray(m.items) ? m.items : String(m.text || '').split('\n');
                    const keep = new Map();
                    for (const name of names) {
                        const r = row(name);
                        if (r) { r.name = String(name).trim(); keep.set(r.key, r); }
                    }
                    // Taken off the list: off the board, unless it is the one listened for now.
                    for (const [k, r] of rows) if (!keep.has(k) && k !== current) rows.delete(k); else if (!keep.has(k)) keep.set(k, r);
                    const ordered = [...keep.values()];
                    rows.clear();
                    for (const r of ordered) rows.set(r.key, r);
                }
                // A new thing listened for: the last settled first.
                if (cur && cur.list && cur.list.length) {
                    const m = cur.list[cur.list.length - 1];
                    const name = String((m.text != null ? m.text : m.value) || '').trim();
                    const key = keyOf(name);
                    if (key && key !== current) {
                        settle(outs);
                        const r = row(name);
                        r.state = 'listening';
                        r.hits = 0;
                        current = key;
                    }
                }
                // A hit counts for the thing listened for now.
                if (hit && hit.list && hit.list.length && current) {
                    const r = rows.get(current);
                    if (r) {
                        r.hits += hit.list.length;
                        r.lastHeard = now();
                        r.state = 'listening';
                    }
                }
                summarise(outs);
                return 0;
            },
        };
    },
};
