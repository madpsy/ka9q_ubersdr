// Noughts and crosses. The rules and the opponent are lib/games/ttt.js; this is
// the board and the turn-taking.
//
// The AI's move is on a timer rather than immediate — 120 ms after yours, 300 ms
// when it opens. It computes in microseconds, and a reply that lands in the same
// frame as your click reads as though the board played itself.

import React, { useCallback, useEffect, useRef, useState } from '../../react.js';
import Frame from './Frame.jsx';
import { useOpponent } from './opponent.js';
import {
    AI, BLUNDER_START, EMPTY, HUMAN, adaptBlunder, bestMove, emptyBoard, winLine, winner,
} from '../../lib/games/ttt.js';

const THINK_MS = 120;
const OPENING_MS = 300;

// How long a finished board stays up before the next game deals itself. Three
// seconds is the same beat the two quizzes use, and it is about right here: long
// enough to see the winning line, short enough that the panel is never sitting
// there finished while you look back at it.
const OVER_MS = 3000;

// ...and the shortest that board is ever up for. A click already in flight when
// the game ends would otherwise wipe the result before it had been seen — the
// widget guarded this too, and it is the one case where reacting instantly is
// wrong.
const SETTLE_MS = 600;

export default function Ttt() {
    const [board, setBoard] = useState(emptyBoard);
    const [status, setStatus] = useState('Your turn ✕');
    const [score, setScore] = useState({ w: 0, d: 0, l: 0 });
    const [done, setDone] = useState(null);          // the winning line, once there is one
    // Neither of these belongs in state: the blunder rate is the opponent's
    // memory across games and never renders, and the starter is decided at the
    // end of one game and read at the start of the next.
    // Held in a ref as well: the status is set from inside callbacks that must
    // not be rebuilt every time /api/description answers.
    const opponent = useOpponent();
    const them = useRef(opponent);
    them.current = opponent;
    const blunder = useRef(BLUNDER_START);
    const starter = useRef(null);
    const timer = useRef(null);
    const turn = useRef(false);
    // The next game, reachable from finish() — which is defined above it, and
    // cannot close over it without the two chasing each other round the
    // dependency list.
    const restart = useRef(null);
    // When the board stops ignoring clicks. See SETTLE_MS.
    const settled = useRef(0);

    useEffect(() => () => clearTimeout(timer.current), []);

    const finish = useCallback((b, result) => {
        setDone(winLine(b) || []);
        turn.current = false;
        settled.current = Date.now() + SETTLE_MS;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => { if (restart.current) restart.current(); }, OVER_MS);
        if (result === HUMAN) {
            setScore((s) => ({ ...s, w: s.w + 1 }));
            setStatus('🎉 You win!');
            starter.current = HUMAN;
            blunder.current = adaptBlunder(blunder.current, true);
        } else if (result === AI) {
            setScore((s) => ({ ...s, l: s.l + 1 }));
            setStatus(`🤖 ${them.current} wins`);
            starter.current = AI;
            blunder.current = adaptBlunder(blunder.current, false);
        } else {
            setScore((s) => ({ ...s, d: s.d + 1 }));
            setStatus('🤝 Draw');
            starter.current = null;
        }
    }, []);

    const aiPlay = useCallback((from) => {
        const i = bestMove(from, blunder.current);
        if (i === -1) return;
        const next = from.slice();
        next[i] = AI;
        setBoard(next);
        const result = winner(next);
        if (result) finish(next, result);
        else { turn.current = true; setStatus('Your turn ✕'); }
    }, [finish]);

    const newGame = useCallback(() => {
        clearTimeout(timer.current);
        const b = emptyBoard();
        setBoard(b);
        setDone(null);
        // Whoever won goes first next time; a draw or a first game is a coin toss.
        const first = starter.current !== null
            ? starter.current
            : (Math.random() < 0.5 ? HUMAN : AI);
        if (first === HUMAN) {
            turn.current = true;
            setStatus('Your turn ✕');
        } else {
            turn.current = false;
            setStatus(`${them.current} opens…`);
            timer.current = setTimeout(() => aiPlay(b), OPENING_MS);
        }
    }, [aiPlay]);

    // Read by finish(), which runs long before this is assigned on any given
    // render but never before the first one has completed.
    restart.current = newGame;

    useEffect(() => { newGame(); }, []);

    const play = (i) => {
        // A finished board restarts on a click as well as on the timer — but not
        // in the moment right after it finished, which is a click that was
        // already on its way.
        if (done) {
            if (Date.now() >= settled.current) newGame();
            return;
        }
        if (!turn.current || board[i] !== EMPTY) return;
        turn.current = false;
        const next = board.slice();
        next[i] = HUMAN;
        setBoard(next);
        const result = winner(next);
        if (result) { finish(next, result); return; }
        setStatus('Thinking…');
        timer.current = setTimeout(() => aiPlay(next), THINK_MS);
    };

    return (
        <Frame
            status={status}
            score={`W:${score.w} D:${score.d} L:${score.l}`}
            action={newGame}
        >
            <div className="ttt">
                {board.map((v, i) => (
                    <button
                        key={i}
                        type="button"
                        className={`ttt__cell${v ? ' is-taken' : ''}${done && done.includes(i) ? ' is-win' : ''}`}
                        onClick={() => play(i)}
                        aria-label={v === HUMAN ? 'X' : v === AI ? 'O' : `Square ${i + 1}`}
                    >
                        {v === HUMAN ? '✕' : v === AI ? '◯' : ''}
                    </button>
                ))}
            </div>
        </Frame>
    );
}
