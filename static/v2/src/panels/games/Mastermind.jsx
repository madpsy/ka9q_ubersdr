// Mastermind. The scoring — the part that is easy to get subtly wrong — is
// lib/games/mastermind.js.

import React, { useCallback, useState } from '../../react.js';
import Frame from './Frame.jsx';
import {
    COLORS, MAX_ROWS, SLOTS, isCracked, makeSecret, scoreGuess,
} from '../../lib/games/mastermind.js';

const Pegs = ({ pegs, className = '' }) => (
    <div className={`mm__pegs ${className}`}>
        {Array.from({ length: SLOTS }, (_, i) => (
            <span
                key={i}
                className={`mm__peg${pegs[i] != null ? ` mm__peg--${pegs[i]}` : ''}`}
            />
        ))}
    </div>
);

// Black for right colour and place, white for right colour wrong place — and
// deliberately not in the order they were found, which would leak which slot.
const Feedback = ({ black = 0, white = 0 }) => (
    <div className="mm__fb">
        {Array.from({ length: SLOTS }, (_, i) => (
            <i
                key={i}
                className={i < black ? 'is-black' : i < black + white ? 'is-white' : ''}
            />
        ))}
    </div>
);

export default function Mastermind() {
    const [secret, setSecret] = useState(makeSecret);
    const [rows, setRows] = useState([]);
    const [current, setCurrent] = useState([]);
    const [state, setState] = useState('play');      // play | won | lost
    const [tally, setTally] = useState({ w: 0, l: 0 });

    const newGame = useCallback(() => {
        setSecret(makeSecret());
        setRows([]);
        setCurrent([]);
        setState('play');
    }, []);

    const add = (c) => {
        if (state !== 'play' || current.length >= SLOTS) return;
        setCurrent([...current, c]);
    };
    const undo = () => {
        if (state !== 'play' || !current.length) return;
        setCurrent(current.slice(0, -1));
    };

    const submit = () => {
        if (state !== 'play' || current.length < SLOTS) return;
        const result = scoreGuess(current, secret);
        const next = [...rows, { pegs: current, ...result }];
        setRows(next);
        setCurrent([]);
        if (isCracked(result)) {
            setState('won');
            setTally((t) => ({ ...t, w: t.w + 1 }));
        } else if (next.length >= MAX_ROWS) {
            setState('lost');
            setTally((t) => ({ ...t, l: t.l + 1 }));
        }
    };

    const status = state === 'won' ? `🎉 Cracked in ${rows.length}`
        : state === 'lost' ? 'Out of guesses — code shown'
            : 'Crack the code';

    return (
        <Frame status={status} score={`W:${tally.w} L:${tally.l}`} action={newGame}>
            <div className="mm">
                <div className="mm__board">
                    {Array.from({ length: MAX_ROWS }, (_, r) => {
                        if (r < rows.length) {
                            return (
                                <div className="mm__row" key={r}>
                                    <Pegs pegs={rows[r].pegs} />
                                    <Feedback black={rows[r].black} white={rows[r].white} />
                                </div>
                            );
                        }
                        const active = r === rows.length && state === 'play';
                        return (
                            <div className={`mm__row${active ? ' is-active' : ''}`} key={r}>
                                <Pegs pegs={active ? current : []} />
                                <Feedback />
                            </div>
                        );
                    })}
                    {state === 'lost' && (
                        <div className="mm__row is-reveal">
                            <Pegs pegs={secret} />
                            <Feedback />
                        </div>
                    )}
                </div>

                <div className="mm__palette">
                    {Array.from({ length: COLORS }, (_, c) => (
                        <button
                            key={c}
                            type="button"
                            className={`mm__sw mm__peg--${c}`}
                            onClick={() => add(c)}
                            disabled={state !== 'play' || current.length >= SLOTS}
                            aria-label={`Colour ${c + 1}`}
                        />
                    ))}
                </div>
                <div className="mm__controls">
                    <button type="button" className="chip chip--button" onClick={undo} disabled={!current.length}>
                        ⌫ Undo
                    </button>
                    <button
                        type="button"
                        className="chip chip--button"
                        onClick={submit}
                        disabled={current.length < SLOTS}
                    >
                        Submit
                    </button>
                </div>
            </div>
        </Frame>
    );
}
