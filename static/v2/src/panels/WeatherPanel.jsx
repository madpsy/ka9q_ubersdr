// Terrestrial weather where the receiver is.
//
// Worth a panel on a receiver rather than being a curiosity: what the sky is
// doing is what the noise floor is doing. A thunderstorm two counties away is
// the crashes on 80m, and what the wind is up to decides whether anyone wants to
// turn the beam.
//
// The endpoint returns OWM's whole current-weather document; only the readings
// an operator would act on are shown. Dropped deliberately: the station id and
// coordinates, the response code, sea-level and ground-level pressure (the same
// figure twice over for anywhere near the sea), and the day's min/max, which for
// a current-conditions reading are mostly the current temperature again.
//
// `minimal` is the glance: what it is doing, how warm, and the wind. Everything
// else — humidity, pressure, cloud, visibility, sun times, where and when the
// reading came from — is the full panel.

import React, { useEffect, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Icon } from '../components/ui.jsx';
import { countryFlag } from '../lib/format.js';
import {
    ageLabel, beaufort, beaufortName, fetchWeather, localTime, round, windDirection, windKmh,
} from '../lib/weather.js';
import { feedInterval } from '../lib/serverFeeds.js';

// The server refreshes every fifteen minutes, so asking more often than every
// five buys nothing. Unforced, so this goes through the cache the spectrum's
// station-ID block shares — only Refresh insists on a request of its own.
const POLL_MS = 5 * 60 * 1000;

function Reading({ label, value, title }) {
    if (value == null || value === '') return null;
    return (
        <div className="wx__cell" title={title}>
            <span className="wx__cell-label">{label}</span>
            <span className="wx__cell-value">{value}</span>
        </div>
    );
}

export default function WeatherPanel({ minimal }) {
    const { serverInfo } = useRadio();
    const [state, setState] = useState({ loading: true });
    const [, setTick] = useState(0);

    useEffect(() => {
        let alive = true;
        const load = (force) => fetchWeather({ force }).then((r) => {
            if (alive) setState({ ...r, loading: false });
        });
        const stop = feedInterval(() => load(false), POLL_MS);
        return () => { alive = false; stop(); };
    }, []);

    // Only so "20 mins ago" keeps counting while the panel sits open. `tick` is
    // never read; re-rendering is the whole point of it.
    useEffect(() => {
        const id = setInterval(() => setTick((n) => n + 1), 60_000);
        return () => clearInterval(id);
    }, []);

    if (state.loading) return <div className="note note--tight">Loading…</div>;
    if (state.unavailable) return <div className="note note--tight">{state.unavailable}</div>;
    if (state.error) return <div className="note note--warn">{state.error}</div>;

    const w = state.data;
    const force = beaufort(w.windMs);
    const kmh = windKmh(w.windMs);
    const dir = windDirection(w.windDeg);
    // The station's own offset when it gave one, the receiver's otherwise.
    const tz = w.tzOffsetSec != null
        ? w.tzOffsetSec
        : (serverInfo?.receiver?.timezone_offset || 0) * 60;

    const wind = kmh == null ? '' : `${kmh} km/h${dir ? ` ${dir}` : ''}`;
    const windTitle = [
        w.windMs != null ? `${w.windMs.toFixed(1)} m/s` : '',
        force != null ? `Force ${force} — ${beaufortName(force)}` : '',
        w.windDeg != null ? `from ${Math.round(w.windDeg)}°` : '',
        w.gustMs != null ? `gusting ${windKmh(w.gustMs)} km/h` : '',
    ].filter(Boolean).join(' · ');

    return (
        <div className="stack">
            <div className="wx__now">
                {w.icon && <img className="wx__icon" src={w.icon} alt="" width="48" height="48" />}
                <div className="wx__now-text">
                    <div className="wx__temp">
                        {round(w.tempC) != null ? `${round(w.tempC)}°C` : '—'}
                    </div>
                    <div className="wx__desc">{w.description}</div>
                </div>
            </div>

            {/* In the minimal view too: on a receiver the wind is half the
                reason to look, and it is one line. */}
            {wind && (
                <div className="wx__wind" title={windTitle}>
                    <Icon.Wind size={13} />
                    <span>{wind}</span>
                    {force != null && <span className="wx__force">F{force}</span>}
                    {w.gustMs != null && (
                        <span className="wx__gust">gusts {windKmh(w.gustMs)}</span>
                    )}
                </div>
            )}

            {!minimal && (
                <>
                    <div className="wx__grid">
                        <Reading
                            label="Feels like"
                            value={round(w.feelsLikeC) != null ? `${round(w.feelsLikeC)}°C` : null}
                            title="What it feels like with wind and humidity"
                        />
                        <Reading label="Humidity" value={w.humidity != null ? `${w.humidity}%` : null} />
                        <Reading
                            label="Pressure"
                            value={w.pressure != null ? `${w.pressure} hPa` : null}
                            title="Sea-level pressure"
                        />
                        <Reading label="Cloud" value={w.cloud != null ? `${w.cloud}%` : null} />
                        <Reading
                            label="Visibility"
                            value={w.visibilityM != null
                                ? (w.visibilityM >= 10000 ? '10+ km' : `${(w.visibilityM / 1000).toFixed(1)} km`)
                                : null}
                            title={w.visibilityM >= 10000 ? 'Reported as 10 km, which is the maximum' : undefined}
                        />
                    </div>

                    {(w.sunrise != null || w.sunset != null) && (
                        <div className="wx__sun">
                            {w.sunrise != null && (
                                <span title="Sunrise, local to the weather station">
                                    <Icon.Sun size={12} /> {localTime(w.sunrise, tz)}
                                </span>
                            )}
                            {w.sunset != null && (
                                <span title="Sunset, local to the weather station">
                                    <Icon.Moon size={12} /> {localTime(w.sunset, tz)}
                                </span>
                            )}
                        </div>
                    )}

                    <div className="wx__foot">
                        <span className="wx__place">
                            {w.country && <span className="wx__flag">{countryFlag(w.country)}</span>}
                            {w.place}
                        </span>
                        <span className="wx__age" title="When the reading was taken">
                            {ageLabel(w.at)}
                        </span>
                    </div>

                    <Button
                        variant="ghost"
                        size="sm"
                        icon={<Icon.Reset size={13} />}
                        onClick={() => fetchWeather({ force: true }).then((r) => setState({ ...r, loading: false }))}
                    >
                        Refresh
                    </Button>
                </>
            )}
        </div>
    );
}
