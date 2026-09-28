// This page's clock against the receiver's, for ageing audio by its capture time.
//
// Every version 4 packet says when its first sample was captured, on the
// receiver host's clock (see capture_time.go). Subtracting that from Date.now()
// would be subtracting two different clocks, and a phone or laptop being a few
// hundred milliseconds out is ordinary -- so an age taken that way is a
// confident number that is wrong by however far out this device happens to be.
//
// So the offset is measured, the way an NTP client does it: time a request whose
// reply carries the server's clock, and take half the round trip as the one-way
// delay. The arithmetic and the sample filter are lib/ntpTime.js's, used as they
// are -- least-delayed sample wins, a sample's error bound is half its round
// trip and grows at PHI as this page's clock wanders, and a sample that
// disagrees with the rest by more than their bounds allow means a clock stepped
// and the window starts again.
//
// Samples come from two requests the page already makes and nothing else:
//
//   /api/description on load, whose server_time is stamped while the reply is
//   built -- so it falls somewhere inside the round trip, which is all the
//   error bound assumes. One sample, and a poor one, taken while the page is
//   loading everything else; it is there so an age can be shown straight away.
//
//   the audio socket's ping, whose pong carries serverTimeNs. v2 pings only
//   when the operator does something (radio/idle.js) because every message
//   touches the session, and that is kept: a ping on a timer of our own would
//   keep an abandoned tab's session alive for ever. While somebody is using the
//   receiver that is a sample every ten seconds or so; while nobody is, there
//   are none, and the estimate they left is still good -- a device clock
//   drifts by milliseconds an hour, not a second.
//
// One per page, since there is one receiver per page.
//
// performance.now() rather than Date.now() throughout, so the wall clock never
// supplies an instant -- only this measurement does. That is the point.

import { addSample, bestEstimate, newClock } from '../lib/ntpTime.js';

let clock = newClock();

/**
 * Fold in one round trip.
 *
 * @param sent      performance.now() when the request went
 * @param got       performance.now() when the reply came back
 * @param serverMs  the server's clock at some instant between the two, Unix ms
 */
export function addServerTimeSample(sent, got, serverMs) {
    if (!Number.isFinite(sent) || !Number.isFinite(got) || !Number.isFinite(serverMs)) return;
    if (!(serverMs > 0) || got < sent) return;
    clock = addSample(clock, {
        theta: serverMs - (sent + got) / 2,
        delay: got - sent,
        at: got,
        srvOffset: null,
        srvRate: 0,
    });
}

/**
 * What to add to performance.now() to get the server's Unix ms, and how far out
 * that could be. Null until a sample has landed.
 *
 * @returns {{theta:number, err:number}|null}
 */
export function serverClock(nowPerf = performance.now()) {
    const est = bestEstimate(clock, nowPerf);
    return est ? { theta: est.theta, err: est.err } : null;
}

/**
 * The receiver's time now, Unix ms, or null before any measurement.
 *
 * For a display of the time rather than an age: the top bar's clocks. Only as
 * right as the receiver's own clock, which is why the caller checks
 * server_time_sync before preferring this to the device's.
 */
export function serverNowMs(nowPerf = performance.now()) {
    const c = serverClock(nowPerf);
    return c ? nowPerf + c.theta : null;
}

/** Forget every sample. Tests only -- the receiver does not change under a page. */
export function resetServerClock() {
    clock = newClock();
}
