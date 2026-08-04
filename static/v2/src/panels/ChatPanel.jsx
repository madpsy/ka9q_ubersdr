import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from '../react.js';
import { useChat } from '../chat/ChatContext.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { Button, Empty, Icon } from '../components/ui.jsx';
import { USERNAME_MAX, validateUsername } from '../radio/dxcluster-connection.js';
import { countryFlag, formatFreqShort } from '../lib/format.js';
import {
    EMOJI_SHORTCODES, applyCompletion, applyEmojiCompletion, emojiQuery, expandShortcodes,
    matchShortcodes, matchUsernames, mentionQuery, shortcodeFor, splitMessage,
} from '../lib/mentions.js';
import { clamp } from '../lib/format.js';

// The user list can be dragged narrower or wider. Bounds keep both halves
// usable however the panel is sized.
const USERS_MIN = 90;
const STREAM_MIN = 180;

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

// v1's wording exactly: "5242.252 KHz (USB)", so a frequency shared from either
// frontend reads the same in the room.
function freqMessage(frequency, mode) {
    return `${(frequency / 1000).toFixed(3)} KHz (${String(mode).toUpperCase()})`;
}

// `minimal` drops the user list and its drag grip, giving the whole panel to
// the conversation. The list is still loaded — @-completion matches against it,
// and the "N here" count is one expand away. See the registry's `minimal`.
export default function ChatPanel({ minimal }) {
    const chat = useChat();
    const { actions: radio, running, tuning } = useRadio();
    const [draft, setDraft] = useState('');
    const [cursor, setCursor] = useState(0);
    const [sel, setSel] = useState(0);
    const [name, setName] = useState(chat.username);
    const [nameError, setNameError] = useState(null);
    const [emojiOpen, setEmojiOpen] = useState(false);
    const inputRef = useRef(null);
    const logRef = useRef(null);
    const rootRef = useRef(null);
    const drag = useRef(null);

    // Width of the user list. Held locally while dragging and written to the
    // display settings on release, so a drag is one persisted value rather than
    // one per pointer event.
    const display = useDisplay();
    const [usersWidth, setUsersWidth] = useState(display.chatUsersWidth ?? 170);
    useEffect(() => {
        if (!drag.current) setUsersWidth(display.chatUsersWidth ?? 170);
    }, [display.chatUsersWidth]);

    const onGripDown = (e) => {
        e.preventDefault();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        drag.current = { x: e.clientX, w: usersWidth };
    };
    const onGripMove = (e) => {
        const d = drag.current;
        if (!d) return;
        const total = rootRef.current ? rootRef.current.getBoundingClientRect().width : 600;
        // Dragging left widens the list, so the delta is inverted.
        setUsersWidth(clamp(d.w - (e.clientX - d.x), USERS_MIN, Math.max(USERS_MIN, total - STREAM_MIN)));
    };
    const onGripUp = (e) => {
        if (!drag.current) return;
        drag.current = null;
        try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        display.set({ chatUsersWidth: Math.round(usersWidth) });
    };

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
        if (!err) chat.actions.join(name.trim());
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
        if (chat.actions.send(expandShortcodes(draft))) setDraft('');
    };

    // Clicking a frequency someone shared tunes there, as v1 does. setMode
    // applies that mode's default passband, which is what v1 does by hand.
    const tuneTo = ({ hz, mode }) => {
        radio.setMode(mode);
        radio.setFrequency(hz);
        radio.ensureVisible(hz);
    };

    // Sent straight away rather than dropped into the box: sharing where you
    // are is one action, and anything already half-typed is left alone.
    const shareFrequency = () => {
        chat.actions.send(freqMessage(tuning.frequency, tuning.mode));
    };

    return (
        <div className="chat" ref={rootRef}>
            <div className="chat__stream">
                <div className="chat__log" ref={logRef} onScroll={onLogScroll}>
                    {chat.messages.length === 0 && <Empty>No messages yet.</Empty>}
                    {chat.messages.map((m) => (
                        m.system ? (
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
                                <span className="chat__who">{m.username}</span>
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

                {!chat.joined ? (
                    <form className="chat__join" onSubmit={submitName}>
                        <input
                            className="input"
                            placeholder="Choose a name to chat…"
                            maxLength={USERNAME_MAX}
                            value={name}
                            onChange={(e) => { setName(e.target.value); setNameError(null); }}
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
                        <Button
                            variant="ghost"
                            size="sm"
                            icon={<Icon.Close />}
                            title="Leave chat"
                            onClick={chat.actions.leave}
                        />
                    </form>
                )}
                {nameError && <div className="chat__hint">{nameError}</div>}
            </div>

            {/* The grip goes with the list — a splitter with nothing on its far
                side is a handle that resizes nothing. */}
            {!minimal && (
                <div
                    className="chat__grip"
                    title="Drag to resize the user list"
                    onPointerDown={onGripDown}
                    onPointerMove={onGripMove}
                    onPointerUp={onGripUp}
                    onPointerCancel={onGripUp}
                    onDoubleClick={() => { setUsersWidth(170); display.set({ chatUsersWidth: 170 }); }}
                />
            )}

            {!minimal && (
                <div className="chat__users" style={{ flexBasis: usersWidth }}>
                    <div className="section-label"><span>{chat.users.length} here</span></div>
                    {chat.users.length === 0 && <Empty>Nobody yet.</Empty>}
                    {chat.users.map((u) => (
                        <button
                            key={u.username}
                            type="button"
                            className={`chat__user${u.is_idle ? ' is-idle' : ''}`}
                            // Their frequency is published over chat, so it
                            // doubles as a way to go and listen to what they
                            // are hearing.
                            disabled={!u.frequency}
                            title={u.frequency ? `Tune to ${formatFreqShort(u.frequency)}` : u.username}
                            onClick={() => {
                                if (!u.frequency) return;
                                if (u.mode) radio.setMode(u.mode);
                                radio.setFrequency(u.frequency);
                                radio.setSpectrumCenter(u.frequency);
                            }}
                        >
                            <span className="chat__user-name">
                                {countryFlag(u.country_code)} {u.username}
                                {u.tx && <span className="chip">TX</span>}
                            </span>
                            <span className="chat__user-meta">
                                {u.frequency ? formatFreqShort(u.frequency) : '—'}
                                {u.mode ? ` ${u.mode.toUpperCase()}` : ''}
                                {u.is_idle && u.idle_minutes ? ` · idle ${u.idle_minutes}m` : ''}
                            </span>
                        </button>
                    ))}
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
