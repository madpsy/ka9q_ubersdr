// Space weather in full — the panel behind the top bar's one-line summary.
//
// The bar has room for five numbers (S, K, A, W and the overall grade) and a
// tooltip. This is the rest of the same /api/spaceweather reply: what each
// number means, the NOAA scales now and forecast, and the band-by-band day and
// night table, which is the part an operator actually acts on.
//
// It shares the top bar's poll rather than starting one of its own — see
// lib/spaceWeather.js, which also owns every threshold used to colour a
// reading, so the bar and the panel cannot disagree about what "good" is.

import React, { useEffect, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Empty, Icon } from '../components/ui.jsx';
import { bandForFrequency, bandRange, tuneToBand } from '../lib/bands.js';
import { loadScript } from '../lib/loadScript.js';
import {
    ageLabel, aTone, bandRows, bzLabel, bzTone, fluxLabel, fluxTone,
    gradeClass, gradeTone, kStatus, kTone, probPercent, probTone,
    scaleLabel, scaleLevel, scaleTone, subscribeSpaceWeather, updatedAt,
} from '../lib/spaceWeather.js';

const HISTORY_URL = '/spaceweather_history.html';
const POPUP_W = 1200;
const POPUP_H = 800;

// The age readout only has to be right to the minute, so it is redrawn twice a
// minute rather than every second — this panel is otherwise entirely static
// between polls.
const TICK_MS = 30000;

// v1's SunCalc, the same copy StartMap borrows for its day/night note.
const SUNCALC_JS = '/suncalc.js';

const TONE_COLOUR = { good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--bad)' };

function openHistory() {
    const left = Math.round((screen.width - POPUP_W) / 2);
    const top = Math.round((screen.height - POPUP_H) / 2);
    window.open(
        HISTORY_URL,
        'UberSDR_SpaceWeatherHistory',
        `width=${POPUP_W},height=${POPUP_H},left=${left},top=${top},resizable=yes,scrollbars=yes`,
    );
}

// Is it daylight at the receiver? Which of the two band-condition columns is
// the one in force right now, and there is no point colouring both equally when
// only one of them describes tonight.
//
// Best-effort, exactly as StartMap treats it: no position configured or the
// library will not load and the answer is null, which draws both columns plain
// rather than guessing. Guessing from the clock alone would be wrong by hours
// at high latitudes, which is where the guess would matter most.
function useDaylight(gps) {
    const [day, setDay] = useState(null);

    const lat = gps && gps.lat;
    const lon = gps && gps.lon;
    // 0,0 is the config default, not a position — the same test StatusPanel
    // applies before printing coordinates.
    const positioned = (lat || lon) && Number.isFinite(lat) && Number.isFinite(lon);

    useEffect(() => {
        if (!positioned) return undefined;
        let cancelled = false;

        const evaluate = () => {
            const SunCalc = window.SunCalc;
            if (cancelled || !SunCalc || typeof SunCalc.getTimes !== 'function') return;
            try {
                const t = SunCalc.getTimes(new Date(), lat, lon);
                const now = new Date();
                setDay(now >= t.sunrise && now < t.sunset);
            } catch (e) {
                setDay(null);
            }
        };

        loadScript(SUNCALC_JS).then(evaluate).catch(() => { /* both columns plain */ });
        // Re-checked on the same tick as the age readout, so the marker moves
        // across at sunset on a panel that has been open all day.
        const id = setInterval(evaluate, TICK_MS);
        return () => { cancelled = true; clearInterval(id); };
    }, [positioned, lat, lon]);

    return positioned ? day : null;
}

// One number with its unit and a plain-language note under it — "136 SFU /
// High". The note is the point: an operator who knows what an A-index of 9
// means does not need this panel, and one who does not is not helped by the
// figure on its own.
function Cell({ label, value, unit, note, tone }) {
    return (
        <div className="readout sw-cell">
            <div className="readout__label">{label}</div>
            <div className="readout__value" style={tone && TONE_COLOUR[tone] ? { color: TONE_COLOUR[tone] } : undefined}>
                {value}
                {unit && <span className="readout__unit">{unit}</span>}
            </div>
            {note && <div className="sw-cell__note">{note}</div>}
        </div>
    );
}

// One NOAA storm scale. Takes an already-formatted value and tone rather than
// deciding either, because the four tiles do not carry the same kind of number:
// two are levels and two are probabilities. See lib/spaceWeather.js.
function ScaleBadge({ value, tone, label, title }) {
    return (
        <div className={`sw-scale sw-scale--${tone}`} title={title}>
            <span className="sw-scale__v">{value}</span>
            <span className="sw-scale__k">{label}</span>
        </div>
    );
}

// `minimal` keeps the grade, the four indices and the storm scales — the state
// of the ionosphere — and drops the band table and the forecast, which are the
// detail you go looking for rather than glance at. See the registry's
// `minimal`.
export default function SpaceWeatherPanel({ minimal }) {
    const { serverInfo, tuning, actions } = useRadio();
    const [state, setState] = useState(null);
    const [now, setNow] = useState(() => Date.now());

    // One poll for the whole app — the top bar's summary is the other
    // subscriber. See lib/spaceWeather.js.
    useEffect(() => subscribeSpaceWeather(setState), []);

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(id);
    }, []);

    const daylight = useDaylight(serverInfo && serverInfo.receiver && serverInfo.receiver.gps);

    const sw = state && state.data;

    if (!sw) {
        return (
            <Empty>
                {state && state.error
                    ? `Space weather unavailable: ${state.error}`
                    : 'Loading space weather…'}
            </Empty>
        );
    }

    const quality = sw.propagation_quality || '';
    const at = updatedAt(sw);
    const flux = sw.solar_flux == null ? null : Math.round(sw.solar_flux);
    const k = sw.k_index == null ? null : sw.k_index;
    const a = sw.a_index == null ? null : sw.a_index;
    const bz = sw.solar_wind_bz == null ? null : sw.solar_wind_bz;

    const forecast = sw.forecast || {};
    const observedR = sw.observed_r_scale == null ? null : sw.observed_r_scale;
    const gLevel = scaleLevel(forecast.g_scale);
    // R and S come back as probabilities, and only fall back to a level on the
    // rare reply that carries one — see probPercent in lib/spaceWeather.js.
    const rMinor = probPercent(forecast.r_minor_prob);
    const rMajor = probPercent(forecast.r_major_prob);
    const sProb = probPercent(forecast.s_prob);
    const rLevel = scaleLevel(forecast.r_scale);
    const sLevel = scaleLevel(forecast.s_scale);

    const rows = bandRows(sw);
    const current = bandForFrequency(tuning.frequency);

    return (
        <div className="stack sw">
            {/* The headline the whole reply comes down to, in the colour the
                grade earns. Everything below it is the working. */}
            <div className={`sw-hero sw-hero--${gradeTone(quality)}`}>
                <div className="sw-hero__label">HF propagation</div>
                <div className="sw-hero__value">{quality || '—'}</div>
                <div className="sw-hero__age">
                    {at ? `Updated ${ageLabel(at, now)}` : 'Update time unknown'}
                </div>
            </div>

            {/* Stale inputs are shown rather than silently carried: a solar wind
                figure from three hours ago is not wrong, but it is not news
                either, and only the server knows which fields fell behind. */}
            {Array.isArray(sw.stale) && sw.stale.length > 0 && (
                <div className="note note--warn">
                    Carried over from an earlier fetch: {sw.stale.join(', ')}.
                </div>
            )}

            {state.error && (
                <div className="note note--warn">
                    Last refresh failed ({state.error}) — showing the previous reading.
                </div>
            )}

            <div className="readout-grid">
                <Cell
                    label="Solar flux"
                    value={flux == null ? '—' : flux}
                    unit="SFU"
                    note={fluxLabel(flux)}
                    tone={fluxTone(flux)}
                />
                <Cell
                    label="K-index"
                    value={k == null ? '—' : k}
                    note={[
                        sw.k_index_status || kStatus(k),
                        sw.kp == null ? '' : `Kp ${sw.kp.toFixed(2)}`,
                    ].filter(Boolean).join(' · ')}
                    tone={kTone(k)}
                />
                <Cell
                    label="A-index"
                    value={a == null ? '—' : a}
                    note="24 h average"
                    tone={aTone(a)}
                />
                <Cell
                    label="Solar wind Bz"
                    value={bz == null ? '—' : bz.toFixed(1)}
                    unit="nT"
                    note={bzLabel(bz)}
                    tone={bzTone(bz)}
                />
            </div>

            {/* NOAA's storm scales: what is happening now, then the 24-hour
                outlook. Only the radio blackout is reported as observed — an R3
                is the one thing here that takes HF away while you are sitting
                at the radio — so it leads, and the forecast follows in G, R, S
                order. */}
            <div className="sw-scales">
                <ScaleBadge
                    value={scaleLabel('R', observedR)}
                    tone={scaleTone(observedR)}
                    label="Blackout now"
                    title={observedR == null
                        ? 'No blackout level reported'
                        : observedR === 0
                            ? 'No radio blackout in progress'
                            : `NOAA R${observedR}: HF absorption on the sunlit side of the earth right now`}
                />
                <ScaleBadge
                    value={scaleLabel('G', gLevel)}
                    tone={scaleTone(gLevel)}
                    label="Storm 24 h"
                    title={`Geomagnetic storm forecast: ${forecast.geomagnetic_storm || forecast.g_text || 'unknown'}`}
                />
                {/* Probability, not a level: NOAA forecasts flares as odds. The
                    R3+ figure rides in the tooltip — one number on the tile, and
                    it is the one that is almost always the larger. */}
                <ScaleBadge
                    value={rLevel != null ? scaleLabel('R', rLevel) : rMinor == null ? '—' : `${rMinor}%`}
                    tone={rLevel != null ? scaleTone(rLevel) : probTone(rMinor)}
                    label="R1+ 24 h"
                    title={[
                        rMinor == null ? '' : `${rMinor}% chance of an R1 or greater blackout in 24 hours`,
                        rMajor == null ? '' : `${rMajor}% chance of R3 or greater`,
                    ].filter(Boolean).join('\n') || 'No blackout forecast issued'}
                />
                <ScaleBadge
                    value={sLevel != null ? scaleLabel('S', sLevel) : sProb == null ? '—' : `${sProb}%`}
                    tone={sLevel != null ? scaleTone(sLevel) : probTone(sProb)}
                    label="S1+ 24 h"
                    title={sProb == null
                        ? 'No radiation storm forecast issued'
                        : `${sProb}% chance of an S1 or greater solar radiation storm in 24 hours`}
                />
            </div>

            {!minimal && (
                <>
                    <div className="divider" />

                    {/* Day and night side by side, because that is the choice
                        being made: whether to stay on 20m or drop to 40m in an
                        hour. The column that is in force at the receiver right
                        now is the lit one. */}
                    <div className="sw-bands">
                        <div className="sw-bands__head">
                            <span>Band</span>
                            <span className={daylight === true ? 'is-now' : ''}>Day</span>
                            <span className={daylight === false ? 'is-now' : ''}>Night</span>
                        </div>
                        {rows.map((r) => {
                            const range = bandRange(r.band);
                            const tip = range
                                ? `${r.band} — day ${r.day || 'unknown'}, night ${r.night || 'unknown'}\nClick to tune`
                                : `${r.band} — day ${r.day || 'unknown'}, night ${r.night || 'unknown'}`;
                            return (
                                <button
                                    key={r.band}
                                    type="button"
                                    className={`sw-bands__row${r.band === current ? ' is-current' : ''}`}
                                    title={tip}
                                    disabled={!range}
                                    onClick={() => range && tuneToBand(actions, range.min, range.max)}
                                >
                                    <span className="sw-bands__band">{r.band}</span>
                                    <span className={`sw-grade sw-grade--${gradeClass(r.day)}${daylight === false ? ' is-off' : ''}`}>
                                        {r.day || '—'}
                                    </span>
                                    <span className={`sw-grade sw-grade--${gradeClass(r.night)}${daylight === true ? ' is-off' : ''}`}>
                                        {r.night || '—'}
                                    </span>
                                </button>
                            );
                        })}
                        {rows.length === 0 && <Empty>No band conditions reported.</Empty>}
                    </div>

                    {(forecast.geomagnetic_storm || forecast.radio_blackout || forecast.solar_radiation) && (
                        <>
                            <div className="divider" />
                            {/* NOAA's own wording for the next 24 hours. Its
                                one-line summary is these three sentences run
                                together, so it is the tooltip rather than a
                                fourth line repeating them. */}
                            <div className="sw-forecast" title={forecast.summary || undefined}>
                                <div className="sw-forecast__head">Next 24 hours</div>
                                <div className="kv-list">
                                    {forecast.geomagnetic_storm && (
                                        <div className="kv">
                                            <span className="kv__k">Geomagnetic</span>
                                            <span className="kv__v">{forecast.geomagnetic_storm}</span>
                                        </div>
                                    )}
                                    {forecast.radio_blackout && (
                                        <div className="kv">
                                            <span className="kv__k">Blackout</span>
                                            <span className="kv__v">{forecast.radio_blackout}</span>
                                        </div>
                                    )}
                                    {forecast.solar_radiation && (
                                        <div className="kv">
                                            <span className="kv__k">Radiation</span>
                                            <span className="kv__v">{forecast.solar_radiation}</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </>
                    )}

                    <Button
                        size="sm"
                        variant="ghost"
                        icon={<Icon.External size={13} />}
                        title="Charts of solar flux and the indices over time"
                        onClick={openHistory}
                    >
                        History
                    </Button>
                </>
            )}
        </div>
    );
}
