// How long to wait before reopening a stream that failed.
//
// Shared, because there are two SSE panels now — the band spectrum and the lightning
// addon — and two receivers that have gone away must not be asked about on two
// different schedules. It was the band spectrum's until the second caller appeared.
//
// EventSource has a reconnect of its own, and it is not enough. It covers the
// case where an established stream drops — retrying on a fixed timer, about every
// three seconds, for ever — and does nothing at all for a connection that fails
// at the HTTP level: a 502 from the proxy while the receiver restarts, a 404, a
// response with the wrong content type. Those set readyState to CLOSED and fire
// one error, and the panel then sits on a picture that will never be added to,
// with nothing on screen to say the stream has gone rather than the band being
// quiet. That is the failure this exists for.
//
// So a panel closes the stream on any error and reopens it on this curve, which
// makes one policy out of the two cases instead of the browser's timer running
// alongside ours. Forever, deliberately: the panel *is* the subscription — it is
// unmounted when its section is collapsed, hidden or dragged, so "stop trying" is
// something the operator already has a way to say, and a stream that gave up
// would leave a panel that looks open and is not. A receiver being restarted for
// twenty minutes should be found working when it comes back.
//
// The curve is the spectrum WebSocket's (see _scheduleReconnect): 1 s, then half
// again each time, to a 30 s ceiling — about eight attempts in the first minute
// and then twice a minute for as long as it takes. Same shape for the same
// reason, so a receiver that has gone away is not asked twice about it on
// different schedules.
export const RETRY_BASE_MS = 1000;
export const RETRY_GROWTH = 1.6;
export const RETRY_MAX_MS = 30000;

export function retryDelay(attempt) {
    const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
    return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (RETRY_GROWTH ** n));
}
