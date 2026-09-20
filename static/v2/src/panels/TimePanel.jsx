// Time: what the NTP addon is hearing, in a dock column.
//
// The clock, ticking on the broadcast second rather than on this machine's; local time
// beside it; how far out this machine actually is, drawn as well as written; and where the
// time is coming from. The addon's own page has the signal path, every source's delay model,
// the event log and a day of charts, and there is a link to it at the bottom — this is the
// glance, not the workbench. Same bargain as the Lightning panel next door.
//
// ── Two things that are not obvious ──────────────────────────────────────────
//
// The clock is written straight to the DOM, not through state. It is redrawn every animation
// frame, because a display showing milliseconds has to be; a setState per frame would
// re-render the panel sixty times a second to change four characters. Everything that moves
// slowly — the reference, the figures, the dial — is ordinary state and re-renders when it
// changes, which is rarely. With the fraction switched off there is nothing on screen that
// moves faster than once a second, and the animation frame is dropped for a timer that
// re-aims itself at each corrected second — so that switch is a real saving, not a cosmetic
// one. See draw() and the two drivers under it.
//
// Nothing is fetched unless the panel is on screen. A dock column is taller than the window,
// so an open panel three screens down was still polling; useInView is the gate for that, and
// the feed gate is the one for a stopped receiver. Both, plus document.hidden for a
// backgrounded tab, and the cost of this panel while nobody is looking at it is zero.
// See lib/ntpTime.js for why it polls at all rather than holding the addon's event stream.
//
// `minimal` keeps the clock, the local time, this device's error and the reference, and
// drops the date, the dial, the figures and the link. Those four are the panel — "what time
// is it, is my clock right, and says who" — and they fit on three lines. The reference is
// the one of the four somebody may not want on a phone, so the full view carries a switch
// for it; both switches there are preferences about this machine and are remembered.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Icon, Switch } from '../components/ui.jsx';
import {
    BURST_GAP_MS, FETCH_TIMEOUT_MS, POLL_MS, WINDOW,
    addSample, addonUrl, bestEstimate, clockAsleep, clockParts, deviceError, deviceLabel,
    deviceTone, deviceWithin, dialEdge, dialPos, dialSpan, dispersionTone, formatDur,
    formatMs, localIsUtc, newClock, nextSecondDelay, ntpAvailable, referenceKey, referenceOf,
    sampleFrom, saveMinRef, saveShowMs, savedMinRef, savedShowMs, servingNote, staleStatus,
    statusUrl, timeUrl, zoneLabel,
} from '../lib/ntpTime.js';
import useFeedsAllowed from '../lib/useServerFeeds.js';
import useInView from '../lib/useInView.js';

export { ntpAvailable };

// How long the tick dot stays lit. Long enough to catch out of the corner of an eye, short
// enough that two seconds never overlap.
const DOT_MS = 140;

// How often the slow figures are recomputed — the device error, the reference age. They are
// all "how far out" or "how long ago", so they change with the clock and not only with the
// data.
const TICK_MS = 1000;

function Stat({ label, value, sub, tone, title }) {
    return (
        <div className="tm__stat" title={title}>
            <span className="tm__stat-k">{label}</span>
            <span className={`tm__stat-v${tone ? ` is-${tone}` : ''}`}>{value}</span>
            {sub && <span className="tm__stat-s">{sub}</span>}
        </div>
    );
}

/**
 * This device's clock against the broadcast, drawn.
 *
 * The broadcast is the centre line. The band around it is what the measurement itself cannot
 * resolve — half the round trip, near enough — so a marker inside the band is a clock that
 * is right as far as anyone here can tell, and the width of the band is the honest part: on
 * a slow path it is wide, and the panel says so rather than quoting a figure it cannot
 * stand behind.
 */
function Dial({ device, within, span }) {
    const pos = dialPos(device, span);
    const bandFrom = dialPos(-(within || 0), span);
    const bandTo = dialPos(within || 0, span);
    return (
        <div className="tm__dial">
            <div className="tm__dial-track">
                <i
                    className="tm__dial-band"
                    style={{ left: `${bandFrom * 100}%`, width: `${(bandTo - bandFrom) * 100}%` }}
                />
                <i className="tm__dial-zero" />
                <i className="tm__dial-mark" style={{ left: `${pos * 100}%` }} />
            </div>
            <div className="tm__dial-axis">
                <span>−{dialEdge(span)}</span>
                <span>broadcast</span>
                <span>+{dialEdge(span)}</span>
            </div>
        </div>
    );
}

export default function TimePanel({ minimal }) {
    const wrap = useRef(null);
    const feeds = useFeedsAllowed();
    const inView = useInView(wrap);
    // The whole cost of this panel is behind these two. See the header.
    const running = feeds && inView;

    // The measurement. A ref rather than state: it changes on every sample and the clock is
    // painted from it per frame, so re-rendering on it would be sixty renders a second for
    // a number that is already on the screen.
    const clock = useRef(newClock());
    // The last /api/time and /api/status, which are what the figures are drawn from.
    const [time, setTime] = useState(null);
    const [status, setStatus] = useState(null);
    const [state, setState] = useState('loading');   // loading | ok | error
    // Whether the fraction is drawn, which is also what decides the paint driver below.
    // Remembered, because it is a preference about this machine rather than about this
    // session — see lib/ntpTime.js. It applies wherever the panel is drawn, as the minimal
    // flag itself does: the switch is only offered in the full view, because that is where
    // there is room for it, but turning it off there turns it off on the phone as well,
    // which is where the saving is worth most.
    const [showMs, setShowMs] = useState(savedShowMs);
    // Whether the reference survives into the minimal view — see lib/ntpTime.js. Remembered
    // the same way and for the same reason; the full view shows it either way.
    const [minRef, setMinRef] = useState(savedMinRef);
    const showRef = !minimal || minRef;
    // Bumped whenever the estimate changes enough to be worth redrawing the slow figures.
    const [, setBeat] = useState(0);

    // The elements the clock is written into. See paint().
    const utcEl = useRef(null);
    const fracEl = useRef(null);
    const dateEl = useRef(null);
    const localEl = useRef(null);
    const dotEl = useRef(null);

    // Status bookkeeping, kept out of state because none of it is drawn: which reference the
    // current document was fetched for, when, and whether a request is already out.
    const statusKey = useRef(null);
    const statusAt = useRef(0);
    const statusBusy = useRef(false);

    // ── The clock ────────────────────────────────────────────────────────────
    //
    // Redrawn every frame while the panel is on screen. A frame drawn now is on the glass at
    // the next vsync, roughly one frame after this callback's timestamp, so that is the
    // instant to draw — the addon's own page does the same, and at a millisecond readout it
    // is the difference between a clock that reads right and one that is a frame late.
    // With the fraction hidden there is nothing on screen that changes faster than once a
    // second, so the animation frame is dropped for a timer that re-aims itself at each
    // corrected second boundary — see nextSecondDelay. Both drivers share one draw().
    useEffect(() => {
        if (!running) return undefined;
        let raf = 0;
        let timer = 0;
        let lastTs = 0;
        let frameMs = 1000 / 60;
        let shownHms = null;
        let shownSec = null;
        let dotTimer = 0;

        /** @param at  the instant to draw for, on the page's monotonic clock. */
        const draw = (at) => {
            const est = bestEstimate(clock.current, at);
            // Until something has answered, this machine's own clock — clearly labelled as
            // such below. A blank panel would be the one thing worse than an unchecked clock.
            const t = est ? at + est.theta : Date.now();

            const utc = clockParts(t, true);
            // Only when it changes: at 60 Hz this is 59 assignments a second of the string
            // that is already there, each one an attribute write the browser has to consider.
            if (utcEl.current && shownHms !== utc.hms) {
                utcEl.current.textContent = utc.hms;
                shownHms = utc.hms;
            }
            if (showMs && fracEl.current) fracEl.current.textContent = `.${utc.frac}`;

            const sec = Math.floor(t / 1000);
            if (sec === shownSec) return t;
            shownSec = sec;

            // Once a second: the date, the local reading, and the dot. The dot marks the
            // second as *displayed*, which is the corrected one.
            const d = new Date(t);
            if (localEl.current) localEl.current.textContent = clockParts(t, false).hms;
            if (dateEl.current) {
                dateEl.current.textContent = d.toLocaleDateString('en-GB', {
                    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
                });
            }
            if (dotEl.current) {
                const el = dotEl.current;
                el.classList.add('is-on');
                clearTimeout(dotTimer);
                dotTimer = setTimeout(() => el.classList.remove('is-on'), DOT_MS);
            }
            return t;
        };

        // Per frame, for the fraction. A frame drawn now is on the glass at the next vsync,
        // roughly one frame interval after this callback's timestamp, so that is the instant
        // to draw for — at a millisecond readout that is the difference between a clock that
        // reads right and one that is visibly a frame behind.
        const perFrame = (ts) => {
            raf = requestAnimationFrame(perFrame);
            if (lastTs) {
                const dt = ts - lastTs;
                if (dt > 4 && dt < 50) frameMs += (dt - frameMs) * 0.05;
            }
            lastTs = ts;
            draw(ts + frameMs);
        };

        // Once a second, aimed just past the boundary of the corrected second rather than
        // set free-running at 1000 ms, so it cannot drift into painting the second before.
        const perSecond = () => {
            const t = draw(performance.now());
            timer = setTimeout(perSecond, nextSecondDelay(t));
        };

        if (showMs) raf = requestAnimationFrame(perFrame);
        else perSecond();

        return () => {
            cancelAnimationFrame(raf);
            clearTimeout(timer);
            clearTimeout(dotTimer);
        };
    }, [running, showMs]);

    // The slow figures, on the clock as well as on the data: "reference age 4s" that reads 4s
    // for ten minutes because nothing new arrived is worse than one that says 10m.
    useEffect(() => {
        if (!running) return undefined;
        const id = setInterval(() => setBeat((n) => n + 1), TICK_MS);
        return () => clearInterval(id);
    }, [running]);

    // ── The expensive document, read as rarely as it can be ──────────────────
    const loadStatus = useCallback((key) => {
        if (statusBusy.current) return;
        statusBusy.current = true;
        fetch(statusUrl())
            .then((r) => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then((d) => {
                statusKey.current = key;
                statusAt.current = Date.now();
                setStatus(d);
            })
            .catch(() => {
                // Not fatal and not reported: /api/time is the one that has to work, and it
                // carries the stratum and the refid. This only names the sources.
                statusAt.current = Date.now();
            })
            .finally(() => { statusBusy.current = false; });
    }, []);

    // ── The measurement ──────────────────────────────────────────────────────
    useEffect(() => {
        if (!running) return undefined;
        let stopped = false;
        let timer = 0;
        let seq = 0;
        // A burst fills the filter so the panel is showing a corrected time within a couple
        // of seconds of being looked at; after that it settles to POLL_MS.
        let burst = WINDOW - 1;
        let wallMinusPerf = null;

        const schedule = (ms) => {
            clearTimeout(timer);
            timer = setTimeout(run, ms);
        };

        const takeSample = async () => {
            const url = new URL(timeUrl(++seq), window.location.href).href;
            const ctl = new AbortController();
            const kill = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
            let d;
            let t0;
            let t3;
            try {
                t0 = performance.now();
                const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
                t3 = performance.now();
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                d = await r.json();
            } finally {
                clearTimeout(kill);
            }

            // Resource Timing gives the instants the request reached the socket and the first
            // response byte came back, which is a tighter pair than fetch()'s own — see
            // lib/ntpTime.js. Where the entry is missing, the fetch's own instants still work.
            // The entry is recorded when the body completes, which some browsers do a task
            // or two after the promise resolves — hence the wait rather than one look.
            let entry = null;
            for (let i = 0; i < 5 && !entry; i++) {
                const list = performance.getEntriesByName(url, 'resource');
                if (list.length) entry = list[list.length - 1];
                else await new Promise((res) => { setTimeout(res, 20); });
            }
            // Or the buffer fills and entries stop being recorded at all.
            performance.clearResourceTimings();
            const precise = entry && entry.requestStart > 0 && entry.responseStart >= entry.requestStart;
            const sent = precise ? entry.requestStart : t0;
            const got = precise ? entry.responseStart : t3;
            return { d, sample: sampleFrom(d, sent, got) };
        };

        const run = async () => {
            timer = 0;
            if (stopped) return;
            // A hidden tab has nothing to show, and a sample taken while timers are being
            // held back is late for reasons that say nothing about the clock.
            if (typeof document !== 'undefined' && document.hidden) { schedule(POLL_MS); return; }

            // The page's monotonic clock against its wall clock. The two coming apart is how
            // this finds out the machine slept, and every sample taken before it is suspect.
            const now = Date.now() - performance.now();
            if (clockAsleep(now, wallMinusPerf)) {
                clock.current = newClock();
                burst = WINDOW - 1;
            }
            wallMinusPerf = now;

            try {
                const { d, sample } = await takeSample();
                if (stopped) return;
                if (sample) clock.current = addSample(clock.current, sample);
                setTime(d);
                setState('ok');
                const key = referenceKey(d);
                if (staleStatus(statusKey.current, key, Date.now() - statusAt.current)) {
                    loadStatus(key);
                }
            } catch (err) {
                if (stopped) return;
                // One failure is a dropped packet; the panel keeps the estimate it has and
                // tries again. `state` only decides what an empty panel says.
                if (!clock.current.list.length) setState('error');
            }
            if (stopped) return;
            if (burst > 0) { burst--; schedule(BURST_GAP_MS); } else schedule(POLL_MS);
        };

        // Coming back to a tab is the moment the estimate is most likely to be stale and the
        // moment somebody is looking at it, so it re-converges rather than waiting out a poll.
        const onVisible = () => {
            if (stopped || document.hidden) return;
            burst = WINDOW - 1;
            schedule(0);
        };
        document.addEventListener('visibilitychange', onVisible);
        schedule(0);

        return () => {
            stopped = true;
            clearTimeout(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [running, loadStatus]);

    // ── What is drawn ────────────────────────────────────────────────────────
    const est = bestEstimate(clock.current, performance.now());
    const synced = !!est;
    const device = deviceError(est, Date.now(), performance.now());
    const within = deviceWithin(est);
    const tone = deviceTone(device, within);
    const ref = referenceOf(time, status);
    const note = servingNote(status);
    const span = dialSpan(device, within);
    const localSame = localIsUtc(new Date());

    const devText = synced ? deviceLabel(device, within) : 'measuring…';

    return (
        <div className="stack tm" ref={wrap}>
            {/* The clock. `is-free` while nothing has answered: the figures are this
                machine's own clock, which is precisely the thing this panel exists to
                check, so it is drawn dimmed and says so rather than passing itself off
                as the broadcast. */}
            <div className={`tm__clock${synced ? '' : ' is-free'}`}>
                <div className="tm__now">
                    <span ref={utcEl} className="tm__hms">--:--:--</span>
                    {showMs && <span ref={fracEl} className="tm__frac">.000</span>}
                    <span ref={dotEl} className="tm__dot" aria-hidden="true" />
                </div>
                {!minimal && (
                    <div className="tm__date">
                        <span ref={dateEl}>&nbsp;</span>
                        <span className="tm__zone">UTC</span>
                    </div>
                )}
            </div>

            {/* Local time, always — a clock that shows only UTC is half a clock in a shack.
                Where the machine is itself on UTC the two readings agree, and the label says
                so rather than leaving it looking like the same figure drawn twice. */}
            <div className="tm__local">
                <span ref={localEl} className="tm__local-v">--:--:--</span>
                <span className="tm__local-k">
                    {localSame ? 'local · this machine is on UTC' : (minimal ? 'local' : zoneLabel(new Date()))}
                </span>
            </div>

            {/* Where it came from. A pill for the class, and under it the sources that are
                actually in the answer — which is the question "says who", and the one a
                radio clock has an interesting answer to. */}
            {showRef && (
                <div className="tm__ref" title={ref.detail || undefined}>
                    <span className={`tm__ref-pill is-${ref.kind}`}>{ref.text}</span>
                    <span className="tm__ref-sub">{ref.sub}</span>
                </div>
            )}
            {showRef && note && <div className={`tm__note is-${note.tone}`}>{note.text}</div>}

            {/* This device. The headline in the minimal view is the sentence; the dial is
                what makes the sentence mean something, and it is the first thing to go. */}
            <div
                className="tm__dev"
                title={
                    'Your own computer or phone, compared with the broadcast time above — nothing to do with the '
                    + 'server, and the times shown here do not use it. The comparison is corrected by half the '
                    + 'measured round trip to the server, which is exact only if the path is the same both ways: '
                    + 'no measurement can tell how a round trip splits, so a proxy or a tunnel that buffers one '
                    + 'direction more than the other is an error this cannot see.'
                }
            >
                <span className="tm__dev-k">This device</span>
                <span className={`tm__dev-v is-${tone}`}>{devText}</span>
            </div>
            {!minimal && synced && <Dial device={device} within={within} span={span} />}

            {!minimal && (
                <div className="tm__stats">
                    <Stat
                        label="Stratum"
                        value={time && time.synchronised ? String(time.stratum) : '—'}
                        sub={time && time.synchronised && time.stratum === 1 ? 'radio' : 'via net'}
                        tone={time && time.synchronised ? (time.stratum === 1 ? 'ok' : 'warn') : 'bad'}
                        title="1 is a radio reference with no NTP path above it. Higher means the time has failed over to an upstream server."
                    />
                    <Stat
                        label="Spread"
                        value={time ? formatMs(time.dispersion_ms) : '—'}
                        sub="ms"
                        tone={dispersionTone(time && time.dispersion_ms)}
                        title="Root dispersion: how far out the server says its own time could be. The panel's own measurement is on top of this."
                    />
                    <Stat
                        label="Sources"
                        value={time ? String(time.sources_used) : '—'}
                        sub={status && status.served ? `of ${status.served.sources_candidate}` : 'in use'}
                        title="How many sources are in the served answer, of those ready to be."
                    />
                    <Stat
                        label="Age"
                        value={time ? formatDur(time.reference_age_seconds) : '—'}
                        title="How long since the reference last spoke."
                    />
                </div>
            )}

            {!minimal && time && time.leap_pending && (
                <div className="tm__note is-warn">Leap second pending at the end of the month</div>
            )}

            {!minimal && !synced && (
                <div className="tm__note is-dim">
                    {state === 'error'
                        ? 'The time addon is not answering — showing this device’s own clock.'
                        : 'Measuring the path to the server — showing this device’s own clock.'}
                </div>
            )}

            {/* The addon's page: the signal path, every source's delay model, the event log
                and the history. Same new tab as the Addons panel and the Lightning panel —
                these are separate applications with their own interface. */}
            {!minimal && (
                <div className="tm__foot">
                    <div className="tm__foot-opts">
                        {/* Turning this off is a real saving and not a cosmetic one: with no
                            fraction on screen the panel stops repainting per frame and
                            redraws once a second instead. See the paint effect. */}
                        <Switch
                            checked={showMs}
                            onChange={(on) => { setShowMs(on); saveShowMs(on); }}
                            label="ms"
                            title={
                                'Show milliseconds. They are the proof the clock is ticking with '
                                + 'the broadcast rather than with this machine — and drawing them '
                                + 'costs an animation frame a second for as long as the panel is on '
                                + 'screen, so turning them off drops the panel to one redraw a second.'
                            }
                        />
                        {/* Only about the cut-down view: the reference is always shown here,
                            where there is room for it. */}
                        <Switch
                            checked={minRef}
                            onChange={(on) => { setMinRef(on); saveMinRef(on); }}
                            label="source"
                            title={
                                'Keep the reference — the station or server the time is coming from, '
                                + 'and any failover — in the cut-down view. It is always shown here. '
                                + 'Nothing is fetched either way.'
                            }
                        />
                    </div>
                    <a
                        className="btn btn--ghost btn--sm"
                        href={addonUrl()}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        Open Time
                        <Icon.External size={13} />
                    </a>
                </div>
            )}
        </div>
    );
}
