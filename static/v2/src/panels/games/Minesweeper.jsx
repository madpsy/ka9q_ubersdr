// Minesweeper. The field, the flood fill and the first-click rule are
// lib/games/minesweeper.js.
//
// Flags are a long press as well as a right-click: this panel is usable on a
// phone, where there is no second button, and a minesweeper you cannot flag on
// is a minesweeper you cannot finish.

import React, { useCallback, useEffect, useRef, useState } from '../../react.js';
import Frame from './Frame.jsx';
import {
    CELLS, COLS, MINE, MINES, colOf, floodReveal, idx, isWon, minesLeft, placeMines, rowOf,
} from '../../lib/games/minesweeper.js';

const LONG_PRESS_MS = 450;

const fresh = () => ({
    board: Array(CELLS).fill(0),
    revealed: Array(CELLS).fill(false),
    flagged: Array(CELLS).fill(false),
    started: false,
    over: false,
    hit: -1,
});

export default function Minesweeper() {
    const [g, setG] = useState(fresh);
    const [tally, setScore] = useState({ w: 0, l: 0 });
    const [secs, setSecs] = useState(0);
    const clock = useRef(null);
    const press = useRef(null);

    const stopClock = () => { clearInterval(clock.current); clock.current = null; };
    useEffect(() => () => { stopClock(); clearTimeout(press.current); }, []);

    const newGame = useCallback(() => {
        stopClock();
        setSecs(0);
        setG(fresh());
    }, []);

    const flag = (i) => {
        setG((s) => {
            if (s.over || s.revealed[i]) return s;
            const flagged = s.flagged.slice();
            flagged[i] = !flagged[i];
            return { ...s, flagged };
        });
    };

    const dig = (i) => {
        setG((s) => {
            if (s.over || s.flagged[i] || s.revealed[i]) return s;
            const r = rowOf(i);
            const c = colOf(i);

            // The field is laid on the first click, around it — see placeMines.
            let { board } = s;
            let started = s.started;
            if (!started) {
                board = placeMines(r, c);
                started = true;
                stopClock();
                setSecs(0);
                clock.current = setInterval(() => setSecs((t) => t + 1), 1000);
            }

            if (board[i] === MINE) {
                stopClock();
                setScore((x) => ({ ...x, l: x.l + 1 }));
                return { ...s, board, started, over: true, hit: i };
            }

            const revealed = floodReveal(board, s.revealed, s.flagged, r, c);
            if (isWon(revealed)) {
                stopClock();
                setScore((x) => ({ ...x, w: x.w + 1 }));
                return { ...s, board, started, revealed, over: true };
            }
            return { ...s, board, started, revealed };
        });
    };

    // A press that is held is a flag; one that is let go quickly is a dig. Both
    // ends are cancelled if the finger leaves the square.
    const onDown = (i) => {
        clearTimeout(press.current);
        press.current = setTimeout(() => { press.current = null; flag(i); }, LONG_PRESS_MS);
    };
    const onUp = (i) => {
        if (!press.current) return;              // already became a flag
        clearTimeout(press.current);
        press.current = null;
        dig(i);
    };
    const cancel = () => { clearTimeout(press.current); press.current = null; };

    const won = g.over && g.hit === -1;
    const status = g.over
        ? (won ? `🎉 Cleared in ${secs}s` : '💥 Boom')
        : (g.started ? 'Good luck' : 'Click to start · hold to flag');

    return (
        <Frame
            info={<><span>💣 {minesLeft(g.flagged)}</span><span>⏱ {secs}s</span></>}
            status={status}
            score={`W:${tally.w} L:${tally.l}`}
            action={newGame}
        >
            <div className="ms">
                {Array.from({ length: CELLS }, (_, i) => {
                    const shown = g.revealed[i] || (g.over && g.board[i] === MINE);
                    const n = g.board[i];
                    const mine = shown && n === MINE;
                    return (
                        <button
                            key={i}
                            type="button"
                            className={[
                                'ms__cell',
                                shown ? 'is-open' : '',
                                g.flagged[i] && !shown ? 'is-flag' : '',
                                i === g.hit ? 'is-hit' : '',
                                shown && n > 0 ? `ms__cell--${n}` : '',
                            ].filter(Boolean).join(' ')}
                            onPointerDown={() => onDown(i)}
                            onPointerUp={() => onUp(i)}
                            onPointerLeave={cancel}
                            onPointerCancel={cancel}
                            onContextMenu={(e) => { e.preventDefault(); cancel(); flag(i); }}
                        >
                            {mine ? '💣' : g.flagged[i] && !shown ? '🚩' : (shown && n > 0 ? n : '')}
                        </button>
                    );
                })}
            </div>
        </Frame>
    );
}
