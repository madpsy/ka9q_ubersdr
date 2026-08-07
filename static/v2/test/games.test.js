// The rules behind the Mini Games panel.
//
// Every one of these is a bug you would not find by playing: a Sudoku with two
// answers rejects a correct grid, an unsolvable 15-puzzle just feels hard, a
// Mastermind that scores duplicate colours generously is unsolvable by reasoning
// rather than obviously broken, and a first click that can hit a mine loses a
// game once a fortnight. The widget this is ported from had none of it under
// test, which is most of the reason the logic was pulled out of the rendering.

const assert = require('assert');
const ttt = require('./.build/game-ttt.cjs');
const ms = require('./.build/game-minesweeper.cjs');
const p15 = require('./.build/game-puzzle15.cjs');
const mem = require('./.build/game-memory.cjs');
const c4 = require('./.build/game-connect4.cjs');
const su = require('./.build/game-sudoku.cjs');
const lo = require('./.build/game-lightsout.cjs');
const mm = require('./.build/game-mastermind.cjs');
const quiz = require('./.build/game-quiz.cjs');
// The projection and the coastline decode moved to lib/worldMap.js when the HFDL panel
// wanted the same map; the cases stay here, with the game they were written for.
const map = require('./.build/worldmap.cjs');
// lib/morse.js rather than lib/games/: the announcer in the callsign panel shares
// it. The Morse cases live on here because this is where they were written and the
// trainer is still the fussiest caller.
const cw = require('./.build/morsecode.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// A deterministic stand-in for Math.random: cycles a fixed list.
const seeded = (values) => {
    let i = 0;
    return () => values[i++ % values.length];
};

// --- noughts and crosses ------------------------------------------------------

t('a perfect opponent never loses', () => {
    // The property that makes the blunder rate necessary: with both sides playing
    // optimally the game is a draw every time, so an AI at rate 0 cannot be beaten
    // and the game is unwinnable rather than hard.
    for (let game = 0; game < 20; game++) {
        let board = ttt.emptyBoard();
        let human = game % 2 === 0;      // alternate who opens
        while (!ttt.winner(board)) {
            if (human) {
                // The human plays optimally too, by borrowing the same search.
                const flipped = board.map((v) => (v === ttt.HUMAN ? ttt.AI : v === ttt.AI ? ttt.HUMAN : v));
                const i = ttt.bestMove(flipped, 0);
                board[i] = ttt.HUMAN;
            } else {
                board[ttt.bestMove(board, 0)] = ttt.AI;
            }
            human = !human;
        }
        assert.notStrictEqual(ttt.winner(board), ttt.HUMAN, `game ${game} was lost by a perfect AI`);
    }
});

t('the opponent takes a win when there is one, and blocks when there is not', () => {
    const win = [ttt.AI, ttt.AI, '', ttt.HUMAN, ttt.HUMAN, '', '', '', ''];
    assert.strictEqual(ttt.bestMove(win, 0), 2, 'should finish its own line');
    const block = [ttt.HUMAN, ttt.HUMAN, '', '', ttt.AI, '', '', '', ''];
    assert.strictEqual(ttt.bestMove(block, 0), 2, 'should block');
});

t('the blunder rate moves toward the player who is losing', () => {
    // Asymmetric on purpose: a losing player is helped faster than a winning one
    // is punished.
    const start = ttt.BLUNDER_START;
    assert.ok(ttt.adaptBlunder(start, false) - start > start - ttt.adaptBlunder(start, true));
    assert.strictEqual(ttt.adaptBlunder(start, null), start, 'a draw changes nothing');
    // And it never reaches "never misses" or "plays at random".
    let rate = start;
    for (let i = 0; i < 50; i++) rate = ttt.adaptBlunder(rate, true);
    assert.ok(rate >= ttt.BLUNDER_MIN);
    for (let i = 0; i < 50; i++) rate = ttt.adaptBlunder(rate, false);
    assert.ok(rate <= ttt.BLUNDER_MAX);
});

t('a full board is a draw, not a crash', () => {
    const full = [ttt.HUMAN, ttt.AI, ttt.HUMAN, ttt.HUMAN, ttt.AI, ttt.AI, ttt.AI, ttt.HUMAN, ttt.HUMAN];
    assert.strictEqual(ttt.winner(full), 'draw');
    assert.strictEqual(ttt.bestMove(full, 0), -1);
    assert.strictEqual(ttt.winLine(full), null);
});

// --- minesweeper ---------------------------------------------------------------

t('the first click and everything around it are always safe', () => {
    // Not just the square: a first click that survives and reveals a lone "8" is
    // a game with nothing to go on.
    for (const [r, c] of [[0, 0], [3, 4], [7, 7], [0, 7]]) {
        const board = ms.placeMines(r, c);
        assert.notStrictEqual(board[ms.idx(r, c)], ms.MINE, `${r},${c} was mined`);
        for (const [nr, nc] of ms.neighboursOf(r, c)) {
            assert.notStrictEqual(board[ms.idx(nr, nc)], ms.MINE, `${nr},${nc} beside the first click`);
        }
    }
});

t('the field always has exactly ten mines and correct counts', () => {
    const board = ms.placeMines(4, 4);
    assert.strictEqual(board.filter((v) => v === ms.MINE).length, ms.MINES);
    for (let r = 0; r < ms.ROWS; r++) {
        for (let c = 0; c < ms.COLS; c++) {
            if (board[ms.idx(r, c)] === ms.MINE) continue;
            const around = ms.neighboursOf(r, c)
                .filter(([nr, nc]) => board[ms.idx(nr, nc)] === ms.MINE).length;
            assert.strictEqual(board[ms.idx(r, c)], around, `count at ${r},${c}`);
        }
    }
});

t('opening a space opens outwards, and flags stop it', () => {
    const board = ms.placeMines(0, 0);
    const none = Array(ms.CELLS).fill(false);
    const opened = ms.floodReveal(board, none, none, 0, 0);
    assert.ok(opened.filter(Boolean).length > 1, 'a safe corner should open more than itself');

    // A flag in the way is not opened, whatever is under it.
    const flagged = none.slice();
    const spread = opened.findIndex((v, i) => v && i !== 0);
    flagged[spread] = true;
    const stopped = ms.floodReveal(board, none, flagged, 0, 0);
    assert.strictEqual(stopped[spread], false);
});

t('cleared means every square that is not a mine', () => {
    const revealed = Array(ms.CELLS).fill(true);
    for (let i = 0; i < ms.MINES; i++) revealed[i] = false;
    assert.ok(ms.isWon(revealed));
    revealed[ms.MINES] = false;
    assert.ok(!ms.isWon(revealed));
});

// --- 15-puzzle -----------------------------------------------------------------

t('a shuffle is always solvable and never already solved', () => {
    // Half of all arrangements cannot be solved at all, and a player has no way
    // of telling which they have been handed.
    for (let i = 0; i < 200; i++) {
        const tiles = p15.shuffle();
        assert.ok(p15.isSolvable(tiles), 'unsolvable board dealt');
        assert.ok(!p15.isSolved(tiles), 'dealt an already-finished puzzle');
        assert.strictEqual(new Set(tiles).size, p15.TOTAL, 'tiles duplicated or lost');
    }
});

t('parity is measured, not assumed', () => {
    // The solved board is solvable; one swap away from it is not.
    const solved = p15.solvedTiles();
    assert.ok(p15.isSolvable(solved));
    const swapped = solved.slice();
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    assert.ok(!p15.isSolvable(swapped));
});

t('only a tile beside the gap moves, and moving is reversible', () => {
    const tiles = p15.solvedTiles();          // gap at the end, 15
    assert.ok(p15.canMove(tiles, 14), 'left of the gap');
    assert.ok(p15.canMove(tiles, 11), 'above the gap');
    assert.ok(!p15.canMove(tiles, 10), 'diagonal is not a move');
    assert.ok(!p15.canMove(tiles, 0), 'far away');
    assert.strictEqual(p15.slide(tiles, 0), tiles, 'a refused move returns the same board');
    const moved = p15.slide(tiles, 14);
    assert.deepStrictEqual(p15.slide(moved, 15), tiles, 'sliding back undoes it');
});

// --- memory ---------------------------------------------------------------------

t('the deck is every face twice', () => {
    const cards = mem.deal();
    assert.strictEqual(cards.length, mem.CARDS);
    for (const face of mem.FACES) {
        assert.strictEqual(cards.filter((c) => c === face).length, 2, face);
    }
});

t('a third card cannot be turned while two are up', () => {
    // The bug this rule exists for: a fast player ends up with three face up and
    // a state nobody can unpick.
    const locked = { locked: true, flipped: [0, 1], matched: [] };
    assert.ok(!mem.canFlip(locked, 2));
    const open = { locked: false, flipped: [0], matched: [] };
    assert.ok(mem.canFlip(open, 2));
    assert.ok(!mem.canFlip(open, 0), 'nor the same card twice');
    assert.ok(!mem.canFlip({ locked: false, flipped: [], matched: [[2, 3]] }, 3), 'nor a found pair');
});

// --- connect 4 --------------------------------------------------------------------

t('every four-in-a-row on the board is known, once each', () => {
    // 69 lines on a 7×6 board: 24 horizontal, 21 vertical, 12 each diagonal.
    assert.strictEqual(c4.LINES.length, 69);
    const seen = new Set(c4.LINES.map((l) => l.join(',')));
    assert.strictEqual(seen.size, c4.LINES.length);
});

t('a disc falls to the bottom of its column', () => {
    let board = c4.emptyBoard();
    assert.strictEqual(c4.dropRow(board, 0), c4.ROWS - 1);
    board = c4.dropDisc(board, 0, c4.HUMAN);
    assert.strictEqual(c4.dropRow(board, 0), c4.ROWS - 2);
    for (let i = 0; i < c4.ROWS - 1; i++) board = c4.dropDisc(board, 0, c4.HUMAN);
    assert.strictEqual(c4.dropRow(board, 0), -1, 'a full column takes no more');
    assert.strictEqual(c4.dropDisc(board, 0, c4.AI), null);
});

t('the opponent takes a win and blocks a loss', () => {
    // Three of its own on the bottom row: it must finish rather than build.
    let board = c4.emptyBoard();
    for (const col of [0, 1, 2]) board = c4.dropDisc(board, col, c4.AI);
    assert.strictEqual(c4.bestCol(board, 0), 3, 'should complete its own four');

    // Three of the human's against the left wall: the only threat is column 3,
    // and it must be taken. Deliberately not 1-2-3, which is open at both ends —
    // that position is already lost and every reply scores the same, so it tests
    // nothing about blocking.
    let block = c4.emptyBoard();
    for (const col of [0, 1, 2]) block = c4.dropDisc(block, col, c4.HUMAN);
    assert.strictEqual(c4.bestCol(block, 0), 3, 'should block the only threat');
});

t('a win is detected in all four directions', () => {
    const line = (cells) => {
        const b = c4.emptyBoard();
        for (const i of cells) b[i] = c4.AI;
        return b;
    };
    assert.ok(c4.hasWon(line([35, 36, 37, 38]), c4.AI), 'horizontal');
    assert.ok(c4.hasWon(line([14, 21, 28, 35]), c4.AI), 'vertical');
    assert.ok(c4.hasWon(line([14, 22, 30, 38]), c4.AI), 'diagonal down');
    assert.ok(c4.hasWon(line([17, 23, 29, 35]), c4.AI), 'diagonal up');
    assert.ok(!c4.hasWon(line([35, 36, 37]), c4.AI), 'three is not four');
});

// --- sudoku ------------------------------------------------------------------------

t('a generated puzzle has exactly one answer', () => {
    // Removing cells at random leaves an ambiguous puzzle surprisingly often, and
    // an ambiguous puzzle rejects a correct grid.
    for (let i = 0; i < 8; i++) {
        const { puzzle, given, solution } = su.generate();
        assert.strictEqual(su.countSolutions(puzzle, 3), 1, 'not unique');
        assert.strictEqual(given.filter(Boolean).length, su.CELLS - su.MAX_REMOVE);
        // ...and the answer it was cut from is a legal grid.
        assert.ok(su.isComplete(solution));
        assert.strictEqual(su.conflicts(solution).size, 0);
    }
});

t('the givens agree with the solution', () => {
    const { puzzle, given, solution } = su.generate();
    puzzle.forEach((v, i) => {
        if (given[i]) assert.strictEqual(v, solution[i], `given at ${i}`);
        else assert.strictEqual(v, 0);
    });
});

t('conflicts name both sides of the clash', () => {
    // Telling somebody a digit is wrong without showing what it argues with is a
    // puzzle about the puzzle.
    const grid = new Array(su.CELLS).fill(0);
    grid[0] = 3;
    grid[5] = 3;                      // same row
    const bad = su.conflicts(grid);
    assert.ok(bad.has(0) && bad.has(5));
    assert.strictEqual(bad.size, 2);
    assert.strictEqual(su.conflicts([...new Array(su.CELLS).fill(0)]).size, 0, 'an empty grid is not in conflict');
});

t('the box rule is two rows by three columns', () => {
    const grid = new Array(su.CELLS).fill(0);
    grid[0] = 4;
    // Same 2×3 box (row 1, column 2) — a clash.
    assert.ok(!su.canPlace(grid, su.N + 2, 4));
    // Row 2, column 3 is the next box along — allowed.
    assert.ok(su.canPlace(grid, su.N + 3, 4));
});

// --- lights out ----------------------------------------------------------------------

t('a press flips the light and its four neighbours, and never the diagonals', () => {
    const off = new Array(lo.CELLS).fill(false);
    const after = lo.pressAt(off, 2, 2);
    assert.strictEqual(lo.litCount(after), 5);
    for (const [r, c] of [[2, 2], [1, 2], [3, 2], [2, 1], [2, 3]]) {
        assert.ok(after[lo.idx(r, c)], `${r},${c} should be lit`);
    }
    assert.ok(!after[lo.idx(1, 1)], 'diagonals are untouched');
});

t('a press in a corner does not wrap round the board', () => {
    const off = new Array(lo.CELLS).fill(false);
    assert.strictEqual(lo.litCount(lo.pressAt(off, 0, 0)), 3);
});

t('every scramble can be turned off, and none starts finished', () => {
    // Only a fraction of the 33 million boards are solvable, so scrambling by
    // pressing — rather than by filling at random — is the whole guarantee.
    for (let i = 0; i < 100; i++) {
        const grid = lo.scramble();
        assert.ok(!lo.isWon(grid), 'dealt an already-solved board');
    }
    // Pressing is its own inverse, which is why the guarantee holds.
    const off = new Array(lo.CELLS).fill(false);
    assert.deepStrictEqual(lo.pressAt(lo.pressAt(off, 1, 3), 1, 3), off);
});

// --- mastermind ------------------------------------------------------------------------

t('an exact match scores black and nothing else', () => {
    assert.deepStrictEqual(mm.scoreGuess([0, 1, 2, 3], [0, 1, 2, 3]), { black: 4, white: 0 });
    assert.ok(mm.isCracked(mm.scoreGuess([0, 1, 2, 3], [0, 1, 2, 3])));
});

t('a peg is never counted twice', () => {
    // The classic bug. Two of a colour in the guess against one in the code is
    // one white, not two — and a peg already counted black cannot also be white.
    assert.deepStrictEqual(mm.scoreGuess([0, 0, 1, 1], [0, 1, 2, 3]), { black: 1, white: 1 });
    assert.deepStrictEqual(mm.scoreGuess([0, 0, 0, 0], [0, 1, 1, 1]), { black: 1, white: 0 });
    assert.deepStrictEqual(mm.scoreGuess([1, 1, 1, 1], [0, 1, 1, 0]), { black: 2, white: 0 });
});

t('the same colours in the wrong places are all white', () => {
    assert.deepStrictEqual(mm.scoreGuess([1, 0, 3, 2], [0, 1, 2, 3]), { black: 0, white: 4 });
});

t('black and white never exceed the number of slots', () => {
    const rand = seeded([0.1, 0.9, 0.4, 0.6, 0.2, 0.8]);
    for (let i = 0; i < 200; i++) {
        const secret = mm.makeSecret(Math.random);
        const guess = mm.makeSecret(rand);
        const { black, white } = mm.scoreGuess(guess, secret);
        assert.ok(black + white <= mm.SLOTS, `${black}+${white} for ${guess} vs ${secret}`);
        assert.ok(black >= 0 && white >= 0);
    }
});

// --- the quizzes -------------------------------------------------------------------------

t('a question always has the right answer among the options, exactly once', () => {
    for (let i = 0; i < 50; i++) {
        const opts = quiz.buildOptions('England', ['England', 'Wales', 'Spain', 'Peru', 'Chad', 'Fiji']);
        assert.strictEqual(opts.length, quiz.OPTIONS);
        assert.strictEqual(opts.filter((o) => o === 'England').length, 1);
        assert.strictEqual(new Set(opts).size, opts.length, 'no repeats');
    }
});

t('a short pool still makes a question', () => {
    // A receiver with a tiny country list must still be playable, with fewer
    // wrong answers rather than none.
    const opts = quiz.buildOptions('England', ['England', 'Wales']);
    assert.deepStrictEqual([...opts].sort(), ['England', 'Wales']);
});

t('recently asked callsigns are held back until the pool runs dry', () => {
    const seen = new Set(['A', 'B', 'C']);
    assert.deepStrictEqual(quiz.orderCandidates(seen, ['A', 'B'], new Set()).sort(), ['C']);
    // Everything asked recently: start over rather than run out of questions.
    assert.strictEqual(quiz.orderCandidates(seen, ['A', 'B', 'C'], new Set()).length, 3);
});

t('callsigns nothing could be found for go last, not away', () => {
    // With a small pool they may be all there is, and the receiver may since have
    // learned the prefix.
    const order = quiz.orderCandidates(new Set(['A', 'B']), [], new Set(['A']));
    assert.deepStrictEqual(order, ['B', 'A']);
});

t('the callsign pool is capped, dropping the oldest', () => {
    let seen = new Set();
    for (let i = 0; i < quiz.SEEN_MAX + 50; i++) seen = quiz.addSeen(seen, [`CALL${i}`]);
    assert.strictEqual(seen.size, quiz.SEEN_MAX);
    assert.ok(!seen.has('CALL0'), 'the oldest went first');
    assert.ok(seen.has(`CALL${quiz.SEEN_MAX + 49}`));
});

// --- the map ---------------------------------------------------------------------------------

t('the view never leaves the planet', () => {
    // Zoomed out, an axis wider than the world locks to the centre rather than
    // showing empty space beside it.
    const out = map.clampView({ lon: 170, lat: 80, z: 1 }, 336, 168);
    assert.strictEqual(out.lon, 0);
    assert.strictEqual(out.lat, 0);
    // Zoomed in, panning is allowed but stops at the edge.
    const inn = map.clampView({ lon: 200, lat: 100, z: 8 }, 336, 168);
    assert.ok(inn.lon < 180 && inn.lon > 0);
    assert.ok(inn.lat < 90 && inn.lat > 0);
    // And the zoom itself is bounded.
    assert.strictEqual(map.clampView({ lon: 0, lat: 0, z: 1000 }, 336, 168).z, map.ZOOM_MAX);
    assert.strictEqual(map.clampView({ lon: 0, lat: 0, z: 0.01 }, 336, 168).z, map.ZOOM_MIN);
});

t('projecting and unprojecting are inverses', () => {
    const view = { lon: 12, lat: -30, z: 4 };
    const [x, y] = map.project(20, -25, view, 336, 168);
    const [lon, lat] = map.unproject(x, y, view, 336, 168);
    assert.ok(Math.abs(lon - 20) < 1e-9 && Math.abs(lat + 25) < 1e-9);
});

t('a country with an absurd bounding box is framed by fallback, not by its box', () => {
    // Natural Earth spans are unusable for anything owning distant islands or
    // crossing the antimeridian — Russia, the USA, Fiji, Norway with Bouvet.
    const russia = map.viewFor({
        country: 'Russia', lon: 100, lat: 60, min_lon: -180, max_lon: 180, min_lat: 41, max_lat: 82,
    }, 336, 168);
    assert.strictEqual(russia.z, 3, 'fell back to a regional zoom');
    // A compact country is framed by its own box, and closer in.
    const wales = map.viewFor({
        country: 'Wales', lon: -3.5, lat: 52.3, min_lon: -5.3, max_lon: -2.6, min_lat: 51.3, max_lat: 53.4,
    }, 336, 168);
    assert.ok(wales.z > 3, `zoomed to ${wales.z}`);
});

t('a country is not asked about twice in a row', () => {
    const list = [{ country: 'A' }, { country: 'B' }, { country: 'C' }];
    assert.strictEqual(quiz.pickCountry(list, ['A', 'B']).country, 'C');
    // Everything asked: start over rather than return nothing.
    assert.ok(quiz.pickCountry(list, ['A', 'B', 'C']));
});

t('TopoJSON arcs are decoded with the running sum and the transform', () => {
    // Points are delta-encoded integers, so a decoder that forgets the running
    // total produces a map that looks like static.
    const topo = {
        transform: { scale: [1, 2], translate: [10, 20] },
        arcs: [[[0, 0], [1, 1], [2, 2]]],
    };
    const [arc] = map.decodeArcs(topo);
    assert.deepStrictEqual([...arc.pts], [10, 20, 11, 22, 13, 26]);
    assert.deepStrictEqual(arc.b, [10, 20, 13, 26], 'and the bounding box comes with it');
    assert.strictEqual(map.decodeArcs(null), null);
});

t('an arc outside the view is rejected without looking at its points', () => {
    const arc = { pts: [], b: [-10, -10, -5, -5] };
    assert.ok(map.arcVisible(arc, { lon: -7, lat: -7, z: 8 }, 336, 168));
    assert.ok(!map.arcVisible(arc, { lon: 150, lat: 60, z: 8 }, 336, 168));
});

// --- morse: the code ------------------------------------------------------------
//
// A trainer that teaches the wrong code is worse than no trainer, and a test that
// simply repeats the table agrees with whatever slip is in it. So most of these
// check properties a transcription error breaks rather than the entries
// themselves — and the entries that *are* written out are the half anybody can
// check against a card, or a memory of one.

t('the alphabet is the alphabet', () => {
    const expected = {
        A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.',
        H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.',
        O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-',
        V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
    };
    assert.deepStrictEqual(cw.LETTERS, expected);
});

t('no two characters share a code', () => {
    // The failure a typo actually produces: one entry wrong is usually one entry
    // colliding with another, and then the reverse table silently loses a letter.
    const codes = Object.values(cw.MORSE);
    assert.strictEqual(new Set(codes).size, codes.length);
    assert.strictEqual(Object.keys(cw.FROM_CODE).length, codes.length);
});

t('every code is dots and dashes and nothing else', () => {
    for (const [ch, code] of Object.entries(cw.MORSE)) {
        assert.ok(/^[.-]+$/.test(code), `${ch} is "${code}"`);
    }
});

t('letters are one to four elements, digits exactly five', () => {
    for (const [ch, code] of Object.entries(cw.LETTERS)) {
        assert.ok(code.length >= 1 && code.length <= 4, `${ch} is ${code.length} elements`);
    }
    for (const [d, code] of Object.entries(cw.DIGITS)) {
        assert.strictEqual(code.length, 5, `${d} is ${code.length} elements`);
    }
    for (const [ch, code] of Object.entries(cw.PUNCTUATION)) {
        assert.ok(code.length >= 5 && code.length <= 6, `${ch} is ${code.length} elements`);
    }
});

t('the digits count up in dahs from the left', () => {
    // 1 is one dit then four dahs, 5 is five dits, 0 is five dahs — a pattern the
    // whole set follows, and one that needs no table to check against.
    for (let n = 1; n <= 5; n++) {
        assert.strictEqual(cw.DIGITS[n], '.'.repeat(n) + '-'.repeat(5 - n), String(n));
    }
    for (let n = 6; n <= 9; n++) {
        assert.strictEqual(cw.DIGITS[n], '-'.repeat(n - 5) + '.'.repeat(10 - n), String(n));
    }
    assert.strictEqual(cw.DIGITS[0], '-----');
});

t('the shortest codes are the commonest letters', () => {
    // Morse was built that way, so it is a real property of a correct table.
    const byLength = (n) => Object.entries(cw.LETTERS)
        .filter(([, code]) => code.length === n).map(([ch]) => ch).sort();
    assert.deepStrictEqual(byLength(1), ['E', 'T']);
    assert.deepStrictEqual(byLength(2), ['A', 'I', 'M', 'N']);
});

t('SOS, CQ and a callsign come out right', () => {
    assert.strictEqual(cw.toMorse('SOS'), '... --- ...');
    assert.strictEqual(cw.toMorse('CQ'), '-.-. --.-');
    assert.strictEqual(cw.toMorse('M9PSY'), '-- ----. .--. ... -.--');
    assert.strictEqual(cw.toMorse('cq de'), '-.-. --.- / -.. .', 'case and words');
});

t('the code reads back as what was sent', () => {
    for (const ch of Object.keys(cw.MORSE)) {
        assert.strictEqual(cw.fromMorse(cw.toMorse(ch)), ch, ch);
    }
    assert.strictEqual(cw.fromMorse('... --- ...'), 'SOS');
    assert.strictEqual(cw.fromMorse('-.-. --.- / -.. .'), 'CQ DE');
});

t('anything not in the table is left out rather than guessed at', () => {
    assert.strictEqual(cw.codeFor('£'), '');
    assert.strictEqual(cw.charFor('.-.-.-.-.-'), '');
    assert.strictEqual(cw.toMorse('A£B'), '.- -...');
});

// --- morse: the timing ------------------------------------------------------------

t('PARIS is fifty units, which is what a word per minute means', () => {
    // The definition. Wrong here and every speed in the trainer is wrong, and
    // somebody learns a rhythm they will have to unlearn.
    assert.strictEqual(cw.unitsFor('PARIS') + cw.WORD_GAP, cw.PARIS_UNITS);
});

t('a unit is 1200 ms divided by the speed', () => {
    assert.strictEqual(cw.unitMs(20), 60);
    assert.strictEqual(cw.unitMs(12), 100);
    assert.strictEqual(cw.unitMs(25), 48);
    // ...so "PARIS " at 20 wpm takes exactly three seconds, which is twenty of
    // them in a minute.
    const total = cw.toneSlices('PARIS', 20).reduce((n, s) => n + s.ms, 0);
    assert.strictEqual(Math.round(total + cw.WORD_GAP * cw.unitMs(20)), 3000);
});

t('a dit is one unit, a dah is three, and the gaps are one, three and seven', () => {
    const u = cw.unitMs(20);
    assert.deepStrictEqual(cw.toneSlices('A', 20), [
        { on: true, ms: 1 * u },
        { on: false, ms: 1 * u },
        { on: true, ms: 3 * u },
    ]);
    assert.deepStrictEqual(cw.toneSlices('EE', 20)[1], { on: false, ms: 3 * u }, 'characters');
    assert.deepStrictEqual(cw.toneSlices('E E', 20)[1], { on: false, ms: 7 * u }, 'words');
});

t('a character never starts or ends with silence', () => {
    // Inaudible, but it would shift everything after it — the classic off-by-one
    // in a keyer.
    for (const ch of Object.keys(cw.MORSE)) {
        const slices = cw.toneSlices(ch, 20);
        assert.ok(slices[0].on, `${ch} starts silent`);
        assert.ok(slices[slices.length - 1].on, `${ch} ends silent`);
        slices.forEach((s, i) => assert.strictEqual(s.on, i % 2 === 0, `${ch} slice ${i}`));
    }
});

t('Farnsworth stretches the space between characters, not inside them', () => {
    // The whole point of the method: full-speed characters from the start with the
    // spacing padded out. Stretching the insides teaches a rhythm that exists at
    // no speed.
    const slow = cw.toneSlices('AA', 10, 20);
    assert.strictEqual(slow[0].ms, cw.unitMs(20), 'the dit is at character speed');
    assert.strictEqual(slow[3].ms, cw.CHAR_GAP * cw.unitMs(10), 'the gap is at word speed');
});

// --- morse: learning ---------------------------------------------------------------

t('Koch starts with two characters that sound nothing alike', () => {
    assert.deepStrictEqual(cw.kochSet(cw.KOCH_MIN), ['K', 'M']);
    assert.strictEqual(cw.KOCH_MIN, 2, 'one character is not a choice');
});

t('the Koch order has every character once, and all of them are sendable', () => {
    assert.strictEqual(new Set(cw.KOCH).size, cw.KOCH.length);
    for (const ch of cw.KOCH) assert.ok(cw.codeFor(ch), `${ch} has no code`);
});

t('a level can neither drop below two nor run off the end', () => {
    assert.deepStrictEqual(cw.kochSet(0), ['K', 'M']);
    assert.deepStrictEqual(cw.kochSet(-5), ['K', 'M']);
    assert.strictEqual(cw.kochSet(9999).length, cw.KOCH.length);
});

t('the next character asked is one in play, and rarely the one just asked', () => {
    const set = cw.kochSet(8);
    for (let i = 0; i < 200; i++) {
        const ch = cw.pickChar(8, ['K', 'M', 'R']);
        assert.ok(set.includes(ch), `${ch} is not in play`);
        assert.ok(!['K', 'M', 'R'].includes(ch), 'just asked');
    }
    // With only two in play there is nothing to avoid, and it must still answer.
    assert.ok(['K', 'M'].includes(cw.pickChar(2, ['K', 'M'])));
});

console.log(`\n${pass} ok`);
