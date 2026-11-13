// Admin -> Chat tab: the message log (Messages) and the moderation settings,
// chat bans and history (Moderation).
//
// The pure helpers at the top have no DOM access and are exported for the node
// tests in static/test-admin-chat/. Everything that touches the page is below
// the "DOM" line and only runs in a browser. It relies on these globals from
// admin.html: authenticatedFetch, showAlert and banUser.

(function () {
    'use strict';

    // ── Pure helpers ────────────────────────────────────────────────────────

    const MIN_WORD_LETTERS = 3;
    const MAX_WORD_LENGTH = 32;

    // Chat-ban lengths offered everywhere (seconds), matching the v2 chat panel.
    const DURATION_PRESETS = [
        { sec: 900, label: '15 minutes' },
        { sec: 3600, label: '1 hour' },
        { sec: 86400, label: '24 hours' },
        { sec: 604800, label: '7 days' },
        { sec: 2592000, label: '30 days' },
    ];

    const DEFAULT_SETTINGS = {
        mode: 'censor',
        words: [],
        links: 'allow',
        link_allowlist: [],
        auto_moderation: { enabled: true, strikes: 3, window_minutes: 10, chat_ban_minutes: 60 },
        sdr_escalation: { enabled: false, chat_bans: 3, window_days: 30 },
    };

    const ACTION_NAMES = {
        warn: 'Warning',
        auto_warn: 'Automatic warning',
        chat_ban: 'Chat ban',
        auto_chat_ban: 'Automatic chat ban',
        lift: 'Lifted',
        sdr_ban: 'Ban from SDR',
        auto_sdr_ban: 'Automatic ban from SDR',
        delete: 'Messages deleted',
    };

    function esc(s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function isRelayUser(name) {
        return typeof name === 'string' && name.startsWith('~');
    }

    // Same folding as the server for the parts an admin types: lower case,
    // trimmed, inner spaces collapsed. Fullwidth letters are folded too.
    function normaliseWord(raw) {
        let s = String(raw == null ? '' : raw);
        s = s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
        return s.toLowerCase().trim().split(/\s+/).filter(Boolean).join(' ');
    }

    // Mirrors chatWordProblem in chat_filter.go. Returns '' when the word is fine.
    function wordProblem(w) {
        let letters = 0;
        let n = 0;
        for (const ch of w) {
            n++;
            if (/\p{L}/u.test(ch)) letters++;
            else if (/\p{Nd}/u.test(ch) || ch === ' ' || ch === '-' || ch === "'") { /* allowed */ }
            else return 'Use letters and numbers only';
        }
        if (n > MAX_WORD_LENGTH) return `Too long (at most ${MAX_WORD_LENGTH} characters)`;
        if (letters === 0) return "Numbers on their own can't be blocked";
        if (letters < MIN_WORD_LETTERS) return `Too short (at least ${MIN_WORD_LETTERS} letters)`;
        return '';
    }

    // Mirrors chatNormaliseDomain: "https://www.QRZ.com/db" -> "qrz.com"; '' if not a site.
    const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
    function normaliseDomain(raw) {
        let s = String(raw == null ? '' : raw).toLowerCase().trim();
        let i = s.indexOf('://');
        if (i >= 0) s = s.slice(i + 3);
        i = s.search(/[/?#]/);
        if (i >= 0) s = s.slice(0, i);
        i = s.lastIndexOf('@');
        if (i >= 0) s = s.slice(i + 1);
        i = s.indexOf(':');
        if (i >= 0) s = s.slice(0, i);
        s = s.replace(/^\.+|\.+$/g, '');
        if (s.startsWith('www.')) s = s.slice(4);
        return DOMAIN_RE.test(s) ? s : '';
    }

    // A pasted or typed list: commas, semicolons and new lines separate items.
    function splitPasted(text) {
        return String(text == null ? '' : text)
            .split(/[,;\r\n]+/)
            .map((s) => s.trim())
            .filter(Boolean);
    }

    function hasSeparator(text) {
        return /[,;\r\n]/.test(String(text == null ? '' : text));
    }

    // Checks one typed word against the rules, your list and the built-in list.
    // kind: empty | invalid | duplicate | builtin | ok. `live` relaxes "too short"
    // and "numbers only" (the person is still typing).
    function checkWord(raw, list, builtinSet, live) {
        const word = normaliseWord(raw);
        if (!word) return { kind: 'empty', word, message: '' };
        const index = (list || []).indexOf(word);
        if (index >= 0) return { kind: 'duplicate', word, index, message: 'Already in your list' };
        const problem = wordProblem(word);
        if (problem) {
            if (live && (problem.startsWith('Too short') || problem.startsWith('Numbers'))) {
                return { kind: 'pending', word, message: '' };
            }
            return { kind: 'invalid', word, message: problem };
        }
        if (builtinSet && builtinSet.has(word)) {
            return { kind: 'builtin', word, message: 'Already covered by the built-in list' };
        }
        return { kind: 'ok', word, message: '' };
    }

    function checkDomain(raw, list, _unused, live) {
        const typed = String(raw == null ? '' : raw).trim();
        if (!typed) return { kind: 'empty', word: '', message: '' };
        const word = normaliseDomain(typed);
        if (!word) {
            if (live && !typed.includes('.')) return { kind: 'pending', word: typed, message: '' };
            return { kind: 'invalid', word: typed, message: 'Not a website address (example: qrz.com)' };
        }
        const index = (list || []).indexOf(word);
        if (index >= 0) return { kind: 'duplicate', word, index, message: 'Already in your list' };
        return { kind: 'ok', word, message: '' };
    }

    // Adds several items at once. Returns the new list plus what was skipped and why.
    function addItems(list, rawItems, checker, builtinSet) {
        const out = (list || []).slice();
        const added = [];
        const skipped = [];
        for (const raw of rawItems) {
            const r = checker(raw, out, builtinSet, false);
            if (r.kind === 'ok') {
                out.push(r.word);
                added.push(r.word);
            } else if (r.kind !== 'empty') {
                skipped.push({ item: String(raw).trim(), kind: r.kind, message: r.message });
            }
        }
        return { list: out, added, skipped };
    }

    function plural(n, one, many) {
        return `${n} ${n === 1 ? one : many}`;
    }

    // One plain sentence describing an addItems result.
    function describeAdd(res, noun, nouns) {
        const parts = [];
        if (res.added.length) parts.push(`Added ${plural(res.added.length, noun, nouns)}.`);
        const dup = res.skipped.filter((s) => s.kind === 'duplicate').length;
        const built = res.skipped.filter((s) => s.kind === 'builtin').length;
        const bad = res.skipped.filter((s) => s.kind === 'invalid');
        if (dup) parts.push(`${plural(dup, 'was', 'were')} already in your list.`);
        if (built) parts.push(`${plural(built, 'is', 'are')} already covered by the built-in list.`);
        if (bad.length) {
            parts.push('Not added: ' + bad.map((b) => `${b.item} (${b.message.toLowerCase()})`).join(', ') + '.');
        }
        return parts.join(' ');
    }

    function toInt(v, def) {
        const n = parseInt(v, 10);
        return Number.isFinite(n) && n > 0 ? n : def;
    }

    // Server settings -> the editable form state (defaults filled in, copies only).
    function settingsToForm(s) {
        s = s || {};
        const d = DEFAULT_SETTINGS;
        const am = s.auto_moderation || {};
        const se = s.sdr_escalation || {};
        return {
            mode: s.mode === 'block' ? 'block' : 'censor',
            words: Array.isArray(s.words) ? s.words.map(normaliseWord).filter(Boolean) : [],
            links: ['allow', 'block', 'allowlist'].includes(s.links) ? s.links : d.links,
            linkAllowlist: Array.isArray(s.link_allowlist) ? s.link_allowlist.slice() : [],
            autoEnabled: am.enabled === undefined ? d.auto_moderation.enabled : !!am.enabled,
            strikes: toInt(am.strikes, d.auto_moderation.strikes),
            windowMinutes: toInt(am.window_minutes, d.auto_moderation.window_minutes),
            chatBanMinutes: toInt(am.chat_ban_minutes, d.auto_moderation.chat_ban_minutes),
            sdrEnabled: se.enabled === undefined ? d.sdr_escalation.enabled : !!se.enabled,
            sdrChatBans: toInt(se.chat_bans, d.sdr_escalation.chat_bans),
            sdrWindowDays: toInt(se.window_days, d.sdr_escalation.window_days),
        };
    }

    // Form state -> the JSON body for PUT /admin/chat/moderation.
    function formToSettings(f) {
        const d = DEFAULT_SETTINGS;
        return {
            mode: f.mode === 'block' ? 'block' : 'censor',
            words: (f.words || []).slice(),
            links: ['allow', 'block', 'allowlist'].includes(f.links) ? f.links : d.links,
            link_allowlist: (f.linkAllowlist || []).slice(),
            auto_moderation: {
                enabled: !!f.autoEnabled,
                strikes: toInt(f.strikes, d.auto_moderation.strikes),
                window_minutes: toInt(f.windowMinutes, d.auto_moderation.window_minutes),
                chat_ban_minutes: toInt(f.chatBanMinutes, d.auto_moderation.chat_ban_minutes),
            },
            sdr_escalation: {
                enabled: !!f.sdrEnabled,
                chat_bans: toInt(f.sdrChatBans, d.sdr_escalation.chat_bans),
                window_days: toInt(f.sdrWindowDays, d.sdr_escalation.window_days),
            },
        };
    }

    function formsEqual(a, b) {
        return JSON.stringify(formToSettings(a)) === JSON.stringify(formToSettings(b));
    }

    // Which action buttons a log row gets.
    function rowActions(log) {
        const relay = isRelayUser(log && log.username);
        const deleted = !!(log && log.deleted_at);
        const blocked = log && log.status === 'blocked';
        return {
            del: !deleted && !blocked,
            chatBan: !relay && !!(log && log.source_ip),
            sdrBan: !relay && !!(log && log.source_ip),
        };
    }

    // The small tag shown next to a message, or null.
    function statusTag(log) {
        if (!log) return null;
        if (log.status === 'blocked') {
            return { kind: 'blocked', label: 'Blocked', title: 'Not sent: it contained a blocked word or link' };
        }
        if (log.status === 'censored') {
            const raw = log.message_raw || '';
            return { kind: 'censored', label: 'Starred', title: raw ? 'Original: ' + raw : 'Some letters were replaced with stars' };
        }
        return null;
    }

    function formatTime(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function deletedNote(log) {
        if (!log || !log.deleted_at) return '';
        const by = log.deleted_by ? log.deleted_by : 'a moderator';
        return `Deleted by ${by}, ${formatTime(log.deleted_at)}`;
    }

    // HTML for the Message cell. Every piece of user text is escaped.
    function renderMessageCell(log) {
        const tag = statusTag(log);
        let tagHtml = '';
        if (tag) {
            tagHtml = ` <span class="chatmod-tag chatmod-tag-${tag.kind}" title="${esc(tag.title)}">${esc(tag.label)}</span>`;
        }
        if (log.deleted_at) {
            return `<span class="chatmod-removed">${esc(log.message)}</span>${tagHtml}` +
                `<div class="chatmod-removed-note">${esc(deletedNote(log))}</div>`;
        }
        return `<span>${esc(log.message)}</span>${tagHtml}`;
    }

    function statusLabel(log) {
        let s = 'Sent';
        if (log.status === 'censored') s = 'Starred';
        else if (log.status === 'blocked') s = 'Blocked';
        if (log.deleted_at) s += `; deleted by ${log.deleted_by || 'a moderator'} at ${new Date(log.deleted_at).toISOString()}`;
        return s;
    }

    function csvField(v) {
        let s = v === null || v === undefined ? '' : String(v);
        // Stop spreadsheet programs from running text that looks like a formula.
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
        return s;
    }

    const CSV_HEADER = 'Timestamp,IP Address,Country,Country Code,Nickname,Message,Status,Original text';

    function csvRow(log) {
        const ts = log.timestamp ? new Date(log.timestamp).toISOString() : '';
        return [ts, log.source_ip, log.country, log.country_code, log.username, log.message,
            statusLabel(log), log.message_raw || ''].map(csvField).join(',');
    }

    function buildCsv(logs) {
        return CSV_HEADER + '\n' + (logs || []).map(csvRow).join('\n') + ((logs && logs.length) ? '\n' : '');
    }

    function actionName(action) {
        return ACTION_NAMES[action] || (action ? String(action).replace(/_/g, ' ') : 'Unknown');
    }

    function durationLabel(sec) {
        const p = DURATION_PRESETS.find((x) => x.sec === sec);
        if (p) return p.label;
        if (sec % 86400 === 0) return plural(sec / 86400, 'day', 'days');
        if (sec % 3600 === 0) return plural(sec / 3600, 'hour', 'hours');
        return plural(Math.round(sec / 60), 'minute', 'minutes');
    }

    // Plain-words result of POST /admin/chat/moderation/test.
    function describeTest(r) {
        if (!r) return { tone: 'error', text: 'No answer from the server.' };
        const why = r.reason ? ` (${r.reason})` : '';
        if (r.result === 'blocked') return { tone: 'bad', text: `This message would not be sent${why}.` };
        if (r.result === 'censored') return { tone: 'warn', text: 'This message would be sent as:', output: r.output || '' };
        return { tone: 'good', text: 'This message would be sent as written.' };
    }

    // "Chat-ban someone": decide whether the text is an IP or a name.
    function parseTarget(text) {
        const t = String(text == null ? '' : text).trim();
        if (!t) return null;
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t) || (/^[0-9a-f:]+$/i.test(t) && t.includes(':') && t.split(':').length > 2)) {
            return { ip: t };
        }
        return { username: t };
    }

    function logsQuery(f) {
        const p = new URLSearchParams();
        if (f.start) p.append('start', f.start);
        if (f.end) p.append('end', f.end);
        if (f.ip) p.append('ip', f.ip);
        if (f.nickname) p.append('nickname', f.nickname);
        if (f.message) p.append('message', f.message);
        if (f.limit) p.append('limit', f.limit);
        if (f.show && f.show !== 'all') p.append('show', f.show);
        return p.toString();
    }

    // The ids "Delete all shown" removes: rows still visible in chat.
    function deletableIds(logs) {
        return (logs || []).filter((l) => l.id && rowActions(l).del).map((l) => l.id);
    }

    function sortLogs(logs, column, dir) {
        const key = (l) => {
            switch (column) {
                case 'ip': return l.source_ip || '';
                case 'nickname': return (l.username || '').toLowerCase();
                case 'country': return (l.country || '').toLowerCase();
                default: return new Date(l.timestamp).getTime() || 0;
            }
        };
        return logs.slice().sort((a, b) => {
            const x = key(a), y = key(b);
            const c = x > y ? 1 : x < y ? -1 : 0;
            return dir === 'asc' ? c : -c;
        });
    }

    const helpers = {
        DURATION_PRESETS, DEFAULT_SETTINGS, ACTION_NAMES, CSV_HEADER,
        esc, isRelayUser, normaliseWord, wordProblem, normaliseDomain, splitPasted, hasSeparator,
        checkWord, checkDomain, addItems, describeAdd, settingsToForm, formToSettings, formsEqual,
        rowActions, statusTag, renderMessageCell, deletedNote, statusLabel, csvField, csvRow, buildCsv,
        actionName, durationLabel, describeTest, parseTarget, logsQuery, deletableIds, sortLogs,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    // ── DOM ─────────────────────────────────────────────────────────────────

    const $ = (id) => document.getElementById(id);

    function injectStyles() {
        if ($('chatmod-styles')) return;
        const st = document.createElement('style');
        st.id = 'chatmod-styles';
        st.textContent = `
            .chatmod-card { background: #fff; border: 1px solid #e3e6ea; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
            .chatmod-card h3 { margin: 0 0 4px 0; color: #333; font-size: 17px; }
            .chatmod-card .chatmod-sub { color: #666; font-size: 13px; margin: 0 0 14px 0; }
            .chatmod-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
            .chatmod-chip { display: inline-flex; align-items: center; gap: 4px; background: #eef0fb; color: #333; border: 1px solid #c9cff3; border-radius: 14px; padding: 3px 4px 3px 10px; font-size: 13px; transition: background .2s, box-shadow .2s; }
            .chatmod-chip button { background: none; border: none; cursor: pointer; color: #667; font-size: 15px; line-height: 1; padding: 0 5px; border-radius: 50%; }
            .chatmod-chip button:hover { background: #dc3545; color: #fff; }
            .chatmod-chip.builtin { background: #f1f3f5; color: #888; border-color: #e1e4e8; padding-right: 10px; }
            .chatmod-chip.flash { background: #fff3cd; border-color: #f0ad4e; box-shadow: 0 0 0 2px #f0ad4e55; }
            .chatmod-input-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
            .chatmod-input-row input[type=text] { flex: 1; min-width: 180px; max-width: 360px; padding: 8px 10px; border: 1px solid #ccc; border-radius: 5px; font-size: 14px; }
            .chatmod-input-row .btn { padding: 8px 16px; margin-left: 0; }
            .chatmod-hint { font-size: 13px; min-height: 18px; margin-top: 6px; color: #666; }
            .chatmod-hint.error { color: #c62828; }
            .chatmod-hint.ok { color: #2e7d32; }
            .chatmod-meta { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; font-size: 13px; color: #555; }
            .chatmod-linkbtn { background: none; border: none; color: #667eea; cursor: pointer; font-size: 13px; padding: 0; text-decoration: underline; }
            .chatmod-radio { display: block; margin: 6px 0; font-size: 14px; cursor: pointer; }
            .chatmod-radio input { margin-right: 8px; }
            .chatmod-sentence { font-size: 14px; line-height: 2.2; color: #333; }
            .chatmod-sentence input[type=number] { width: 60px; padding: 3px 6px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; }
            .chatmod-sentence select { padding: 3px 6px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; }
            .chatmod-sentence.disabled { color: #999; }
            .chatmod-savebar { position: sticky; bottom: 0; z-index: 5; display: flex; gap: 10px; align-items: center; justify-content: flex-end; background: #fff; border: 1px solid #e3e6ea; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; box-shadow: 0 -2px 8px rgba(0,0,0,.05); }
            .chatmod-savebar.dirty { border-color: #f0ad4e; background: #fffaf0; }
            .chatmod-savebar .chatmod-state { margin-right: auto; font-size: 14px; color: #666; }
            .chatmod-savebar.dirty .chatmod-state { color: #b26a00; font-weight: 600; }
            .chatmod-savebar .btn { margin-left: 0; padding: 8px 18px; }
            .chatmod-result { border-radius: 6px; padding: 10px 14px; font-size: 14px; margin-top: 10px; }
            .chatmod-result.good { background: #e8f5e9; color: #1b5e20; }
            .chatmod-result.warn { background: #fff8e1; color: #6d4c00; }
            .chatmod-result.bad, .chatmod-result.error { background: #fdecea; color: #b71c1c; }
            .chatmod-result code { display: block; margin-top: 6px; background: rgba(255,255,255,.7); padding: 6px 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
            .chatmod-tag { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 10px; margin-left: 6px; vertical-align: middle; cursor: default; }
            .chatmod-tag-blocked { background: #fdecea; color: #c62828; border: 1px solid #f5c2c0; }
            .chatmod-tag-censored { background: #fff3cd; color: #8a6100; border: 1px solid #f3dc9a; cursor: help; }
            .chatmod-removed { color: #999; text-decoration: line-through; }
            .chatmod-removed-note { color: #999; font-size: 11px; margin-top: 3px; }
            tr.chatmod-row-removed td { background: #fafafa; color: #999; }
            .chatmod-act { background: none; border: none; font-size: 17px; cursor: pointer; padding: 2px 5px; opacity: .65; transition: opacity .2s; }
            .chatmod-act:hover { opacity: 1; }
            .chatmod-table { width: 100%; border-collapse: collapse; font-size: 13px; }
            .chatmod-table th { text-align: left; padding: 8px 10px; background: #f8f9fa; border-bottom: 2px solid #dee2e6; }
            .chatmod-table td { padding: 8px 10px; border-bottom: 1px solid #eee; vertical-align: top; }
            .chatmod-empty { color: #888; font-size: 14px; padding: 14px 0; }
            .chatmod-presets { display: flex; flex-wrap: wrap; gap: 6px; }
            .chatmod-presets button { border: 1px solid #c9cff3; background: #fff; color: #444; border-radius: 16px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
            .chatmod-presets button.selected { background: #667eea; color: #fff; border-color: #667eea; }
            .chatmod-field { margin-bottom: 14px; }
            .chatmod-field label.t { display: block; font-weight: 600; font-size: 13px; color: #555; margin-bottom: 6px; }
            .chatmod-field input[type=text] { width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 5px; font-size: 14px; box-sizing: border-box; }
        `;
        document.head.appendChild(st);
    }

    async function api(url, options) {
        const opts = Object.assign({}, options || {});
        if (opts.json !== undefined) {
            opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
            opts.body = JSON.stringify(opts.json);
            delete opts.json;
        }
        const res = await authenticatedFetch(url, opts);
        if (!res) throw new Error('Not logged in');
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : {}; } catch (_) { data = null; }
        if (!res.ok) {
            const msg = (data && (data.error || data.message)) || text || `Request failed (${res.status})`;
            throw new Error(String(msg).trim());
        }
        return data || {};
    }

    // ── Sub-tabs ──

    let activeSubTab = 'messages';
    let moderationLoaded = false;

    function switchChatSubTab(tab) {
        activeSubTab = tab === 'moderation' ? 'moderation' : 'messages';
        const tabs = { messages: $('chatMessagesSubTab'), moderation: $('chatModerationSubTab') };
        for (const [name, btn] of Object.entries(tabs)) {
            if (!btn) continue;
            const on = name === activeSubTab;
            btn.classList.toggle('active', on);
            btn.style.borderBottom = on ? '3px solid #007bff' : '3px solid transparent';
            btn.style.color = on ? '#007bff' : '#666';
        }
        if ($('chatMessagesContent')) $('chatMessagesContent').style.display = activeSubTab === 'messages' ? 'block' : 'none';
        if ($('chatModerationContent')) $('chatModerationContent').style.display = activeSubTab === 'moderation' ? 'block' : 'none';
        if (activeSubTab === 'moderation' && !moderationLoaded) loadModeration();
    }

    function chatRefreshActive() {
        if (activeSubTab === 'moderation') loadModeration();
        else loadChatLogs();
    }

    // ── Messages ──

    let currentChatLogs = [];
    let lastChatResponse = null;
    let sortColumn = 'timestamp';
    let sortDir = 'desc';

    function readFilters() {
        const v = (id) => ($(id) ? $(id).value.trim() : '');
        return {
            start: v('chatStartDate'), end: v('chatEndDate'), ip: v('chatIPFilter'),
            nickname: v('chatNicknameFilter'), message: v('chatMessageFilter'),
            limit: v('chatLimitFilter'), show: v('chatShowFilter') || 'all',
        };
    }

    function handleChatFilterEnter(event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            loadChatLogs();
        }
    }

    async function loadChatLogs(quiet) {
        try {
            const data = await api('/admin/chat/logs?' + logsQuery(readFilters()));
            lastChatResponse = data;
            currentChatLogs = sortLogs(data.logs || [], sortColumn, sortDir);
            renderChatLogs();
            if (!quiet) showAlert(`Loaded ${data.count || currentChatLogs.length} chat message(s)`, 'success');
        } catch (e) {
            showAlert('Error loading chat logs: ' + esc(e.message), 'error');
        }
    }

    function updateDeleteAllButton() {
        const btn = $('chatDeleteAllShown');
        if (!btn) return;
        const d = lastChatResponse || {};
        const filtered = !!(d.ip_filter || d.nickname_filter);
        const n = deletableIds(currentChatLogs).length;
        btn.style.display = filtered && n > 0 ? '' : 'none';
        btn.textContent = `🗑 Delete all shown (${n})`;
    }

    function renderChatLogs() {
        const container = $('chatLogsList');
        if (!container) return;
        container.classList.remove('loading');
        updateDeleteAllButton();
        const d = lastChatResponse || {};
        if (!currentChatLogs.length) {
            container.innerHTML = '<p style="text-align: center; color: #666; padding: 40px;">No chat messages found for the selected filters</p>';
            return;
        }
        const removed = currentChatLogs.filter((l) => l.deleted_at).length;
        let summary = `<strong>Summary:</strong> ${esc(d.count != null ? d.count : currentChatLogs.length)} message(s) from ${esc(d.start_date)} to ${esc(d.end_date)}`;
        if (removed) summary += ` • ${removed} removed`;
        if (d.ip_filter) summary += ` • IP: <strong>${esc(d.ip_filter)}</strong>`;
        if (d.nickname_filter) summary += ` • Nickname: <strong>${esc(d.nickname_filter)}</strong>`;
        if (d.message_filter) summary += ` • Message: <strong>${esc(d.message_filter)}</strong>`;

        const icon = (c) => (sortColumn === c ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
        const th = (c, label, w) => `<th data-sort="${c}" style="padding: 12px; text-align: left; ${w ? 'width:' + w + ';' : ''} cursor: pointer; user-select: none;" title="Click to sort">${label}${icon(c)}</th>`;

        const rows = currentChatLogs.map((log, i) => {
            const a = rowActions(log);
            const flag = log.country_code && /^[A-Za-z]{2}$/.test(log.country_code)
                ? String.fromCodePoint(...[...log.country_code.toUpperCase()].map((c) => 0x1F1E6 - 65 + c.charCodeAt(0))) + ' ' : '';
            const country = log.country ? `${flag}${esc(log.country)}${log.country_code ? ' (' + esc(log.country_code) + ')' : ''}` : '-';
            const ip = log.source_ip || '';
            let acts = '';
            if (a.del) acts += `<button class="chatmod-act" data-act="delete" data-i="${i}" title="Delete this message">🗑</button>`;
            if (a.chatBan) acts += `<button class="chatmod-act" data-act="chatban" data-i="${i}" title="Chat ban (temporary, chat only)">⏳</button>`;
            if (a.sdrBan) acts += `<button class="chatmod-act" data-act="sdrban" data-i="${i}" title="Ban from SDR (permanent)">🚫</button>`;
            return `<tr class="${log.deleted_at ? 'chatmod-row-removed' : ''}" style="border-bottom: 1px solid #dee2e6;">
                <td style="padding: 12px; font-size: 12px; white-space: nowrap;">${esc(new Date(log.timestamp).toLocaleString())}</td>
                <td style="padding: 12px; font-family: monospace; font-size: 12px; cursor: pointer; color: #667eea;" data-filter-ip="${i}" title="Click to show only this IP">${esc(ip)}</td>
                <td style="padding: 12px; font-size: 12px; line-height: 1.4;">${country}</td>
                <td style="padding: 12px; font-weight: bold; color: #667eea; cursor: pointer;" data-filter-nick="${i}" title="Click to show only this nickname">${esc(log.username)}</td>
                <td style="padding: 12px; word-break: break-word;">${renderMessageCell(log)}</td>
                <td style="padding: 8px; text-align: center; white-space: nowrap;">${acts}</td>
            </tr>`;
        }).join('');

        container.innerHTML = `
            <div style="margin-bottom: 15px; padding: 15px; background: #e3f2fd; border-radius: 5px;">${summary}</div>
            <table id="chatLogsTable" style="width: 100%; border-collapse: collapse;">
                <thead><tr style="background: #f8f9fa; border-bottom: 2px solid #dee2e6;">
                    ${th('timestamp', 'Timestamp', '170px')}${th('ip', 'IP Address', '130px')}${th('country', 'Country', '110px')}${th('nickname', 'Nickname', '140px')}
                    <th style="padding: 12px; text-align: left;">Message</th>
                    <th style="padding: 12px; text-align: center; width: 110px;">Actions</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>`;
    }

    function onLogsClick(ev) {
        const t = ev.target.closest('[data-sort],[data-act],[data-filter-ip],[data-filter-nick]');
        if (!t) return;
        if (t.dataset.sort) {
            const c = t.dataset.sort;
            if (sortColumn === c) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
            else { sortColumn = c; sortDir = c === 'timestamp' ? 'desc' : 'asc'; }
            currentChatLogs = sortLogs(currentChatLogs, sortColumn, sortDir);
            renderChatLogs();
            return;
        }
        const idx = Number(t.dataset.i !== undefined ? t.dataset.i : (t.dataset.filterIp !== undefined ? t.dataset.filterIp : t.dataset.filterNick));
        const log = currentChatLogs[idx];
        if (!log) return;
        if (t.dataset.filterIp !== undefined) { $('chatIPFilter').value = log.source_ip || ''; loadChatLogs(); return; }
        if (t.dataset.filterNick !== undefined) { $('chatNicknameFilter').value = log.username || ''; loadChatLogs(); return; }
        if (t.dataset.act === 'delete') deleteOne(log);
        else if (t.dataset.act === 'chatban') openChatBanDialog({ username: log.username, ip: log.source_ip });
        else if (t.dataset.act === 'sdrban') banUser(log.source_ip, 'Banned from chat log', () => loadChatLogs(true));
    }

    async function postDelete(body, okText) {
        try {
            const r = await api('/admin/chat/delete', { method: 'POST', json: body });
            showAlert(esc(r.message || okText), 'success');
            loadChatLogs(true);
        } catch (e) {
            showAlert('Could not delete: ' + esc(e.message), 'error');
        }
    }

    function deleteOne(log) {
        if (!log.id) { showAlert('This message has no id and cannot be deleted', 'error'); return; }
        const preview = String(log.message || '').slice(0, 80);
        if (!confirm(`Delete this message from ${log.username}?\n\n"${preview}"\n\nIt will disappear from chat for everyone.`)) return;
        postDelete({ ids: [log.id] }, 'Message deleted');
    }

    function deleteAllShown() {
        const ids = deletableIds(currentChatLogs);
        if (!ids.length) return;
        if (!confirm(`Delete all ${ids.length} message(s) shown?\n\nThey will disappear from chat for everyone.`)) return;
        postDelete({ ids }, `${ids.length} message(s) deleted`);
    }

    function clearChatFilters() {
        const today = new Date().toISOString().split('T')[0];
        $('chatStartDate').value = today;
        $('chatEndDate').value = today;
        $('chatIPFilter').value = '';
        $('chatNicknameFilter').value = '';
        $('chatMessageFilter').value = '';
        $('chatLimitFilter').value = '1000';
        if ($('chatShowFilter')) $('chatShowFilter').value = 'all';
        loadChatLogs();
    }

    async function exportChatLogs() {
        try {
            const f = readFilters();
            const data = await api('/admin/chat/logs?' + logsQuery(f));
            const blob = new Blob([buildCsv(data.logs || [])], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `chat_logs_${f.start || 'all'}_to_${f.end || 'all'}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            showAlert('Chat logs exported successfully', 'success');
        } catch (e) {
            showAlert('Error exporting chat logs: ' + esc(e.message), 'error');
        }
    }

    // ── Chat ban dialog ──

    function openChatBanDialog(target) {
        injectStyles();
        let modal = $('chatBanModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'chatBanModal';
            modal.className = 'modal';
            document.body.appendChild(modal);
            modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
        }
        let sec = 3600;
        const presets = DURATION_PRESETS.map((p) =>
            `<button type="button" data-sec="${p.sec}" class="${p.sec === sec ? 'selected' : ''}">${esc(p.label)}</button>`).join('');
        modal.innerHTML = `
            <div class="modal-content" style="max-width: 440px;">
                <div class="modal-header">
                    <h2 style="font-size: 20px;">Chat ban</h2>
                    <button class="modal-close" data-close="1">&times;</button>
                </div>
                <div class="modal-body">
                    <p style="margin: 0 0 14px 0; font-size: 14px; color: #444;">
                        <strong>${esc(target.username || target.ip)}</strong>
                        ${target.ip ? `<span style="font-family: monospace; font-size: 12px; color: #888; margin-left: 6px;">${esc(target.ip)}</span>` : ''}
                    </p>
                    <p style="margin: 0 0 16px 0; font-size: 13px; color: #666;">They can't post in chat or rejoin it until the ban ends. They can still listen to the SDR and read chat.</p>
                    <div class="chatmod-field"><label class="t">How long</label><div class="chatmod-presets">${presets}</div></div>
                    <div class="chatmod-field"><label class="t" for="chatBanReason">Reason (optional)</label>
                        <input type="text" id="chatBanReason" maxlength="200" placeholder="e.g. Bad language"></div>
                    <label style="display: flex; gap: 8px; align-items: center; font-size: 14px; margin-bottom: 18px; cursor: pointer;">
                        <input type="checkbox" id="chatBanDelete" checked> Also delete their messages</label>
                    <div id="chatBanError" class="chatmod-hint error"></div>
                    <div style="display: flex; gap: 10px; justify-content: flex-end;">
                        <button class="btn btn-secondary" data-close="1">Cancel</button>
                        <button class="btn btn-danger" id="chatBanSubmit">Chat ban</button>
                    </div>
                </div>
            </div>`;
        modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { modal.style.display = 'none'; }));
        modal.querySelectorAll('.chatmod-presets button').forEach((b) => b.addEventListener('click', () => {
            sec = Number(b.dataset.sec);
            modal.querySelectorAll('.chatmod-presets button').forEach((x) => x.classList.toggle('selected', x === b));
        }));
        $('chatBanSubmit').addEventListener('click', async () => {
            const btn = $('chatBanSubmit');
            btn.disabled = true;
            try {
                const body = { duration_sec: sec, reason: $('chatBanReason').value.trim(), delete: $('chatBanDelete').checked };
                if (target.ip) body.ip = target.ip;
                if (target.username) body.username = target.username;
                const r = await api('/admin/chat/ban', { method: 'POST', json: body });
                modal.style.display = 'none';
                showAlert(esc(r.message || `${target.username || target.ip} is banned from chat for ${durationLabel(sec)}`), 'success');
                if (activeSubTab === 'messages') loadChatLogs(true);
                loadBansAndActions();
            } catch (e) {
                $('chatBanError').textContent = e.message;
                btn.disabled = false;
            }
        });
        modal.style.display = 'block';
        setTimeout(() => $('chatBanReason') && $('chatBanReason').focus(), 50);
    }

    // ── Chip editor (blocked words and allowed sites) ──

    function ChipEditor(root, opts) {
        this.root = root;
        this.opts = opts; // {checker, noun, nouns, placeholder, builtin:()=>[], onChange}
        this.items = [];
        this.filter = '';
        this.showBuiltin = false;
        root.innerHTML = `
            <div class="chatmod-meta">
                <span data-role="count"></span>
                <input type="text" data-role="filter" placeholder="Find…" style="display:none; padding: 4px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; width: 160px;">
                ${opts.builtin ? '<button type="button" class="chatmod-linkbtn" data-role="toggle"></button>' : ''}
            </div>
            <div class="chatmod-chips" data-role="chips"></div>
            <div class="chatmod-chips" data-role="builtin" style="display:none"></div>
            <div class="chatmod-input-row">
                <input type="text" data-role="input" maxlength="2000" placeholder="${esc(opts.placeholder)}" autocomplete="off">
                <button type="button" class="btn" data-role="add">Add</button>
            </div>
            <div class="chatmod-hint" data-role="hint"></div>`;
        const q = (r) => root.querySelector(`[data-role="${r}"]`);
        this.el = { count: q('count'), filter: q('filter'), toggle: q('toggle'), chips: q('chips'), builtin: q('builtin'), input: q('input'), add: q('add'), hint: q('hint') };
        this.el.add.addEventListener('click', () => this.addFromInput());
        this.el.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); this.addFromInput(); } });
        this.el.input.addEventListener('input', () => this.liveCheck());
        this.el.input.addEventListener('paste', (e) => {
            const text = (e.clipboardData || window.clipboardData).getData('text');
            if (hasSeparator(text)) {
                e.preventDefault();
                this.addMany(splitPasted(text));
            }
        });
        this.el.filter.addEventListener('input', () => { this.filter = this.el.filter.value.trim().toLowerCase(); this.renderChips(); });
        this.el.chips.addEventListener('click', (e) => {
            const b = e.target.closest('button[data-remove]');
            if (!b) return;
            const w = b.dataset.remove;
            this.items = this.items.filter((x) => x !== w);
            this.render();
            this.opts.onChange(this.items);
        });
        if (this.el.toggle) {
            this.el.toggle.addEventListener('click', () => { this.showBuiltin = !this.showBuiltin; this.renderBuiltin(); });
        }
    }

    ChipEditor.prototype.builtinSet = function () {
        return new Set(this.opts.builtin ? this.opts.builtin() : []);
    };

    ChipEditor.prototype.setItems = function (items) {
        this.items = (items || []).slice();
        this.el.input.value = '';
        this.setHint('', '');
        this.render();
    };

    ChipEditor.prototype.setHint = function (text, tone) {
        this.el.hint.textContent = text;
        this.el.hint.className = 'chatmod-hint' + (tone ? ' ' + tone : '');
    };

    ChipEditor.prototype.flash = function (word) {
        if (this.filter && !word.includes(this.filter)) { this.filter = ''; this.el.filter.value = ''; this.renderChips(); }
        this.el.chips.querySelectorAll('.chatmod-chip').forEach((c) => {
            const on = c.dataset.word === word;
            c.classList.toggle('flash', on);
            if (on && c.scrollIntoView) c.scrollIntoView({ block: 'nearest' });
        });
    };

    ChipEditor.prototype.liveCheck = function () {
        const r = this.opts.checker(this.el.input.value, this.items, this.builtinSet(), true);
        this.flash(r.kind === 'duplicate' ? r.word : '');
        if (r.kind === 'invalid') this.setHint(r.message, 'error');
        else if (r.kind === 'duplicate' || r.kind === 'builtin') this.setHint(r.message, '');
        else this.setHint('', '');
    };

    ChipEditor.prototype.addFromInput = function () {
        const v = this.el.input.value;
        if (hasSeparator(v)) { this.addMany(splitPasted(v)); return; }
        const r = this.opts.checker(v, this.items, this.builtinSet(), false);
        if (r.kind === 'empty') return;
        if (r.kind === 'ok') {
            this.items.push(r.word);
            this.el.input.value = '';
            this.setHint('', '');
            this.render();
            this.flash(r.word);
            this.opts.onChange(this.items);
            return;
        }
        if (r.kind === 'duplicate') this.flash(r.word);
        this.setHint(r.message, r.kind === 'invalid' ? 'error' : '');
    };

    ChipEditor.prototype.addMany = function (list) {
        const res = addItems(this.items, list, this.opts.checker, this.builtinSet());
        this.items = res.list;
        this.el.input.value = '';
        this.render();
        this.setHint(describeAdd(res, this.opts.noun, this.opts.nouns), res.skipped.some((s) => s.kind === 'invalid') ? 'error' : (res.added.length ? 'ok' : ''));
        if (res.added.length) this.opts.onChange(this.items);
    };

    ChipEditor.prototype.renderChips = function () {
        const shown = this.filter ? this.items.filter((w) => w.includes(this.filter)) : this.items;
        this.el.chips.innerHTML = shown.map((w) =>
            `<span class="chatmod-chip" data-word="${esc(w)}">${esc(w)}<button type="button" data-remove="${esc(w)}" title="Remove ${esc(w)}" aria-label="Remove ${esc(w)}">×</button></span>`).join('') +
            (this.filter && !shown.length ? '<span class="chatmod-empty">No match</span>' : '');
    };

    ChipEditor.prototype.renderBuiltin = function () {
        if (!this.el.toggle || !this.opts.builtin) return;
        const list = this.opts.builtin();
        this.el.toggle.textContent = (this.showBuiltin ? 'Hide' : 'Show') + ` built-in words (${list.length})`;
        this.el.builtin.style.display = this.showBuiltin ? 'flex' : 'none';
        if (this.showBuiltin) {
            this.el.builtin.innerHTML = list.map((w) => `<span class="chatmod-chip builtin" title="Built-in, always on">${esc(w)}</span>`).join('');
        }
    };

    ChipEditor.prototype.render = function () {
        const n = this.items.length;
        this.el.count.textContent = n ? plural(n, this.opts.countNoun, this.opts.countNouns) : this.opts.emptyText;
        this.el.filter.style.display = n > 20 ? '' : 'none';
        if (n <= 20 && this.filter) { this.filter = ''; this.el.filter.value = ''; }
        this.renderChips();
        this.renderBuiltin();
    };

    // ── Moderation settings ──

    let savedForm = settingsToForm(DEFAULT_SETTINGS);
    let form = settingsToForm(DEFAULT_SETTINGS);
    let builtinWords = [];
    let wordEditor = null;
    let siteEditor = null;
    let modUiReady = false;

    function setupModerationUi() {
        if (modUiReady || !$('chatModWords')) return;
        modUiReady = true;
        injectStyles();
        wordEditor = new ChipEditor($('chatModWords'), {
            checker: checkWord, noun: 'word', nouns: 'words', countNoun: 'extra word', countNouns: 'extra words',
            emptyText: 'No extra words yet — the built-in list is always on.',
            placeholder: 'Type a word and press Enter (or paste a list)',
            builtin: () => builtinWords,
            onChange: (items) => { form.words = items.slice(); markDirty(); },
        });
        siteEditor = new ChipEditor($('chatModSites'), {
            checker: checkDomain, noun: 'site', nouns: 'sites', countNoun: 'site', countNouns: 'sites',
            emptyText: 'No sites yet — add at least one, or links will be blocked.',
            placeholder: 'e.g. qrz.com',
            onChange: (items) => { form.linkAllowlist = items.slice(); markDirty(); },
        });
        const presetOpts = DURATION_PRESETS.map((p) => `<option value="${p.sec / 60}">${esc(p.label)}</option>`).join('');
        $('chatModAutoBan').innerHTML = presetOpts;
        $('chatModManualDuration').innerHTML = DURATION_PRESETS.map((p) =>
            `<option value="${p.sec}"${p.sec === 3600 ? ' selected' : ''}>${esc(p.label)}</option>`).join('');

        const content = $('chatModerationContent');
        content.addEventListener('change', (e) => { if (e.target.closest('[data-form]')) readFormFromDom(); });
        content.addEventListener('input', (e) => { if (e.target.matches('[data-form] input[type=number]')) readFormFromDom(); });
        $('chatModSave').addEventListener('click', saveModeration);
        $('chatModDiscard').addEventListener('click', () => { form = JSON.parse(JSON.stringify(savedForm)); applyFormToDom(); markDirty(); setSaveResult(''); });
        $('chatModTestBtn').addEventListener('click', runTest);
        $('chatModTestInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runTest(); } });
        $('chatModManualBan').addEventListener('click', manualBan);
        $('chatModBans').addEventListener('click', (e) => {
            const b = e.target.closest('button[data-lift]');
            if (b) liftBan(b.dataset.lift, b.dataset.name);
        });
        let t = null;
        $('chatModActionsSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(loadActions, 300); });
        window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });
    }

    function readFormFromDom() {
        const checked = (name) => { const el = document.querySelector(`input[name="${name}"]:checked`); return el ? el.value : ''; };
        form.mode = checked('chatModMode') || 'censor';
        form.links = checked('chatModLinks') || 'allow';
        form.autoEnabled = $('chatModAutoEnabled').checked;
        form.strikes = $('chatModStrikes').value;
        form.windowMinutes = $('chatModWindow').value;
        form.chatBanMinutes = $('chatModAutoBan').value;
        form.sdrEnabled = $('chatModSdrEnabled').checked;
        form.sdrChatBans = $('chatModSdrBans').value;
        form.sdrWindowDays = $('chatModSdrDays').value;
        syncEnabledStates();
        markDirty();
    }

    function syncEnabledStates() {
        $('chatModSitesWrap').style.display = form.links === 'allowlist' ? 'block' : 'none';
        const autoOn = $('chatModAutoEnabled').checked;
        ['chatModStrikes', 'chatModWindow', 'chatModAutoBan'].forEach((id) => { $(id).disabled = !autoOn; });
        $('chatModAutoSentence').classList.toggle('disabled', !autoOn);
        const sdrOn = $('chatModSdrEnabled').checked;
        ['chatModSdrBans', 'chatModSdrDays'].forEach((id) => { $(id).disabled = !sdrOn; });
        $('chatModSdrSentence').classList.toggle('disabled', !sdrOn);
    }

    function applyFormToDom() {
        const setRadio = (name, v) => document.querySelectorAll(`input[name="${name}"]`).forEach((r) => { r.checked = r.value === v; });
        setRadio('chatModMode', form.mode);
        setRadio('chatModLinks', form.links);
        $('chatModAutoEnabled').checked = form.autoEnabled;
        $('chatModStrikes').value = form.strikes;
        $('chatModWindow').value = form.windowMinutes;
        const sel = $('chatModAutoBan');
        sel.querySelectorAll('option[data-custom]').forEach((o) => o.remove());
        if (![...sel.options].some((o) => Number(o.value) === Number(form.chatBanMinutes))) {
            const o = document.createElement('option');
            o.value = String(form.chatBanMinutes);
            o.dataset.custom = '1';
            o.textContent = durationLabel(Number(form.chatBanMinutes) * 60);
            sel.appendChild(o);
        }
        sel.value = String(form.chatBanMinutes);
        $('chatModSdrEnabled').checked = form.sdrEnabled;
        $('chatModSdrBans').value = form.sdrChatBans;
        $('chatModSdrDays').value = form.sdrWindowDays;
        wordEditor.setItems(form.words);
        siteEditor.setItems(form.linkAllowlist);
        syncEnabledStates();
    }

    function isDirty() {
        return modUiReady && moderationLoaded && !formsEqual(form, savedForm);
    }

    function markDirty() {
        const dirty = isDirty();
        $('chatModSaveBar').classList.toggle('dirty', dirty);
        $('chatModState').textContent = dirty ? 'Unsaved changes' : 'All changes saved';
        $('chatModSave').disabled = !dirty;
        $('chatModDiscard').style.display = dirty ? '' : 'none';
        $('chatModTestNote').style.display = dirty ? '' : 'none';
    }

    function setSaveResult(html, tone) {
        const el = $('chatModSaveResult');
        el.innerHTML = html;
        el.className = html ? 'chatmod-result ' + (tone || 'good') : '';
        el.style.display = html ? '' : 'none';
    }

    async function loadModeration() {
        setupModerationUi();
        if (!modUiReady) return;
        loadBansAndActions();
        if (isDirty()) {
            showAlert('You have unsaved changes; settings were not reloaded.', 'info');
            return;
        }
        try {
            const data = await api('/admin/chat/moderation');
            builtinWords = (data.builtin_words || []).slice().sort();
            savedForm = settingsToForm(data.settings);
            form = settingsToForm(data.settings);
            moderationLoaded = true;
            applyFormToDom();
            markDirty();
        } catch (e) {
            showAlert('Could not load chat moderation settings: ' + esc(e.message), 'error');
        }
    }

    async function saveModeration() {
        const btn = $('chatModSave');
        btn.disabled = true;
        try {
            const r = await api('/admin/chat/moderation', { method: 'PUT', json: formToSettings(form) });
            savedForm = settingsToForm(r.settings || formToSettings(form));
            form = JSON.parse(JSON.stringify(savedForm));
            applyFormToDom();
            markDirty();
            const notes = (r.notes || []).map((n) => `<div>${esc(n)}</div>`).join('');
            const rej = (r.rejected || []).map((x) => `<li><strong>${esc(x.word)}</strong> — ${esc(x.reason)}</li>`).join('');
            if (rej) {
                setSaveResult(`<div><strong>Saved, but some entries were left out:</strong></div><ul style="margin: 6px 0 0 18px;">${rej}</ul>${notes}`, 'warn');
            } else {
                setSaveResult(`<div><strong>Saved.</strong> Chat uses the new settings right away.</div>${notes}`, 'good');
            }
        } catch (e) {
            setSaveResult(`<strong>Not saved:</strong> ${esc(e.message)}`, 'error');
            markDirty();
        }
    }

    async function runTest() {
        const input = $('chatModTestInput');
        const out = $('chatModTestResult');
        const message = input.value.trim();
        if (!message) { input.focus(); return; }
        try {
            const r = await api('/admin/chat/moderation/test', { method: 'POST', json: { message } });
            const d = describeTest(r);
            out.className = 'chatmod-result ' + d.tone;
            out.innerHTML = esc(d.text) + (d.output !== undefined ? `<code>${esc(d.output)}</code>` : '');
        } catch (e) {
            out.className = 'chatmod-result error';
            out.textContent = 'Could not test: ' + e.message;
        }
        out.style.display = '';
    }

    // ── Chat bans and history ──

    function loadBansAndActions() {
        if (!$('chatModBans')) return;
        loadBans();
        loadActions();
    }

    async function loadBans() {
        const el = $('chatModBans');
        try {
            const data = await api('/admin/chat/bans');
            const bans = data.bans || [];
            if (!bans.length) { el.innerHTML = '<div class="chatmod-empty">Nobody is banned from chat right now.</div>'; return; }
            el.innerHTML = `<table class="chatmod-table"><thead><tr><th>Name</th><th>IP address</th><th>Reason</th><th>By</th><th>Until</th><th></th></tr></thead><tbody>${
                bans.map((b) => `<tr>
                    <td><strong>${esc(b.username || '—')}</strong></td>
                    <td style="font-family: monospace;">${esc(b.ip)}</td>
                    <td>${esc(b.reason || '—')}</td>
                    <td>${esc(b.by || '—')}</td>
                    <td style="white-space: nowrap;">${esc(formatTime(b.until))}</td>
                    <td style="text-align: right;"><button class="btn btn-secondary" style="padding: 4px 12px; font-size: 12px; margin-left: 0;" data-lift="${esc(b.ip)}" data-name="${esc(b.username || b.ip)}">Lift</button></td>
                </tr>`).join('')}</tbody></table>`;
        } catch (e) {
            el.innerHTML = `<div class="chatmod-hint error">Could not load chat bans: ${esc(e.message)}</div>`;
        }
    }

    async function loadActions() {
        const el = $('chatModActions');
        if (!el) return;
        const q = $('chatModActionsSearch').value.trim();
        try {
            const data = await api('/admin/chat/actions?limit=50' + (q ? '&q=' + encodeURIComponent(q) : ''));
            const list = data.actions || [];
            if (!list.length) { el.innerHTML = `<div class="chatmod-empty">${q ? 'Nothing matches that search.' : 'Nothing has happened yet.'}</div>`; return; }
            el.innerHTML = `<table class="chatmod-table"><thead><tr><th>When</th><th>What</th><th>Name</th><th>IP address</th><th>By</th><th>Details</th></tr></thead><tbody>${
                list.map((a) => {
                    const details = [a.reason, a.expires_at ? 'until ' + formatTime(a.expires_at) : ''].filter(Boolean).join(' · ');
                    return `<tr>
                        <td style="white-space: nowrap;">${esc(formatTime(a.ts))}</td>
                        <td><strong>${esc(actionName(a.action))}</strong></td>
                        <td>${esc(a.username || '—')}</td>
                        <td style="font-family: monospace;">${esc(a.ip || '—')}</td>
                        <td>${esc(a.by || '—')}</td>
                        <td>${esc(details || '—')}</td>
                    </tr>`;
                }).join('')}</tbody></table>`;
        } catch (e) {
            el.innerHTML = `<div class="chatmod-hint error">Could not load recent actions: ${esc(e.message)}</div>`;
        }
    }

    async function liftBan(ip, name) {
        if (!confirm(`Lift the chat ban on ${name}? They can rejoin chat straight away.`)) return;
        try {
            const r = await api('/admin/chat/lift', { method: 'POST', json: { ip } });
            showAlert(esc(r.message || `Chat ban lifted for ${name}`), 'success');
            loadBansAndActions();
        } catch (e) {
            showAlert('Could not lift the chat ban: ' + esc(e.message), 'error');
        }
    }

    async function manualBan() {
        const hint = $('chatModManualHint');
        const target = parseTarget($('chatModManualTarget').value);
        if (!target) { hint.className = 'chatmod-hint error'; hint.textContent = 'Enter a chat name or an IP address.'; return; }
        const sec = Number($('chatModManualDuration').value);
        const body = Object.assign({ duration_sec: sec, reason: $('chatModManualReason').value.trim() }, target);
        try {
            const r = await api('/admin/chat/ban', { method: 'POST', json: body });
            hint.className = 'chatmod-hint ok';
            hint.textContent = r.message || `${target.username || target.ip} is banned from chat for ${durationLabel(sec)}`;
            $('chatModManualTarget').value = '';
            $('chatModManualReason').value = '';
            loadBansAndActions();
        } catch (e) {
            hint.className = 'chatmod-hint error';
            hint.textContent = e.message;
        }
    }

    // ── Start-up ──

    function init() {
        injectStyles();
        const today = new Date().toISOString().split('T')[0];
        if ($('chatStartDate')) $('chatStartDate').value = today;
        if ($('chatEndDate')) $('chatEndDate').value = today;
        if ($('chatLogsList')) $('chatLogsList').addEventListener('click', onLogsClick);
        if ($('chatDeleteAllShown')) $('chatDeleteAllShown').addEventListener('click', deleteAllShown);
        if ($('chatShowFilter')) $('chatShowFilter').addEventListener('change', () => loadChatLogs());
        setupModerationUi();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    // Used by inline handlers in admin.html.
    Object.assign(window, {
        loadChatLogs, clearChatFilters, exportChatLogs, handleChatFilterEnter,
        switchChatSubTab, chatRefreshActive, openChatBanDialog,
    });
})();
