// How each band is actually measuring, from the noise floor monitor.
//
// static/noisefloor.html's dashboard, compressed into a dock column. That page
// is a survey — every band's card, four 24-hour charts, a 0–30 MHz spectrum —
// and it is the right shape for a browser window somebody has gone to look at.
// Beside the dial there is room for one question: how is the band I am on, and
// which band should I be on instead. So this is one band's numbers in full, with
// every measured band under it as a table you can read down and tune from.
//
// The picker is the band spectrum panel's, and means the same thing: Auto
// follows the dial, and pinning a band is for watching one you are not listening
// to. Same wording, same fallback when a pin names a band the monitor no longer
// watches — see lib/bandNoise.js `followsDial`.
//
// The data is one request a minute for the whole panel, and only while the panel
// is open: Section unmounts a closed section's body, so a collapsed panel holds
// no timer and makes no request. The once-a-minute rule survives being opened
// and closed repeatedly, which a bare timer would not — see lib/bandNoise.js.
//
// `minimal` is the band, its condition and the two figures that decide whether
// to stay on it: the noise floor and the dynamic range. The picker, the rest of
// the readouts and the all-bands table are what you expand for.

import React, { useEffect, useMemo, useState } from '../react.js';
import { Empty, Icon } from '../components/ui.jsx';
import { useRadio } from '../radio/RadioContext.jsx';
import { bandForFrequency, bandRange, tuneToBand } from '../lib/bands.js';
import {
    chooseBand, floorStats, floorTone, followsDial, formatFigure, getBandNoise, hasFT8,
    measuredMs, rowsFrom, saveBand, savedBand, snrLabel, snrTone, subscribeBandNoise,
} from '../lib/bandNoise.js';
import { sinceLabel } from '../lib/format.js';

// The full page, for the questions a dock column cannot answer — 24 hours of
// anything, or the whole 0–30 MHz at once.
const MONITOR_URL = '/noisefloor.html';

// The age readout is redrawn on this, not on the poll: a measurement a minute
// old should say so before the next one lands, or a stalled monitor reads as a
// fresh one. Ten seconds is finer than the data and far cheaper than the second
// ticks elsewhere in the app — this panel is otherwise static between polls.
const TICK_MS = 10000;

// One measurement, labelled. The unit lives on the cell rather than in the
// value so a column of them lines up on the decimal point, which is the whole
// reason these are monospace.
function Cell({ label, value, unit, tone, title }) {
    return (
        <div className={`readout bst-cell${tone && tone !== 'none' ? ` bst-cell--${tone}` : ''}`} title={title}>
            <div className="readout__label">{label}</div>
            <div className="readout__value">
                {value}
                {unit && <span className="readout__unit">{unit}</span>}
            </div>
        </div>
    );
}

export default function BandStatsPanel({ minimal }) {
    const { tuning, actions } = useRadio();
    const [feed, setFeed] = useState(getBandNoise);
    const [pref, setPrefState] = useState(savedBand);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => subscribeBandNoise(setFeed), []);

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(id);
    }, []);

    const rows = useMemo(() => rowsFrom(feed.latest), [feed.latest]);
    const stats = useMemo(() => floorStats(rows), [rows]);

    const dialBand = bandForFrequency(tuning.frequency);
    const band = chooseBand(pref, rows, dialBand);
    const m = band ? rows.find((r) => r.band === band) : null;
    const auto = followsDial(pref, rows);

    const pin = (name) => {
        saveBand(name);
        setPrefState(name);
    };

    // Tuning to a band the monitor measures is the point of the table, so a row
    // does what the band keys do — the middle of the band, the band's sideband,
    // the spectrum zoomed to it. A pinned panel re-pins as it goes, so it does
    // not end up showing 20m while the receiver sits on 40m without being asked.
    const go = (name) => {
        const range = bandRange(name);
        if (!range) return;
        if (!auto) pin(name);
        tuneToBand(actions, range.min, range.max);
    };

    if (feed.latest === null) {
        return <Empty>{feed.error ? `Noise floor unavailable: ${feed.error}` : 'Loading band measurements…'}</Empty>;
    }
    if (!m) {
        return (
            <div className="stack">
                <Empty>No band measurements yet — the monitor reports once a minute.</Empty>
                {feed.error && <div className="note note--warn">Last refresh failed ({feed.error}).</div>}
            </div>
        );
    }

    const at = measuredMs(m);
    const tone = snrTone(m);
    const fTone = floorTone(m.p5_db, stats);

    return (
        <div className="stack bst">
            {!minimal && (
                <div className="bst__pick">
                    <select
                        className="select"
                        value={auto ? 'auto' : pref}
                        onChange={(e) => pin(e.target.value)}
                        title="Which band this panel reports. Auto follows the dial"
                        aria-label="Band"
                    >
                        {/* Auto says what it resolved to, so the row is not read
                            twice to find out which band the numbers belong to. */}
                        <option value="auto">{auto ? `Auto — ${band}` : 'Auto'}</option>
                        {rows.map((r) => (
                            <option key={r.band} value={r.band}>{r.band}</option>
                        ))}
                    </select>
                    <span className="bst__age" title={at ? new Date(at).toLocaleString() : 'No measurement time reported'}>
                        {at ? `${sinceLabel(at, now)} ago` : '—'}
                    </span>
                </div>
            )}

            {/* The headline: which band, and what the FT8 traffic on it says
                about whether it is open. Everything under it is the working. */}
            <div className={`bst-hero bst-hero--${tone}`}>
                <div className="bst-hero__label">{minimal && auto ? 'Band — auto' : 'Band'}</div>
                <div className="bst-hero__value">
                    <span className="bst-hero__band">{band}</span>
                    <span className="bst-hero__grade">{snrLabel(m)}</span>
                </div>
                <div className="bst-hero__foot">
                    {hasFT8(m)
                        ? `FT8 SNR ${formatFigure(m.ft8_snr)} dB`
                        : 'No FT8 heard in the last measurement'}
                    {minimal && at ? ` · ${sinceLabel(at, now)} ago` : ''}
                </div>
            </div>

            {feed.error && (
                <div className="note note--warn">
                    Last refresh failed ({feed.error}) — showing the previous measurement.
                </div>
            )}

            {/* The two figures a band is judged on, then — expanded — the rest of
                what the monitor measured. The labels are in words where the full
                page uses percentiles: "Noise floor" rather than "P5". The
                percentile is in the tooltip instead, so somebody reading this
                beside noisefloor.html or the API can see they are the same
                number without the panel itself being written in shorthand. */}
            <div className="readout-grid">
                <Cell
                    label="Noise floor"
                    value={formatFigure(m.p5_db)}
                    unit="dB"
                    tone={fTone}
                    title={`P5 — the 5th percentile of this band's bins.${
                        fTone === 'good' ? '\nAmong the quietest bands on this receiver.'
                            : fTone === 'bad' ? '\nAmong the noisiest bands on this receiver.' : ''}`}
                />
                <Cell
                    label="Dynamic range"
                    value={formatFigure(m.dynamic_range)}
                    unit="dB"
                    title="P95 − P5: how far the strongest signals stand above the floor. The room the band has for a weak signal"
                />
                {!minimal && (
                    <>
                        <Cell
                            label="Signal peak"
                            value={formatFigure(m.p95_db)}
                            unit="dB"
                            title="P95 — the 95th percentile, i.e. the level the strongest few percent of the band reach"
                        />
                        <Cell
                            label="Occupancy"
                            value={formatFigure(m.occupancy_pct)}
                            unit="%"
                            title="Share of the band's bins more than 10 dB above the noise floor — how busy it is"
                        />
                        <Cell
                            label="Median"
                            value={formatFigure(m.median_db)}
                            unit="dB"
                            title="The middle bin of the band. Well above the floor means the whole band is lifted, not just the signals in it"
                        />
                        <Cell
                            label="Max"
                            value={formatFigure(m.max_db)}
                            unit="dB"
                            title="The single strongest bin in the band"
                        />
                    </>
                )}
            </div>

            {!minimal && rows.length > 1 && (
                <>
                    <div className="divider" />

                    {/* Every measured band at once — the part of noisefloor.html
                        worth carrying over, because "which band should I be on"
                        is not answerable from one band's card. Floor and SNR
                        only: the two columns you scan, with the rest a click
                        away by selecting the band. */}
                    <div className="bst-table">
                        <div className="bst-table__head">
                            <span>Band</span>
                            <span>Floor</span>
                            <span>FT8 SNR</span>
                        </div>
                        {rows.map((r) => {
                            const range = bandRange(r.band);
                            const rt = snrTone(r);
                            return (
                                <button
                                    key={r.band}
                                    type="button"
                                    className={`bst-table__row${r.band === band ? ' is-current' : ''}`}
                                    disabled={!range}
                                    title={[
                                        `${r.band} — ${snrLabel(r)}`,
                                        `Noise floor ${formatFigure(r.p5_db)} dB · range ${formatFigure(r.dynamic_range)} dB · ${formatFigure(r.occupancy_pct)}% occupied`,
                                        range ? 'Click to tune' : 'Not one of the amateur bands — nothing to tune to',
                                    ].join('\n')}
                                    onClick={() => go(r.band)}
                                >
                                    <span className="bst-table__band">{r.band}</span>
                                    <span className={`bst-table__num bst-cell--${floorTone(r.p5_db, stats)}`}>
                                        {formatFigure(r.p5_db)}
                                    </span>
                                    <span className={`bst-table__grade bst-grade bst-grade--${rt}`}>
                                        {hasFT8(r) ? formatFigure(r.ft8_snr) : '—'}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    {/* Where the questions this panel raises but cannot answer
                        get answered: 24 hours of any of these figures, the full
                        HF spectrum, and the same numbers for a day last week.
                        Not in the minimal view, like every other link out of a
                        panel. */}
                    <div className="bst__foot">
                        <a
                            className="btn btn--ghost btn--sm"
                            href={MONITOR_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            Noise Floor Monitor
                            <Icon.External size={13} />
                        </a>
                    </div>
                </>
            )}
        </div>
    );
}
