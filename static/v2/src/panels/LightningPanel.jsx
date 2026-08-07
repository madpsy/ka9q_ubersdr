// Lightning: what the VLF sferic addon is hearing, in a dock column.
//
// Four figures, a minute of history as a bar chart, and the last few strikes. The
// addon's own page has the waveform captures, the spectrum, the map and the full log,
// and there is a link to it at the bottom — this is the glance, not the workbench.
//
// The stream is the panel's: an EventSource opened on mount and closed on unmount, so a
// collapsed section costs nothing. See lib/lightning.js for why it subscribes to the
// compact stream, and lib/backoff.js for why a failed connection is reopened here
// rather than left to the browser.
//
// `minimal` keeps the figures and the strip and drops the list and the link — the two
// things that answer "is it striking, and how hard" from across the room.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Empty, Icon } from '../components/ui.jsx';
import { retryDelay } from '../lib/backoff.js';
import {
    LIST_MAX, WINDOW_S, activityBuckets, addStrike, addonUrl, flashStrength, hourStats,
    lightningAvailable, normaliseStrike, shortClock, sinceLabel, snrBand, strikeRate,
    strikesUrl, streamUrl, trimStrikes,
} from '../lib/lightning.js';

export { lightningAvailable };

// How often the figures are recomputed. They are all "in the last minute" or "how long
// ago", so they change with the clock and not only with the strikes: a panel whose
// "last strike" reads 4s for ten minutes because nothing new arrived is worse than one
// that says 10m.
const TICK_MS = 1000;

// The bar chart, in CSS pixels. Short on purpose — it is a sparkline, and the dock
// column has better uses for the height.
const STRIP_H = 34;

/**
 * A minute of strikes: one bar per second, height by how many, colour by the hardest.
 *
 * Height is the count on a log scale, which is the only way one chart holds both a
 * distant storm at three a minute and one overhead at ten a second. A single strike is
 * already a third of the height, because on a quiet band one strike is the news.
 */
function ActivityStrip({ buckets, tone }) {
    const canvas = useRef(null);

    useEffect(() => {
        const el = canvas.current;
        if (!el) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const w = el.clientWidth || 1;
        if (el.width !== Math.round(w * dpr) || el.height !== Math.round(STRIP_H * dpr)) {
            el.width = Math.round(w * dpr);
            el.height = Math.round(STRIP_H * dpr);
        }
        const c = el.getContext('2d');
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        c.clearRect(0, 0, w, STRIP_H);

        const gap = 1;
        const bw = Math.max(1, (w - gap * (buckets.length - 1)) / buckets.length);
        buckets.forEach((b, i) => {
            if (!b.n) return;
            // log2(n+1) against a ceiling of 32 a second: 1 strike is a third of the
            // height, 3 is a half, 31 fills it.
            const h = Math.max(2, Math.min(1, Math.log2(b.n + 1) / 5) * STRIP_H);
            c.fillStyle = tone[snrBand(b.snr)];
            c.fillRect(i * (bw + gap), STRIP_H - h, bw, h);
        });
    }, [buckets, tone]);

    return <canvas ref={canvas} className="lx__strip" style={{ height: STRIP_H }} />;
}

function Stat({ label, value, sub, tone }) {
    return (
        <div className="lx__stat">
            <span className="lx__stat-k">{label}</span>
            <span className={`lx__stat-v${tone ? ` is-${tone}` : ''}`}>{value}</span>
            {sub && <span className="lx__stat-s">{sub}</span>}
        </div>
    );
}

export default function LightningPanel({ minimal }) {
    const [strikes, setStrikes] = useState([]);
    const [live, setLive] = useState(false);
    const [state, setState] = useState('loading');   // loading | ok | error
    // Redrawn on the clock as well as on strikes — see TICK_MS.
    const [now, setNow] = useState(() => Date.now());
    // The newest strike flashes the panel as it lands, as the addon's own page flashes
    // the window. Held as the strike itself rather than a boolean: the id keys the
    // element, so a second strike during the flash remounts it and starts the animation
    // again instead of being swallowed by the one already running, and the SNR decides
    // how bright it goes.
    const [flash, setFlash] = useState(null);
    const alive = useRef(true);

    useEffect(() => () => { alive.current = false; }, []);

    useEffect(() => {
        const id = setInterval(() => {
            setNow(Date.now());
            // Aged-out strikes go with the tick rather than on arrival: an hour after a
            // storm the list would otherwise sit there full until the next strike.
            setStrikes((list) => {
                const kept = trimStrikes(list);
                return kept.length === list.length ? list : kept;
            });
        }, TICK_MS);
        return () => clearInterval(id);
    }, []);

    const take = useCallback((raw, arrivedAt) => {
        const s = normaliseStrike(raw, arrivedAt);
        if (!s) return;
        setStrikes((list) => addStrike(list, s));
        // Live strikes only. The hour of backfill arrives in one lump on open, and a
        // panel that flashed sixty times on opening would be a fault, not a feature.
        if (arrivedAt != null) setFlash(s);
    }, []);

    // The hour of history behind the strip and the headline figures. One request, on
    // mount: the stream carries everything after it.
    useEffect(() => {
        fetch(strikesUrl())
            .then((r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then((rows) => {
                if (!alive.current) return;
                const list = Array.isArray(rows) ? rows : [];
                // The addon returns oldest first; the panel works newest first.
                setStrikes(trimStrikes(list.map((r) => normaliseStrike(r)).filter(Boolean).reverse()));
                setState('ok');
            })
            .catch(() => {
                if (!alive.current) return;
                // Not fatal: the stream may still connect, and a receiver that has just
                // started has no history to send. The state only decides what an empty
                // panel says.
                setState('error');
            });
    }, []);

    // ── The stream ───────────────────────────────────────────────────────────
    //
    // Same policy as the band spectrum panel: every failure closes it and reopens on the
    // backoff curve, so there is one schedule rather than the browser's running
    // alongside ours. Forever, because the panel is the subscription — closing the
    // section is how you say stop.
    useEffect(() => {
        let es = null;
        let retry = null;
        let attempts = 0;
        let stopped = false;

        const open = () => {
            es = new EventSource(streamUrl());

            es.addEventListener('open', () => setState('ok'));
            // Unnamed messages are the strikes. In the compact stream they are the only
            // thing sent besides the heartbeat.
            es.addEventListener('message', (e) => {
                attempts = 0;
                setLive(true);
                try { take(JSON.parse(e.data), Date.now()); } catch (err) { /* not a strike */ }
            });
            // Proof the addon is there on a night with no weather, which is most of
            // them: without it, "connected" and "silent" look identical.
            es.addEventListener('connected', () => { attempts = 0; setLive(true); });
            es.addEventListener('heartbeat', () => { attempts = 0; setLive(true); });

            es.addEventListener('error', () => {
                if (es) { es.close(); es = null; }
                setLive(false);
                if (stopped || retry) return;
                const wait = retryDelay(attempts);
                attempts++;
                retry = setTimeout(() => { retry = null; if (!stopped) open(); }, wait);
            });
        };

        open();
        return () => {
            stopped = true;
            clearTimeout(retry);
            if (es) es.close();
        };
    }, [take]);

    const rate = strikeRate(strikes, now);
    const { count, best } = hourStats(strikes, now);
    const last = strikes[0];
    const buckets = activityBuckets(strikes, now);
    // The strip's colours come from the theme rather than from the addon's palette, so
    // it belongs to the interface it is sitting in.
    const tone = {
        hi: 'var(--bad)',
        med: 'var(--warn)',
        lo: 'var(--accent)',
    };

    if (state === 'loading') return <Empty>Loading…</Empty>;

    return (
        <div className="stack lx">
            {/* The strike itself. Over the panel and keyed by the strike, so each one
                restarts the animation; pointer-events are off, so it never eats a click
                on anything underneath. It fades to nothing on its own and is left in
                place afterwards — at zero opacity it costs nothing, and taking it away
                on a timer would be a second thing to get wrong.

                Anyone who has asked for reduced motion gets none of it: the global rule
                in styles.css cuts every animation to a hundredth of a millisecond. */}
            {flash && (
                <span
                    key={flash.id}
                    className={`lx__flash is-${snrBand(flash.snr)}`}
                    style={{ '--lx-flash': flashStrength(flash.snr) }}
                    aria-hidden="true"
                />
            )}
            <div className="lx__stats">
                <Stat label="Rate" value={rate.toFixed(1)} sub="/min" />
                <Stat
                    label="Last"
                    value={last ? sinceLabel(last.at, now) : '—'}
                    tone={last ? snrBand(last.snr) : undefined}
                />
                <Stat label="Hour" value={count} />
                <Stat
                    label="Peak"
                    value={best == null ? '—' : Math.round(best)}
                    sub={best == null ? undefined : 'dB'}
                    tone={best == null ? undefined : snrBand(best)}
                />
            </div>

            {/* A minute of it. Always drawn, empty or not: a flat strip is the answer
                "nothing is striking", and a panel that hid it would look broken on the
                quiet nights that are most of them. */}
            <ActivityStrip buckets={buckets} tone={tone} />
            <div className="lx__axis">
                <span>{WINDOW_S}s ago</span>
                <span className={`lx__live${live ? ' is-on' : ''}`}>
                    {live ? 'live' : 'reconnecting…'}
                </span>
                <span>now</span>
            </div>

            {!minimal && (
                strikes.length === 0 ? (
                    <Empty>
                        {state === 'error'
                            ? 'The lightning addon is not answering.'
                            : 'No strikes in the last hour.'}
                    </Empty>
                ) : (
                    <ul className="lx__list">
                        {strikes.slice(0, LIST_MAX).map((s) => (
                            <li
                                key={s.id}
                                className={`lx__row is-${snrBand(s.snr)}${flash && s.id === flash.id ? ' is-new' : ''}`}
                            >
                                <span className="lx__t">{shortClock(s.time)}</span>
                                {/* The bar is the reading and the number is the detail:
                                    a column of numbers has to be read, whereas the
                                    lengths can be compared without being read. */}
                                <span className="lx__bar">
                                    <i style={{ width: `${Math.max(2, Math.min(100, (s.snr / 40) * 100))}%` }} />
                                </span>
                                <span className="lx__db">{Math.round(s.snr)}</span>
                                <span className="lx__ms" title={`${s.ms.toFixed(1)} ms`}>
                                    {s.saturated ? '⚠' : `${s.ms.toFixed(1)}m`}
                                </span>
                            </li>
                        ))}
                    </ul>
                )
            )}

            {/* The addon's page: the waveform of each strike, the VLF spectrum, the map
                and the whole log. Same new tab as the Addons panel and the SSTV panel —
                these are separate applications with their own interface. */}
            {!minimal && (
                <div className="row-end">
                    <a
                        className="btn btn--ghost btn--sm"
                        href={addonUrl()}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Open Lightning
                        <Icon.External size={13} />
                    </a>
                </div>
            )}
        </div>
    );
}
