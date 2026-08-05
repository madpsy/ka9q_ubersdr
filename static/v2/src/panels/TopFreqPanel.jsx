// Where you actually spend your time — widgets/top_freqmode.widget.html.
//
// A combination of dial frequency and mode earns a point for every full minute
// the receiver stays on it, so tuning past a frequency never scores and the
// places you sit rise on their own. Click a row to go back to one.
//
// One difference from the widget, and it is the point of the thing: the clock
// only runs while the receiver is running. The widget has no way to know, so it
// scores a dial left parked overnight with the audio stopped. That is not time
// spent listening, and a leaderboard built from it says nothing.
//
// `minimal` is the top five alone — no Show more, no line saying what is being
// timed now, no Clear.

import React, { useEffect, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { Button, Empty, Icon, ShowMore } from '../components/ui.jsx';
import { formatFreqShort } from '../lib/format.js';
import { MODE_BY_ID } from '../radio/constants.js';
import {
    TOP_FREQ_ROWS, comboKey, creditMinute, formatDwell, loadCombos, saveCombos, sortedCombos,
} from '../lib/topFreq.js';

const MINUTE_MS = 60 * 1000;

const modeLabel = (id) => (MODE_BY_ID[id] || {}).label || String(id || '').toUpperCase();

export default function TopFreqPanel({ minimal }) {
    const { actions, running, tuning } = useRadio();
    const [combos, setCombos] = useState(loadCombos);
    // Minutes credited during the current stay, for the "timing this now" line.
    const [dwell, setDwell] = useState(0);
    const [shown, setShown] = useState(TOP_FREQ_ROWS);

    const hz = Math.round(tuning.frequency || 0);
    const mode = tuning.mode || '';
    const key = hz && mode ? comboKey(hz, mode) : null;
    const timing = running && key;

    // Restarted whenever the dial or the mode moves, which is what makes the
    // first point cost a *full* minute on one combination rather than a minute
    // spread across several. Tuning away throws away the part-minute, the same
    // way the widget does.
    useEffect(() => {
        setDwell(0);
        if (!timing) return undefined;
        const id = setInterval(() => {
            setDwell((n) => n + 1);
            setCombos((prev) => {
                const next = creditMinute(prev, hz, mode);
                saveCombos(next);
                return next;
            });
        }, MINUTE_MS);
        return () => clearInterval(id);
    }, [timing, hz, mode]);

    const all = sortedCombos(combos);
    // Minimal is the leaderboard: five rows, and no button to grow it.
    const rows = all.slice(0, minimal ? TOP_FREQ_ROWS : shown);

    // The list is rebuilt from what was stored, so a row already knows its own
    // frequency and mode; tuning is the same path a shared frequency in chat or
    // a bookmark takes.
    const tuneTo = (rec) => {
        actions.setMode(rec.mode);
        actions.setFrequency(rec.hz);
        actions.ensureVisible(rec.hz);
    };

    const clear = useRef(null);
    clear.current = () => {
        setCombos({});
        saveCombos({});
        setDwell(0);
        setShown(TOP_FREQ_ROWS);
    };

    return (
        <div className="stack">
            {rows.length === 0 ? (
                <Empty>
                    {running
                        ? 'Stay on a frequency for a minute and it will appear here.'
                        : 'Start the receiver — time only counts while you are listening.'}
                </Empty>
            ) : (
                <div className="tfm">
                    {rows.map((rec, i) => (
                        <button
                            key={comboKey(rec.hz, rec.mode)}
                            type="button"
                            className={`tfm__row${comboKey(rec.hz, rec.mode) === key ? ' is-active' : ''}`}
                            title={`Tune to ${formatFreqShort(rec.hz)} ${modeLabel(rec.mode)} — ${formatDwell(rec.count)} spent here`}
                            onClick={() => tuneTo(rec)}
                        >
                            <span className="tfm__rank">{i + 1}</span>
                            <span className="tfm__freq">{formatFreqShort(rec.hz)}</span>
                            <span className="tfm__mode">{modeLabel(rec.mode)}</span>
                            <span className="tfm__count">{formatDwell(rec.count)}</span>
                        </button>
                    ))}
                </div>
            )}

            {!minimal && rows.length > 0 && (
                <ShowMore
                    shown={rows.length}
                    total={all.length}
                    onMore={() => setShown((n) => n + TOP_FREQ_ROWS)}
                />
            )}

            {/* What is being timed right now, and how far into it — so a
                frequency that has not scored yet is still visibly counting. */}
            {!minimal && timing && (
                <div className="tfm__now" title="The first point lands after a full minute here">
                    <Icon.Clock size={12} />
                    <span className="tfm__now-freq">{formatFreqShort(hz)} {modeLabel(mode)}</span>
                    <span className="tfm__now-min">{dwell ? `+${dwell}` : '<1 min'}</span>
                </div>
            )}

            {!minimal && rows.length > 0 && (
                <Button
                    variant="ghost"
                    size="sm"
                    icon={<Icon.Trash size={13} />}
                    onClick={() => clear.current()}
                >
                    Clear
                </Button>
            )}
        </div>
    );
}
