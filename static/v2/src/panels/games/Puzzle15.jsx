// The 15-puzzle. Solvability and the slide rule are lib/games/puzzle15.js.

import React, { useCallback, useState } from '../../react.js';
import Frame from './Frame.jsx';
import { BLANK, isSolved, slide, shuffle, solvedTiles } from '../../lib/games/puzzle15.js';

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
