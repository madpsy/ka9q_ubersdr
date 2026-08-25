// The DX cluster terminal.
//
// A port of widgets/dxcluster.widget.html: a login to the cluster the dxcluster
// addon runs, over the WebSocket it proxies its telnet server on. You type
// Spider commands and read what comes back, and any line that parses as a spot
// is clickable — it tunes this receiver, with the mode worked out the way the
// widget works it out.
//
// The socket is not opened until Connect, and it does not belong to this component: the
// session lives in lib/dxclusterSession.js and outlives every way a panel can be
// unmounted. That was not the original design and the original design was wrong — the
// panel disappears when a dock is collapsed, when a collapsed dock is peeked at, when it
// is dragged to another dock and when a phone switches sheets, and none of those is
// somebody asking to leave the cluster. Collapsing the bottom dock is the everyday one,
// and losing a login and a screenful of spots to it is not a trade anybody would make on
// purpose.
//
// What ends a session is a decision: Disconnect, or moving the panel into a side dock
// where it cannot be read, or stopping the receiver, or reloading the page. A remembered
// callsign still connects on its own, as the widget does, and only once per page load.
// None of that is decided here — see components/DXClusterWatch.jsx, which is mounted for
// the life of the page so that a panel collapsed into a dock still logs in.
//
// `minimal` keeps the transcript and the command line, and drops the quick
// commands, the links and the connected/disconnect row — once you are in,
// those are the two things you are actually using. The login row stays: a
// minimal panel still has to be able to let you in.
//
// ── Why a side dock shows two buttons instead of a terminal ──────────────────
//
// A cluster line is eighty columns of fixed-pitch text: a callsign, a frequency, a
// comment, a spotter and a time. A side dock is 220 to 560 pixels wide, which wraps
// every line into three and makes the transcript unreadable — and the quick commands
// and the login row are a grid that needs the same room.
//
// So in the left or right dock the panel does not pretend. It says where it belongs and
// offers the two places it works, and it does not connect: a login on a shared cluster
// held open behind a panel that cannot show you the output is the worst of both.
//
// It still *starts* in the left dock, open, because that is where somebody will find it.
// The bottom dock is the right home for it and the wrong default — that dock is already
// the busiest by default, and a receiver whose first impression is a terminal across the
// bottom of the screen has led with the wrong thing.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { freqInRange } from '../lib/format.js';
import { Button, Empty, Modal } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import DockTooNarrow, { useDockRoom } from '../components/DockTooNarrow.jsx';
import {
    MAX_CALLSIGN, MAX_COMMAND, MAX_PASSWORD, QUICK_COMMANDS, clientUrl, parseSpotLine,
    savedLogin, webUrl,
} from '../lib/dxclusterTerminal.js';
import {
    dxConnect, dxDisconnect, dxSend, dxSession, onDxSession,
} from '../lib/dxclusterSession.js';

export const ADDON_NAME = 'dxcluster';

// This panel's registry id. Exported because DXClusterWatch has to ask the layout
// where the panel is without the panel being mounted.
export const PANEL_ID = 'dxcluster';

/** Is the addon on this receiver? Same test the widget makes. */
export function dxClusterAvailable(serverInfo) {
    const addons = serverInfo && serverInfo.addons;
    return Array.isArray(addons)
        && addons.some((n) => String(n).toLowerCase() === ADDON_NAME);
}

// How near the bottom still counts as following the output.
const STICK_PX = 40;

// What a floated cluster window opens at. Eighty columns of the terminal's font is about
// 560 px, and the rest is the scrollbar and somewhere for the login row to sit on one
// line. Enough and no more: a window that opens across most of the screen has decided how
// you are going to use the rest of it, and this one is meant to sit beside the spectrum.
const FLOAT_WANT = { w: 680, h: 480 };

export default function DXClusterPanel({ minimal }) {
    const { actions } = useRadio();
    // Where this panel is living. A side dock cannot show a cluster — see above — so
    // the panel becomes a signpost rather than a terminal, and none of the state below
    // is reached: no socket, no login, nothing held open.
    const { cramped, toBottom, floatIt } = useDockRoom('dxcluster', FLOAT_WANT);
    const [login, setLogin] = useState(savedLogin);
    // A mirror of the session, not a copy of the truth: everything below reads these and
    // every change to them comes from the store.
    const [{ state, detail, text }, setSession] = useState(dxSession);
    const [line, setLine] = useState('');
    const [flash, setFlash] = useState('');
    // A quick command that needs a callsign before it can be sent.
    const [asking, setAsking] = useState(null);   // { cmd, label, value }
    const outRef = useRef(null);
    const inputRef = useRef(null);
    const flashRef = useRef(null);
    // Whether the next render should scroll to the bottom. Decided when the
    // text arrives, not after — see the note in the effect below.
    const stickRef = useRef(true);

    const connected = state === 'open';

    const say = useCallback((msg) => {
        setFlash(msg);
        clearTimeout(flashRef.current);
        flashRef.current = setTimeout(() => setFlash(''), 1600);
    }, []);


    const connect = useCallback(() => {
        stickRef.current = true;
        dxConnect({ callsign: login.callsign, password: login.password });
    }, [login]);

    useEffect(() => () => clearTimeout(flashRef.current), []);

    // The session, and the one thing the panel has to decide as text arrives: whether it
    // was following the output. Decided *before* the state update, because afterwards the
    // new lines have already pushed the view away from the bottom and it would read as
    // "the user scrolled up". Echoes always follow: you typed it, you should see it.
    useEffect(() => onDxSession((next, event) => {
        if (event && event.type === 'text') {
            const el = outRef.current;
            stickRef.current = event.isEcho || !el
                || el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
        }
        setSession(next);
    }), []);

    // Auto-connect, the side-dock rule and the Stop rule all used to be three
    // effects here. They are in components/DXClusterWatch.jsx now, because an
    // effect in this panel only runs while the panel is mounted and a collapsed
    // dock unmounts it — so a remembered callsign in a collapsed bottom dock,
    // which is where this panel spends most of its life, never logged in at all.
    // What is left here is the panel: the transcript, the command line and the
    // buttons. Connect and Disconnect are still yours to press.

    useEffect(() => {
        if (!stickRef.current) return;
        const el = outRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [text]);

    // The command line is where you are once you are in — on the way *in*, and not on
    // every mount that happens to find the session already connected.
    //
    // That distinction is the second half of the dock-focus fix. The session now outlives
    // the panel, so a collapsed dock peeked at remounts a panel that is already
    // connected; focusing on mount meant the cluster took the keyboard off whatever had
    // it — typically the chat box next to it — every single time the dock reappeared.
    // See lib/dockFocus.js for the half that remembers where it should have gone.
    const wasConnected = useRef(connected);
    useEffect(() => {
        const justConnected = connected && !wasConnected.current;
        wasConnected.current = connected;
        if (justConnected && inputRef.current) inputRef.current.focus();
    }, [connected]);

    const disconnect = () => dxDisconnect();

    const send = useCallback((cmd) => {
        dxSend(cmd);
        if (inputRef.current) inputRef.current.focus();
    }, []);

    // Parsed once per transcript change rather than per click: a click has to
    // know immediately whether the line under it is tuneable.
    const lines = useMemo(
        () => text.split('\n').map((raw) => ({ raw, spot: parseSpotLine(raw) })),
        [text],
    );

    const tune = (spot) => {
        // Frequency and mode together: separately the receiver passes through
        // the old mode's passband on the new frequency on the way.
        // Refused, not clamped: a spot outside this receiver would otherwise pull the
        // dial to the band edge and look like it worked. Live cluster spots are filtered
        // server-side, but injected and replayed ones reach here too.
        if (!freqInRange(spot.hz)) return;
        actions.tuneTo({ frequency: spot.hz, mode: spot.mode });
        actions.ensureVisible(spot.hz);
        say(`Tuned ${spot.khz} ${spot.mode.toUpperCase()}`);
    };

    if (cramped) {
        return (
            <DockTooNarrow
                note="A cluster line is eighty columns wide — too wide for a side dock."
                onBottom={toBottom}
                onFloat={floatIt}
            />
        );
    }

    return (
        <div className="stack">
            {!connected ? (
                <div className="dxc-login">
                    <input
                        className="input dxc-login__call"
                        placeholder="Callsign"
                        value={login.callsign}
                        maxLength={MAX_CALLSIGN}
                        onChange={(e) => setLogin((l) => ({ ...l, callsign: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') connect(); }}
                        autoComplete="off"
                        spellCheck={false}
                    />
                    {/* Only some clusters want one, and only for spotting — so
                        it is offered rather than demanded, and Connect does not
                        wait for it. */}
                    <input
                        className="input dxc-login__pass"
                        type="password"
                        placeholder="Password (optional)"
                        value={login.password}
                        maxLength={MAX_PASSWORD}
                        onChange={(e) => setLogin((l) => ({ ...l, password: e.target.value }))}
                        onKeyDown={(e) => { if (e.key === 'Enter') connect(); }}
                        autoComplete="off"
                        spellCheck={false}
                    />
                    <Button
                        size="sm"
                        variant="primary"
                        disabled={!login.callsign.trim() || state === 'connecting'}
                        onClick={connect}
                    >
                        {state === 'connecting' ? 'Connecting…' : 'Connect'}
                    </Button>
                    {!minimal && (
                    <span className="dxc-top__links">
                        <a
                            className="chip chip--button"
                            href={webUrl()}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Open the full DX Cluster web UI in a new tab"
                        >
                            Open web UI
                        </a>
                        <a
                            className="chip chip--button"
                            href={clientUrl()}
                            rel="noopener"
                            title="Download the desktop client"
                        >
                            Desktop client ⬇
                        </a>
                    </span>
                    )}
                </div>
            ) : !minimal && (
                <div className="dxc-status">
                    <span className="dot dot--good" />
                    <span className="dxc-status__text">
                        {flash || `Connected as ${login.callsign.toUpperCase()}`}
                    </span>
                    <Button size="sm" variant="ghost" onClick={disconnect}>Disconnect</Button>
                    <span className="dxc-top__links">
                        <a
                            className="chip chip--button"
                            href={webUrl()}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Open the full DX Cluster web UI in a new tab"
                        >
                            Open web UI
                        </a>
                        <a
                            className="chip chip--button"
                            href={clientUrl()}
                            rel="noopener"
                            title="Download the desktop client"
                        >
                            Desktop client ⬇
                        </a>
                    </span>
                </div>
            )}

            {detail && <div className="note note--warn">{detail}</div>}

            {/* The cluster's own words. Text, never markup, and one element per
                line so a spot can be a click target. */}
            <div className="dxc-out" ref={outRef}>
                {text ? lines.map(({ raw, spot }, i) => (
                    spot ? (
                        <button
                            // The transcript is append-only and trimmed from the
                            // front, so the index is stable while a line is up.
                            key={i}
                            type="button"
                            className="dxc-out__line dxc-out__line--spot"
                            title={`Tune to ${spot.callsign} — ${spot.khz} kHz ${spot.mode.toUpperCase()}`}
                            onClick={() => {
                                // Not while text is being selected: dragging
                                // across a line to copy it should not retune.
                                const sel = window.getSelection && window.getSelection();
                                if (sel && !sel.isCollapsed) return;
                                tune(spot);
                            }}
                        >
                            {raw}
                        </button>
                    ) : (
                        <div
                            key={i}
                            className={`dxc-out__line${raw.startsWith('> ') ? ' dxc-out__line--echo' : ''}`}
                        >
                            {raw}
                        </div>
                    )
                )) : (
                    <Empty>
                        {connected ? 'Waiting for the cluster…' : 'Enter your callsign and connect.'}
                    </Empty>
                )}
            </div>

            {connected && !minimal && (
                <div className="chip-row chip-row--wrap">
                    {QUICK_COMMANDS.map((q) => (
                        <button
                            key={q.label}
                            type="button"
                            className="chip chip--button"
                            title={q.title || q.cmd || `${q.prompt} …`}
                            onClick={() => {
                                // The two that take an argument ask for it,
                                // prefilled with your own callsign.
                                if (q.prompt) {
                                    // Empty, not prefilled with your own
                                    // callsign: you are looking somebody else
                                    // up, and the widget's prefill just meant
                                    // clearing the box before typing.
                                    setAsking({ cmd: q.prompt, label: q.label, value: '' });
                                    return;
                                }
                                send(q.cmd);
                            }}
                        >
                            {q.label}
                        </button>
                    ))}
                </div>
            )}

            {connected && (
                <div className="dxc-input">
                    <span className="dxc-input__prompt">&gt;</span>
                    <input
                        ref={inputRef}
                        /* Where this dock hands the keyboard back to when it reopens. */
                        data-dock-focus=""
                        className="input"
                        placeholder="Type a command and press Enter…"
                        value={line}
                        maxLength={MAX_COMMAND}
                        onChange={(e) => setLine(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key !== 'Enter' || !line.trim()) return;
                            // The shortcut watcher is on the window and would
                            // otherwise see this too.
                            e.stopPropagation();
                            send(line);
                            setLine('');
                        }}
                        autoComplete="off"
                        spellCheck={false}
                    />
                    <Button
                        size="sm"
                        variant="ghost"
                        disabled={!line.trim()}
                        onClick={() => { send(line); setLine(''); }}
                    >
                        Send
                    </Button>
                </div>
            )}

            {!minimal && !connected && (
                <div className="note note--tight">
                    The DX cluster this receiver runs. Log in with your callsign and type
                    Spider commands — <code>show/dx</code>, <code>set/filter band 20m</code>,{' '}
                    <code>help</code>. Any spot in the output is clickable and tunes the
                    receiver to it.
                </div>
            )}

            {asking && (
                <Modal onClose={() => setAsking(null)} label={`${asking.label} — ${asking.cmd}`}>
                    <div className="stack">
                        <span className="section-label">{asking.label} — {asking.cmd}</span>
                        <input
                            className="input"
                            value={asking.value}
                            maxLength={MAX_CALLSIGN}
                            autoFocus
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(e) => setAsking((a) => ({ ...a, value: e.target.value }))}
                            onKeyDown={(e) => {
                                if (e.key !== 'Enter' || !asking.value.trim()) return;
                                e.stopPropagation();
                                send(`${asking.cmd} ${asking.value.trim().toUpperCase()}`);
                                setAsking(null);
                            }}
                        />
                        <div className="row-end">
                            <Button size="sm" variant="ghost" onClick={() => setAsking(null)}>
                                Cancel
                            </Button>
                            <Button
                                size="sm"
                                variant="primary"
                                disabled={!asking.value.trim()}
                                onClick={() => {
                                    send(`${asking.cmd} ${asking.value.trim().toUpperCase()}`);
                                    setAsking(null);
                                }}
                            >
                                Send
                            </Button>
                        </div>
                    </div>
                </Modal>
            )}
        </div>
    );
}
