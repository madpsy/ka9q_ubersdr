// Which country is this callsign from?
//
// The questions come from the receiver itself — every callsign the spot feeds and
// the voice detector have shown this browser, accumulated across sessions (see
// lib/games/quiz.js). That is the point of it: the other nine games could be on
// any web page, and this one can only exist on a receiver.
//
// Lookups go to /api/cty/lookup rather than the shared callsign cache the rest of
// the app uses, deliberately: that cache is read by the Markers panel and the
// media session, and warming it with the answer would show the country in another
// panel before the question had been answered here.

import React, { useCallback, useEffect, useRef, useState } from '../../react.js';
import Frame from './Frame.jsx';
import { useRadio } from '../../radio/RadioContext.jsx';
import { subscribeSpots } from '../../lib/spotStore.js';
import { subscribeVoiceActivity } from '../../lib/voiceActivity.js';
import { countryFlag } from '../../lib/format.js';
import {
    MIN_CALLSIGNS, RECENT_MAX, addSeen, buildOptions, ctyDetail, loadSeen, orderCandidates,
    saveSeen,
} from '../../lib/games/quiz.js';

// How long the answer stays up before the next round. Long enough to read the
// country and the detail under it, short enough that it does not feel like being
// kept waiting.
const NEXT_MS = 3000;
// Lookups that find nothing before giving up on the round. Each costs a second,
// so this is the longest the game will spend hunting rather than asking.
const MAX_TRIES = 8;
const TRY_GAP_MS = 1000;

export default function CallsignQuiz() {
    const { serverInfo, running } = useRadio();
    const [seen, setSeen] = useState(loadSeen);
    const [countries, setCountries] = useState(null);
    const [question, setRound] = useState(null);        // { callsign, country, cty, options }
    const [picked, setPicked] = useState('');
    const [status, setStatus] = useState('Loading…');
    const [streak, setStreak] = useState({ now: 0, best: 0 });
    const busy = useRef(false);
    const alive = useRef(true);
    const recent = useRef([]);
    const misses = useRef(new Set());
    const timer = useRef(null);

    useEffect(() => () => { alive.current = false; clearTimeout(timer.current); }, []);

    // The pool. Both feeds are gated the same way the Markers panel gates them —
    // a receiver without them contributes nothing and is not asked.
    const hasDx = !!(serverInfo && serverInfo.dx_cluster);
    const hasCw = !!(serverInfo && serverInfo.cw_skimmer);
    const hasVoice = !!(serverInfo && serverInfo.noise_floor);

    const harvest = useCallback((calls) => {
        if (!calls.length) return;
        setSeen((prev) => {
            const next = addSeen(prev, calls);
            if (next.size !== prev.size) saveSeen(next);
            return next;
        });
    }, []);

    useEffect(() => {
        if (!running || !hasDx) return undefined;
        return subscribeSpots('dx', (list) => harvest(list.map((s) => s.callsign).filter(Boolean)));
    }, [running, hasDx, harvest]);

    useEffect(() => {
        if (!running || !hasCw) return undefined;
        return subscribeSpots('cw', (list) => harvest(list.map((s) => s.callsign).filter(Boolean)));
    }, [running, hasCw, harvest]);

    useEffect(() => {
        if (!running || !hasVoice) return undefined;
        return subscribeVoiceActivity((state) => harvest(
            ((state && state.activities) || []).map((a) => a.dx_callsign).filter(Boolean),
        ));
    }, [running, hasVoice, harvest]);

    // The country list, for the wrong answers. One request a page.
    useEffect(() => {
        let cancelled = false;
        fetch('/api/cty/countries')
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
                const list = j && j.success && j.data && j.data.countries;
                if (!cancelled && Array.isArray(list)) setCountries(list);
            })
            .catch(() => { /* the game says so below */ });
        return () => { cancelled = true; };
    }, []);

    const nextRound = useCallback(async () => {
        if (busy.current) return;
        clearTimeout(timer.current);
        busy.current = true;
        setPicked('');
        setRound(null);

        if (!countries || countries.length < 5) {
            setStatus('Country list unavailable');
            busy.current = false;
            return;
        }
        setStatus('Finding a callsign…');

        const candidates = orderCandidates(seen, recent.current, misses.current);
        let found = null;
        for (let i = 0; i < Math.min(MAX_TRIES, candidates.length); i++) {
            const cs = candidates[i];
            // eslint-disable-next-line no-await-in-loop
            const cty = await fetch(`/api/cty/lookup?callsign=${encodeURIComponent(cs)}`)
                .then((r) => (r.ok || r.status === 404 ? r.json() : null))
                .then((d) => (d && d.success && d.data && d.data.country ? d.data : null))
                .catch(() => null);
            if (!alive.current) { busy.current = false; return; }
            if (cty) { found = { cs, cty }; break; }
            // Remembered so the next round does not spend a second on it again.
            misses.current.add(cs);
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => { setTimeout(r, TRY_GAP_MS); });
            if (!alive.current) { busy.current = false; return; }
        }

        if (!found) {
            setStatus('No lookups succeeded — press Next');
            busy.current = false;
            return;
        }

        recent.current = [...recent.current, found.cs].slice(-RECENT_MAX);
        const names = countries.map((c) => c.name).filter(Boolean);
        const codes = new Map(countries.map((c) => [c.name, c.country_code || '']));
        setRound({
            callsign: found.cs,
            country: found.cty.country,
            cty: found.cty,
            options: buildOptions(found.cty.country, names).map((name) => ({
                name,
                code: name === found.cty.country ? (found.cty.country_code || '') : (codes.get(name) || ''),
            })),
        });
        setStatus('Which country?');
        busy.current = false;
    }, [countries, seen]);

    // The first round, once there is a list and a pool to draw from.
    useEffect(() => {
        if (!question && !busy.current && countries && seen.size >= MIN_CALLSIGNS) nextRound();
    }, [countries, seen, question, nextRound]);

    const answer = (name) => {
        if (picked || !question) return;
        setPicked(name);
        if (name === question.country) {
            setStreak((s) => {
                const now = s.now + 1;
                return { now, best: Math.max(now, s.best) };
            });
            setStatus('Correct ✓');
        } else {
            setStreak((s) => ({ ...s, now: 0 }));
            setStatus(`Nope — ${question.country}`);
        }
        timer.current = setTimeout(() => { if (alive.current) nextRound(); }, NEXT_MS);
    };

    // Not enough callsigns yet. Said plainly, with the count, because the fix is
    // to leave the receiver running rather than anything in this panel.
    if (seen.size < MIN_CALLSIGNS) {
        return (
            <Frame
                status="Listening for callsigns…"
                score={`${seen.size}/${MIN_CALLSIGNS}`}
            >
                <p className="game__note">
                    The questions come from callsigns this receiver has actually heard — spots
                    and decoded voice. {MIN_CALLSIGNS - seen.size} more and the quiz starts.
                </p>
            </Frame>
        );
    }

    const detail = picked && question ? ctyDetail(question.cty, question.callsign) : null;
    return (
        <Frame
            status={status}
            score={`Streak:${streak.now} Best:${streak.best}`}
            action={() => { if (!busy.current) nextRound(); }}
            actionLabel="Next"
        >
            <div className="cq">
                <div className="cq__call">{question ? question.callsign : '…'}</div>
                <div className="cq__options">
                    {(question ? question.options : []).map((o) => (
                        <button
                            key={o.name}
                            type="button"
                            className={[
                                'cq__opt',
                                picked ? 'is-done' : '',
                                picked && o.name === question.country ? 'is-right' : '',
                                picked === o.name && o.name !== question.country ? 'is-wrong' : '',
                            ].filter(Boolean).join(' ')}
                            onClick={() => answer(o.name)}
                            disabled={!!picked}
                        >
                            {countryFlag(o.code)} {o.name}
                        </button>
                    ))}
                </div>
                {detail && (detail.where || detail.zone) && (
                    <div className="cq__detail">
                        {detail.where && <span>{detail.where}</span>}
                        {detail.zone && <span>{detail.zone}</span>}
                    </div>
                )}
            </div>
        </Frame>
    );
}
