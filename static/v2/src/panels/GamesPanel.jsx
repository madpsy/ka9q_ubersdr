// Mini games — a port of widgets/games.widget.html.
//
// Ten games in the space of one dock panel. A receiver is a thing you sit beside
// for hours waiting for something to happen, which is the entire argument for it
// being here rather than being a browser tab of its own.
//
// The port is a rewrite rather than a copy, for reasons worth recording: about a
// hundred and thirty lines of the widget were its own floating-window chrome —
// drag, collapse, remembered position — which a panel gets from the registry, and
// the rest drove the DOM through eighty-odd getElementById calls against globally
// unique ids. What was worth keeping is the *rules*, and those are now in
// lib/games/, pure and tested: minimax and its adaptive blunder rate, the
// first-click-is-safe mine field, the 15-puzzle parity check, the Sudoku
// generator's uniqueness test, Mastermind's two-pass scoring.
//
// One file per game under panels/games/, because ten games in one file is how the
// widget got to three thousand lines and why nobody wanted to touch it.
//
// `minimal` drops the picker and leaves whichever game is chosen — the games
// themselves are all board and no chrome, so they cut down well.

import React, { useState } from '../react.js';
import Ttt, { gameHelp as tttHelp } from './games/Ttt.jsx';
import Minesweeper, { gameHelp as msHelp } from './games/Minesweeper.jsx';
import Puzzle15, { gameHelp as p15Help } from './games/Puzzle15.jsx';
import Memory, { gameHelp as memHelp } from './games/Memory.jsx';
import Connect4, { gameHelp as c4Help } from './games/Connect4.jsx';
import Sudoku, { gameHelp as suHelp } from './games/Sudoku.jsx';
import LightsOut, { gameHelp as loHelp } from './games/LightsOut.jsx';
import Mastermind, { gameHelp as mmHelp } from './games/Mastermind.jsx';
import CallsignQuiz, { gameHelp as cqHelp } from './games/CallsignQuiz.jsx';
import Countries, { gameHelp as coHelp } from './games/Countries.jsx';

const KEY = 'ubersdr.v2.games.chosen';

// In the widget's order, which is roughly easiest first. The two that need the
// receiver are last: they are the ones that can be unavailable.
const GAMES = [
    { id: 'ttt', name: 'Noughts & Crosses', Component: Ttt, help: tttHelp },
    { id: 'ms', name: 'Minesweeper', Component: Minesweeper, help: msHelp },
    { id: 'p15', name: '15-Puzzle', Component: Puzzle15, help: p15Help },
    { id: 'mem', name: 'Memory', Component: Memory, help: memHelp },
    { id: 'c4', name: 'Connect 4', Component: Connect4, help: c4Help },
    { id: 'su', name: 'Sudoku', Component: Sudoku, help: suHelp },
    { id: 'lo', name: 'Lights Out', Component: LightsOut, help: loHelp },
    { id: 'mm', name: 'Mastermind', Component: Mastermind, help: mmHelp },
    { id: 'cq', name: 'Callsign Quiz', Component: CallsignQuiz, help: cqHelp },
    { id: 'co', name: 'Countries', Component: Countries, help: coHelp },
];

function saved() {
    try {
        const id = localStorage.getItem(KEY);
        return GAMES.some((g) => g.id === id) ? id : GAMES[0].id;
    } catch (e) {
        return GAMES[0].id;
    }
}

export default function GamesPanel({ minimal }) {
    const [id, setId] = useState(saved);
    const [helping, setHelping] = useState(false);
    const game = GAMES.find((g) => g.id === id) || GAMES[0];

    const choose = (next) => {
        setId(next);
        // The rules of the game you have left are not the rules of the one you
        // have arrived at.
        setHelping(false);
        try { localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }
    };

    return (
        <div className="stack stack--tight">
            {/* A list rather than the widget's ◀ ▶ pair: ten games is four presses
                to reach the far end, and a name you have to step past to read is a
                name you cannot choose from. Remembered, because a game is
                something you come back to. */}
            {/* The picker and the rules on one row: they are the two things that
                are about the panel rather than about the game in it, and the ?
                belongs beside what it explains rather than down in the game's own
                footer among the score and the New button. */}
            {!minimal && (
                <div className="games__row">
                    <select
                        className="select"
                        value={game.id}
                        aria-label="Game"
                        onChange={(e) => choose(e.target.value)}
                    >
                        {GAMES.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                    <button
                        type="button"
                        className={`chip chip--button games__help-btn${helping ? ' is-active' : ''}`}
                        title={helping ? 'Back to the game' : 'How to play'}
                        aria-label="How to play"
                        aria-pressed={helping}
                        onClick={() => setHelping((v) => !v)}
                    >
                        {helping ? '✕' : '?'}
                    </button>
                </div>
            )}

            {/* The rules lie *over* the game rather than above or instead of it:
                the game's height is the panel's height, and help text that pushed
                it down would move everything below this panel in the dock — the
                thing several rounds of fixes went into stopping.

                The game stays mounted underneath, so reading the rules mid-game
                does not cost you the board. */}
            <div className="games__stage">
                {/* Keyed, so switching games unmounts the old one rather than
                    handing its board to the next. Two grids of buttons look alike
                    enough to React that a stale one would otherwise survive. */}
                <game.Component key={game.id} />
                {helping && <div className="games__help" role="note">{game.help}</div>}
            </div>
        </div>
    );
}
