import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from '../react.js';
import { useChat } from '../chat/ChatContext.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { Button, Empty, Icon } from '../components/ui.jsx';
import { USERNAME_MAX, validateUsername } from '../radio/chat-connection.js';
import { formatFreqShort } from '../lib/format.js';
import { applyCompletion, matchUsernames, mentionQuery, splitMentions } from '../lib/mentions.js';
import { clamp } from '../lib/format.js';

// The user list can be dragged narrower or wider. Bounds keep both halves
// usable however the panel is sized.
const USERS_MIN = 90;
const STREAM_MIN = 180;

function time(ts) {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function flag(code) {
    if (!code || code.length !== 2) return '';
    // Regional indicator letters: 'GB' -> 🇬🇧
    return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export default function ChatPanel() {
    const chat = useChat();
    const { actions: radio, running } = useRadio();
    const [draft, setDraft] = useState('');
    const [cursor, setCursor] = useState(0);
    const [sel, setSel] = useState(0);
    const [name, setName] = useState(chat.username);
    const [nameError, setNameError] = useState(null);
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
    const query = mentionQuery(draft.slice(0, cursor));
    const suggestions = useMemo(
        () => (query ? matchUsernames(names, query.partial, chat.username).slice(0, 8) : []),
        [query && query.partial, names, chat.username],
    );

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

    const complete = (username) => {
        const next = applyCompletion(draft, cursor, username);
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
        if (e.key === 'Tab' || (e.key === 'Enter' && suggestions.length > 0 && query)) {
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

    const submitMessage = (e) => {
        e.preventDefault();
        if (chat.actions.send(draft)) setDraft('');
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
                                    {splitMentions(m.message, names).map((part, i) => (
                                        part.mention
                                            ? <mark key={i} className={`chat__at${part.mention.toLowerCase() === (chat.username || '').toLowerCase() ? ' is-me' : ''}`}>{part.text}</mark>
                                            : <React.Fragment key={i}>{part.text}</React.Fragment>
                                    ))}
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
                                {suggestions.map((name, i) => (
                                    <button
                                        type="button"
                                        key={name}
                                        className={`chat__suggest-item${i === sel ? ' is-active' : ''}`}
                                        onMouseDown={(e) => { e.preventDefault(); complete(name); }}
                                    >
                                        @{name}
                                    </button>
                                ))}
                            </div>
                        )}
                        <input
                            ref={inputRef}
                            className="input"
                            placeholder={chat.connected ? `Message as ${chat.username}… (@ to mention)` : 'Reconnecting…'}
                            disabled={!chat.connected}
                            value={draft}
                            onChange={(e) => { setDraft(e.target.value); setCursor(e.target.selectionStart); }}
                            onKeyUp={(e) => setCursor(e.target.selectionStart)}
                            onClick={(e) => setCursor(e.target.selectionStart)}
                            onBlur={() => setSel(0)}
                            onKeyDown={onKeyDown}
                        />
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

            <div
                className="chat__grip"
                title="Drag to resize the user list"
                onPointerDown={onGripDown}
                onPointerMove={onGripMove}
                onPointerUp={onGripUp}
                onPointerCancel={onGripUp}
                onDoubleClick={() => { setUsersWidth(170); display.set({ chatUsersWidth: 170 }); }}
            />

            <div className="chat__users" style={{ flexBasis: usersWidth }}>
                <div className="section-label"><span>{chat.users.length} here</span></div>
                {chat.users.length === 0 && <Empty>Nobody yet.</Empty>}
                {chat.users.map((u) => (
                    <button
                        key={u.username}
                        type="button"
                        className={`chat__user${u.is_idle ? ' is-idle' : ''}`}
                        // Their frequency is published over chat, so it doubles
                        // as a way to go and listen to what they are hearing.
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
                            {flag(u.country_code)} {u.username}
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
