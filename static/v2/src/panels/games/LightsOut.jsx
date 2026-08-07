// Lights Out. The scramble and the press rule are lib/games/lightsout.js.

import React, { useCallback, useEffect, useState } from '../../react.js';
import Frame from './Frame.jsx';
import { N, isWon, litCount, pressAt, scramble } from '../../lib/games/lightsout.js';

export default function LightsOut() {
    const [grid, setGrid] = useState(() => scramble());
    const [moves, setMoves] = useState(0);
    const [wins, setWins] = useState(0);
    const [won, setWon] = useState(false);

    const newGame = useCallback(() => {
        setGrid(scramble());
        setMoves(0);
        setWon(false);
    }, []);

    // Counted here rather than inside the click, so a board that arrives solved
    // — which scramble() will not produce, but a future one might — is still
    // noticed.
    useEffect(() => {
        if (!won && isWon(grid) && moves > 0) {
            setWon(true);
            setWins((w) => w + 1);
        }
    }, [grid, moves, won]);

    const hit = (r, c) => {
        if (won) return;
        setGrid((g) => pressAt(g, r, c));
        setMoves((m) => m + 1);
    };

    const lit = litCount(grid);
    return (
        <Frame
            info={<><span>Moves: {moves}</span><span>Lit: {lit}</span></>}
            status={won ? `💡 Out in ${moves} moves` : 'Turn off all the lights'}
            score={`W:${wins}`}
            action={newGame}
        >
            <div className="lo">
                {grid.map((on, i) => (
                    <button
                        key={i}
                        type="button"
                        className={`lo__cell${on ? ' is-on' : ''}`}
                        onClick={() => hit(Math.floor(i / N), i % N)}
                        aria-label={`${on ? 'On' : 'Off'} ${Math.floor(i / N) + 1},${(i % N) + 1}`}
                    />
                ))}
            </div>
        </Frame>
    );
}
