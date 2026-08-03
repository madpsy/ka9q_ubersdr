// Chat state, kept out of RadioContext so a busy channel never re-renders the
// receiver. Only the chat panel subscribes to this.

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from '../react.js';
import { dxcluster, validateUsername } from '../radio/dxcluster-connection.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useLayout } from '../layout/LayoutContext.jsx';
import { throttle } from '../lib/throttle.js';
import { isMention } from '../lib/mentions.js';

const ChatContext = createContext(null);

const NAME_KEY = 'ubersdr.v2.chatName';
const MAX_MESSAGES = 300;

// Two short notes. Deliberately synthesised rather than shipped as an asset:
// one small file to fetch, and it cannot 404 on a server that has not copied it.
function playMentionChime() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = playMentionChime.ctx || (playMentionChime.ctx = new Ctx());
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const now = ctx.currentTime;
        [880, 1320].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.0001, now + i * 0.12);
            gain.gain.exponentialRampToValueAtTime(0.15, now + i * 0.12 + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.11);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now + i * 0.12);
            osc.stop(now + i * 0.12 + 0.12);
        });
    } catch (e) { /* audio is a nicety, never a failure */ }
}

export function ChatProvider({ children }) {
    const { serverInfo, tuning, running } = useRadio();
    const { sections } = useLayout();
    const enabled = !!(serverInfo && serverInfo.chat_enabled);
    // Hiding the panel should also drop the socket — otherwise everyone carries
    // a third connection and the whole channel's traffic for a panel they are
    // not looking at.
    const wanted = enabled && !(sections.chat && sections.chat.hidden);

    // The shared `/ws/dxcluster` socket — chat is one stream on it, alongside
    // the spot feeds. See radio/dxcluster-connection.js.
    const chat = dxcluster;

    const [state, setState] = useState('idle');
    const [messages, setMessages] = useState([]);
    const [users, setUsers] = useState([]);
    const [error, setError] = useState(null);
    const [username, setUsername] = useState(() => {
        try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
    });
    const [joined, setJoined] = useState(false);
    const [unreadMentions, setUnreadMentions] = useState(0);
    const [chimeOn, setChimeOn] = useState(() => {
        try { return localStorage.getItem('ubersdr.v2.chatChime') !== 'off'; } catch (e) { return true; }
    });
    // Read inside the message handler, which must not resubscribe per keystroke.
    const nameRef = useRef(username);
    nameRef.current = username;
    const chimeRef = useRef(chimeOn);
    chimeRef.current = chimeOn;
    const joinedRef = useRef(joined);
    joinedRef.current = joined;
    // Bounds the automatic re-join so a name the server will never accept
    // (now restricted, or newly caught by the profanity filter) cannot turn
    // into an error loop.
    const autoJoins = useRef(0);

    useEffect(() => {
        const offs = [];
        offs.push(chat.on('state', setState));
        offs.push(chat.on('message', (m) => {
            const mine = m.username === nameRef.current;
            const mentioned = !mine && isMention(m.message, nameRef.current);
            setMessages((prev) => {
                const next = prev.concat({
                    ...m, mention: mentioned, id: `${m.timestamp}-${m.username}-${prev.length}`,
                });
                return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
            });
            if (mentioned) {
                setUnreadMentions((n) => n + 1);
                if (chimeRef.current) playMentionChime();
            }
        }));
        offs.push(chat.on('presence', (p) => {
            setMessages((prev) => prev.concat({
                id: `${p.timestamp}-${p.kind}-${p.username}-${prev.length}`,
                system: true,
                username: p.username,
                message: p.kind === 'joined' ? 'joined' : 'left',
                country: p.country,
                timestamp: p.timestamp,
            }).slice(-MAX_MESSAGES));
            // The list is authoritative only from the server, so ask rather
            // than trying to patch it locally.
            chat.requestUsers();
        }));
        offs.push(chat.on('users', ({ users: list }) => setUsers(list)));
        offs.push(chat.on('userUpdate', () => chat.requestUsers()));
        offs.push(chat.on('idle', () => chat.requestUsers()));
        offs.push(chat.on('error', (e) => {
            const message = e.message || 'chat error';
            setError(message);
            // The server forgets our identity when its session goes (a restart,
            // or a socket it had already dropped). Re-join rather than making
            // the user notice and retype.
            if (message === 'username not set' && nameRef.current && autoJoins.current < 3) {
                autoJoins.current += 1;
                chat.setUsername(nameRef.current);
                return;
            }
            // A name the server refuses outright drops us back to the join form
            // with the reason showing.
            if (/username/i.test(message)) setJoined(false);
        }));

        // Auto-join with a remembered name, as v1 does. Driven by the
        // subscription confirmation because nothing is accepted before it —
        // and the socket confirms several streams, so only chat's counts.
        offs.push(chat.on('subscribed', ({ stream, enabled }) => {
            if (stream !== 'chat' || !enabled) return;
            autoJoins.current = 0;
            const saved = nameRef.current;
            if (!saved || joinedRef.current || validateUsername(saved)) return;
            chat.setUsername(saved);
            setJoined(true);
        }));
        return () => offs.forEach((off) => off());
    }, [chat]);

    // The socket follows the receiver: no point holding a second connection open
    // for someone who has not started listening. Acquiring the stream is what
    // opens it — the connection is shared, so it stays up for as long as chat
    // *or* any other consumer (the spots panel) still wants it.
    useEffect(() => {
        if (!wanted || !running) return undefined;
        return chat.acquire('chat');
    }, [wanted, running, chat]);

    // Publish what we are tuned to, so it shows beside our name in the user
    // list. Throttled — this fires on every dial movement.
    const pushStatus = useMemo(() => throttle((t) => chat.setStatus(t), 1500), [chat]);
    useEffect(() => {
        if (joined && chat.connected) pushStatus(tuning);
    }, [joined, tuning, pushStatus, chat]);

    const actions = useMemo(() => ({
        join(name) {
            setError(null);
            chat.setUsername(name);
            setUsername(name);
            setJoined(true);
            try { localStorage.setItem(NAME_KEY, name); } catch (e) { /* ignore */ }
            chat.setStatus(tuning);
        },
        leave() {
            chat.leave();
            setJoined(false);
            // Forget the name too, or the next connection silently re-joins the
            // person who just chose to leave.
            setUsername('');
            try { localStorage.removeItem(NAME_KEY); } catch (e) { /* ignore */ }
        },
        send(text) {
            const body = String(text).trim();
            if (!body) return false;
            return chat.sendMessage(body);
        },
        clearError: () => setError(null),
        markMentionsRead: () => setUnreadMentions(0),
        setChime(on) {
            setChimeOn(on);
            try { localStorage.setItem('ubersdr.v2.chatChime', on ? 'on' : 'off'); } catch (e) { /* ignore */ }
        },
    }), [chat, tuning]);

    const value = useMemo(() => ({
        enabled, state, messages, users, error, username, joined, actions,
        unreadMentions, chimeOn,
        connected: state === 'open',
    }), [enabled, state, messages, users, error, username, joined, actions, unreadMentions, chimeOn]);

    return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
    const ctx = useContext(ChatContext);
    if (!ctx) throw new Error('useChat outside ChatProvider');
    return ctx;
}
