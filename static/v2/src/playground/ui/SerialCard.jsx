// A Serial port block's card: whether there can be a port here at all, which
// one it is, the lines, and the buttons to connect. The port is the page's
// (serialLink.js), so this reads the engine's link rather than the worker's
// readings.

import React, { useEffect, useReducer } from '../../react.js';
import { serialSupport } from '../serialLink.js';

const STATE_WORDS = {
    idle: 'Not connected',
    connecting: 'Connecting…',
    open: 'Connected',
    error: 'Not connected',
};

function Light({ name, on, title }) {
    return <span className={`pg-ser__light${on ? ' is-on' : ''}`} title={`${title}: ${on ? 'on' : 'off'}`}>{name}</span>;
}

const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * `support` is serialSupport()'s answer, a parameter for the tests. Buttons
 * stop their press reaching the canvas, which would otherwise start a drag of
 * the card.
 */
export default function SerialCard({ pg, node, large = false, support = serialSupport() }) {
    const [, bump] = useReducer((n) => n + 1, 0);
    const link = support.ok ? pg.serialOf(node.id) : null;
    useEffect(() => {
        if (!link) return undefined;
        const offs = [link.on('change', bump), link.on('lines', bump), link.on('activity', bump)];
        return () => offs.forEach((off) => off());
    }, [link]);
    if (!support.ok) {
        return <div className="pg-ser pg-ser--off" title={support.why}>{large ? support.why : 'No serial ports here'}</div>;
    }
    const open = link.state === 'open';
    const known = link.remembered();
    const hold = (e) => e.stopPropagation();
    const go = (pick) => link.connect(node.params, { pick });
    return (
        <div className="pg-ser">
            <div className="pg-ser__row">
                <span className={`pg-ser__state is-${link.state}`}>
                    {open ? link.label : STATE_WORDS[link.state] || ''}
                </span>
                {open ? (
                    <button type="button" className="pg-vis__mini" onPointerDown={hold} onClick={() => link.disconnect()}>disconnect</button>
                ) : (
                    <>
                        <button
                            type="button"
                            className="pg-vis__mini"
                            onPointerDown={hold}
                            onClick={() => go(false)}
                            title={known ? `Open ${known} again, or choose a port if it is not there` : 'Choose a serial port to open'}
                        >
                            {known ? 'connect' : 'choose port'}
                        </button>
                        {known && <button type="button" className="pg-vis__mini" onPointerDown={hold} onClick={() => go(true)} title="Choose a different port">other…</button>}
                    </>
                )}
            </div>
            <div className="pg-ser__row pg-ser__lines">
                <Light name="DTR" on={open && link.outLines.dtr} title="DTR, sent" />
                <Light name="RTS" on={open && link.outLines.rts} title="RTS, sent" />
                <span className="pg-ser__gap" />
                <Light name="CTS" on={open && link.lines.cts} title="CTS, received" />
                <Light name="DSR" on={open && link.lines.dsr} title="DSR, received" />
                <Light name="DCD" on={open && link.lines.dcd} title="DCD, received" />
                <Light name="RI" on={open && link.lines.ri} title="RI, received" />
            </div>
            {(large || link.state === 'error' || (open && link.message)) && (
                <div className={`pg-ser__note${link.state === 'error' ? ' is-error' : ''}`}>
                    {link.message || (open ? `In ${bytes(link.rxBytes)} · out ${bytes(link.txBytes)}${pg.running ? '' : ' · start the graph to send and receive'}` : known ? `Last used: ${known}` : 'Nothing chosen yet. Opening a port always needs a press here: a graph never opens one by itself.')}
                </div>
            )}
        </div>
    );
}
