// Ham radio headlines.
//
// The one thing this panel depends on is not the receiver: it is rss2json.com,
// a free relay standing in for two feeds that send no CORS headers. So what is
// worth testing is what happens when that is unavailable — because it will be,
// and a news panel that goes blank when somebody else's service is down is a
// worse panel than one that says its headlines are old.

const assert = require('assert');
const news = require('./.build/news.cjs');

let pass = 0;
let chain = Promise.resolve();
const t = (name, fn) => {
    chain = chain.then(() => Promise.resolve(fn())).then(
        () => { console.log('ok    ' + name); pass++; },
        (e) => { console.log('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; },
    );
};

// localStorage, since node has none.
const store = new Map();
global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};

// A relay response, in the shape rss2json actually returns.
const feed = (n) => ({
    status: 'ok',
    items: Array.from({ length: n }, (_, i) => ({
        title: `Headline ${i + 1}`,
        link: `https://example.org/${i + 1}`,
        pubDate: '2026-08-05 15:50:52',
        author: 'someone',
        content: '<p>ignored</p>',
    })),
});

function withFetch(impl, fn) {
    const prev = global.fetch;
    let calls = 0;
    global.fetch = (...args) => { calls++; return impl(...args); };
    return Promise.resolve(fn(() => calls)).finally(() => { global.fetch = prev; });
}
const ok = (body) => () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const dead = () => Promise.reject(new TypeError('Failed to fetch'));

// --- sources -----------------------------------------------------------------

t('both sources are offered, and each has a feed', () => {
    assert.strictEqual(news.NEWS_SOURCES.length, 2);
    const ids = news.NEWS_SOURCES.map((s) => s.id);
    assert.deepStrictEqual(ids, ['arrl', 'rsgb']);
    for (const s of news.NEWS_SOURCES) assert.match(s.feed, /^https:\/\//);
});

t('the feed goes through the relay, encoded', () => {
    // Neither feed sends CORS headers, so a direct URL here would fail in a
    // browser and pass in node — worth pinning.
    const url = news.newsApiUrl('arrl');
    assert.ok(url.startsWith('https://api.rss2json.com/'), url);
    assert.ok(url.includes(encodeURIComponent('https://www.arrl.org/news/rss')), url);
});

t('an unknown source has no URL and fetches nothing', () => withFetch(
    ok(feed(5)),
    async (calls) => {
        assert.strictEqual(news.newsApiUrl('nope'), '');
        const r = await news.fetchNews('nope');
        assert.strictEqual(calls(), 0);
        assert.ok(r.error);
    },
));

t('the chosen source is remembered, and nonsense is not', () => {
    news._clearNews();
    assert.strictEqual(news.savedNewsSource(), 'arrl', 'the default');
    news.saveNewsSource('rsgb');
    assert.strictEqual(news.savedNewsSource(), 'rsgb');
    news.saveNewsSource('bbc');
    assert.strictEqual(news.savedNewsSource(), 'rsgb', 'an unknown source overwrote the choice');
});

// --- parsing -----------------------------------------------------------------

t('the relay payload is reduced to what is shown', () => {
    const items = news.parseNewsItems(feed(3));
    assert.strictEqual(items.length, 3);
    assert.deepStrictEqual(Object.keys(items[0]).sort(), ['link', 'pubDate', 'title']);
});

t('a headline with nothing to open is dropped', () => {
    const items = news.parseNewsItems({
        status: 'ok',
        items: [
            { title: 'Fine', link: 'https://example.org/1' },
            { title: 'No link', link: '' },
            { title: '', link: 'https://example.org/3' },
        ],
    });
    assert.deepStrictEqual(items.map((i) => i.title), ['Fine']);
});

t('a feed that runs away is capped', () => {
    assert.strictEqual(news.parseNewsItems(feed(500)).length, 20);
});

t('a relay error, or nonsense, is no items rather than a crash', () => {
    for (const bad of [null, undefined, {}, { status: 'error' }, { status: 'ok' }, 'nope']) {
        assert.deepStrictEqual(news.parseNewsItems(bad), [], String(bad));
    }
});

// --- dates -------------------------------------------------------------------

t('the relay\'s date format is understood', () => {
    // "2026-08-05 15:50:52" — a space, not a T, which Safari refuses outright.
    assert.strictEqual(news.formatNewsDate('2026-08-05 15:50:52'), news.formatNewsDate('2026-08-05T15:50:52'));
    assert.ok(news.formatNewsDate('2026-08-05 15:50:52').length > 0);
});

t('an RFC 822 date works too, since that is what RSS carries', () => {
    assert.ok(news.formatNewsDate('Wed, 05 Aug 2026 15:50:52 +0000').length > 0);
});

t('a missing or unparseable date is no date, not "Invalid Date"', () => {
    assert.strictEqual(news.formatNewsDate(''), '');
    assert.strictEqual(news.formatNewsDate(null), '');
    assert.strictEqual(news.formatNewsDate('sometime last week'), '');
});

// --- fetching and the cache --------------------------------------------------

t('a good fetch returns headlines and remembers them', () => withFetch(
    ok(feed(7)),
    async () => {
        news._clearNews();
        const r = await news.fetchNews('arrl');
        assert.strictEqual(r.items.length, 7);
        assert.strictEqual(r.stale, false);
        assert.strictEqual(news.loadNewsCache('arrl').items.length, 7);
    },
));

t('a dead relay falls back to the last headlines, and says they are old', () => withFetch(
    ok(feed(4)),
    async () => {
        news._clearNews();
        await news.fetchNews('arrl');

        global.fetch = dead;
        const r = await news.fetchNews('arrl');
        assert.strictEqual(r.items.length, 4, 'the panel went blank');
        assert.strictEqual(r.stale, true, 'old headlines were passed off as current');
        assert.strictEqual(r.error, undefined);
    },
));

t('a dead relay with nothing cached is an error, not silence', () => withFetch(
    dead,
    async () => {
        news._clearNews();
        const r = await news.fetchNews('arrl');
        assert.deepStrictEqual(r.items, []);
        assert.ok(r.error, 'nothing on screen would say why');
    },
));

t('an HTTP error is treated as a failure, not as headlines', () => withFetch(
    () => Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) }),
    async () => {
        news._clearNews();
        const r = await news.fetchNews('arrl');
        assert.ok(r.error);
    },
));

t('a relay that answers with an empty feed does not wipe the cache', () => withFetch(
    ok(feed(4)),
    async () => {
        news._clearNews();
        await news.fetchNews('arrl');

        global.fetch = ok({ status: 'ok', items: [] });
        const r = await news.fetchNews('arrl');
        assert.strictEqual(r.items.length, 4, 'an empty answer emptied the panel');
        assert.strictEqual(r.stale, true);
    },
));

t('each source has its own cache', () => withFetch(
    ok(feed(3)),
    async () => {
        news._clearNews();
        await news.fetchNews('arrl');
        assert.strictEqual(news.loadNewsCache('rsgb'), null, 'switching would show the other feed');

        global.fetch = ok(feed(6));
        await news.fetchNews('rsgb');
        assert.strictEqual(news.loadNewsCache('arrl').items.length, 3);
        assert.strictEqual(news.loadNewsCache('rsgb').items.length, 6);
    },
));

t('a corrupt cache is ignored rather than thrown on', () => {
    news._clearNews();
    global.localStorage.setItem('ubersdr.v2.news.cache.arrl', '{not json');
    assert.strictEqual(news.loadNewsCache('arrl'), null);
});

t('storage that refuses to write does not break the fetch', () => withFetch(
    ok(feed(3)),
    async () => {
        const prev = global.localStorage.setItem;
        global.localStorage.setItem = () => { throw new Error('quota'); };
        try {
            const r = await news.fetchNews('arrl');
            assert.strictEqual(r.items.length, 3, 'the headlines were lost with the cache write');
        } finally {
            global.localStorage.setItem = prev;
        }
    },
));

chain.then(() => {
    if (process.exitCode) console.log('\nnews tests FAILED');
    else console.log(`\nall ${pass} news tests passed`);
});
