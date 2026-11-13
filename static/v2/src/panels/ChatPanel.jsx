import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from '../react.js';
import { useChat } from '../chat/ChatContext.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Empty, Icon, Modal } from '../components/ui.jsx';
import DockTooNarrow, { useDockRoom } from '../components/DockTooNarrow.jsx';
import { MOBILE_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { USERNAME_MAX, validateUsername } from '../radio/dxcluster-connection.js';
import { suggestUsername } from '../lib/chatName.js';
import { countryFlag, formatFreqShort } from '../lib/format.js';
import { followable, sortFollowFirst } from '../lib/chatFollow.js';
import { absentIgnored, isIgnored, setIgnored, toggleIgnored } from '../lib/chatIgnore.js';
import { untilText } from '../lib/chatModeration.js';
import {
    EMOJI_SHORTCODES, applyCompletion, applyEmojiCompletion, emojiQuery, expandShortcodes,
    matchShortcodes, matchUsernames, mentionQuery, shortcodeFor, splitMessage,
} from '../lib/mentions.js';

function time(ts) {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// The picker's set, in v1's order (chat-ui.js showEmojiPicker). Keeping it
// identical means the same faces are one tap away in both frontends — and they
// are the same characters v1's :shortcode: entry produces.
const EMOJI = [
    '😊', '😂', '🤣', '😍', '😎', '🤔', '👍', '👎',
    '❤️', '🎉', '🔥', '⭐', '✨', '💯', '🚀', '🎯',
    '👋', '🙏', '💪', '🤝', '👏', '🎵', '📻', '📡',
    '🌟', '💡', '⚡', '🌈', '☀️', '🌙', '⚙️', '🔧',
];

// What a floated chat window opens at. Narrower than the cluster's — a chat line is
// prose and wraps happily, so the width only has to hold a name, a time and a sentence
// without the sentence becoming a column — and taller, because a conversation is read
// backwards up the screen.
const FLOAT_WANT = { w: 520, h: 560 };

// v1's wording exactly: "5242.252 KHz (USB)", so a frequency shared from either
// frontend reads the same in the room.
function freqMessage(frequency, mode) {
    return `${(frequency / 1000).toFixed(3)} KHz (${String(mode).toUpperCase()})`;
}

/**
 * Everything a chat user's row knows, for its tooltip.
 *
 * The row itself shows the name and the dial, because those are what the list is read for
 * — who is here, and where they are. The bin width and the idle time are worth knowing and
 * are not worth the height: in a dock column narrow enough for chat they turn a one-line
 * row into two, and two lines each is what makes a busy channel's user list unreadable at
 * the moment it is most worth reading.
 *
 * So they go here. v1 built the same string for the same reason and put the same things in
 * it (chat-ui.js, `tooltip`), which is also why the wording is its wording.
 *
 * One line each, because a `title` renders newlines and a run-on sentence of four facts
 * does not read.
 */
function userTip(u, me) {
    const lines = [u.username];
    // Where they are, spelled out. The row already carries the flag, and a flag is the
    // fastest thing on it to recognise and the easiest to get wrong — the entities a
    // receiver hears most are exactly the ambiguous ones. The code is the fallback for a
    // server that sent one without a name, which is what v1 falls back to as well.
    if (u.country || u.country_code) lines.push(String(u.country || u.country_code));
    if (u.frequency) {
        lines.push(`${formatFreqShort(u.frequency)}${u.mode ? ` ${u.mode.toUpperCase()}` : ''}`);
    }
    // How coarse their spectrum is — the thing "follow their zoom" copies across.
    if (u.zoom_bw > 0) lines.push(`${Math.round(u.zoom_bw)} Hz/bin`);
    if (u.is_idle && u.idle_minutes) lines.push(`Idle ${u.idle_minutes}m`);
    // Last, and only where there is something to click: it is an instruction rather than a
    // fact about them, and on our own row it would be an instruction to go nowhere.
    if (u.frequency && u.username !== me) lines.push('Click to tune');
    return lines.join('\n');
}

// ── Moderation ───────────────────────────────────────────────────────────────
//
// Only ever drawn for somebody the server has told us is a moderator, and only
// while their Moderate switch is on: with it off the panel is exactly what every
// other listener sees. The state and the requests are ChatContext's (see
// lib/chatModeration.js); this is the part that is pressed.

// The switch, per browser. A moderator who keeps it on in one window is not
// committing every other window they open to it.
const MOD_KEY = 'ubersdr.v2.chatModerate';
function loadModerate() {
    try { return localStorage.getItem(MOD_KEY) === 'on'; } catch (e) { return false; }
}
function saveModerate(on) {
    try { localStorage.setItem(MOD_KEY, on ? 'on' : 'off'); } catch (e) { /* ignore */ }
}

// What "Float larger" opens at: room for the log, the user list with its badges and
// the banner on one line. Trimmed to the window by floatSize.
const MOD_FLOAT_WANT = { w: 760, h: 620 };
// Below this the banner offers the larger window.
const MOD_NARROW_PX = 560;

// The contract's presets, in seconds, with the words a button can hold.
export const CHAT_BAN_PRESETS = [
    { sec: 900, label: '15 min' },
    { sec: 3600, label: '1 hour' },
    { sec: 86400, label: '24 hours' },
    { sec: 604800, label: '7 days' },
    { sec: 2592000, label: '30 days' },
];
const DEFAULT_BAN_SEC = 3600;

// Ready-made warnings. The words are what the person receives.
export const WARN_CHIPS = [
    { id: 'language', label: 'Language', text: 'Please keep the language clean.' },
    { id: 'spam', label: 'Spam', text: 'Please do not spam the chat.' },
    { id: 'civil', label: 'Be civil', text: 'Please be civil to other users.' },
];

const lc = (s) => String(s || '').toLowerCase();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Their current chat ban, from the moderators' shared state, or null. */
export function modBanFor(modState, name) {
    const bans = (modState && Array.isArray(modState.bans)) ? modState.bans : [];
    return bans.find((b) => b && lc(b.username) === lc(name)) || null;
}

/** Warnings in the last 30 days, from the moderators' shared state. */
export function modWarningsFor(modState, name) {
    const w = (modState && modState.warnings) || {};
    const key = Object.keys(w).find((k) => lc(k) === lc(name));
    return key === undefined ? 0 : (Number(w[key]) || 0);
}

// When a chat ban ends, in local time — lives with the notice text that uses it.
export { untilText };

/** "Banned from chat until 14:05", or the same with no end the server told us. */
export function banText(until, now = Date.now()) {
    const at = untilText(until, now);
    return at ? `Banned from chat until ${at}` : 'Banned from chat for now';
}

/** The 30-day record, as one line. */
export function recordLine(record) {
    const r = record || {};
    const parts = [];
    if (Number(r.warnings) > 0) parts.push(plural(Number(r.warnings), 'warning', 'warnings'));
    if (Number(r.chat_bans) > 0) parts.push(plural(Number(r.chat_bans), 'chat ban', 'chat bans'));
    if (Number(r.deleted) > 0) parts.push(plural(Number(r.deleted), 'message removed', 'messages removed'));
    return `Last 30 days: ${parts.length ? parts.join(' · ') : 'nothing on record'}`;
}

// Who chat-banned them, as a note after the time. Only said when the server
// said; an automatic ban is the filter's, a named one a moderator's.
function byNote(by) {
    if (!by) return '';
    return /^(auto|automatic|system|filter)/i.test(String(by)) ? ' (automatic)' : ` (by ${by})`;
}

/**
 * The small mark before a name a moderator is looking at: a lock when they are
 * banned from chat, otherwise their warning count. Nothing for a clean record.
 * Its own box ahead of the name, so an ellipsis on a long name never eats it.
 */
export function ModBadge({ modState, name }) {
    if (modBanFor(modState, name)) {
        return (
            <span className="chat__modbadge chat__modbadge--ban" title="Banned from chat">
                <Icon.Lock size={10} />
            </span>
        );
    }
    const n = modWarningsFor(modState, name);
    if (n <= 0) return null;
    return (
        <span className="chat__modbadge" title={`${plural(n, 'warning', 'warnings')} in the last 30 days`}>
            {String(n)}
        </span>
    );
}

/**
 * Everything a moderator can do to one person, in one dialog.
 *
 * The same single column at any panel size — it is a Modal, so it is never
 * squeezed by the dock it was opened from. It asks the server about them as it
 * opens (their IP, whether anyone shares it, their record), and every action
 * is a request answered by the server: success closes it, and ChatContext has
 * already put the line saying what happened in the log; a refusal is shown
 * here, where the moderator is looking.
 */
export function ModSheet({ name, onClose }) {
    const chat = useChat();
    const [info, setInfo] = useState(null);
    const [loadError, setLoadError] = useState(null);
    const [pending, setPending] = useState(null);
    const [error, setError] = useState(null);
    const [chip, setChip] = useState(null);
    const [note, setNote] = useState('');
    const [duration, setDuration] = useState(DEFAULT_BAN_SEC);
    const [alsoDelete, setAlsoDelete] = useState(true);
    const [confirmSdr, setConfirmSdr] = useState(false);
    // Bumped by Retry, to run the lookup again.
    const [attempt, setAttempt] = useState(0);
    // Replies can land after the sheet is closed; they must not write to it.
    const alive = useRef(true);

    useEffect(() => {
        alive.current = true;
        setInfo(null);
        setLoadError(null);
        let req;
        try { req = chat.actions.mod('info', name); } catch (e) { req = Promise.reject(e); }
        Promise.resolve(req).then((r) => {
            if (!alive.current) return;
            if (r && r.ok) setInfo(r.info || {});
            else setLoadError((r && r.message) || 'Could not look this person up.');
        }, (e) => {
            if (alive.current) setLoadError((e && e.message) || 'Could not look this person up.');
        });
        return () => { alive.current = false; };
    }, [name, attempt]);

    const run = (action, opts) => {
        if (pending) return;
        setPending(action);
        setError(null);
        let req;
        try { req = chat.actions.mod(action, name, opts || {}); } catch (e) { req = Promise.reject(e); }
        Promise.resolve(req).then((r) => {
            if (!alive.current) return;
            setPending(null);
            if (r && r.ok) onClose();
            else setError((r && r.message) || 'That did not work. Please try again.');
        }, (e) => {
            if (!alive.current) return;
            setPending(null);
            setError((e && e.message) || 'That did not work. Please try again.');
        });
    };

    const user = chat.users.find((u) => lc(u.username) === lc(name));
    const relay = !!(info && info.relay) || String(name).startsWith('~');
    const inChat = info ? !!info.in_chat : !!user;
    const stateBan = modBanFor(chat.modState, name);
    const bannedUntil = (info && info.chat_banned_until) || (stateBan && stateBan.until) || null;
    const banned = !!(info && info.chat_banned_until) || !!stateBan;
    const banBy = (info && info.chat_ban_by) || (stateBan && stateBan.by) || '';
    const isMod = !!(info && info.moderator);
    const shared = info ? (Number(info.shared_ip_users) || 0) : 0;
    const record = info && info.record;
    const repeat = !!record && Number(record.chat_bans) >= 2;
    const count = info ? (Number(info.message_count) || 0) : null;
    const ready = !!info || !!loadError;
    const busy = !!pending;
    const chipText = (WARN_CHIPS.find((c) => c.id === chip) || {}).text || '';
    const reason = [chipText, note.trim()].filter(Boolean).join(' ');
    const sharedText = shared > 0
        ? `${shared === 1 ? '1 other chat user shares' : `${shared} other chat users share`} this IP — actions apply to them too.`
        : '';

    let body;
    if (!ready) {
        body = <p className="chat-mod__muted">Looking them up…</p>;
    } else if (loadError) {
        // Without the lookup we cannot tell a moderator or a relayed user from
        // anybody else, so nothing is offered that the server might act on
        // wrongly — only the reason, and a way to try again.
        body = (
            <>
                <div className="chat-mod__error" role="alert">{loadError}</div>
                <div className="chat-mod__row">
                    <Button size="sm" onClick={onClose}>Close</Button>
                    <Button size="sm" variant="primary" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
                </div>
            </>
        );
    } else if (confirmSdr) {
        body = (
            <div className="chat-mod__confirm">
                <h3 className="chat-mod__title">Ban {name} from SDR?</h3>
                <p className="chat-mod__text">
                    Permanent. Disconnects them from the whole receiver and deletes their
                    messages. You can undo this in Admin → Banned IPs.
                </p>
                <div className="chat-mod__row">
                    <Button size="sm" disabled={busy} onClick={() => { setConfirmSdr(false); setError(null); }}>
                        Cancel
                    </Button>
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => run('sdr_ban', { delete: true })}>
                        {pending === 'sdr_ban' ? 'Banning…' : 'Ban from SDR'}
                    </Button>
                </div>
            </div>
        );
    } else if (isMod) {
        body = (
            <p className="chat-mod__note">
                {name} is a moderator. Moderators can’t take action on each other.
            </p>
        );
    } else {
        body = (
            <>
                {relay ? (
                    <p className="chat-mod__note">
                        {name} writes from another chat that is relayed here, so they can’t be
                        warned or chat-banned from here. You can still delete their messages.
                    </p>
                ) : (
                    <section className="chat-mod__section">
                        <h3 className="chat-mod__label">Warn</h3>
                        <div className="chat-mod__chips">
                            {WARN_CHIPS.map((c) => (
                                <button
                                    key={c.id}
                                    type="button"
                                    className={`chat-mod__chip${chip === c.id ? ' is-on' : ''}`}
                                    aria-pressed={chip === c.id}
                                    title={c.text}
                                    onClick={() => setChip(chip === c.id ? null : c.id)}
                                >
                                    {c.label}
                                </button>
                            ))}
                        </div>
                        <input
                            className="input"
                            placeholder="Your own words (optional)"
                            maxLength={200}
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                        />
                        <div className="chat-mod__row">
                            <Button size="sm" variant="primary" disabled={busy} onClick={() => run('warn', reason ? { reason } : {})}>
                                {pending === 'warn' ? 'Sending…' : 'Send warning'}
                            </Button>
                        </div>
                    </section>
                )}

                <section className="chat-mod__section">
                    <div className="chat-mod__row chat-mod__row--start">
                        <Button size="sm" disabled={busy} icon={<Icon.Trash size={14} />} onClick={() => run('delete_user')}>
                            {pending === 'delete_user'
                                ? 'Deleting…'
                                : `Delete their messages${count === null ? '' : ` (${count})`}`}
                        </Button>
                    </div>
                </section>

                {!relay && (
                    <section className="chat-mod__section">
                        <h3 className="chat-mod__label">Chat ban</h3>
                        {banned ? (
                            <div className="chat-mod__banned">
                                <span>{banText(bannedUntil)}{byNote(banBy)}</span>
                                <Button size="sm" disabled={busy} onClick={() => run('lift')}>
                                    {pending === 'lift' ? 'Lifting…' : 'Lift'}
                                </Button>
                            </div>
                        ) : (
                            <>
                                <p className="chat-mod__muted">
                                    They can still listen and read chat, but can’t post or rejoin.
                                </p>
                                <div className="chat-mod__durations" role="group" aria-label="How long">
                                    {CHAT_BAN_PRESETS.map((d) => (
                                        <button
                                            key={d.sec}
                                            type="button"
                                            className={`chat-mod__chip${duration === d.sec ? ' is-on' : ''}`}
                                            aria-pressed={duration === d.sec}
                                            onClick={() => setDuration(d.sec)}
                                        >
                                            {d.label}
                                        </button>
                                    ))}
                                </div>
                                <label className="chat-mod__check">
                                    <input
                                        type="checkbox"
                                        checked={alsoDelete}
                                        onChange={(e) => setAlsoDelete(e.target.checked)}
                                    />
                                    <span>Also delete their messages</span>
                                </label>
                                <div className="chat-mod__row">
                                    <Button
                                        size="sm"
                                        variant="primary"
                                        disabled={busy}
                                        onClick={() => run('chat_ban', { duration_sec: duration, delete: alsoDelete })}
                                    >
                                        {pending === 'chat_ban' ? 'Banning…' : 'Chat ban'}
                                    </Button>
                                </div>
                            </>
                        )}
                    </section>
                )}

                {!relay && (
                    <section className="chat-mod__section chat-mod__section--danger">
                        <Button size="sm" variant="danger" disabled={busy} onClick={() => { setConfirmSdr(true); setError(null); }}>
                            Ban from SDR…
                        </Button>
                        <span className="chat-mod__muted">Permanent: blocks them from the whole receiver.</span>
                    </section>
                )}
            </>
        );
    }

    return (
        <Modal onClose={onClose} label={`Moderate ${name}`}>
            <div className="chat-mod">
                <div className="chat-mod__head">
                    <div className="chat-mod__name">
                        {user && user.country_code ? <span>{countryFlag(user.country_code)}</span> : null}
                        <b>{name}</b>
                        <span className={`chat-mod__status${inChat ? ' is-in' : ''}`}>{inChat ? 'In chat' : 'Left'}</span>
                    </div>
                    {info && info.ip ? <div className="chat-mod__ip">{info.ip}</div> : null}
                    {sharedText ? <div className="chat-mod__shared">{sharedText}</div> : null}
                    {record ? (
                        <div className="chat-mod__record">
                            <span>{recordLine(record)}</span>
                            {repeat ? <span className="chat-mod__tag">Repeat offender</span> : null}
                        </div>
                    ) : null}
                </div>
                {body}
                {error ? <div className="chat-mod__error" role="alert">{error}</div> : null}
            </div>
        </Modal>
    );
}

// A side dock is too narrow for it, and it says so rather than rendering badly there —
// see components/DockTooNarrow.jsx. A line of chat is a name, a time and a sentence, with
// the user list beside it; in 220 pixels every line wraps into three and the room becomes
// unreadable at exactly the moment it gets busy. The bottom dock and a floating window
// both have the width, and the signpost offers both.
//
// Nothing is disconnected by that: the chat connection belongs to ChatContext and feeds
// the unread badge on the tab whether this panel is drawn or not. What the signpost does
// prevent is messages being marked read — which is right, since they cannot be read there.
//
// `minimal` drops the user list and its drag grip, giving the whole panel to
// the conversation. The list is still loaded — @-completion matches against it,
// and the "N here" count is one expand away. See the registry's `minimal`.
export default function ChatPanel({ minimal }) {
    const chat = useChat();
    const { cramped, toBottom, floatIt } = useDockRoom('chat', FLOAT_WANT);
    const { actions: radio, running, tuning } = useRadio();
    const [draft, setDraft] = useState('');
    const [cursor, setCursor] = useState(0);
    const [sel, setSel] = useState(0);
    // The name to join with, and whether it is ours or merely offered.
    //
    // A saved name is used as it stands — that is somebody's choice, and the
    // chat rejoins with it without being asked. With nothing saved the box is
    // filled in rather than left empty: see lib/chatName.js.
    const [name, setName] = useState(() => chat.username
        || suggestUsername(chat.users.map((u) => u.username)));
    // True while `name` is the suggestion and not something the operator typed.
    // What it buys is the next few lines.
    const [suggested, setSuggested] = useState(() => !chat.username);
    const [nameError, setNameError] = useState(null);

    // The first thing typed replaces the suggestion instead of joining it.
    //
    // Otherwise a filled-in box is worse than an empty one: the caret sits at
    // the end of "user417", and somebody typing the name they actually wanted
    // gets "user417g4abc" — which is refused for length, or worse, is not, and
    // they join under it. Selecting the text on focus does most of this, but
    // only until a finger lands in the middle of the word and deselects it, so
    // the rule is enforced here rather than left to the caret.
    const onNameChange = (e) => {
        const next = e.target.value;
        setNameError(null);
        if (!suggested) { setName(next); return; }
        setSuggested(false);
        // What was added, wherever it was added. A shorter value means they
        // deleted from the suggestion instead, and what is left of it is not
        // worth keeping either.
        if (next.length > name.length && next.includes(name)) {
            setName(next.replace(name, ''));
            return;
        }
        setName(next.length < name.length ? '' : next);
    };
    const [emojiOpen, setEmojiOpen] = useState(false);
    // The leave button asking to be sure. See the note on it.
    const [leaving, setLeaving] = useState(false);
    const inputRef = useRef(null);
    const logRef = useRef(null);

    // Our own name is always included, even when the server's user list has not
    // caught up — a mention of us is the one that must never fail to highlight.
    const names = useMemo(
        () => [...new Set([...chat.users.map((u) => u.username), chat.username].filter(Boolean))],
        [chat.users, chat.username],
    );
    // Two completions share one list, as v1's does: @name, and :shortcode for
    // an emoji. A mention wins where both could match — "@" cannot appear
    // inside a shortcode, so in practice they never both fire.
    const before = draft.slice(0, cursor);
    const query = mentionQuery(before);
    const emoji = query ? null : emojiQuery(before);
    const suggestions = useMemo(() => {
        if (query) {
            return matchUsernames(names, query.partial, chat.username)
                .slice(0, 8)
                .map((name) => ({ kind: 'mention', value: name, label: `@${name}` }));
        }
        if (emoji) {
            return matchShortcodes(emoji.partial)
                .slice(0, 8)
                .map((code) => ({ kind: 'emoji', value: code, label: `:${code}:`, emoji: EMOJI_SHORTCODES[code] }));
        }
        return [];
    }, [query && query.partial, emoji && emoji.partial, names, chat.username]);

    // Reading the panel is what clears the alert.
    useEffect(() => {
        if (chat.unreadMentions > 0) chat.actions.markMentionsRead();
    }, [chat.messages.length]);

    // Stay pinned to the newest message unless the user scrolls away from it.
    //
    // Tracking "is the user at the bottom" from their own scrolling, rather
    // than inferring it per update, is what makes this reliable: the buffered
    // history can arrive as one message and then a batch of twenty more, and
    // any per-update "were we near the bottom before this render" test fails on
    // that second batch and strands you at the top.
    //
    // Layout effect, not effect: runs before paint, so the log never flashes at
    // the top first. Safe to scroll here, unlike other panels — the log owns its
    // scroller, so it cannot move the dock.
    const pinned = useRef(true);

    const onLogScroll = (e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    };

    useLayoutEffect(() => {
        const el = logRef.current;
        if (!el || !pinned.current) return;
        el.scrollTop = el.scrollHeight;
        // Rows can still be growing as fonts and wrapping settle, so land on the
        // bottom once more after the browser has finished laying out.
        const raf = requestAnimationFrame(() => {
            const cur = logRef.current;
            if (cur && pinned.current) cur.scrollTop = cur.scrollHeight;
        });
        return () => cancelAnimationFrame(raf);
    }, [chat.messages.length]);

    const complete = (item) => {
        const next = item.kind === 'emoji'
            ? applyEmojiCompletion(draft, cursor, item.value)
            : applyCompletion(draft, cursor, item.value);
        setDraft(next.text);
        setSel(0);
        // The cursor has to be placed after React writes the new value.
        requestAnimationFrame(() => {
            const el = inputRef.current;
            if (el) { el.focus(); el.setSelectionRange(next.cursor, next.cursor); }
            setCursor(next.cursor);
        });
    };

    const onKeyDown = (e) => {
        if (suggestions.length === 0) return;
        if (e.key === 'Tab' || (e.key === 'Enter' && suggestions.length > 0)) {
            e.preventDefault();
            complete(suggestions[Math.min(sel, suggestions.length - 1)]);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((n) => Math.min(n + 1, suggestions.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((n) => Math.max(n - 1, 0));
        } else if (e.key === 'Escape') {
            e.preventDefault();
            setSel(0);
            setCursor(-1);   // hides the list until the caret moves again
        }
    };

    // Moderation. `moderating` is the switch AND the server's word: the switch is
    // remembered, but a moderator whose login lapsed, or who left, sees the
    // ordinary panel the moment the server stops calling them one.
    const [modOn, setModOn] = useState(loadModerate);
    const moderating = !!chat.isModerator && modOn;
    const setModerate = (on) => { setModOn(on); saveModerate(on); };
    // The person whose actions are open, or null.
    const [modFor, setModFor] = useState(null);
    const [liftError, setLiftError] = useState(null);
    const [lifting, setLifting] = useState(null);
    // A sheet left open when moderating ends (Done, or the server withdrawing it)
    // must not spring back the next time it is switched on.
    useEffect(() => { if (!moderating) setModFor(null); }, [moderating]);
    const mobile = useMediaQuery(MOBILE_QUERY);
    const { where, floatIt: floatLarger } = useDockRoom('chat', MOD_FLOAT_WANT);
    // Is the panel narrow enough to offer the larger window? Measured only while
    // moderating, since that is the only thing that asks.
    const rootRef = useRef(null);
    const [narrow, setNarrow] = useState(false);
    useEffect(() => {
        const el = rootRef.current;
        if (!moderating || !el || typeof ResizeObserver === 'undefined') return undefined;
        const measure = () => setNarrow(el.getBoundingClientRect().width < MOD_NARROW_PX);
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [moderating, cramped, chat.enabled, running]);

    if (!chat.enabled) {
        return <Empty>Chat is not enabled on this receiver.</Empty>;
    }
    if (!running) {
        return <Empty>Start the receiver to join chat.</Empty>;
    }

    const submitName = (e) => {
        e.preventDefault();
        const err = validateUsername(name);
        setNameError(err);
        if (!err) {
            setSuggested(false);
            chat.actions.join(name.trim());
        }
    };

    // Inserts at the caret and keeps focus, so several emoji (or an emoji and a
    // frequency) can be added without the caret jumping to the end each time.
    const insert = (text) => {
        const el = inputRef.current;
        const at = el ? el.selectionStart : draft.length;
        const to = el ? el.selectionEnd : draft.length;
        const next = draft.slice(0, at) + text + draft.slice(to);
        setDraft(next);
        const pos = at + text.length;
        setCursor(pos);
        requestAnimationFrame(() => {
            if (!el) return;
            el.focus();
            el.setSelectionRange(pos, pos);
        });
    };

    const submitMessage = (e) => {
        e.preventDefault();
        // Anything typed in full and never completed is expanded here, so
        // ":fire:" works whether or not the suggestion list was used — v1 does
        // the same on the way out.
        if (chat.actions.send(expandShortcodes(draft))) {
            setDraft('');
            // Sending is asking to see what you sent. Without this, having
            // scrolled up to read something leaves your own message off the
            // bottom of the log with no sign it went anywhere.
            pinned.current = true;
            // Back in the box, ready for the next one.
            //
            // On a keyboard this was already true and needed nothing: Enter
            // submits the form and focus never leaves the input it was pressed
            // in. A phone submits by tapping Send, and tapping a button moves
            // focus to the button — so the on-screen keyboard slid away after
            // every message and the next one began with a tap to bring it back.
            //
            // Synchronous, and that is the whole trick: this runs inside the
            // gesture that sent the message, which is the only time a browser
            // will open the on-screen keyboard for a focus() it did not ask for.
            // A frame later — in a requestAnimationFrame, or after an await —
            // the gesture is over, the input takes focus and the keyboard stays
            // shut, which is the more confusing half of the original fault.
            const el = inputRef.current;
            if (el && !el.disabled) el.focus();
        }
    };

    // Clicking a frequency someone shared tunes there, as v1 does.
    //
    // One tuneTo rather than setMode then setFrequency. The two-call version
    // walked the receiver through an intermediate state — setMode resets the
    // passband, so the *old* frequency was briefly commanded in the new mode —
    // and it is two commands where the server rate-limits by command. tuneTo
    // sends the pair as one, applies the new mode's default passband exactly as
    // setMode would, and gates IQ once rather than twice. See the note on
    // RadioContext's tuneTo, which exists for this.
    const tuneTo = ({ hz, mode }) => {
        radio.tuneTo({ frequency: hz, mode });
        radio.ensureVisible(hz);
    };

    // Sent straight away rather than dropped into the box: sharing where you
    // are is one action, and anything already half-typed is left alone.
    const shareFrequency = () => {
        chat.actions.send(freqMessage(tuning.frequency, tuning.mode));
        pinned.current = true;
    };

    // Lift from the "Chat-banned" list, without opening the sheet.
    const liftBan = (who) => {
        if (lifting) return;
        setLifting(who);
        setLiftError(null);
        Promise.resolve(chat.actions.mod('lift', who)).then((r) => {
            setLifting(null);
            if (!r || !r.ok) setLiftError((r && r.message) || `Could not lift ${who}.`);
        }, (e) => {
            setLifting(null);
            setLiftError((e && e.message) || `Could not lift ${who}.`);
        });
    };
    const modBans = moderating ? chat.modState.bans.filter((b) => b && b.username) : [];
    // A name on a message line is a way into the sheet while moderating — not our
    // own, nor another moderator's (the server marks them in the user list), both
    // of which the server would refuse.
    const isModUser = (who) => chat.users.some((u) => u && lc(u.username) === lc(who)
        && (u.moderator || u.is_moderator));
    const canModerate = (who) => moderating && !!who && lc(who) !== lc(chat.username) && !isModUser(who);

    if (cramped) {
        return (
            <DockTooNarrow
                note="A chat line is a name, a time and a sentence — too much for a side dock."
                onBottom={toBottom}
                onFloat={floatIt}
            />
        );
    }

    return (
        <div className="chat" ref={rootRef}>
            <div className="chat__stream">
                {moderating && (
                    <div className="chat__modbar">
                        <Icon.Shield size={14} />
                        <span className="chat__modbar-text">Moderating — pick a name for actions</span>
                        {narrow && !mobile && where !== 'float' && (
                            <button type="button" className="chat__unfollow" onClick={floatLarger}>
                                Float larger
                            </button>
                        )}
                        <button type="button" className="chat__unfollow" onClick={() => setModerate(false)}>
                            Done
                        </button>
                    </div>
                )}
                <div className="chat__log" ref={logRef} onScroll={onLogScroll}>
                    {chat.messages.length === 0 && <Empty>No messages yet.</Empty>}
                    {chat.messages.map((m) => (
                        m.notice ? (
                            // Something said to us alone — a warning, a chat ban, or
                            // the record of a moderator's own action. Its own row,
                            // full width, not dressed as a "<name> joined" line.
                            <div
                                key={m.id}
                                className={`chat__row chat__notice${m.highlight ? ' is-warn' : ''}`}
                                role={m.highlight ? 'alert' : undefined}
                            >
                                <span className="chat__time">{time(m.timestamp)}</span>
                                <span className="chat__notice-text">{m.message}</span>
                            </div>
                        ) : m.system ? (
                            <div key={m.id} className="chat__row chat__row--system">
                                <span className="chat__time">{time(m.timestamp)}</span>
                                <span className="chat__sys">
                                    {m.username} {m.message}
                                    {m.country ? ` · ${m.country}` : ''}
                                </span>
                            </div>
                        ) : (
                            <div key={m.id} className={`chat__row${m.username === chat.username ? ' is-me' : ''}${m.mention ? ' is-mention' : ''}`}>
                                <span className="chat__time">{time(m.timestamp)}</span>
                                {canModerate(m.username) ? (
                                    <button
                                        type="button"
                                        className="chat__who chat__who--mod"
                                        title={`Moderate ${m.username}`}
                                        onClick={() => setModFor(m.username)}
                                    >
                                        <ModBadge modState={chat.modState} name={m.username} />
                                        {m.username}
                                    </button>
                                ) : (
                                    <span className="chat__who">{m.username}</span>
                                )}
                                <span className="chat__text">
                                    {splitMessage(m.message, names).map((part, i) => {
                                        if (part.mention) {
                                            const me = part.mention.toLowerCase() === (chat.username || '').toLowerCase();
                                            return <mark key={i} className={`chat__at${me ? ' is-me' : ''}`}>{part.text}</mark>;
                                        }
                                        if (part.url) {
                                            return (
                                                <a
                                                    key={i}
                                                    className="chat__link"
                                                    href={part.url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                >
                                                    {part.text}
                                                </a>
                                            );
                                        }
                                        if (part.freq) {
                                            return (
                                                <button
                                                    key={i}
                                                    type="button"
                                                    className="chat__link chat__link--freq"
                                                    title={`Tune to ${part.text}`}
                                                    onClick={() => tuneTo(part.freq)}
                                                >
                                                    {part.text}
                                                </button>
                                            );
                                        }
                                        return <React.Fragment key={i}>{part.text}</React.Fragment>;
                                    })}
                                </span>
                            </div>
                        )
                    ))}
                </div>

                {chat.error && (
                    <div className="chat__error" onClick={chat.actions.clearError}>
                        {chat.error}
                    </div>
                )}

                {chat.chatBan ? (
                    // Banned from chat: no box to type in, and the reason in its
                    // place, at the same height so the log does not jump.
                    <div className="chat__banned" role="status">
                        {`${banText(chat.chatBan.until)}. You can still listen.`}
                    </div>
                ) : !chat.joined ? (
                    <form className="chat__join" onSubmit={submitName}>
                        <input
                            className="input"
                            placeholder="Choose a name to chat…"
                            maxLength={USERNAME_MAX}
                            value={name}
                            // Selected on focus while it is only a suggestion,
                            // so on a desktop the first keystroke replaces it
                            // the way any pre-filled field does.
                            onFocus={(e) => { if (suggested) e.target.select(); }}
                            onChange={onNameChange}
                        />
                        <Button type="submit" variant="primary" size="sm">Join</Button>
                    </form>
                ) : (
                    <form className="chat__compose" onSubmit={submitMessage}>
                        {suggestions.length > 0 && (
                            <div className="chat__suggest">
                                {suggestions.map((item, i) => (
                                    <button
                                        type="button"
                                        key={item.label}
                                        className={`chat__suggest-item${i === sel ? ' is-active' : ''}`}
                                        onMouseDown={(e) => { e.preventDefault(); complete(item); }}
                                    >
                                        {item.emoji && <span className="chat__suggest-emoji">{item.emoji}</span>}
                                        {item.label}
                                    </button>
                                ))}
                            </div>
                        )}
                        <input
                            ref={inputRef}
                            /* Where this dock hands the keyboard back to when it reopens. */
                            data-dock-focus=""
                            className="input"
                            placeholder={chat.connected ? `Message as ${chat.username}… (@name, :emoji)` : 'Reconnecting…'}
                            disabled={!chat.connected}
                            value={draft}
                            onChange={(e) => { setDraft(e.target.value); setCursor(e.target.selectionStart); }}
                            onKeyUp={(e) => setCursor(e.target.selectionStart)}
                            onClick={(e) => setCursor(e.target.selectionStart)}
                            onBlur={() => setSel(0)}
                            onKeyDown={onKeyDown}
                        />
                        <div className="chat__tools">
                            <button
                                type="button"
                                className="chat__tool chat__tool--icon"
                                title={`Send ${formatFreqShort(tuning.frequency)} ${String(tuning.mode).toUpperCase()} to the room`}
                                disabled={!chat.connected}
                                onClick={shareFrequency}
                            >
                                <Icon.Radio size={15} />
                            </button>
                            {chat.isModerator && (
                                <button
                                    type="button"
                                    className={`chat__tool chat__tool--icon${moderating ? ' is-open' : ''}`}
                                    title={moderating ? 'Stop moderating' : 'Moderate chat'}
                                    aria-pressed={moderating}
                                    onClick={() => setModerate(!modOn)}
                                >
                                    <Icon.Shield size={15} />
                                </button>
                            )}
                            <button
                                type="button"
                                className={`chat__tool${emojiOpen ? ' is-open' : ''}`}
                                title="Insert emoji"
                                onClick={() => setEmojiOpen((o) => !o)}
                            >
                                😊
                            </button>
                            {emojiOpen && (
                                <div className="chat__emoji">
                                    {EMOJI.map((e2) => {
                                        // v1 titles each one with its shortcode,
                                        // which is how anyone finds out the
                                        // shortcodes exist at all.
                                        const code = shortcodeFor(e2);
                                        return (
                                            <button
                                                type="button"
                                                key={e2}
                                                className="chat__emoji-item"
                                                title={code ? `:${code}:` : undefined}
                                                onMouseDown={(ev) => { ev.preventDefault(); insert(e2); }}
                                            >
                                                {e2}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                        <Button type="submit" variant="primary" size="sm" disabled={!chat.connected}>Send</Button>
                        {/* Asks first, unlike everything else in this row.
                            Leaving is the one press here that cannot be taken
                            back cheaply — it announces a departure to the
                            channel, forgets the name, and ends any follow — and
                            it sits one slip to the right of Send, the most
                            pressed button in the panel, on exactly the screens
                            where slips happen. A modal, not window.confirm: the
                            browser's own dialog blurs the input and takes the
                            keyboard down with it, so cancelling would still have
                            cost what it exists to protect. */}
                        <Button
                            variant="ghost"
                            size="sm"
                            icon={<Icon.Close />}
                            title="Leave chat"
                            onClick={() => setLeaving(true)}
                        />
                    </form>
                )}
                {nameError && <div className="chat__hint">{nameError}</div>}

                {moderating && modFor && (
                    <ModSheet key={modFor} name={modFor} onClose={() => setModFor(null)} />
                )}

                {leaving && (
                    <Modal onClose={() => setLeaving(false)} label="Leave chat?">
                        <div className="confirm">
                            <h2 className="confirm__title">Leave chat?</h2>
                            <p className="confirm__text">
                                Your name is forgotten and the channel is told you left —
                                coming back means joining again.
                            </p>
                            <div className="confirm__row">
                                {/* Stay first and primary: the likeliest reason
                                    this is open is a slip aimed at Send, and the
                                    default-looking button should be the undo. */}
                                <Button variant="primary" onClick={() => setLeaving(false)}>Stay</Button>
                                <Button
                                    variant="danger"
                                    onClick={() => { setLeaving(false); chat.actions.leave(); }}
                                >
                                    Leave chat
                                </Button>
                            </div>
                        </div>
                    </Modal>
                )}
            </div>

            {!minimal && (
                <div className="chat__users">
                    <div className="section-label"><span>{chat.users.length} here</span></div>
                    {chat.users.length === 0 && <Empty>Nobody yet.</Empty>}

                    {/* Who is driving the dial, and the way out of it. On its own line above
                        the list rather than only as a lit button in it: the receiver is being
                        tuned by somebody else, which is worth stating in words. */}
                    {chat.following && (
                        <div className="chat__following">
                            <span>
                                Following <b>{chat.following}</b> — their dial moves yours
                            </span>
                            <button
                                type="button"
                                className="chat__unfollow"
                                onClick={chat.actions.unfollow}
                            >
                                Stop
                            </button>
                        </div>
                    )}

                    {/* Their spectrum view as well as their tuning, off by default: the view is
                        your own window on the band, and somebody zoomed into 200 Hz of a CW
                        signal would take away your sight of everything else. Only worth
                        offering while following somebody. */}
                    {chat.following && (
                        <label className="chat__zoomsync">
                            <input
                                type="checkbox"
                                checked={chat.followZoom}
                                onChange={(e) => chat.actions.setFollowZoom(e.target.checked)}
                            />
                            <span>Match their zoom</span>
                        </label>
                    )}

                    {/* Followed first, then alphabetical — v1's order. The server's own order
                        changes as people come and go, which moves the row you are aiming at. */}
                    {sortFollowFirst(chat.users, chat.following).map((u) => (
                        <div
                            key={u.username}
                            className={`chat__user-row${u.username === chat.following ? ' is-following' : ''}`
                                + `${isIgnored(u.username) ? ' is-ignored' : ''}`}
                            // On the row rather than on the button inside it: the button
                            // is disabled for anybody whose client has published no
                            // frequency, and a disabled control takes no pointer events,
                            // so a tooltip on it is one those users would never show. The
                            // follow and ignore buttons carry their own, which win over
                            // this one while the pointer is on them.
                            title={userTip(u, chat.username)}
                        >
                            <button
                                type="button"
                                className={`chat__user${u.is_idle ? ' is-idle' : ''}`}
                                // Their frequency is published over chat, so it
                                // doubles as a way to go and listen to what they
                                // are hearing.
                                disabled={!u.frequency}
                                onClick={() => {
                                    if (!u.frequency) return;
                                    // As one tune, for the reason given on tuneTo
                                    // above. The mode is optional here — a client
                                    // that has published a frequency and no mode
                                    // is tuned in whatever we are already in,
                                    // which is what tuneTo does with a mode it
                                    // does not recognise.
                                    radio.tuneTo({ frequency: u.frequency, mode: u.mode });
                                    radio.setSpectrumCenter(u.frequency);
                                }}
                            >
                                <span className="chat__user-name">
                                    {moderating && <ModBadge modState={chat.modState} name={u.username} />}
                                    {countryFlag(u.country_code)} {u.username}
                                    {u.tx && <span className="chip">TX</span>}
                                </span>
                                {/* The dial and nothing else. The bin width and how long
                                    they have been quiet are real information and neither
                                    is worth a row two lines deep in a dock column — they
                                    are in the tooltip, which is where a detail that is
                                    only occasionally wanted belongs. See userTip. */}
                                <span className="chat__user-meta">
                                    {u.frequency ? formatFreqShort(u.frequency) : '—'}
                                    {u.mode ? ` ${u.mode.toUpperCase()}` : ''}
                                </span>
                            </button>
                            {/* Not on our own row — we are already where we are — and not on
                                somebody whose client has published no frequency and mode, whom
                                there is nothing to follow. */}
                            {/* Moderating: one shield in place of Follow and Ignore, so the
                                column keeps its width. Not on our own row, nor on another
                                moderator's when the server marks them. */}
                            {moderating && u.username !== chat.username && !u.moderator && !u.is_moderator && (
                                <button
                                    type="button"
                                    className="chat__modbtn"
                                    title={`Moderate ${u.username}`}
                                    onClick={() => setModFor(u.username)}
                                >
                                    <Icon.Shield size={12} />
                                </button>
                            )}
                            {!moderating && followable(u, chat.username) && (
                                <button
                                    type="button"
                                    className={`chat__follow${u.username === chat.following ? ' is-on' : ''}`}
                                    title={u.username === chat.following
                                        ? `Stop following ${u.username}`
                                        : `Follow ${u.username} — your dial tracks theirs`}
                                    aria-pressed={u.username === chat.following}
                                    onClick={() => chat.actions.follow(u.username)}
                                >
                                    {u.username === chat.following ? <Icon.Tick size={12} /> : <Icon.Link size={12} />}
                                </button>
                            )}
                            {/* Not on our own row: ignoring yourself is not a thing
                                anybody means to do, and the press would hide half the
                                conversation with no obvious way back. */}
                            {!moderating && u.username !== chat.username && (
                                <button
                                    type="button"
                                    className={`chat__ignore${isIgnored(u.username) ? ' is-on' : ''}`}
                                    title={isIgnored(u.username)
                                        ? `Stop ignoring ${u.username}`
                                        : `Ignore ${u.username} — hide what they say, here only`}
                                    aria-pressed={isIgnored(u.username)}
                                    onClick={() => {
                                        // Following somebody you have just decided not to
                                        // read is a contradiction, and leaving their dial
                                        // driving yours would be the surprising half of it.
                                        if (!isIgnored(u.username) && chat.following === u.username) {
                                            chat.actions.follow(u.username);
                                        }
                                        toggleIgnored(u.username);
                                    }}
                                >
                                    {isIgnored(u.username) ? <Icon.EyeOff size={12} /> : <Icon.Eye size={12} />}
                                </button>
                            )}
                        </div>
                    ))}

                    {/* The ones who are not here to be pressed.

                        Without this, ignoring somebody who then leaves the channel is a
                        decision with no way back — the row they would be un-ignored from
                        is gone, and the only remaining route is the browser's storage.
                        Only the absent ones, because the rest have their own button
                        above. */}
                    {absentIgnored(chat.ignored, chat.users).length > 0 && (
                        <div className="chat__ignored">
                            <span className="chat__ignored-label">Ignored, not here</span>
                            {absentIgnored(chat.ignored, chat.users).map((name) => (
                                <button
                                    key={name}
                                    type="button"
                                    className="chip chip--button"
                                    title={`Stop ignoring ${name}`}
                                    onClick={() => setIgnored(name, false)}
                                >
                                    {name}
                                    <Icon.Close size={10} />
                                </button>
                            ))}
                        </div>
                    )}

                    {/* Chat-banned, whether here or not — the way back for
                        somebody whose row is gone. */}
                    {modBans.length > 0 && (
                        <div className="chat__ignored chat__removed">
                            <span className="chat__ignored-label">{`Chat-banned (${modBans.length})`}</span>
                            {modBans.map((b) => (
                                <div key={`${b.username}|${b.ip || ''}`} className="chat__removed-row">
                                    <button
                                        type="button"
                                        className="chat__removed-name"
                                        title={b.until ? banText(b.until) : 'Banned from chat'}
                                        onClick={() => setModFor(b.username)}
                                    >
                                        {b.username}
                                    </button>
                                    <button
                                        type="button"
                                        className="chat__unfollow"
                                        disabled={!!lifting}
                                        onClick={() => liftBan(b.username)}
                                    >
                                        {lifting === b.username ? 'Lifting…' : 'Lift'}
                                    </button>
                                </div>
                            ))}
                            {liftError && <span className="chat__hint">{liftError}</span>}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// Unread mentions, shown on the panel header so an alert is visible even when
// the chat body is scrolled out of view in a dock.
export function ChatBadge() {
    const chat = useChat();
    if (!chat.enabled || chat.unreadMentions === 0) return null;
    return <span className="badge badge--closed">{chat.unreadMentions}</span>;
}
