// admin-chat.js — the Admin -> Chat tab (Messages and Moderation sub-tabs).
//
// The file exports its pure helpers under node (module.exports guard) and only touches
// the DOM in a browser, so the helpers are required directly. The page wiring is checked
// against admin.html as shipped: every element id the script looks up must exist, and
// banUser's new optional callback must replace the Sessions refresh without breaking the
// callers that pass none.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..');
const H = require(path.join(STATIC, 'admin-chat.js'));

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (process.env.STACK ? e.stack : e.message)); process.exitCode = 1; }
};
const tAsync = async (name, fn) => {
    try { await fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + (process.env.STACK ? e.stack : e.message)); process.exitCode = 1; }
};

const builtin = new Set(['damn', 'shit']);

// ── Words ──

t('normaliseWord: lower case, trimmed, inner spaces collapsed, fullwidth folded', () => {
    assert.strictEqual(H.normaliseWord('  Spam   Bot '), 'spam bot');
    assert.strictEqual(H.normaliseWord('ＳＰＡＭ'), 'spam');
    assert.strictEqual(H.normaliseWord(null), '');
});

t('wordProblem mirrors the server rules', () => {
    assert.strictEqual(H.wordProblem('spam'), '');
    assert.strictEqual(H.wordProblem('rock-on'), '');
    assert.strictEqual(H.wordProblem("don't"), '');
    assert.strictEqual(H.wordProblem('abc123'), '');
    assert.match(H.wordProblem('ab'), /Too short/);
    assert.match(H.wordProblem('a1b2'), /Too short/);
    assert.match(H.wordProblem('12345'), /Numbers on their own/);
    assert.match(H.wordProblem('a'.repeat(33)), /Too long/);
    assert.strictEqual(H.wordProblem('a'.repeat(32)), '');
    assert.match(H.wordProblem('sp@m'), /letters and numbers only/);
    assert.strictEqual(H.wordProblem('ölmotor'), '', 'non-ASCII letters count as letters');
});

t('checkWord: duplicate in your list points at the existing chip', () => {
    const r = H.checkWord(' SPAM ', ['eggs', 'spam'], builtin);
    assert.strictEqual(r.kind, 'duplicate');
    assert.strictEqual(r.index, 1);
    assert.strictEqual(r.word, 'spam');
});

t('checkWord: built-in words are a quiet note, not added', () => {
    const r = H.checkWord('Damn', [], builtin);
    assert.strictEqual(r.kind, 'builtin');
    assert.match(r.message, /already covered by the built-in list/i);
});

t('checkWord: invalid words give an inline message; typing stays quiet for short words', () => {
    assert.strictEqual(H.checkWord('ab', [], builtin).kind, 'invalid');
    assert.strictEqual(H.checkWord('ab', [], builtin, true).kind, 'pending');
    assert.strictEqual(H.checkWord('123', [], builtin, true).kind, 'pending');
    assert.strictEqual(H.checkWord('a'.repeat(40), [], builtin, true).kind, 'invalid', 'too long shows while typing');
    assert.strictEqual(H.checkWord('', [], builtin).kind, 'empty');
    assert.strictEqual(H.checkWord('spam', [], builtin).kind, 'ok');
});

t('splitPasted: commas, semicolons and new lines', () => {
    assert.deepStrictEqual(H.splitPasted('spam, eggs\nham;;  \r\nbacon,'), ['spam', 'eggs', 'ham', 'bacon']);
    assert.deepStrictEqual(H.splitPasted(''), []);
    assert.strictEqual(H.hasSeparator('one two'), false);
    assert.strictEqual(H.hasSeparator('one,two'), true);
    assert.strictEqual(H.hasSeparator('one\ntwo'), true);
});

t('addItems: adds the good ones, reports the rest, no duplicates within the paste', () => {
    const res = H.addItems(['spam'], H.splitPasted('eggs, SPAM, damn, ab, eggs, ham'), H.checkWord, builtin);
    assert.deepStrictEqual(res.list, ['spam', 'eggs', 'ham']);
    assert.deepStrictEqual(res.added, ['eggs', 'ham']);
    assert.deepStrictEqual(res.skipped.map((s) => s.kind), ['duplicate', 'builtin', 'invalid', 'duplicate']);
    const text = H.describeAdd(res, 'word', 'words');
    assert.match(text, /Added 2 words\./);
    assert.match(text, /2 were already in your list\./);
    assert.match(text, /1 is already covered by the built-in list\./);
    assert.match(text, /Not added: ab \(too short/);
});

// ── Sites ──

t('normaliseDomain mirrors the server', () => {
    assert.strictEqual(H.normaliseDomain('https://www.QRZ.com/db/G4XYZ'), 'qrz.com');
    assert.strictEqual(H.normaliseDomain('user@example.org:8080'), 'example.org');
    assert.strictEqual(H.normaliseDomain('sub.example.co.uk.'), 'sub.example.co.uk');
    assert.strictEqual(H.normaliseDomain('localhost'), '');
    assert.strictEqual(H.normaliseDomain('not a site'), '');
    assert.strictEqual(H.normaliseDomain('-bad.com'), '');
});

t('checkDomain: validation and duplicates (same chip rules as words)', () => {
    assert.strictEqual(H.checkDomain('www.qrz.com', ['qrz.com']).kind, 'duplicate');
    assert.strictEqual(H.checkDomain('qrz', [], null, true).kind, 'pending');
    assert.strictEqual(H.checkDomain('qrz', []).kind, 'invalid');
    assert.match(H.checkDomain('qrz', []).message, /example: qrz\.com/);
    const ok = H.checkDomain('https://hamqsl.com/x', []);
    assert.strictEqual(ok.kind, 'ok');
    assert.strictEqual(ok.word, 'hamqsl.com');
    const res = H.addItems([], ['qrz.com', 'www.qrz.com', 'bad'], H.checkDomain);
    assert.deepStrictEqual(res.list, ['qrz.com']);
});

// ── Settings <-> form ──

t('settingsToForm fills defaults for a missing or partial file', () => {
    const f = H.settingsToForm({});
    assert.strictEqual(f.mode, 'censor');
    assert.strictEqual(f.links, 'allow');
    assert.strictEqual(f.autoEnabled, true);
    assert.strictEqual(f.strikes, 3);
    assert.strictEqual(f.windowMinutes, 10);
    assert.strictEqual(f.chatBanMinutes, 60);
    assert.strictEqual(f.sdrEnabled, false, 'SDR escalation is off by default');
    assert.strictEqual(f.sdrChatBans, 3);
    assert.strictEqual(f.sdrWindowDays, 30);
    assert.deepStrictEqual(H.formToSettings(H.settingsToForm(null)), H.DEFAULT_SETTINGS);
});

t('settings round-trip through the form unchanged', () => {
    const s = {
        mode: 'block', words: ['spam', 'eggs'], links: 'allowlist', link_allowlist: ['qrz.com'],
        auto_moderation: { enabled: false, strikes: 5, window_minutes: 15, chat_ban_minutes: 1440 },
        sdr_escalation: { enabled: true, chat_bans: 2, window_days: 7 },
    };
    assert.deepStrictEqual(H.formToSettings(H.settingsToForm(s)), s);
});

t('formToSettings coerces typed numbers and falls back on blanks', () => {
    const f = H.settingsToForm({});
    f.strikes = '4';
    f.windowMinutes = '';
    f.chatBanMinutes = '15';
    f.sdrChatBans = '-2';
    const s = H.formToSettings(f);
    assert.strictEqual(s.auto_moderation.strikes, 4);
    assert.strictEqual(s.auto_moderation.window_minutes, 10);
    assert.strictEqual(s.auto_moderation.chat_ban_minutes, 15);
    assert.strictEqual(s.sdr_escalation.chat_bans, 3);
});

t('formsEqual drives the "Unsaved changes" state', () => {
    const a = H.settingsToForm({ words: ['spam'] });
    const b = H.settingsToForm({ words: ['spam'] });
    assert.ok(H.formsEqual(a, b));
    b.strikes = '3';
    assert.ok(H.formsEqual(a, b), 'the same number typed as text is not a change');
    b.words.push('eggs');
    assert.ok(!H.formsEqual(a, b));
});

// ── Message rows ──

t('rowActions: relay users get Delete only', () => {
    assert.deepStrictEqual(H.rowActions({ username: '~tg_bob', source_ip: '1.2.3.4', status: 'ok' }), { del: true, chatBan: false, sdrBan: false });
    assert.deepStrictEqual(H.rowActions({ username: 'G4XYZ', source_ip: '1.2.3.4', status: 'ok' }), { del: true, chatBan: true, sdrBan: true });
});

t('rowActions: nothing to delete on removed or blocked rows; bans still offered', () => {
    assert.strictEqual(H.rowActions({ username: 'A', source_ip: '1.1.1.1', deleted_at: '2026-01-01T00:00:00Z' }).del, false);
    const b = H.rowActions({ username: 'A', source_ip: '1.1.1.1', status: 'blocked' });
    assert.strictEqual(b.del, false);
    assert.strictEqual(b.chatBan, true);
});

t('statusTag: Blocked and Starred (with the original text in the tooltip)', () => {
    assert.strictEqual(H.statusTag({ status: 'ok' }), null);
    assert.strictEqual(H.statusTag({ status: 'blocked' }).label, 'Blocked');
    const c = H.statusTag({ status: 'censored', message_raw: 'you damn fool' });
    assert.strictEqual(c.label, 'Starred');
    assert.strictEqual(c.title, 'Original: you damn fool');
});

t('renderMessageCell escapes user text everywhere, including the tooltip', () => {
    const html = H.renderMessageCell({ message: '<img src=x onerror=alert(1)>', status: 'censored', message_raw: '"><script>x</script>' });
    assert.ok(!html.includes('<img'), html);
    assert.ok(!html.includes('<script>'), html);
    assert.ok(html.includes('&lt;img'));
    assert.ok(html.includes('&quot;&gt;&lt;script&gt;'));
    assert.ok(html.includes('chatmod-tag-censored'));
});

t('renderMessageCell: removed rows are struck through with who and when', () => {
    const html = H.renderMessageCell({ message: 'hi', status: 'ok', deleted_at: '2026-03-04T14:05:00Z', deleted_by: '<admin>' });
    assert.ok(html.includes('chatmod-removed'));
    assert.match(html, /Deleted by &lt;admin&gt;, /);
    assert.match(H.deletedNote({ deleted_at: '2026-03-04T14:05:00Z' }), /^Deleted by a moderator, /);
});

t('deletableIds: only rows still in chat', () => {
    const ids = H.deletableIds([
        { id: 1, status: 'ok' }, { id: 2, status: 'blocked' }, { id: 3, deleted_at: 'x' }, { status: 'ok' }, { id: 5, status: 'censored' },
    ]);
    assert.deepStrictEqual(ids, [1, 5]);
});

t('logsQuery maps Show to show= (omitted for All)', () => {
    assert.strictEqual(H.logsQuery({ start: '2026-01-01', show: 'all', limit: '10' }), 'start=2026-01-01&limit=10');
    assert.strictEqual(H.logsQuery({ show: 'removed', nickname: 'a b' }), 'nickname=a+b&show=removed');
    assert.strictEqual(H.logsQuery({ show: 'visible' }), 'show=visible');
});

t('sortLogs by time and name', () => {
    const logs = [{ timestamp: '2026-01-01T00:00:02Z', username: 'b' }, { timestamp: '2026-01-01T00:00:01Z', username: 'A' }];
    assert.deepStrictEqual(H.sortLogs(logs, 'timestamp', 'desc').map((l) => l.username), ['b', 'A']);
    assert.deepStrictEqual(H.sortLogs(logs, 'nickname', 'asc').map((l) => l.username), ['A', 'b']);
    assert.strictEqual(logs[0].username, 'b', 'input not mutated');
});

// ── CSV ──

t('CSV gains Status and Original text columns', () => {
    assert.strictEqual(H.CSV_HEADER, 'Timestamp,IP Address,Country,Country Code,Nickname,Message,Status,Original text');
    const row = H.csvRow({ timestamp: '2026-01-01T00:00:00Z', source_ip: '1.2.3.4', country: 'UK', country_code: 'GB', username: 'G4XYZ', message: 'd**n, "ok"', status: 'censored', message_raw: 'damn, "ok"' });
    assert.strictEqual(row, '2026-01-01T00:00:00.000Z,1.2.3.4,UK,GB,G4XYZ,"d**n, ""ok""",Starred,"damn, ""ok"""');
    const del = H.csvRow({ timestamp: '2026-01-01T00:00:00Z', source_ip: '1.2.3.4', username: 'x', message: 'm', status: 'blocked', deleted_at: '2026-01-02T00:00:00Z', deleted_by: 'admin' });
    assert.match(del, /,Blocked; deleted by admin at 2026-01-02T00:00:00.000Z,$/);
    assert.strictEqual(H.buildCsv([]).trim(), H.CSV_HEADER);
    assert.strictEqual(H.buildCsv([{ timestamp: '2026-01-01T00:00:00Z', message: 'a', status: 'ok' }]).split('\n').length, 3);
});

t('CSV fields that look like formulas are neutralised', () => {
    assert.strictEqual(H.csvField('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
    assert.strictEqual(H.csvField('+1'), "'+1");
    assert.strictEqual(H.csvField('@x'), "'@x");
    assert.strictEqual(H.csvField('line\nbreak'), '"line\nbreak"');
    assert.strictEqual(H.csvField(undefined), '');
});

// ── Actions, durations, test box, manual ban ──

t('actionName gives the friendly names', () => {
    const want = {
        warn: 'Warning', auto_warn: 'Automatic warning', chat_ban: 'Chat ban', auto_chat_ban: 'Automatic chat ban',
        lift: 'Lifted', sdr_ban: 'Ban from SDR', delete: 'Messages deleted',
    };
    for (const [k, v] of Object.entries(want)) assert.strictEqual(H.actionName(k), v);
    assert.strictEqual(H.actionName('auto_sdr_ban'), 'Automatic ban from SDR');
    assert.strictEqual(H.actionName('something_new'), 'something new');
});

t('duration presets match the contract', () => {
    assert.deepStrictEqual(H.DURATION_PRESETS.map((p) => p.sec), [900, 3600, 86400, 604800, 2592000]);
    assert.deepStrictEqual(H.DURATION_PRESETS.map((p) => p.label), ['15 minutes', '1 hour', '24 hours', '7 days', '30 days']);
    assert.strictEqual(H.durationLabel(3600), '1 hour');
    assert.strictEqual(H.durationLabel(7200), '2 hours');
    assert.strictEqual(H.durationLabel(172800), '2 days');
    assert.strictEqual(H.durationLabel(1800), '30 minutes');
});

t('describeTest puts the outcome in plain words', () => {
    assert.strictEqual(H.describeTest({ result: 'ok' }).text, 'This message would be sent as written.');
    const c = H.describeTest({ result: 'censored', output: 'd**n' });
    assert.strictEqual(c.tone, 'warn');
    assert.strictEqual(c.output, 'd**n');
    assert.strictEqual(H.describeTest({ result: 'blocked', reason: 'contains a link' }).text, 'This message would not be sent (contains a link).');
});

t('parseTarget: IP addresses vs chat names', () => {
    assert.deepStrictEqual(H.parseTarget('192.168.1.20'), { ip: '192.168.1.20' });
    assert.deepStrictEqual(H.parseTarget('2001:db8::1'), { ip: '2001:db8::1' });
    assert.deepStrictEqual(H.parseTarget(' G4XYZ '), { username: 'G4XYZ' });
    assert.deepStrictEqual(H.parseTarget('M0ABC:'), { username: 'M0ABC:' });
    assert.strictEqual(H.parseTarget('  '), null);
});

t('esc escapes quotes too (safe in attributes)', () => {
    assert.strictEqual(H.esc(`<a href='x' title="y">&`), '&lt;a href=&#39;x&#39; title=&quot;y&quot;&gt;&amp;');
    assert.strictEqual(H.esc(0), '0');
    assert.strictEqual(H.esc(null), '');
});

// ── The page as shipped ──

const html = fs.readFileSync(path.join(STATIC, 'admin.html'), 'utf8');
const js = fs.readFileSync(path.join(STATIC, 'admin-chat.js'), 'utf8');

t('admin.html loads admin-chat.js', () => {
    assert.ok(html.includes('<script src="admin-chat.js"></script>'));
});

t('every element id admin-chat.js looks up exists in admin.html exactly once', () => {
    const created = new Set(['chatmod-styles', 'chatBanModal', 'chatBanReason', 'chatBanDelete', 'chatBanSubmit', 'chatBanError']);
    const ids = new Set([...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
    assert.ok(ids.size > 20, 'found ids: ' + ids.size);
    for (const id of ids) {
        if (created.has(id)) continue;
        const n = html.split(`id="${id}"`).length - 1;
        assert.strictEqual(n, 1, `id="${id}" appears ${n} times`);
    }
});

t('the old inline chat functions are gone (no double definitions)', () => {
    for (const name of ['loadChatLogs', 'renderChatLogsTable', 'exportChatLogs', 'clearChatFilters', 'sortChatLogs']) {
        assert.ok(!new RegExp(`function ${name}\\b`).test(html), name + ' still defined in admin.html');
    }
});

t('the Chat tab markup is balanced', () => {
    const start = html.indexOf('<!-- Chat Tab');
    const end = html.indexOf('<!-- System Tab -->');
    assert.ok(start > 0 && end > start);
    const part = html.slice(start, end).replace(/<!--[\s\S]*?-->/g, '');
    for (const tag of ['div', 'button', 'select', 'label', 'span']) {
        const open = (part.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
        const close = (part.match(new RegExp(`</${tag}>`, 'g')) || []).length;
        assert.strictEqual(open, close, `<${tag}> ${open} open vs ${close} closed`);
    }
});

t('the Chat tab and its script use one vocabulary: "Chat ban" and "Ban from SDR"', () => {
    const start = html.indexOf('<!-- Chat Tab');
    const end = html.indexOf('<!-- System Tab -->');
    const part = html.slice(start, end);
    assert.ok(part.includes('<h3>Chat bans now</h3>'), 'the card is "Chat bans now"');
    assert.ok(part.includes('>Chat-ban someone</div>'), 'the form is "Chat-ban someone"');
    assert.ok(part.includes('and chat-ban them for'), 'the automatic sentence says chat-ban');
    assert.ok(part.includes('id="chatModManualBan">Chat ban</button>'));
    // The old wording, for the ban, nowhere a person can read it.
    for (const src of [part, js]) {
        assert.ok(!/remove(d)? (them |someone )?from chat/i.test(src), 'old "remove from chat" wording left');
        assert.ok(!/removed from chat/i.test(src), 'old "Removed from chat" wording left');
    }
    // The Messages table keeps both actions under their names.
    assert.ok(js.includes('title="Chat ban (temporary, chat only)"'));
    assert.ok(js.includes('title="Ban from SDR (permanent)"'));
});

t('handlers called from inline markup are published on window', () => {
    for (const name of ['switchChatSubTab', 'loadChatLogs', 'clearChatFilters', 'exportChatLogs', 'handleChatFilterEnter', 'chatRefreshActive']) {
        assert.ok(new RegExp(`Object\\.assign\\(window, \\{[\\s\\S]*\\b${name}\\b`).test(js), name);
    }
    assert.ok(html.includes('onclick="chatRefreshActive()"'), 'Refresh button refreshes the active sub-tab');
});

/** Slice one brace-balanced declaration, starting at `opener`, out of `src`. */
function sliceBlock(src, opener) {
    const start = src.indexOf(opener);
    assert.ok(start >= 0, `"${opener}" not found`);
    let depth = 0;
    let str = null;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        const c = src[i];
        if (str) { if (c === '\\') { i++; continue; } if (c === str) str = null; continue; }
        if (c === '"' || c === "'" || c === '`') { str = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error('unbalanced');
}

async function runBanUser(args) {
    const calls = [];
    const ctx = {
        prompt: () => 'r', confirm: () => true,
        fetch: async () => ({ ok: true, json: async () => ({ message: 'banned' }) }),
        showAlert: () => {}, loadSessions: () => calls.push('sessions'),
        done: () => calls.push('callback'),
    };
    vm.createContext(ctx);
    vm.runInContext(sliceBlock(html, 'async function banUser(') + '\nthis.banUser = banUser;', ctx);
    await ctx.banUser(...args.map((a) => (a === 'DONE' ? ctx.done : a)));
    return calls;
}

// A throwaway DOM: enough for the browser half of admin-chat.js to run end to end, so a
// mistyped name or a missing function in the page wiring fails here, not in front of an admin.
function fakeDom() {
    const byId = new Map();
    const make = (id) => {
        const el = {
            id, style: {}, dataset: {}, value: '', checked: false, disabled: false, textContent: '', className: '',
            innerHTML: '', options: [], children: [], handlers: {},
            classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { if (on === undefined) on = !this._s.has(c); if (on) this._s.add(c); else this._s.delete(c); return on; }, contains(c) { return this._s.has(c); } },
            _q: new Map(),
            addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
            querySelector(sel) { if (!this._q.has(sel)) this._q.set(sel, make(null)); return this._q.get(sel); },
            querySelectorAll() { return []; },
            appendChild(c) { this.children.push(c); return c; },
            removeChild() {}, focus() {}, click() {}, remove() {},
        };
        return el;
    };
    const document = {
        readyState: 'complete',
        head: make(null), body: make(null),
        getElementById(id) { if (!byId.has(id)) byId.set(id, make(id)); return byId.get(id); },
        createElement() { return make(null); },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
    };
    return { document, byId, make };
}

async function runPage(routes) {
    const { document, byId } = fakeDom();
    const alerts = [];
    const requests = [];
    const window = { addEventListener() {} };
    const ctx = {
        window, document, console, URLSearchParams, setTimeout, clearTimeout, Blob: function () {}, URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
        confirm: () => true,
        showAlert: (m, type) => alerts.push([type, m]),
        banUser: () => {},
        authenticatedFetch: async (url, opts) => {
            requests.push([url, opts && opts.method, opts && opts.body]);
            const key = Object.keys(routes).find((k) => url.startsWith(k));
            const body = key ? routes[key] : { error: 'no route' };
            return { ok: !!key, status: key ? 200 : 404, text: async () => JSON.stringify(body) };
        },
    };
    ctx.window = Object.assign(window, ctx);
    vm.createContext(ctx);
    vm.runInContext(js, ctx);
    return { ctx, byId, alerts, requests, settle: () => new Promise((r) => setTimeout(r, 20)) };
}

const sampleLogs = {
    count: 3, start_date: '2026-01-01', end_date: '2026-01-01', nickname_filter: 'G4XYZ',
    logs: [
        { id: 1, timestamp: '2026-01-01T10:00:00Z', source_ip: '1.2.3.4', username: 'G4XYZ', message: 'hello', status: 'ok' },
        { id: 2, timestamp: '2026-01-01T10:01:00Z', source_ip: '1.2.3.4', username: 'G4XYZ', message: 'd**n', status: 'censored', message_raw: 'damn' },
        { id: 3, timestamp: '2026-01-01T10:02:00Z', source_ip: '5.6.7.8', username: '~tg_bob', message: 'x', status: 'ok', deleted_at: '2026-01-01T10:03:00Z', deleted_by: 'admin' },
    ],
};

async function pageTests() {
    await tAsync('page: Messages renders rows, tags, actions and "Delete all shown"', async () => {
        const p = await runPage({ '/admin/chat/logs': sampleLogs });
        p.byId.get('chatShowFilter').value = 'removed';
        await p.ctx.window.loadChatLogs();
        assert.match(p.requests[0][0], /show=removed/);
        const html = p.byId.get('chatLogsList').innerHTML;
        assert.strictEqual((html.match(/<tr class/g) || []).length, 3);
        assert.ok(html.includes('Starred') && html.includes('Original: damn'));
        assert.ok(html.includes('Deleted by admin'));
        assert.strictEqual((html.match(/data-act="sdrban"/g) || []).length, 2, 'no SDR ban for the relay user');
        assert.strictEqual((html.match(/data-act="delete"/g) || []).length, 2, 'removed row has no Delete');
        const btn = p.byId.get('chatDeleteAllShown');
        assert.strictEqual(btn.style.display, '');
        assert.match(btn.textContent, /\(2\)/);
    });

    await tAsync('page: Moderation loads settings into the form and saves them', async () => {
        const settings = { mode: 'block', words: ['spam'], links: 'allowlist', link_allowlist: ['qrz.com'],
            auto_moderation: { enabled: true, strikes: 4, window_minutes: 10, chat_ban_minutes: 60 },
            sdr_escalation: { enabled: false, chat_bans: 3, window_days: 30 } };
        const p = await runPage({
            '/admin/chat/moderation': { settings, builtin_words: ['damn'], builtin_count: 1, notes: ['1 word is already in the built-in list'], rejected: [] },
            '/admin/chat/bans': { bans: [{ ip: '1.2.3.4', username: '<b>x</b>', reason: 'r', by: 'admin', until: '2026-01-01T11:00:00Z' }] },
            '/admin/chat/actions': { actions: [{ id: 1, ts: '2026-01-01T10:00:00Z', action: 'auto_chat_ban', ip: '1.2.3.4', username: 'x', by: 'auto' }] },
        });
        p.ctx.window.switchChatSubTab('moderation');
        await p.settle();
        assert.strictEqual(p.byId.get('chatModerationContent').style.display, 'block');
        assert.strictEqual(p.byId.get('chatModStrikes').value, 4);
        assert.strictEqual(p.byId.get('chatModSitesWrap').style.display, 'block');
        assert.strictEqual(p.byId.get('chatModState').textContent, 'All changes saved');
        assert.ok(p.byId.get('chatModBans').innerHTML.includes('&lt;b&gt;x&lt;/b&gt;'));
        assert.ok(p.byId.get('chatModActions').innerHTML.includes('Automatic chat ban'));
        // Change a number and save.
        p.byId.get('chatModStrikes').value = '5';
        p.byId.get('chatModAutoEnabled').checked = true;
        const content = p.byId.get('chatModerationContent');
        content.handlers.change[0]({ target: { closest: () => ({}) } });
        assert.strictEqual(p.byId.get('chatModState').textContent, 'Unsaved changes');
        p.byId.get('chatModSave').handlers.click[0]();
        await p.settle();
        const put = p.requests.find((r) => r[1] === 'PUT');
        assert.ok(put, 'PUT sent');
        assert.strictEqual(JSON.parse(put[2]).auto_moderation.strikes, 5);
        assert.ok(p.byId.get('chatModSaveResult').innerHTML.includes('already in the built-in list'));
    });
}

(async () => {
    await tAsync('banUser without a callback still refreshes Sessions', async () => {
        assert.deepStrictEqual(await runBanUser(['1.2.3.4']), ['sessions']);
    });
    await tAsync('banUser with a callback runs it instead (the chat table refreshes)', async () => {
        assert.deepStrictEqual(await runBanUser(['1.2.3.4', 'Banned from chat log', 'DONE']), ['callback']);
    });
    await pageTests();
    console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
