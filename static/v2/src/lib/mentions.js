// @mention parsing, matching v1's chat-ui.js so both frontends agree on what
// counts as a mention and how tab completion behaves.

// The partial username being typed, or null. Only fires directly before the
// cursor, so "@bob hello @" completes the trailing one and text pasted earlier
// in the line is left alone.
export function mentionQuery(textBeforeCursor) {
    const m = String(textBeforeCursor || '').match(/@(\w*)$/);
    return m ? { partial: m[1], at: m.index } : null;
}

// Candidates for a partial, excluding ourselves — completing your own name is
// never what you want.
export function matchUsernames(users, partial, self) {
    const p = String(partial || '').toLowerCase();
    return (users || [])
        .map((u) => (typeof u === 'string' ? u : u.username))
        .filter((name) => name && name !== self && name.toLowerCase().startsWith(p))
        .sort();
}

// Replaces the partial with the full username and a trailing space, returning
// the new text and where the cursor should land.
export function applyCompletion(text, cursor, username) {
    const before = text.slice(0, cursor);
    const q = mentionQuery(before);
    if (!q) return { text, cursor };
    const next = `${text.slice(0, q.at)}@${username} ${text.slice(cursor)}`;
    return { text: next, cursor: q.at + username.length + 2 };
}

// v1 uses a plain case-insensitive substring test rather than word boundaries,
// so "@bobby" also alerts bob. Kept identical: diverging would mean the two
// frontends disagree about whether you were spoken to.
export function isMention(message, username) {
    if (!username) return false;
    return String(message || '').toLowerCase().includes(`@${username.toLowerCase()}`);
}

// Splits a message into plain and mention runs for highlighting.
export function splitMentions(message, usernames) {
    const text = String(message || '');
    const names = (usernames || []).filter(Boolean).sort((a, b) => b.length - a.length);
    if (names.length === 0) return [{ text }];
    const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`@(${escaped.join('|')})`, 'gi');
    const out = [];
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push({ text: text.slice(last, m.index) });
        out.push({ text: m[0], mention: m[1] });
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
}

// ---------------------------------------------------------------------------
// Rich message parts
//
// v1 processes a message in three passes — URLs, then frequencies, then
// mentions (chat-ui.js:2067) — and turns the first two into links. This does
// the same in one pass, returning runs for the renderer:
//
//   { text }                       plain
//   { text, mention }              @name
//   { text, url }                  http(s) link
//   { text, freq: { hz, mode } }   "14175.000 KHz (USB)", click to tune
//
// The frequency pattern and its validation are v1's: 10 kHz–30 MHz, and only
// modes the receiver actually has.
const URL_RE = /https?:\/\/[^\s]+/gi;
const FREQ_RE = /(\d+\.?\d*)\s*KHz\s*\(([A-Za-z]+)\)/gi;
const FREQ_MODES = ['usb', 'lsb', 'am', 'sam', 'fm', 'nfm', 'cwu', 'cwl'];

function freqPart(match, khz, mode) {
    const f = parseFloat(khz);
    const m = String(mode).toLowerCase();
    // Out of band, or a mode this receiver does not have: leave it as text
    // rather than offering a link that would tune somewhere wrong.
    if (!(f >= 10 && f <= 30000) || !FREQ_MODES.includes(m)) return null;
    return { text: match, freq: { hz: Math.round(f * 1000), mode: m } };
}

export function splitMessage(message, usernames) {
    const text = String(message || '');
    const names = (usernames || []).filter(Boolean).sort((a, b) => b.length - a.length);
    const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

    // One pass, so the parts come out in order and cannot overlap. Priority
    // follows v1: a URL wins over anything inside it.
    const sources = [
        { re: new RegExp(URL_RE.source, 'gi'), make: (m) => ({ text: m[0], url: m[0] }) },
        { re: new RegExp(FREQ_RE.source, 'gi'), make: (m) => freqPart(m[0], m[1], m[2]) },
    ];
    if (escaped.length) {
        sources.push({
            re: new RegExp(`@(${escaped.join('|')})`, 'gi'),
            make: (m) => ({ text: m[0], mention: m[1] }),
        });
    }

    const out = [];
    let last = 0;    // start of the plain run not yet emitted
    let scan = 0;    // where to look for the next match
    while (scan <= text.length) {
        let best = null;
        for (const s of sources) {
            s.re.lastIndex = scan;
            const m = s.re.exec(text);
            if (m && (!best || m.index < best.m.index)) best = { s, m };
        }
        if (!best) break;

        const part = best.s.make(best.m);
        if (!part) {
            // Rejected — an out-of-band frequency, say. Leave it in the plain
            // run and carry on looking after it.
            scan = best.m.index + best.m[0].length;
            continue;
        }
        if (best.m.index > last) out.push({ text: text.slice(last, best.m.index) });
        out.push(part);
        last = best.m.index + best.m[0].length;
        scan = last;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out.length ? out : [{ text }];
}
