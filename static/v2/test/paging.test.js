// The paged-list arithmetic.
//
// These lists change while somebody is looking at them — a bookmark is deleted, a search
// narrows, the receiver republishes its bookmarks — and the page number was chosen for the
// list as it used to be. Most of what is checked here is that case: the window has to land
// inside the list as it is now, on the way out, because the alternative is a panel that
// goes blank for a frame and an operator who cannot say why.

const assert = require('assert');
const { PAGE_ROWS, homePage, pageCount, pageWindow } = require('./.build/paging.cjs');

let pass = 0;
const t = (name, fn) => {
    try { fn(); console.log('ok    ' + name); pass++; }
    catch (e) { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

// --- how many pages ----------------------------------------------------------------

t('a part-full last page still counts', () => {
    assert.strictEqual(pageCount(118, 10), 12);
    assert.strictEqual(pageCount(120, 10), 12);
    assert.strictEqual(pageCount(121, 10), 13);
});

t('an empty list is one page, not none', () => {
    // The controls hide themselves at one page; "of 0" is not a thing to render.
    assert.strictEqual(pageCount(0, 10), 1);
    assert.strictEqual(pageCount(null, 10), 1);
});

t('a page size of nothing does not divide by it', () => {
    assert.strictEqual(pageCount(50, 0), 1);
});

// --- the window --------------------------------------------------------------------

t('the first page starts at the first row', () => {
    const w = pageWindow(118, 0, 10);
    assert.deepStrictEqual([w.start, w.end], [0, 10]);
    assert.strictEqual(w.pages, 12);
});

t('a middle page is the rows it says it is', () => {
    // Page 4 shown as "31–40 of 118", which is start+1 through end.
    const w = pageWindow(118, 3, 10);
    assert.deepStrictEqual([w.start, w.end], [30, 40]);
});

t('the last page is short rather than running past the end', () => {
    const w = pageWindow(118, 11, 10);
    assert.deepStrictEqual([w.start, w.end], [110, 118]);
});

t('a page past the end is clamped to the last one that exists', () => {
    // The search narrowed from two hundred matches to twelve while page 9 was showing.
    const w = pageWindow(12, 9, 10);
    assert.strictEqual(w.page, 1);
    assert.deepStrictEqual([w.start, w.end], [10, 12]);
});

t('deleting the only row on the last page falls back a page', () => {
    // 11 bookmarks on page 2, one deleted: page 2 no longer exists, and the answer is
    // page 1 rather than ten blank rows.
    const before = pageWindow(11, 1, 10);
    assert.deepStrictEqual([before.start, before.end], [10, 11]);
    const after = pageWindow(10, 1, 10);
    assert.strictEqual(after.page, 0);
    assert.deepStrictEqual([after.start, after.end], [0, 10]);
});

t('an emptied list is page one of one, with nothing in the window', () => {
    const w = pageWindow(0, 5, 10);
    assert.deepStrictEqual([w.page, w.pages, w.start, w.end], [0, 1, 0, 0]);
});

t('a negative or nonsense page is the first one', () => {
    assert.strictEqual(pageWindow(50, -3, 10).page, 0);
    assert.strictEqual(pageWindow(50, NaN, 10).page, 0);
});

t('the total comes back as a number the caller can render', () => {
    // The panels pass `filtered.length`, but a list still loading is nothing at all.
    assert.strictEqual(pageWindow(null, 0, 10).total, 0);
});

// --- where to open -----------------------------------------------------------------
//
// The bands panel opens on the band the receiver is in rather than the LF end.

t('the opening page is the one holding the row asked for', () => {
    assert.strictEqual(homePage(0, 12, 10), 0);
    assert.strictEqual(homePage(9, 12, 10), 0);
    assert.strictEqual(homePage(10, 12, 10), 1);
    assert.strictEqual(homePage(117, 12, 10), 11);
});

t('no row asked for means the first page', () => {
    // -1 is what the bands panel passes while a search is running: the matches are then
    // the point, and the first of them is the answer.
    assert.strictEqual(homePage(-1, 12, 10), 0);
    assert.strictEqual(homePage(null, 12, 10), 0);
});

t('a row beyond the list cannot open past the end', () => {
    assert.strictEqual(homePage(500, 12, 10), 11);
});

t('the default page size is the one the panels use', () => {
    assert.strictEqual(PAGE_ROWS, 10);
    assert.strictEqual(pageWindow(25, 1).end, 20);
});

if (process.exitCode) console.log('\npaging tests FAILED');
else console.log(`\nall ${pass} paging tests passed`);
