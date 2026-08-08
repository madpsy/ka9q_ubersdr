// Ham radio headlines — widgets/ham_radio_news.widget.html as a panel.
//
// Two sources in a dropdown, five headlines a page, click one to read it. The
// fetching, caching and paging rules are lib/news.js; this is the chrome.
//
// `minimal` is the headlines and nothing else: the source is chosen once, and
// the panel is a list you glance at rather than one you work.

import React, { useCallback, useEffect, useRef, useState } from '../react.js';
import { Button, Empty, Icon } from '../components/ui.jsx';
import {
    NEWS_PAGE, NEWS_SOURCES, fetchNews, formatNewsDate, loadNewsCache,
    saveNewsSource, savedNewsSource,
} from '../lib/news.js';
import { feedInterval } from '../lib/serverFeeds.js';

// The feeds publish a few times a day; this is only so a panel left open does
// not go stale over an afternoon.
const REFRESH_MS = 30 * 60 * 1000;

export default function NewsPanel({ minimal }) {
    const [source, setSource] = useState(savedNewsSource);
    // Seeded from the cache so a reload shows headlines immediately, with the
    // fresh fetch running behind them.
    const [items, setItems] = useState(() => (loadNewsCache(savedNewsSource()) || {}).items || []);
    const [stale, setStale] = useState(false);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [page, setPage] = useState(0);

    // Which source the panel is showing *now*. A response for a feed the
    // operator has since switched away from must not land on top of the newer
    // one, and the relay is slow enough for that to happen by hand.
    const current = useRef(source);
    current.current = source;

    const load = useCallback((id) => {
        setBusy(true);
        fetchNews(id).then((r) => {
            if (current.current !== id) return;
            setBusy(false);
            setItems(r.items);
            setStale(!!r.stale);
            setError(r.error || '');
            setPage(0);
        });
    }, []);

    useEffect(() => {
        // The first call is the gate's leading one, and it uses `source`
        // through the ref exactly as the repeats do.
        return feedInterval(() => load(current.current), REFRESH_MS);
    }, [source, load]);

    const pick = (id) => {
        if (id === source) return;
        saveNewsSource(id);
        setSource(id);
        setError('');
        setStale(false);
        setPage(0);
        // Whatever was last read from this feed, while the fetch is in flight —
        // rather than the other source's headlines sitting under a new label.
        setItems((loadNewsCache(id) || {}).items || []);
    };

    const pages = Math.max(1, Math.ceil(items.length / NEWS_PAGE));
    const p = Math.min(page, pages - 1);
    const shown = minimal
        ? items.slice(0, NEWS_PAGE)
        : items.slice(p * NEWS_PAGE, p * NEWS_PAGE + NEWS_PAGE);

    return (
        <div className="stack">
            {!minimal && (
                <div className="news__head">
                    <select
                        className="select"
                        value={source}
                        onChange={(e) => pick(e.target.value)}
                        aria-label="News source"
                    >
                        {NEWS_SOURCES.map((s) => (
                            <option key={s.id} value={s.id}>{s.label}</option>
                        ))}
                    </select>
                    <Button
                        variant="ghost"
                        size="sm"
                        icon={<Icon.Reset size={13} />}
                        title="Fetch the latest headlines"
                        disabled={busy}
                        onClick={() => load(source)}
                    />
                </div>
            )}

            {error && !items.length && <div className="note note--warn">{error}</div>}

            {!error && !items.length && (
                <Empty>{busy ? 'Loading headlines…' : 'No headlines.'}</Empty>
            )}

            {shown.length > 0 && (
                <div className="news__list">
                    {shown.map((it) => {
                        const date = formatNewsDate(it.pubDate);
                        return (
                            <a
                                key={it.link}
                                className="news__item"
                                href={it.link}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={it.title}
                            >
                                {date && <span className="news__date">{date}</span>}
                                <span className="news__title">{it.title}</span>
                            </a>
                        );
                    })}
                </div>
            )}

            {/* Said plainly rather than passing old headlines off as current. */}
            {stale && items.length > 0 && !minimal && (
                <div className="note note--tight">Showing the last headlines fetched — the news relay is not answering.</div>
            )}

            {!minimal && pages > 1 && (
                <div className="news__pager">
                    <Button
                        variant="ghost"
                        size="sm"
                        icon={<Icon.ChevronLeft size={13} />}
                        disabled={p === 0}
                        onClick={() => setPage(p - 1)}
                    />
                    <span className="news__page">{p + 1} / {pages}</span>
                    <Button
                        variant="ghost"
                        size="sm"
                        icon={<Icon.ChevronRight size={13} />}
                        disabled={p >= pages - 1}
                        onClick={() => setPage(p + 1)}
                    />
                </div>
            )}
        </div>
    );
}
