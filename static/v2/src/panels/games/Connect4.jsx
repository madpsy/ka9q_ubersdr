// Connect 4. The search and the heuristic are lib/games/connect4.js.
//
// The AI's turn is deferred by a tick as well as by a delay: a depth-four
// alpha–beta search is a few milliseconds, but those milliseconds are on the main
// thread, and running it inside the click handler stops the disc you just dropped
// from ever being painted.

import React, { useCallback, useEffect, useRef, useState } from '../../react.js';
import Frame from './Frame.jsx';
import {
    AI, CELLS, COLS, EMPTY, HUMAN, bestCol, dropDisc, dropRow, emptyBoard, hasWon, isFull, winLine,
} from '../../lib/games/connect4.js';
import { BLUNDER_START, adaptBlunder } from '../../lib/games/ttt.js';

const THINK_MS = 220;

export default function Connect4() {
    const [board, setBoard] = useState(emptyBoard);
    const [status, setStatus] = useState('Your turn 🔴');
    const [tally, setScore] = useState({ w: 0, d: 0, l: 0 });
    const [line, setLine] = useState(null);
    const blunder = useRef(BLUNDER_START);
    const starter = useRef(null);
    const timer = useRef(null);
    const turn = useRef(false);

    useEffect(() => () => clearTimeout(timer.current), []);

    const finish = useCallback((b, who) => {
        turn.current = false;
        setLine(who ? winLine(b, who) : []);
        if (who === HUMAN) {
            setScore((s) => ({ ...s, w: s.w + 1 }));
            setStatus('🎉 You win!');
            starter.current = HUMAN;
            blunder.current = adaptBlunder(blunder.current, true);
        } else if (who === AI) {
            setScore((s) => ({ ...s, l: s.l + 1 }));
            setStatus('🤖 Receiver wins');
            starter.current = AI;
            blunder.current = adaptBlunder(blunder.current, false);
        } else {
            setScore((s) => ({ ...s, d: s.d + 1 }));
            setStatus('🤝 Draw');
            starter.current = null;
        }
    }, []);

    const aiPlay = useCallback((from) => {
        const c = bestCol(from, blunder.current);
        if (c === -1) { finish(from, null); return; }
        const next = dropDisc(from, c, AI);
        setBoard(next);
        if (hasWon(next, AI)) finish(next, AI);
        else if (isFull(next)) finish(next, null);
        else { turn.current = true; setStatus('Your turn 🔴'); }
    }, [finish]);

    const newGame = useCallback(() => {
        clearTimeout(timer.current);
        const b = emptyBoard();
        setBoard(b);
        setLine(null);
        const first = starter.current !== null
            ? starter.current
            : (Math.random() < 0.5 ? HUMAN : AI);
        if (first === HUMAN) {
            turn.current = true;
            setStatus('Your turn 🔴');
        } else {
            turn.current = false;
            setStatus('Receiver opens…');
            timer.current = setTimeout(() => aiPlay(b), THINK_MS);
        }
    }, [aiPlay]);

    useEffect(() => { newGame(); }, []);

    const play = (c) => {
        if (line) { newGame(); return; }
        if (!turn.current || dropRow(board, c) === -1) return;
        turn.current = false;
        const next = dropDisc(board, c, HUMAN);
        setBoard(next);
        if (hasWon(next, HUMAN)) { finish(next, HUMAN); return; }
        if (isFull(next)) { finish(next, null); return; }
        setStatus('Thinking…');
        timer.current = setTimeout(() => aiPlay(next), THINK_MS);
    };

    return (
        <Frame
            status={status}
            score={`W:${tally.w} D:${tally.d} L:${tally.l}`}
            action={newGame}
        >
            <div className="c4">
                <div className="c4__cols">
                    {Array.from({ length: COLS }, (_, c) => (
                        <button
                            key={c}
                            type="button"
                            className="c4__drop"
                            onClick={() => play(c)}
                            disabled={dropRow(board, c) === -1}
                            aria-label={`Drop in column ${c + 1}`}
                        >
                            ▼
                        </button>
                    ))}
                </div>
                <div className="c4__board">
                    {Array.from({ length: CELLS }, (_, i) => (
                        <button
                            key={i}
                            type="button"
                            className={[
                                'c4__cell',
                                board[i] === HUMAN ? 'is-p1' : board[i] === AI ? 'is-p2' : '',
                                line && line.includes(i) ? 'is-win' : '',
                            ].filter(Boolean).join(' ')}
                            onClick={() => play(i % COLS)}
                            tabIndex={-1}
                            aria-hidden="true"
                        />
                    ))}
                </div>
            </div>
        </Frame>
    );
}
