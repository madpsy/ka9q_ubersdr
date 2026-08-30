// The Listeners panel's spectrum view: one bar per band, one dot per listener.
//
// The list answers "who is here"; this answers "where is everybody", which is
// the question the bands themselves answer badly in a list — twelve rows of
// frequencies do not add up to "the whole club is on 40" at a glance, and one
// row of dots does.
//
// The geometry is in lib/listenerBands.js. This draws it, and owns the two
// things that are drawing decisions rather than layout: what a dot says when
// you hover it, and the line marking where your own dial is.

import React, { useMemo } from '../react.js';
import { countryFlag } from '../lib/format.js';
import { activeLabel } from '../lib/listeners.js';
import { bandRows, pctOf } from '../lib/listenerBands.js';

// A dot standing for more listeners than this lists the first few and says how
// many are left. A tooltip is not a panel.
const MAX_LINES = 6;

// One listener as a line of the tooltip: where, who, and how long since they
// moved — the same fields the list row carries, on one line instead of two.
function line(channel, now) {
    const where = [
        `${(channel.frequency / 1000).toFixed(3)} kHz`,
        channel.mode ? channel.mode.toUpperCase() : '',
    ].filter(Boolean).join(' ');
    const who = [
        channel.chatUsername,
        [countryFlag(channel.countryCode), channel.country].filter(Boolean).join(' '),
    ].filter(Boolean).join(' ');
    const when = channel.you ? 'you' : activeLabel(channel.lastActive, now);
    return [where, who, when].filter(Boolean).join(' · ');
}

function dotTitle(spot, now) {
    const lines = spot.channels.slice(0, MAX_LINES).map((c) => line(c, now));
    const over = spot.channels.length - lines.length;
    if (over > 0) lines.push(`and ${over} more`);
    if (spot.tune) lines.push('Click to listen here');
    return lines.join('\n');
}

// What the row covers, as the row's own tooltip. Its own formatter rather than
// formatFreqShort: that one drops the decimals from a round megahertz, so a
// band would read "7 MHz – 7.300 MHz" and look like two different scales.
function rangeLabel(min, max) {
    if (min >= 1e6) return `${(min / 1e6).toFixed(3)} – ${(max / 1e6).toFixed(3)} MHz`;
    return `${(min / 1e3).toFixed(0)} kHz – ${(max / 1e6).toFixed(3)} MHz`;
}

function Row({ row, dialHz, now, onTune }) {
    const dial = pctOf(dialHz, row.min, row.max);
    const title = `${row.name} · ${rangeLabel(row.min, row.max)}`;
    // Named bands carry their hue; the catch-all row has none and takes the
    // neutral in the stylesheet instead — a colour would claim it is a band.
    const style = row.hue == null ? undefined : { '--lsn-hue': row.hue };

    return (
        <div className={`lsn-band${row.hue == null ? ' lsn-band--other' : ''}`} style={style}>
            <span className="lsn-band__name" title={title}>{row.name}</span>
            <div className="lsn-band__bar" title={title}>
                {/* Where you are tuned, whether or not you are one of the dots:
                    it is what makes the row a picture of the band rather than a
                    row of strangers. */}
                {dial != null && <i className="lsn-band__dial" style={{ left: `${dial}%` }} />}
                {row.spots.map((spot) => {
                    const many = spot.channels.length > 1;
                    const cls = `lsn-dot${spot.you ? ' is-you' : ''}${many ? ' is-many' : ''}`;
                    const pos = { left: `${spot.pct}%` };
                    const label = many ? String(spot.channels.length) : '';
                    // A dot with nobody to tune to — your own, or an IQ channel
                    // — is read, not pressed, for the same reason the static
                    // list rows are.
                    if (!spot.tune) {
                        return (
                            <span
                                key={spot.key}
                                className={`${cls} is-static`}
                                style={pos}
                                title={dotTitle(spot, now)}
                            >
                                {label}
                            </span>
                        );
                    }
                    return (
                        <button
                            key={spot.key}
                            type="button"
                            className={cls}
                            style={pos}
                            title={dotTitle(spot, now)}
                            onClick={() => onTune(spot.tune)}
                        >
                            {label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export default function ListenerBands({ channels, dialHz, minHz, maxHz, now, onTune }) {
    const rows = useMemo(
        () => bandRows(channels, minHz, maxHz),
        [channels, minHz, maxHz],
    );

    return (
        <div className="lsn-bands">
            {rows.map((row) => (
                <Row key={row.name} row={row} dialHz={dialHz} now={now} onTune={onTune} />
            ))}
        </div>
    );
}
