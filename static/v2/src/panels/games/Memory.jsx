// Pairs. The deck and the third-click rule are lib/games/memory.js.

import React, { useCallback, useEffect, useRef, useState } from '../../react.js';
import Frame from './Frame.jsx';
import {
    FLIP_BACK_MS, PAIRS, canFlip, deal, isMatched, isWon,
} from '../../lib/games/memory.js';

// How to play — shown by the ? beside the game picker. See GamesPanel.
//
// `gameHelp` rather than `help`: it is exported into an app where half a dozen
// files have a local of that name, and test/unresolved.js refuses the collision.
export const gameHelp = (
    <>
        <p>Sixteen cards, eight pairs, all face down.</p>
        <p>
            Turn two. If they match they stay up; if they do not they turn back over
            after a moment — and nothing else can be turned until they do.
        </p>
        <p>Find every pair in as few flips as you can. Your best is kept.</p>
    </>
);
export default function Memory() {
    const [cards, setCards] = useState(deal);
    const [flipped, setFlipped] = useState([]);
    const [matched, setMatched] = useState([]);
    const [flips, setFlips] = useState(0);
    const [best, setBest] = useState(null);
    const [locked, setLocked] = useState(false);
    const timer = useRef(null);

    useEffect(() => () => clearTimeout(timer.current), []);

    const newGame = useCallback(() => {
        clearTimeout(timer.current);
        setCards(deal());
        setFlipped([]);
        setMatched([]);
        setFlips(0);
        setLocked(false);
    }, []);

    const turn = (i) => {
        if (!canFlip({ locked, flipped, matched }, i)) return;
        const pair = [...flipped, i];
        setFlipped(pair);
        setFlips((n) => n + 1);
        if (pair.length < 2) return;

        const [a, b] = pair;
        if (cards[a] === cards[b]) {
            const next = [...matched, pair];
            setMatched(next);
            setFlipped([]);
            if (isWon(next)) {
                const n = flips + 1;
                setBest((x) => (x === null || n < x ? n : x));
            }
            return;
        }
        // No match: both stay up long enough to be read, and nothing else can be
        // turned until they go back down.
        setLocked(true);
        timer.current = setTimeout(() => {
            setFlipped([]);
            setLocked(false);
        }, FLIP_BACK_MS);
    };

    const done = isWon(matched);
    return (
        <Frame
            info={<><span>Pairs: {matched.length}/{PAIRS}</span><span>Flips: {flips}</span></>}
            status={done ? `🎉 Done in ${flips} flips` : 'Find all the pairs'}
            score={`Best: ${best === null ? '—' : best}`}
            action={newGame}
        >
            <div className="mem">
                {cards.map((face, i) => {
                    const up = flipped.includes(i) || isMatched(matched, i);
                    return (
                        <button
                            key={i}
                            type="button"
                            className={`mem__card${up ? ' is-up' : ''}${isMatched(matched, i) ? ' is-done' : ''}`}
                            onClick={() => turn(i)}
                            aria-label={up ? face : 'Face down card'}
                        >
                            {up ? face : ''}
                        </button>
                    );
                })}
            </div>
        </Frame>
    );
}
