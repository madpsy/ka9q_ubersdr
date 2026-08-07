// Six-by-six Sudoku. The generator, the uniqueness check and the conflict finder
// are lib/games/sudoku.js.
//
// Tap a cell then a digit, rather than typing: this is a panel in a dock and on a
// phone, and neither has a keyboard pointed at it.

import React, { useCallback, useMemo, useState } from '../../react.js';
import Frame from './Frame.jsx';
import {
    CELLS, DIGITS, N, conflicts, generate, isComplete,
} from '../../lib/games/sudoku.js';

// How to play — shown by the ? beside the game picker. See GamesPanel.
//
// `gameHelp` rather than `help`: it is exported into an app where half a dozen
// files have a local of that name, and test/unresolved.js refuses the collision.
export const gameHelp = (
    <>
        <p>
            Six by six, digits <b>1 to 6</b>. Every row, every column and every 2×3
            box outlined on the grid holds each digit exactly once.
        </p>
        <p>
            Tap a cell, then a digit below. The same digit again clears it. The
            darker digits were given and cannot be changed.
        </p>
        <p>
            Anything clashing with another digit turns red — both of them, so you can
            see what the argument is. There is exactly one solution.
        </p>
    </>
);
export default function Sudoku() {
    const [game, setGame] = useState(generate);
    const [grid, setGrid] = useState(() => game.puzzle.slice());
    const [sel, setSel] = useState(-1);
    const [wins, setWins] = useState(0);
    const [won, setWon] = useState(false);

    const newGame = useCallback(() => {
        const g = generate();
        setGame(g);
        setGrid(g.puzzle.slice());
        setSel(-1);
        setWon(false);
    }, []);

    // Recomputed per render rather than tracked: it is 36 cells, and a conflict
    // set kept in state is a conflict set that can disagree with the grid.
    const bad = useMemo(() => conflicts(grid), [grid]);

    const put = (v) => {
        if (won || sel < 0 || game.given[sel]) return;
        const next = grid.slice();
        // The same digit again clears the cell — there is no separate rubber.
        next[sel] = next[sel] === v ? 0 : v;
        setGrid(next);
        if (isComplete(next)) {
            setWon(true);
            setWins((w) => w + 1);
        }
    };

    return (
        <Frame
            status={won ? '🎉 Solved' : 'Tap a cell, then a number'}
            score={`W:${wins}`}
            action={newGame}
        >
            <div className="su">
                <div className="su__grid">
                    {Array.from({ length: CELLS }, (_, i) => (
                        <button
                            key={i}
                            type="button"
                            className={[
                                'su__cell',
                                game.given[i] ? 'is-given' : '',
                                sel === i ? 'is-sel' : '',
                                bad.has(i) ? 'is-bad' : '',
                                // The heavy rules that separate the 2×3 boxes.
                                (i % N) % 3 === 0 && (i % N) !== 0 ? 'su__cell--vrule' : '',
                                Math.floor(i / N) % 2 === 0 && i >= N ? 'su__cell--hrule' : '',
                            ].filter(Boolean).join(' ')}
                            onClick={() => setSel(game.given[i] ? -1 : i)}
                        >
                            {grid[i] || ''}
                        </button>
                    ))}
                </div>
                <div className="su__pad">
                    {DIGITS.map((v) => (
                        <button
                            key={v}
                            type="button"
                            className="su__key"
                            onClick={() => put(v)}
                            disabled={sel < 0 || won}
                        >
                            {v}
                        </button>
                    ))}
                </div>
            </div>
        </Frame>
    );
}
