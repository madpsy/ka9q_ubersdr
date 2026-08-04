// What this browser needs before the OS will show media controls.
//
// v1 answers this with three booleans spread across the file — _isApple,
// _mediaSessionNeedsBridge, _isMobileChrome — and then re-derives the same
// three cases at every call site. There is really only one question, and it is
// not "which browser is this" but "what has to be playing".
//
//   'none'   — an audible AudioContext is enough. Desktop Chrome and Edge put
//              media controls in the toolbar on their own, so the whole feature
//              is metadata and action handlers.
//
//   'bridge' — an <audio> playing a MediaStream. Safari and Firefox show
//              nothing at all without a media element. The bridge gives them
//              one off the end of the existing graph: no second network stream,
//              no extra bandwidth, and the same element the output-device
//              picker already uses (see AudioPlayer._applyOutput).
//
//   'stream' — an <audio> playing a URL. Chrome on Android will not raise the
//              lock-screen / notification widget for a MediaStream-backed
//              element; it wants a real media resource. That is what
//              /audio/stream serves, and it is the reason this feature has a
//              second audio path at all. The server sends the audio *there
//              instead of* over the WebSocket, so it costs no extra bandwidth —
//              but it does mean the client-side DSP, the audio scope and the
//              recorder see nothing while it runs. See media/httpStream.js.

// Split out so a test can drive it with any user agent.
export function detectSupport(ua = navigator.userAgent, env = {}) {
    const available = env.hasMediaSession !== undefined
        ? env.hasMediaSession
        : (typeof navigator !== 'undefined' && 'mediaSession' in navigator);

    // iPadOS reports itself as Macintosh, which is exactly what we want here —
    // both need the bridge and both default to on.
    const apple = /iPhone|iPad|iPod|Macintosh/i.test(ua);
    const androidChrome = /Android/i.test(ua) && /Chrome/i.test(ua) && !apple;

    // Feature detection rather than a Firefox sniff: the browsers that cannot
    // point an AudioContext at a device are the same ones that will not show
    // controls without a media element. If that stops being true, this reads
    // the wrong answer for an honest reason and one line fixes it.
    const contextSink = env.hasContextSink !== undefined
        ? env.hasContextSink
        : (typeof AudioContext !== 'undefined' && typeof AudioContext.prototype.setSinkId === 'function');

    let anchor = 'none';
    if (apple || !contextSink) anchor = 'bridge';
    else if (androidChrome) anchor = 'stream';

    return {
        available,
        anchor,
        apple,
        androidChrome,
        // v1's defaults, kept: Apple has had this working for years and it is
        // where lock-screen control matters most, so it is opt-out there and
        // opt-in everywhere else. Nobody gets a media widget they did not ask
        // for on a desktop.
        defaultEnabled: available && apple,
    };
}

let cached = null;

export function mediaSupport() {
    if (!cached) cached = detectSupport();
    return cached;
}

export function _resetMediaSupport() {
    cached = null;
}
