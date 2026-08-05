// World clocks — widgets/world_clocks.widget.html as a panel.
//
// The widget's six fixed cities become a list to choose from: which clocks
// matter depends on who you are working. Clicking any face toggles all of them
// between analogue and digital, as the widget does — one choice for the panel,
// because a grid where some faces are round and some are numbers is harder to
// read than either on its own.
//
// SVG rather than the widget's canvas. There is one moving part per hand and no
// pixel work worth doing by hand, and it means the faces take their colours from
// the theme and stay sharp at any size.
//
// `minimal` is the faces alone, without the city picker.

import React, { useEffect, useState } from '../react.js';
import { Icon } from '../components/ui.jsx';
import {
    CLOCK_CITIES, MAX_CLOCKS, formatClock, handAngles, isDaylight,
    saveClockMode, saveClocks, savedClockMode, savedClocks, zoneParts,
} from '../lib/clocks.js';

// The face is drawn in a 100x100 box and scaled by CSS, so these are
// percentages of the face in all but name.
const R = 46;

function Hand({ angle, length, width, className }) {
    const rad = (angle * Math.PI) / 180;
    return (
        <line
            className={className}
            x1="50"
            y1="50"
            x2={50 + Math.sin(rad) * length}
            y2={50 - Math.cos(rad) * length}
            strokeWidth={width}
            strokeLinecap="round"
        />
    );
}

function Face({ parts }) {
    const a = handAngles(parts);
    return (
        <svg className={`wclk__face${isDaylight(parts) ? ' is-day' : ' is-night'}`} viewBox="0 0 100 100">
            <circle className="wclk__dial" cx="50" cy="50" r={R} />
            {Array.from({ length: 12 }, (_, i) => {
                const rad = (i / 12) * Math.PI * 2;
                const inner = R - (i % 3 === 0 ? 11 : 6);
                return (
                    <line
                        key={i}
                        className="wclk__tick"
                        x1={50 + Math.sin(rad) * inner}
                        y1={50 - Math.cos(rad) * inner}
                        x2={50 + Math.sin(rad) * R}
                        y2={50 - Math.cos(rad) * R}
                        strokeWidth={i % 3 === 0 ? 2.4 : 1.4}
                    />
                );
            })}
            <Hand className="wclk__hand" angle={a.hour} length={R * 0.5} width={3.6} />
            <Hand className="wclk__hand" angle={a.minute} length={R * 0.74} width={2.6} />
            <Hand className="wclk__second" angle={a.second} length={R * 0.82} width={1.4} />
            <circle className="wclk__cap" cx="50" cy="50" r="2.6" />
        </svg>
    );
}

export default function ClocksPanel({ minimal }) {
    const [cities, setCities] = useState(savedClocks);
    const [mode, setMode] = useState(savedClockMode);
    const [now, setNow] = useState(() => new Date());

    // One timer for the panel, not one per clock. A second is the right grain
    // whichever mode is on: the second hand steps, as a quartz movement does.
    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 1000);
        return () => clearInterval(id);
    }, []);

    const digital = mode === 'digital';

    const toggleMode = () => {
        const next = digital ? 'analogue' : 'digital';
        setMode(next);
        saveClockMode(next);
    };

    const setList = (next) => {
        setCities(next);
        saveClocks(next.map((c) => c.id));
    };

    const add = (id) => {
        const city = CLOCK_CITIES.find((c) => c.id === id);
        if (!city || cities.some((c) => c.id === id) || cities.length >= MAX_CLOCKS) return;
        setList([...cities, city]);
    };

    const unpicked = CLOCK_CITIES.filter((c) => !cities.some((s) => s.id === c.id));

    return (
        <div className="stack">
            <div className="wclk__grid">
                {cities.map((city) => {
                    const parts = zoneParts(city.tz, now);
                    return (
                        <div className="wclk__cell" key={city.id}>
                            <button
                                type="button"
                                className="wclk__button"
                                title={`${city.label} — ${city.tz}. Click to switch all the clocks.`}
                                onClick={toggleMode}
                            >
                                {digital || !parts
                                    ? <span className="wclk__big">{formatClock(parts, true)}</span>
                                    : <Face parts={parts} />}
                            </button>
                            <span className="wclk__city">{city.label}</span>
                            {/* Under the analogue face only: in digital the big
                                readout above already says it, to the second. */}
                            {!digital && parts && (
                                <span className="wclk__time">{formatClock(parts, false)}</span>
                            )}
                            {!minimal && (
                                <button
                                    type="button"
                                    className="wclk__remove"
                                    title={`Remove ${city.label}`}
                                    aria-label={`Remove ${city.label}`}
                                    onClick={() => setList(cities.filter((c) => c.id !== city.id))}
                                >
                                    <Icon.Close size={11} />
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>

            {!cities.length && (
                <div className="note note--tight">
                    No clocks — add a city below.
                </div>
            )}

            {!minimal && (
                <select
                    className="select"
                    value=""
                    aria-label="Add a city"
                    disabled={!unpicked.length || cities.length >= MAX_CLOCKS}
                    onChange={(e) => { add(e.target.value); e.target.value = ''; }}
                >
                    <option value="">
                        {cities.length >= MAX_CLOCKS
                            ? `${MAX_CLOCKS} clocks is the most that fits`
                            : unpicked.length ? 'Add a city…' : 'Every city is shown'}
                    </option>
                    {unpicked.map((c) => (
                        <option key={c.id} value={c.id}>{c.label}</option>
                    ))}
                </select>
            )}
        </div>
    );
}
