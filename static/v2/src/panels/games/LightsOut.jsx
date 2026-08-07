// Lights Out. The scramble and the press rule are lib/games/lightsout.js.

import React, { useCallback, useEffect, useState } from '../../react.js';
import Frame from './Frame.jsx';
import { N, isWon, litCount, pressAt, scramble } from '../../lib/games/lightsout.js';

// How to play — shown by the ? beside the game picker. See GamesPanel.
//
// `gameHelp` rather than `help`: it is exported into an app where half a dozen
// files have a local of that name, and test/unresolved.js refuses the collision.
export const gameHelp = (
    <>
        <p>Turn every light off. Sounds easy; it is not.</p>
        <p>
            Pressing a square toggles <b>five</b> lights: that one and the four beside
            it — up, down, left and right. Not the diagonals, and not past the edge of
            the board.
        </p>
        <p>
            So every press both helps and hinders, and pressing the same square twice
            undoes it entirely. The order you press in makes no difference to the
            result — only which squares, and how many times each.
        </p>
        <p>
            <b>A way in:</b> ignore the top row and work downwards — whenever a light
            is on, press the square directly <i>below</i> it. That clears everything
            except the bottom row, and which pattern is left there tells you which
            squares to press along the top to finish.
        </p>
        <p>Every board dealt can be cleared.</p>
    </>
);
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
