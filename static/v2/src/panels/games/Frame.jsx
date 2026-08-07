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
//
// `statusLines` reserves height for a status that can run long. One line suits
// the board games, whose messages are all "Your turn" and "Draw"; the two quizzes
// have to be able to say "Nope — South Georgia and the South Sandwich Islands",
// which wraps in a dock column. Reserved rather than allowed to grow, because
// these panels sit in a column and a line appearing pushes everything below it
// down — every three seconds, on the quizzes' own timer.

import React from '../../react.js';

export default function Frame({
    info, status, score, action, actionLabel = 'New', statusLines = 1, children,
}) {
    return (
        <div className="game">
            {info && <div className="game__info">{info}</div>}
            <div
                className="game__status"
                style={statusLines > 1 ? { minHeight: `calc(${statusLines} * 1.35em)` } : undefined}
            >
                {status}
            </div>
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
