// Which country is this callsign from?
//
// The questions come from the receiver itself — every callsign the spot feeds and
// the voice detector have shown this browser, accumulated across sessions (see
// lib/games/quiz.js). That is the point of it: the other nine games could be on
// any web page, and this one can only exist on a receiver.
//
// The country comes from /api/cty/lookup rather than the shared callsign cache
// the rest of the app uses, deliberately: that cache is read by the Markers panel
// and the media session, and warming it with the answer would show the country in
// another panel before the question had been answered here.
//
// Once the answer is in, though, the full lookup runs — the operator's name,
// where they are and their photo, where the receiver has a lookup service and a
// session to ask with. That is the widget's behaviour and it is the best part of
// the game: the reward for a right answer is finding out who you were guessing
// about, which is the difference between a quiz and a flashcard.

import React, { useCallback, useEffect, useRef, useState } from '../../react.js';
import Frame from './Frame.jsx';
import { useRadio } from '../../radio/RadioContext.jsx';
import { subscribeSpots } from '../../lib/spotStore.js';
import { subscribeVoiceActivity } from '../../lib/voiceActivity.js';
import { countryFlag } from '../../lib/format.js';
import { getSessionId } from '../../radio/session.js';
import { lookupCallsignData } from '../../lib/callsign.js';
import { onPhotoShown, photoShown, photoUrl } from '../../lib/operatorPhoto.js';
import {
    MIN_CALLSIGNS, OPTIONS, RECENT_MAX, addSeen, buildOptions, ctyDetail, loadSeen,
    orderCandidates, saveSeen,
} from '../../lib/games/quiz.js';

// How to play — shown by the ? beside the game picker. See GamesPanel.
//
// `gameHelp` rather than `help`: it is exported into an app where half a dozen
// files have a local of that name, and test/unresolved.js refuses the collision.
export const gameHelp = (
    <>
        <p>
            A callsign this receiver has actually heard — from the spot feeds and the
            voice detector — and five countries. Pick the one it belongs to.
        </p>
        <p>
            Get it right and the streak goes up; get it wrong and it starts again.
            Either way the answer is shown, along with the operator's details where
            this receiver has a lookup service.
        </p>
        <p>
            The pool grows as the receiver hears more, and is remembered between
            visits.
        </p>
    </>
);
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
    // The operator behind the callsign, once it has been guessed at. Cleared with
    // every question so the previous station's name cannot sit under the next
    // one's callsign while its lookup is still in flight.
    const [op, setOp] = useState(null);
    const [showPhoto, setShowPhoto] = useState(photoShown);
    // The Callsign panel's switch governs this too: somebody who has turned
    // operator photos off has turned them off, and a game is not an exception.
    useEffect(() => onPhotoShown(setShowPhoto), []);
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
        setOp(null);

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
        // Who it actually is — asked only once the guess is in, and only where
        // the receiver offers the service and this session can authenticate.
        // Failures are silent: the card is a bonus, and a game is no place for an
        // error about a service the player did not ask for.
        if (serverInfo && serverInfo.lookup_service) {
            const call = question.callsign;
            lookupCallsignData(call, getSessionId())
                .then((data) => {
                    if (!alive.current || !data) return;
                    setOp((o) => (o && o.call !== call ? o : {
                        call,
                        name: [data.fname, data.name].filter(Boolean).join(' ').trim(),
                        qth: [data.addr2, data.country].filter(Boolean).join(', ').trim(),
                        grid: (data.grid || '').trim(),
                        image: (data.image || '').trim(),
                    }));
                })
                .catch(() => { /* no lookup, no card */ });
        }
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
    const lookups = !!(serverInfo && serverInfo.lookup_service);
    return (
        <Frame
            status={status}
            score={`Streak:${streak.now} Best:${streak.best}`}
            action={() => { if (!busy.current) nextRound(); }}
            actionLabel="Next"
            statusLines={2}
        >
            <div className="cq">
                {/* A rule rather than nothing while the next callsign is being
                    found. The box is a fixed height either way, so an empty one
                    reads as a fault — something that should be there and is not —
                    where a dashed placeholder reads as waiting. It is dim, too,
                    so it is plainly not a callsign anybody has to squint at. */}
                <div className={`cq__call${question ? '' : ' is-waiting'}`}>
                    {question ? question.callsign : '———'}
                </div>
                {/* Always five rows, even with nothing to put in them.
                    Between questions this list is empty for as long as a lookup
                    takes, and a panel in a dock that loses a hundred and thirty
                    pixels and gets them back shoves everything under it up and
                    down the column each round. The placeholders hold the space. */}
                <div className="cq__options">
                    {Array.from({ length: OPTIONS }, (_, i) => {
                        const o = question && question.options[i];
                        if (!o) {
                            return <span className="cq__opt is-blank" key={`blank${i}`} aria-hidden="true" />;
                        }
                        return (
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
                                title={o.name}
                            >
                                {countryFlag(o.code)} {o.name}
                            </button>
                        );
                    })}
                </div>
                {/* The reveal, in a slot of its own that is there whether or not
                    it has anything in it — the answer arriving must not push the
                    panel taller and the next question must not pull it shorter.
                    Only as tall as it can actually get: without a lookup service
                    there is never a card, so the slot is one line. */}
                <div className={`cq__reveal${lookups ? ' cq__reveal--card' : ''}`}>
                    {detail && (detail.where || detail.zone) && (
                        <div className="cq__detail">
                            {detail.where && <span>{detail.where}</span>}
                            {detail.zone && <span>{detail.zone}</span>}
                        </div>
                    )}
                    {/* Only for the callsign on screen — a lookup that lands after
                        the next question has been dealt belongs to the station
                        before it. */}
                    {op && op.call === question.callsign && (op.name || op.qth || op.image) && (
                        <div className="cq__op">
                            {showPhoto && op.image && (
                                <img className="cq__photo" src={photoUrl(op.image)} alt="" />
                            )}
                            <div className="cq__who">
                                {op.name && <span className="cq__name">{op.name}</span>}
                                {op.qth && <span className="cq__qth">{op.qth}</span>}
                                {op.grid && <span className="cq__grid">Grid {op.grid}</span>}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </Frame>
    );
}
