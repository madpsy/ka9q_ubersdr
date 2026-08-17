// Chat state, kept out of RadioContext so a busy channel never re-renders the
// receiver. Only the chat panel subscribes to this.

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from '../react.js';
import { dxcluster, validateUsername } from '../radio/dxcluster-connection.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useLayout } from '../layout/LayoutContext.jsx';
import { throttle } from '../lib/throttle.js';
import { isMention } from '../lib/mentions.js';
import { ignoredUsers, isIgnored, onChatIgnore } from '../lib/chatIgnore.js';
import {
    followSignature, followTarget, followView, loadFollowZoom, saveFollowZoom,
} from '../lib/chatFollow.js';
import { pushNotification } from '../lib/notifications.js';

const ChatContext = createContext(null);

const NAME_KEY = 'ubersdr.v2.chatName';
const MAX_MESSAGES = 300;

// What makes two deliveries of the same line the same line.
//
// The server replays its recent buffer on every `subscribe_chat`, which is how
// history arrives — and a re-subscribe on a live socket is ordinary: acquire()
// sends one when the reference count goes up, and onopen sends one for every
// stream it wants. So the same messages are delivered more than once by design.
//
// The id used to end in `prev.length`, which made every delivery unique by
// construction and left the second copy of a replayed buffer sitting in the
// list underneath the first — your own join and the welcome that follows it,
// printed twice, looking exactly like joining twice.
//
// Timestamp, who, and what: the server's timestamps carry sub-second precision,
// so this only collides for the same person saying the same thing inside the
// same instant, where showing it once is the better answer anyway.
const msgKey = (timestamp, username, body) => `${timestamp}|${username}|${body}`;

// Was this said before we got here?
//
// The server replays its recent buffer to every client that subscribes, which is
// how the panel opens with a conversation already in it — and those lines are
// ordinary message events, indistinguishable from live ones. So a mention of
// your callsign from two hours ago rang the chime, raised a notification and
// badged the panel, every time the page was loaded. Being told you were
// mentioned is useful; being told the moment you arrive, about something said
// before you did, is not — there is nothing to answer and nobody waiting.
//
// The messages carry timestamps, so it is simply a comparison against when we
// subscribed. The two clocks are not the same clock, but they are both wall
// clocks on machines that keep time, and the only thing a second or two of
// disagreement can do is misjudge a message sent in the same breath as we
// arrived — which is the one case where either answer is defensible.
//
// No timestamp, or one that will not parse, counts as live: one notification too
// many beats a mention that is never mentioned.
const saidBefore = (since, timestamp) => {
    if (!since) return false;
    const at = Date.parse(timestamp);
    return Number.isFinite(at) && at < since;
};

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
    const { serverInfo, tuning, running, view, actions: radio } = useRadio();
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
    // Whom this browser has decided not to hear from. Held in a plain store rather than
    // here because the panel writes it and this reads it, and because it outlives the
    // provider — see lib/chatIgnore.js. Mirrored into state so a press redraws the log.
    // Named apart from the store's own setIgnored, which acts on one person: a setter
    // called setIgnored that replaces the whole list is a confusion waiting to be made.
    const [ignored, ignoredTo] = useState(ignoredUsers);
    useEffect(() => onChatIgnore(ignoredTo), []);
    // Whose dial is driving ours, or null — v1's "sync". One at a time, and not remembered
    // between visits: it is about who is on the channel now, and arriving to find the dial
    // being driven by a name you do not remember choosing is the wrong kind of surprise.
    const [following, setFollowing] = useState(null);
    // Whether their spectrum view comes with it. Stored, and off by default, because the view
    // is your own window on the band — see lib/chatFollow.js.
    // Named apart from the action below that drives it: a method called setFollowZoom whose
    // body calls setFollowZoom is legal and reads like a bug.
    const [followZoom, followZoomTo] = useState(loadFollowZoom);
    const [chimeOn, setChimeOn] = useState(() => {
        try { return localStorage.getItem('ubersdr.v2.chatChime') !== 'off'; } catch (e) { return true; }
    });
    // Which arrivals have already been announced.
    //
    // Its own record rather than a look at `messages`, because the timing is the difficulty: a
    // replayed buffer arrives as a burst of events, all of them before React has re-rendered,
    // so a ref that tracks the message list is stale for every event after the first. The
    // alternative — deciding inside the setMessages updater, where `prev` is current — would be
    // raising a notification from a function React is allowed to call twice.
    const joinsSeen = useRef(new Set());
    // When we got here — see saidBefore. Set at the subscribe rather than here,
    // because those are not the same moment: this provider is mounted by App at
    // page load, while the socket is not subscribed until the receiver is
    // running. Anchoring it at mount would have counted anything said in between
    // — which arrives in the replayed buffer, like the rest of the history — as
    // having been said to us.
    const since = useRef(null);
    // Read inside the message handler, which must not resubscribe per keystroke.
    const nameRef = useRef(username);
    nameRef.current = username;
    const chimeRef = useRef(chimeOn);
    chimeRef.current = chimeOn;
    const joinedRef = useRef(joined);
    joinedRef.current = joined;
    // A join has been sent and the server has not yet announced it back.
    //
    // Everything sent in that window can be refused with "username not set",
    // because the server answers it against a chat user that does not exist
    // yet. That refusal is a race with our own join, not the server having
    // forgotten us — and re-joining on it, which is what the handler below is
    // for, produces a second join and a second welcome for the whole channel.
    const joinPending = useRef(false);
    // The same fact as a piece of state, so the status effect can wait for it.
    const [announced, setAnnounced] = useState(false);
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
            const key = msgKey(m.timestamp, m.username, m.message);
            let fresh = true;
            setMessages((prev) => {
                // Already have it — see msgKey. The server replays its buffer on
                // every subscribe_chat, so this is the ordinary case, not a
                // corner one.
                if (prev.some((x) => x.key === key)) { fresh = false; return prev; }
                const next = prev.concat({
                    ...m, mention: mentioned, key, id: key,
                });
                return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
            });
            // Only for a message being seen for the first time, and only for one
            // said since we arrived.
            //
            // `fresh` and `saidBefore` sound like the same guard and are not. The
            // first asks whether this line is already on screen, which is what
            // stops a second delivery of the same buffer chiming twice — and it
            // is exactly what fails on the first load of a session, where every
            // replayed line is new to us. The second asks whether it was ever
            // ours to hear. It took both to make an arrival quiet.
            // Somebody you have decided not to hear from cannot get your attention by
            // saying your name — which is precisely the case worth having this for. The
            // line is still kept, and reappears if you stop ignoring them; what is refused
            // is the interruption. See lib/chatIgnore.js.
            if (mentioned && fresh && !isIgnored(m.username)
                && !saidBefore(since.current, m.timestamp)) {
                setUnreadMentions((n) => n + 1);
                if (chimeRef.current) playMentionChime();
                // The same gate as the chime, and for the same reason — the server replays its
                // buffer on every subscribe, so `fresh` is what separates being spoken to from
                // being reminded of it. Unkeyed: two people asking you two different things are
                // two notifications, not one with a ×2 on it.
                pushNotification({
                    source: 'chat-mention',
                    severity: 'info',
                    title: `${m.username} mentioned you`,
                    body: m.message,
                });
            }
        }));
        offs.push(chat.on('presence', (p) => {
            // Our own join, echoed back: the server has us now, so anything
            // held back for it can go.
            if (p.kind === 'joined' && p.username === nameRef.current) {
                joinPending.current = false;
                setAnnounced(true);
            }
            const key = msgKey(p.timestamp, p.username, p.kind);
            // Somebody arriving, once. Three things have to be true, and each of them is a way
            // this went wrong before the gate existed:
            //
            //   Not a replay. The server sends its recent buffer again on every subscribe_chat,
            //   and a re-subscribe on a live socket is ordinary — so joins from an hour ago
            //   arrive repeatedly. See joinsSeen for why that is tracked separately from the
            //   log's own dedupe below, which asks the same question at a different moment.
            //
            //   Not us. Our own join comes back to us too, and "you joined" is not news.
            //
            //   Not a departure: `left` is the other half of this event and is not worth
            //   interrupting anybody for.
            const first = !joinsSeen.current.has(key);
            joinsSeen.current.add(key);
            // A session's worth of keys is a few hundred bytes; a very long one with a very
            // busy channel is not, and past this point the oldest of them can never be
            // replayed anyway.
            if (joinsSeen.current.size > 2000) joinsSeen.current.clear();
            //   Not from before we got here. Joins are replayed with the buffer like
            //   everything else, so without this an arrival announced everyone who was
            //   already in the room — as though they had all walked in at once.
            //   Not somebody you are ignoring. Their arrival is not news to you either.
            if (first && p.kind === 'joined' && p.username !== nameRef.current
                && !isIgnored(p.username)
                && !saidBefore(since.current, p.timestamp)) {
                pushNotification({
                    source: 'chat-join',
                    severity: 'info',
                    title: `${p.username} joined chat`,
                    // Where from, when the server says — it is the interesting half of an
                    // arrival, and the panel shows the same flag beside their name.
                    body: p.country ? String(p.country) : '',
                });
            }
            setMessages((prev) => (prev.some((x) => x.key === key) ? prev : prev.concat({
                key,
                id: key,
                system: true,
                username: p.username,
                message: p.kind === 'joined' ? 'joined' : 'left',
                country: p.country,
                timestamp: p.timestamp,
            }).slice(-MAX_MESSAGES)));
            // The list is authoritative only from the server, so ask rather
            // than trying to patch it locally.
            chat.requestUsers();
        }));
        offs.push(chat.on('users', ({ users: list }) => setUsers(list)));
        offs.push(chat.on('userUpdate', () => chat.requestUsers()));
        offs.push(chat.on('idle', () => chat.requestUsers()));
        offs.push(chat.on('error', (e) => {
            const message = e.message || 'chat error';
            // The server forgets our identity when its session goes (a restart,
            // or a socket it had already dropped). Re-join rather than making
            // the user notice and retype — and say nothing while doing it,
            // because from the operator's side nothing went wrong.
            //
            // This used to raise the bar first and then recover, which left
            // "username not set" on screen after a re-join that had worked.
            // Nothing cleared it: the auto-join does not go through
            // actions.join, which is the only other place the error is reset.
            // It is also the one error whose instruction you cannot follow —
            // the name *is* set, and setting it again is exactly what just
            // happened underneath.
            // We got ahead of the handshake: nothing is accepted until the
            // server has registered `subscribe_chat`, and the connection now
            // holds anything sent before that and replays it on confirmation
            // (see setUsername there). Whatever was refused is already on its
            // way again, so this is our own race and not news for the operator.
            if (/subscribe to chat/i.test(message)) {
                setError(null);
                return;
            }
            // A status update the server thought too soon. Nothing the operator
            // did and nothing they can do: publishing frequency and mode is this
            // panel's own housekeeping, it is throttled at our end already, and
            // the next dial movement publishes again. Reporting it would be
            // reporting our own timing at somebody trying to have a conversation.
            if (/update rate limit/i.test(message)) {
                setError(null);
                return;
            }
            if (message === 'username not set') {
                // Still waiting to be announced: this is the race described at
                // joinPending, so the join that is already on its way is the
                // answer and a second one would only duplicate it.
                if (joinPending.current) {
                    setError(null);
                    return;
                }
                if (nameRef.current && autoJoins.current < 3) {
                    autoJoins.current += 1;
                    setError(null);
                    joinPending.current = true;
                    chat.setUsername(nameRef.current);
                    return;
                }
            }
            setError(message);
            // A name the server refuses outright drops us back to the join form
            // with the reason showing.
            if (/username/i.test(message)) {
                joinedRef.current = false;
                setJoined(false);
            }
        }));

        // Auto-join with a remembered name, as v1 does. Driven by the
        // subscription confirmation because nothing is accepted before it —
        // and the socket confirms several streams, so only chat's counts.
        offs.push(chat.on('subscribed', ({ stream, enabled }) => {
            if (stream !== 'chat' || !enabled) return;
            autoJoins.current = 0;
            const saved = nameRef.current;
            if (!saved || joinedRef.current || validateUsername(saved)) return;
            // The ref is claimed here, before the send, rather than being left
            // to `joinedRef.current = joined` on the next render.
            //
            // That assignment happens while rendering, so between calling
            // setJoined(true) and React getting round to re-rendering, the ref
            // still reads false. A second confirmation in that window — the
            // socket resubscribes on open as well as on acquire, so two are
            // ordinary on a fresh start — passed this guard too and sent a
            // second setUsername, which is the double join.
            joinedRef.current = true;
            joinPending.current = true;
            setAnnounced(false);
            setError(null);
            chat.setUsername(saved);
            setJoined(true);
        }));
        return () => offs.forEach((off) => off());
    }, [chat]);

    // The socket follows the receiver: no point holding a second connection open
    // for someone who has not started listening. Acquiring the stream is what
    // opens it — the connection is shared, so it stays up for as long as chat
    // *or* any other consumer (the spots panel) still wants it.
    //
    // The refresh is what stops the server seeing two joins.
    //
    // This socket is usually already open by the time chat wants it: the marker
    // bar subscribes to the DX and CW spot feeds on load, with no `running`
    // guard, so it opens under whatever session id existed then. powerOn() mints
    // a *new* one — audio and spectrum have to be paired under a single UUID —
    // which leaves the socket carrying an id the server has since replaced.
    // Joining on it announces us under the old session; the server then retires
    // that session, the socket closes, and the reconnect replays our identity
    // under the new one — a second join, from the server's point of view by a
    // different user session. v1 never sees this because it does not open the
    // chat socket before the receiver starts.
    //
    // So the socket is put on the current session id *before* anyone joins on
    // it. refresh() is a no-op when it is already there, and costs one round
    // trip when it is not; useAudioExtension does the same thing for the same
    // reason, its attach being keyed by the same UUID.
    useEffect(() => {
        if (!wanted || !running) return undefined;
        // The first subscribe is our arrival: the buffer it brings back is, by
        // definition, what was said before it. Only the first — this effect runs
        // again whenever chat is switched off and on, and moving the anchor
        // forward each time would silence everything said in between.
        if (!since.current) since.current = Date.now();
        chat.refresh();
        return chat.acquire('chat');
    }, [wanted, running, chat]);

    // ── Following ────────────────────────────────────────────────────────────
    //
    // Applied here rather than in the panel, deliberately: a dock that is collapsed unmounts
    // the panel, and a follow that stopped following the moment you tucked the chat away would
    // be worse than not having it. ChatProvider is mounted once by App.
    //
    // Driven off the user list rather than the `chat_user_update` event. Both say the same
    // thing — the handler above asks for a fresh list whenever an update arrives — but the
    // list is the merged, authoritative record, and v1 goes out of its way to read from it too
    // (its update payload can be partial, and syncing to a partial record tunes to half of it).
    const applied = useRef('');
    useEffect(() => {
        if (!following) { applied.current = ''; return; }
        const them = users.find((u) => u.username === following);
        // Gone: they left, or the server dropped them. Stop rather than holding a name that
        // will never move again — and say so by clearing it, so the panel stops claiming to
        // follow somebody who is not there.
        if (!them) { setFollowing(null); return; }
        const sig = followSignature(them, followZoom);
        // Nothing we would act on has changed. The list is refreshed by anything at all
        // happening on the channel, and re-tuning on each of those would fight an operator who
        // has since nudged the dial.
        if (!sig || sig === applied.current) return;
        applied.current = sig;

        const target = followTarget(them);
        if (!target) return;
        radio.tuneTo(target);
        // Their view too, when asked for — and then nothing else touches it. Matching a view
        // already puts their frequency inside it, so ensureVisible would either do nothing or,
        // at the edges of the band, argue with the centre we just chose.
        const v = followZoom ? followView(them, view.binCount) : null;
        if (v) radio.setSpectrumView(v.frequency, v.span);
        // Otherwise the dial has moved and the window has not: v1 forces "edge tune" on for two
        // seconds to drag the spectrum along, which is this said directly.
        else radio.ensureVisible(target.frequency);
    }, [following, followZoom, users, view.binCount, radio]);

    // Publish what we are tuned to, so it shows beside our name in the user
    // list. Throttled — this fires on every dial movement.
    //
    // Not until the server has announced our join. `joined` means "we have sent
    // a name", which is a frame or two ahead of the server having a chat user
    // to hang a frequency on, and this effect fires the instant it flips — so
    // the first status push went out in exactly that window and came back
    // refused. Waiting on the announcement costs nothing: there is no status
    // worth publishing for someone the channel cannot see yet.
    //
    // The spectrum's resolution goes with it, so somebody following us can match our view —
    // hence the zoom in the dependencies as well as the tuning.
    const pushStatus = useMemo(() => throttle((t) => chat.setStatus(t), 1500), [chat]);
    useEffect(() => {
        if (joined && announced && chat.connected) {
            pushStatus({ ...tuning, binBandwidth: view.binBandwidth });
        }
    }, [joined, announced, tuning, view.binBandwidth, pushStatus, chat]);

    const actions = useMemo(() => ({
        join(name) {
            setError(null);
            // Both refs before the send, for the same reason as the auto-join:
            // an error arriving before the next render reads them, and a stale
            // name there would re-join as whoever we were last time.
            nameRef.current = name;
            joinedRef.current = true;
            joinPending.current = true;
            setAnnounced(false);
            chat.setUsername(name);
            setUsername(name);
            setJoined(true);
            try { localStorage.setItem(NAME_KEY, name); } catch (e) { /* ignore */ }
            // No status from here. The effect above publishes one the moment the
            // server announces us, and it publishes the *whole* status — the
            // spectrum's resolution included, which this call had no way to
            // reach. Two publishes a few hundred milliseconds apart, differing
            // only in that field, is two changes as far as the server is
            // concerned, and the second comes back "update rate limit exceeded".
            //
            // It only surfaced once joining started working: before that the
            // join failed, nothing was ever announced, and the effect that
            // publishes never ran at all.
        },
        leave() {
            chat.leave();
            joinedRef.current = false;
            joinPending.current = false;
            setAnnounced(false);
            setJoined(false);
            // Forget the name too, or the next connection silently re-joins the
            // person who just chose to leave. The ref goes with it, or the
            // error handler's auto-join would put them straight back.
            nameRef.current = '';
            setUsername('');
            // Leaving the channel ends the follow with it: the user list is about to be empty,
            // and a dial still being driven by somebody you can no longer see is not a feature.
            applied.current = '';
            setFollowing(null);
            try { localStorage.removeItem(NAME_KEY); } catch (e) { /* ignore */ }
        },
        // Follow a user, or the same one again to stop. Immediate rather than waiting for
        // their next move: the point of pressing it is to hear what they are hearing now.
        follow(name) {
            setFollowing((cur) => {
                applied.current = '';
                return cur === name ? null : name;
            });
        },
        unfollow() {
            applied.current = '';
            setFollowing(null);
        },
        // Turning the zoom on mid-follow applies it at once, which is why the signature is
        // cleared: the numbers have not changed, but what we do with them has.
        setFollowZoom(on) {
            applied.current = '';
            followZoomTo(on);
            saveFollowZoom(on);
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
        // `tuning` is no longer among these: the join stopped publishing a status
        // — see the note in it — and nothing else in here reads the dial, so
        // keeping it would rebuild every action object on every knob movement.
    }), [chat]);

    // Hidden here rather than dropped as they arrive, which is what v1 does.
    //
    // The difference is only visible when somebody is un-ignored, and it is the whole
    // difference: filtering on arrival makes the decision permanent for everything said
    // while it stood, so changing your mind leaves a hole in the conversation. Kept and
    // hidden, the log is whole again the moment you press the button — and the cost is a
    // few strings in memory that were going to be there anyway.
    //
    // Presence lines go with the messages. Ignoring somebody who joins and leaves every
    // two minutes and still watching them do it would not be ignoring them.
    const visible = useMemo(
        () => (ignored.length ? messages.filter((m) => !isIgnored(m.username)) : messages),
        [messages, ignored],
    );

    const value = useMemo(() => ({
        enabled, state, messages: visible, users, error, username, joined, actions,
        unreadMentions, chimeOn, following, followZoom, ignored,
        connected: state === 'open',
    }), [enabled, state, visible, users, error, username, joined, actions, unreadMentions,
        chimeOn, following, followZoom, ignored]);

    return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
    const ctx = useContext(ChatContext);
    if (!ctx) throw new Error('useChat outside ChatProvider');
    return ctx;
}
