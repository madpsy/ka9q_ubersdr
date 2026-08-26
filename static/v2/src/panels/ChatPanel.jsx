import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from '../react.js';
import { useChat } from '../chat/ChatContext.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Empty, Icon, Modal } from '../components/ui.jsx';
import DockTooNarrow, { useDockRoom } from '../components/DockTooNarrow.jsx';
import { USERNAME_MAX, validateUsername } from '../radio/dxcluster-connection.js';
import { suggestUsername } from '../lib/chatName.js';
import { countryFlag, formatFreqShort } from '../lib/format.js';
import { followable, sortFollowFirst } from '../lib/chatFollow.js';
import { absentIgnored, isIgnored, setIgnored, toggleIgnored } from '../lib/chatIgnore.js';
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
        <div className="chat">
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
                            {followable(u, chat.username) && (
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
                            {u.username !== chat.username && (
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
