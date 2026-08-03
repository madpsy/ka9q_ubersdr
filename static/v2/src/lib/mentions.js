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
