// The DX cluster terminal.
//
// A port of widgets/dxcluster.widget.html: a login to the cluster the dxcluster
// addon runs, over the WebSocket it proxies its telnet server on. You type
// Spider commands and read what comes back, and any line that parses as a spot
// is clickable — it tunes this receiver, with the mode worked out the way the
// widget works it out.
//
// The socket is not opened until Connect, and is closed when the panel is
// unmounted — which in this interface means when it is collapsed or hidden. A
// login on a shared cluster is not something to hold open because a panel
// happens to be on screen. A remembered callsign connects on its own, as the
// widget does, because opening the panel is the asking.
//
// `minimal` keeps the transcript and the command line, and drops the quick
// commands, the links and the connected/disconnect row — once you are in,
// those are the two things you are actually using. The login row stays: a
// minimal panel still has to be able to let you in.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { Button, Empty, Modal } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import {
    MAX_CALLSIGN, MAX_COMMAND, MAX_PASSWORD, QUICK_COMMANDS, clientUrl, openTerminal,
    parseSpotLine, saveLogin, savedLogin, trimLines, webUrl,
} from '../lib/dxclusterTerminal.js';

export const ADDON_NAME = 'dxcluster';

/** Is the addon on this receiver? Same test the widget makes. */
export function dxClusterAvailable(serverInfo) {
    const addons = serverInfo && serverInfo.addons;
    return Array.isArray(addons)
        && addons.some((n) => String(n).toLowerCase() === ADDON_NAME);
}

// How near the bottom still counts as following the output.
const STICK_PX = 40;

export default function DXClusterPanel({ minimal }) {
    const { actions } = useRadio();
    const [login, setLogin] = useState(savedLogin);
    const [state, setState] = useState('closed');
    const [detail, setDetail] = useState('');
    const [text, setText] = useState('');
    const [line, setLine] = useState('');
    const [flash, setFlash] = useState('');
    // A quick command that needs a callsign before it can be sent.
    const [asking, setAsking] = useState(null);   // { cmd, label, value }
    const termRef = useRef(null);
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
        const call = login.callsign.trim().toUpperCase();
        if (!call || termRef.current) return;
        saveLogin({ callsign: call, password: login.password });
        setText('');
        setDetail('');
        stickRef.current = true;
        termRef.current = openTerminal({
            callsign: call,
            password: login.password,
            on: {
                text: (chunk, isEcho) => {
                    // Decided *before* the state update, because after it the
                    // new lines have already pushed the view away from the
                    // bottom and it would read as "the user scrolled up".
                    // Echoes always follow: you typed it, you should see it.
                    const el = outRef.current;
                    stickRef.current = isEcho || !el
                        || el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
                    setText((t) => trimLines(t + chunk));
                },
                state: (st, why) => {
                    setState(st);
                    setDetail(why);
                    if (st === 'closed') termRef.current = null;
                },
            },
        });
    }, [login]);

    // The panel's lifetime is the login's.
    useEffect(() => () => {
        if (termRef.current) termRef.current.close();
        clearTimeout(flashRef.current);
    }, []);

    // A remembered callsign connects on its own, as the widget does. Once:
    // a disconnect is a decision, and reconnecting over it would be a fight.
    const tried = useRef(false);
    useEffect(() => {
        if (tried.current) return;
        tried.current = true;
        if (savedLogin().callsign.trim()) connect();
    }, [connect]);

    useEffect(() => {
        if (!stickRef.current) return;
        const el = outRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [text]);

    // The command line is where you are once you are in.
    useEffect(() => {
        if (connected && inputRef.current) inputRef.current.focus();
    }, [connected]);

    const disconnect = () => {
        if (termRef.current) termRef.current.close();
        termRef.current = null;
        setState('closed');
        setDetail('');
    };

    const send = useCallback((cmd) => {
        if (termRef.current) termRef.current.send(cmd);
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
        actions.tuneTo({ frequency: spot.hz, mode: spot.mode });
        actions.ensureVisible(spot.hz);
        say(`Tuned ${spot.khz} ${spot.mode.toUpperCase()}`);
    };

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
