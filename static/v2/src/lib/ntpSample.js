// One timed request to the NTP addon: the round trip its answer is measured by.
//
// Shared by the Time panel and the playground's Clock block (playground/
// timeSource.js), which measure the same clock the same way — see lib/ntpTime.js
// for the arithmetic, which this only feeds.

import { FETCH_TIMEOUT_MS, sampleFrom, timeUrl } from './ntpTime.js';

/**
 * Ask the addon for the time once. Resolves to `{ d, sample }` — the reply and
 * the sample it makes (sampleFrom; null if the reply had no round trip in it) —
 * or rejects if the addon did not answer in time.
 */
export async function takeNtpSample(seq) {
    const url = new URL(timeUrl(seq), window.location.href).href;
    const ctl = new AbortController();
    const kill = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    let d;
    let t0;
    let t3;
    try {
        t0 = performance.now();
        const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
        t3 = performance.now();
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        d = await r.json();
    } finally {
        clearTimeout(kill);
    }

    // Resource Timing gives the instants the request reached the socket and the first
    // response byte came back, which is a tighter pair than fetch()'s own — see
    // lib/ntpTime.js. Where the entry is missing, the fetch's own instants still work.
    // The entry is recorded when the body completes, which some browsers do a task
    // or two after the promise resolves — hence the wait rather than one look.
    let entry = null;
    for (let i = 0; i < 5 && !entry; i++) {
        const list = performance.getEntriesByName(url, 'resource');
        if (list.length) entry = list[list.length - 1];
        else await new Promise((res) => { setTimeout(res, 20); });
    }
    // Or the buffer fills and entries stop being recorded at all.
    performance.clearResourceTimings();
    const precise = entry && entry.requestStart > 0 && entry.responseStart >= entry.requestStart;
    const sent = precise ? entry.requestStart : t0;
    const got = precise ? entry.responseStart : t3;
    return { d, sample: sampleFrom(d, sent, got) };
}
