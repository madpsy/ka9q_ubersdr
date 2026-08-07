// The 15-puzzle. Solvability and the slide rule are lib/games/puzzle15.js.

import React, { useCallback, useState } from '../../react.js';
import Frame from './Frame.jsx';
import { BLANK, isSolved, slide, shuffle, solvedTiles } from '../../lib/games/puzzle15.js';

// How to play — shown by the ? beside the game picker. See GamesPanel.
//
// `gameHelp` rather than `help`: it is exported into an app where half a dozen
// files have a local of that name, and test/unresolved.js refuses the collision.
export const gameHelp = (
    <>
        <p>Slide the tiles until they read 1 to 15 with the gap last.</p>
        <p>
            Only a tile directly beside the gap can move — press it and it slides in.
            Diagonals do not count.
        </p>
        <p>
            <b>Shuffle</b> deals a board that can actually be finished: half of all
            arrangements cannot be, and there is no way to tell by looking.
        </p>
    </>
);
export default function Puzzle15() {
    const [tiles, setTiles] = useState(solvedTiles);
    const [moves, setMoves] = useState(0);
    const [best, setBest] = useState(null);
    const [wins, setWins] = useState(0);
    // Solved-and-untouched is not the same as solved-by-playing: the board starts
    // in order, and that is not a win.
    const [playing, setPlaying] = useState(false);

    const start = useCallback(() => {
        setTiles(shuffle());
        setMoves(0);
        setPlaying(true);
    }, []);

    const slide = (i) => {
        if (!playing) return;
        const next = slide(tiles, i);
        if (next === tiles) return;              // not next to the gap
        const n = moves + 1;
        setTiles(next);
        setMoves(n);
        if (isSolved(next)) {
            setPlaying(false);
            setWins((w) => w + 1);
            setBest((b) => (b === null || n < b ? n : b));
        }
    };

    const solved = isSolved(tiles);
    return (
        <Frame
            info={<><span>Moves: {moves}</span><span>Best: {best === null ? '—' : best}</span></>}
            status={playing ? 'Slide the tiles into order' : (solved && moves ? `🎉 Solved in ${moves}` : 'Press Shuffle to start')}
            score={`W:${wins}`}
            action={start}
            actionLabel="Shuffle"
        >
            <div className="p15">
                {tiles.map((v, i) => (
                    <button
                        key={i}
                        type="button"
                        className={`p15__cell${v === BLANK ? ' is-blank' : ''}${solved && v !== BLANK ? ' is-solved' : ''}`}
                        onClick={() => slide(i)}
                        disabled={v === BLANK}
                    >
                        {v === BLANK ? '' : v}
                    </button>
                ))}
            </div>
        </Frame>
    );
}
