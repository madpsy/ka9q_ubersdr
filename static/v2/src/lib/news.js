// Ham radio headlines, from ARRL or RSGB.
//
// Ported from widgets/ham_radio_news.widget.html, including the two things that
// widget learned the hard way:
//
//   * neither feed sends CORS headers, so neither can be fetched from a browser.
//     Both go through rss2json.com, which relays RSS as JSON. That is a
//     third-party dependency on a free tier, and it is the only part of this
//     panel that can fail — hence the cache below.
//   * rss2json's free tier *rejects* the `count` parameter ("To use this
//     parameter `count` you need a valid api key"), so the whole feed is
//     fetched and paged here instead of asking for a page.
//
// Headlines are cached per source and shown at once on reload while a fresh
// fetch runs behind them, and a failed fetch falls back to that cache rather
// than emptying the panel. A news panel that is blank because somebody else's
// relay is down is worse than a slightly old one that says it is old.

const RELAY = 'https://api.rss2json.com/v1/api.json?rss_url=';

export const NEWS_SOURCES = [
    { id: 'arrl', label: 'ARRL News', feed: 'https://www.arrl.org/news/rss' },
    { id: 'rsgb', label: 'RSGB News', feed: 'https://rsgb.org/main/feed/' },
];

export const NEWS_PAGE = 5;

// Well above what either feed realistically carries (5–10), so there is
// something to page through without a pathological feed filling storage.
const MAX_ITEMS = 20;

const SOURCE_KEY = 'ubersdr.v2.news';
const cacheKey = (id) => `ubersdr.v2.news.cache.${id}`;

export function newsSource(id) {
    return NEWS_SOURCES.find((s) => s.id === id) || null;
}

export function newsApiUrl(id) {
    const src = newsSource(id);
    return src ? RELAY + encodeURIComponent(src.feed) : '';
}

/** The operator's last choice, or the first source. */
export function savedNewsSource() {
    try {
        const id = localStorage.getItem(SOURCE_KEY);
        if (newsSource(id)) return id;
    } catch (e) { /* private browsing */ }
    return NEWS_SOURCES[0].id;
}

export function saveNewsSource(id) {
    if (!newsSource(id)) return;
    try { localStorage.setItem(SOURCE_KEY, id); } catch (e) { /* ignore */ }
}

/**
 * The relay's payload, reduced to the three fields shown. Returns [] for
 * anything unusable, so a caller can treat "no items" as the one failure.
 */
export function parseNewsItems(json) {
    if (!json || json.status !== 'ok' || !Array.isArray(json.items)) return [];
    return json.items.slice(0, MAX_ITEMS)
        .map((it) => ({
            title: String(it.title || '').trim(),
            link: String(it.link || '').trim(),
            pubDate: String(it.pubDate || '').trim(),
        }))
        // A headline with nothing to open is not a headline.
        .filter((it) => it.title && it.link);
}

export function loadNewsCache(id) {
    try {
        const parsed = JSON.parse(localStorage.getItem(cacheKey(id)));
        if (parsed && Array.isArray(parsed.items) && parsed.items.length) return parsed;
    } catch (e) { /* ignore */ }
    return null;
}

export function saveNewsCache(id, items) {
    if (!items || !items.length) return;
    try {
        localStorage.setItem(cacheKey(id), JSON.stringify({ items, at: Date.now() }));
    } catch (e) { /* quota, private browsing — the panel still works this session */ }
}

/** "5 Aug", or '' for a date the feed did not give or mangled. */
export function formatNewsDate(pubDate) {
    if (!pubDate) return '';
    // rss2json hands back "2026-08-05 15:50:52", which Safari will not parse as
    // a date at all. An ISO-ish string with a T is understood everywhere.
    const d = new Date(/^\d{4}-\d{2}-\d{2} /.test(pubDate) ? pubDate.replace(' ', 'T') : pubDate);
    if (Number.isNaN(d.getTime())) return '';
    try {
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch (e) {
        return '';
    }
}

/**
 * Headlines for one source.
 *
 * @returns { items, stale, error } — `stale` means these came from the cache
 *          after the relay failed, which the panel says out loud rather than
 *          passing off as current.
 */
export function fetchNews(id) {
    const url = newsApiUrl(id);
    if (!url) return Promise.resolve({ items: [], error: 'Unknown news source.' });

    return fetch(url)
        .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then((json) => {
            const items = parseNewsItems(json);
            if (!items.length) throw new Error('no headlines in the feed');
            saveNewsCache(id, items);
            return { items, stale: false };
        })
        .catch(() => {
            const cached = loadNewsCache(id);
            if (cached) return { items: cached.items, stale: true, at: cached.at };
            return { items: [], error: 'Unable to load news right now.' };
        });
}

/** Test seam. */
export function _clearNews() {
    for (const s of NEWS_SOURCES) {
        try { localStorage.removeItem(cacheKey(s.id)); } catch (e) { /* ignore */ }
    }
    try { localStorage.removeItem(SOURCE_KEY); } catch (e) { /* ignore */ }
}
