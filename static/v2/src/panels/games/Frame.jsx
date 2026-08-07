// The shape every game in the panel shares: a status line, the board, and a
// footer with the score and whatever starts the next one.
//
// One component rather than ten copies, because the widget this is ported from
// had ten copies and they had drifted — some footers put the score first, some
// last, and two games called their button "New" while doing different things.
// Here the layout is decided once and each game supplies its middle.
//
// `info` is the optional row above the status: the mine count and the clock, the
// move count, whatever the game keeps a running total of.

import React from '../../react.js';

export default function Frame({ info, status, score, action, actionLabel = 'New', children }) {
    return (
        <div className="game">
            {info && <div className="game__info">{info}</div>}
            <div className="game__status">{status}</div>
            <div className="game__body">{children}</div>
            <div className="game__foot">
                <span className="game__score">{score}</span>
                {action && (
                    <button type="button" className="chip chip--button" onClick={action}>
                        {actionLabel}
                    </button>
                )}
            </div>
        </div>
    );
}
