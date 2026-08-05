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
// happens to be on screen.
//
// `minimal` keeps the transcript and the command line, and drops the quick
// commands and the status row.

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { Button, Empty } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import {
    QUICK_COMMANDS, openTerminal, parseSpotLine, saveCallsign, savedCallsign, trimLines,
} from '../lib/dxclusterTerminal.js';

export const ADDON_NAME = 'dxcluster';

/** Is the addon on this receiver? Same test the widget makes. */
export function dxClusterAvailable(serverInfo) {
    const addons = serverInfo && serverInfo.addons;
    return Array.isArray(addons) && addons.includes(ADDON_NAME);
}

export default function DXClusterPanel({ minimal }) {
    const { actions } = useRadio();
    const [callsign, setCallsign] = useState(savedCallsign);
    const [state, setState] = useState('closed');
    const [detail, setDetail] = useState('');
    const [text, setText] = useState('');
    const [line, setLine] = useState('');
    const [flash, setFlash] = useState('');
    const termRef = useRef(null);
    const outRef = useRef(null);
    const flashRef = useRef(null);

    const connected = state === 'open';

    // The panel's lifetime is the login's. Nothing is left connected behind a
    // collapsed panel.
    useEffect(() => () => {
        if (termRef.current) termRef.current.close();
        clearTimeout(flashRef.current);
    }, []);

    // Follow the tail, unless the operator has scrolled up to read something.
    useEffect(() => {
        const el = outRef.current;
        if (!el) return;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) el.scrollTop = el.scrollHeight;
    }, [text]);

    const connect = useCallback(() => {
        const call = callsign.trim().toUpperCase();
        if (!call || termRef.current) return;
        saveCallsign(call);
        setText('');
        setDetail('');
        termRef.current = openTerminal({
            callsign: call,
            on: {
                text: (chunk) => setText((t) => trimLines(t + chunk)),
                state: (st, why) => {
                    setState(st);
                    setDetail(why);
                    if (st === 'closed') termRef.current = null;
                },
            },
        });
    }, [callsign]);

    const disconnect = () => {
        if (termRef.current) termRef.current.close();
        termRef.current = null;
        setState('closed');
        setDetail('');
    };

    const send = (cmd) => {
        if (termRef.current) termRef.current.send(cmd);
    };

    const say = (msg) => {
        setFlash(msg);
        clearTimeout(flashRef.current);
        flashRef.current = setTimeout(() => setFlash(''), 1600);
    };

    // Spot lines are found once per transcript change rather than on every
    // click: the transcript is the thing that changes, and a click has to know
    // immediately whether the line under it is tuneable.
    const lines = useMemo(() => text.split('\n').map((raw) => ({ raw, spot: parseSpotLine(raw) })), [text]);

    const tune = (spot) => {
        // Frequency and mode together: separately, the receiver passes through
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
                        className="input"
                        placeholder="Callsign"
                        value={callsign}
                        onChange={(e) => setCallsign(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') connect(); }}
                        autoComplete="off"
                        spellCheck={false}
                    />
                    <Button
                        size="sm"
                        variant="primary"
                        disabled={!callsign.trim() || state === 'connecting'}
                        onClick={connect}
                    >
                        {state === 'connecting' ? 'Connecting…' : 'Connect'}
                    </Button>
                </div>
            ) : (
                <div className="dxc-status">
                    <span className="dot dot--good" />
                    <span className="dxc-status__text">{flash || `Connected as ${callsign.toUpperCase()}`}</span>
                    <Button size="sm" variant="ghost" onClick={disconnect}>Disconnect</Button>
                </div>
            )}

            {detail && <div className="note note--warn">{detail}</div>}

            {/* The cluster's own words. Rendered as text, never as markup, and
                one element per line so a spot can be a click target. */}
            <div className="dxc-out" ref={outRef}>
                {text ? lines.map(({ raw, spot }, i) => (
                    spot ? (
                        <button
                            // The transcript is append-only and trimmed from the
                            // front, so the index is stable for as long as a line
                            // is on screen.
                            key={i}
                            type="button"
                            className="dxc-out__line dxc-out__line--spot"
                            title={`Tune to ${spot.callsign} — ${spot.khz} kHz ${spot.mode.toUpperCase()}`}
                            onClick={() => tune(spot)}
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
                                // The two that need an argument put themselves in
                                // the command line rather than guessing one.
                                if (q.prompt) {
                                    setLine(`${q.prompt} `);
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
                    <input
                        className="input"
                        placeholder="Command — try help"
                        value={line}
                        onChange={(e) => setLine(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key !== 'Enter' || !line.trim()) return;
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
        </div>
    );
}
