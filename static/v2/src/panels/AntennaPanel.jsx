// Antenna switch — the v1 control panel's "📡 Antenna" tab as a dock panel.
//
// Same endpoints and same behaviour as static/rotator-ui.js: poll
// /api/ant-switch/status every 5 s, select an antenna or ground everything
// through /api/ant-switch/command, and show the recent change log from
// /api/ant-switch/history ten entries to a page. Switching is blocked while
// the operator has thunderstorm mode on, which the server enforces with a 403.
//
// Only mounted when /api/description reports ant_switch.enabled — see the
// registry's `requires`.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Empty, Icon } from '../components/ui.jsx';
import { PasswordRow, usePassword } from './hardwareAuth.jsx';
import { feedAntennaStatus, subscribeAntenna } from '../lib/hardwareNotices.js';
import { feedInterval } from '../lib/serverFeeds.js';

const POLL_MS = 5000;
const PER_PAGE = 10;

const ACTION_ICON = {
    select: '📡',
    ground: '⏚',
    add: '➕',
    remove: '➖',
    default: '⭐',
    startup: '⏻',
    thunderstorm_on: '⚡',
    thunderstorm_off: '✅',
};

export function antennaLabel(status, n) {
    const labels = status.antenna_labels || [];
    return labels[n - 1] || `Antenna ${n}`;
}

// `minimal` is the antenna buttons, and little else: the selected one is the lit
// button, so a line naming it says the same thing twice. What goes is Ground all,
// the switching history and the link to v1's full controls page — grounding is a
// deliberate act rather than a glance.
//
// The readout survives being grounded, because that is the one state the buttons
// cannot show: nothing is lit, and without it a grounded array is indistinguishable
// from one with no antenna selected.
export default function AntennaPanel({ minimal }) {
    const [status, setStatus] = useState(null);
    const [history, setHistory] = useState([]);
    const [page, setPage] = useState(0);
    // The command waiting on a password, e.g. {command:'select', antenna:2}.
    const [pending, setPending] = useState(null);
    const [error, setError] = useState('');
    const { password, save, clear } = usePassword('ant_switch_password');

    // The poll callback must see the latest password without restarting the
    // interval, and send() is called from the password row before React has
    // re-rendered with the new value.
    const pwRef = useRef(password);
    pwRef.current = password;

    // The status is the shared store's — see lib/hardwareNotices.js. It polls at the rate
    // this panel used to and it is what notices the antenna or the grounding changing, so
    // that notification keeps working with the panel closed, which is most of the time.
    // The history stays here: nothing else wants it and it is decoration.
    const refresh = useCallback(() => {
        fetch('/api/ant-switch/history')
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => { if (d && Array.isArray(d.history)) setHistory(d.history); })
            .catch(() => { /* history is decoration */ });
    }, []);

    useEffect(() => subscribeAntenna(setStatus), []);

    useEffect(() => {
        return feedInterval(refresh, POLL_MS);
    }, [refresh]);

    const send = useCallback(async (cmd, pw) => {
        try {
            const resp = await fetch('/api/ant-switch/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: pw, ...cmd }),
            });

            if (resp.status === 401) {
                // Wrong or missing password — forget it and ask again.
                clear();
                setPending(cmd);
                setError('Incorrect password');
                return;
            }
            if (resp.status === 403) return;   // thunderstorm; the banner says so

            setError('');
            const result = await resp.json().catch(() => ({}));
            if (result.selected !== undefined) {
                // The reply carries the verified hardware state, so the buttons update now
                // rather than at the next poll. Fed to the store rather than set here, so
                // it reaches the notification too: an antenna changed from this browser is
                // announced exactly as one changed from another browser is, and the store
                // hands the new status straight back to this panel.
                feedAntennaStatus({ selected: result.selected, grounded: result.grounded });
            }
            refresh();
        } catch (e) {
            setError('Command failed');
        }
    }, [clear, refresh]);

    const run = useCallback((cmd) => {
        if (!pwRef.current) {
            setPending(cmd);
            setError('');
            return;
        }
        send(cmd, pwRef.current);
    }, [send]);

    if (!status) return <Empty>Loading antenna switch…</Empty>;

    const count = status.num_antennas || 0;
    const selected = status.selected || [];
    const locked = !!status.thunderstorm;

    const totalPages = Math.max(1, Math.ceil(history.length / PER_PAGE));
    const p = Math.min(page, totalPages - 1);
    const entries = history.slice(p * PER_PAGE, p * PER_PAGE + PER_PAGE);

    return (
        <div className="stack">
            {locked && (
                <div className="note note--warn">⚡ Thunderstorm mode — switching disabled</div>
            )}

            <div className="ant-grid">
                {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
                    <button
                        key={n}
                        type="button"
                        className={`chip chip--button${selected.includes(n) && !status.grounded ? ' is-active' : ''}`}
                        disabled={locked}
                        onClick={() => run({ command: 'select', antenna: n })}
                    >
                        {antennaLabel(status, n)}
                    </button>
                ))}
            </div>

            {!minimal && (
                <div className="row-end">
                    <button
                        type="button"
                        className={`btn btn--sm${status.grounded ? ' btn--danger' : ' btn--ghost'}`}
                        disabled={locked}
                        onClick={() => run({ command: 'ground' })}
                    >
                        ⏚ Ground all
                    </button>
                    <a className="btn btn--ghost btn--sm" href="/switch.html" target="_blank" rel="noopener noreferrer">
                        Controls <Icon.External size={12} />
                    </a>
                </div>
            )}

            {pending && (
                <PasswordRow
                    error={error}
                    onSubmit={(pw) => { save(pw); setPending(null); send(pending, pw); }}
                    onCancel={() => { setPending(null); setError(''); }}
                />
            )}

            {error && !pending && <div className="note note--warn">{error}</div>}

            {/* Redundant in the minimal view: the selected antennas are the
                lit buttons above. Except when the array is grounded, which lights
                nothing — so that one state still needs saying, and the button
                that would otherwise have said it is not there either. */}
            {(!minimal || status.grounded) && (
                <div className="kv-list">
                    <div className="kv">
                        <span className="kv__k">Active</span>
                        <span className="kv__v">
                            {status.grounded
                                ? 'Grounded'
                                : selected.length
                                    ? selected.map((n) => antennaLabel(status, n)).join(', ')
                                    : 'None'}
                        </span>
                    </div>
                </div>
            )}

            {!minimal && <>
            <div className="divider" />

            <div className="ant-hist__head">
                <span className="section-label">History</span>
                <div className="ant-hist__nav">
                    <button type="button" className="btn btn--ghost btn--sm btn--icon" disabled={p === 0} onClick={() => setPage(p - 1)}>
                        <Icon.ChevronLeft size={13} />
                    </button>
                    <span className="ant-hist__page">{p + 1}/{totalPages}</span>
                    <button type="button" className="btn btn--ghost btn--sm btn--icon" disabled={p >= totalPages - 1} onClick={() => setPage(p + 1)}>
                        <Icon.ChevronRight size={13} />
                    </button>
                </div>
            </div>

            {entries.length === 0 ? (
                <div className="note note--tight">No changes recorded yet.</div>
            ) : (
                <div className="list">
                    {entries.map((e, i) => (
                        <div className="ant-hist__row" key={`${e.time}-${i}`}>
                            <span className="ant-hist__time">
                                {new Date(e.time).toLocaleTimeString(undefined, {
                                    hour: '2-digit', minute: '2-digit', second: '2-digit',
                                })}
                            </span>
                            <span className="ant-hist__label">
                                {ACTION_ICON[e.action] || '•'} {e.label || e.action}
                            </span>
                            <span className="ant-hist__src">{e.source}</span>
                        </div>
                    ))}
                </div>
            )}
            </>}
        </div>
    );
}
