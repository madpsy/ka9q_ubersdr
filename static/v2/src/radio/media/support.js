// What this browser needs before the OS will show media controls.
//
// v1 answers this with three booleans spread across the file — _isApple,
// _mediaSessionNeedsBridge, _isMobileChrome — and then re-derives the same
// three cases at every call site. There is really only one question, and it is
// not "which browser is this" but "what has to be playing".
//
//   'none'   — metadata and action handlers only. An audible AudioContext is
//              enough for desktop Chrome and Edge to raise controls in the
//              toolbar; v1 does exactly this and it works there, so no element
//              of any kind is needed.
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

// The anchors, as a vocabulary the panel can offer directly. 'auto' means take
// the detected one.
export const ANCHORS = ['auto', 'none', 'bridge', 'stream'];

// Detection is a best guess about browser behaviour that is not specified
// anywhere and changes between releases, so it can be overridden — see
// resolveAnchor and the Media controls panel. Worth having permanently: the
// alternative to a setting is editing this file every time a browser moves.
//
// The one case that is not a guess is a host that draws the controls itself
// (`support.host`): there, 'none' is not the best answer but the only coherent
// one, and neither detection nor an override may say otherwise. Every anchor
// above it exists to talk a *browser* into raising a widget by giving it a
// media element to hang one on — there is no browser here to talk into it, so
// the others do not fail loudly, they fail silently. `stream` in particular
// waits for an <audio> element to report itself stably playing before it will
// push any metadata at all (controller.js, rule 2), which in a WebView never
// happens: the lock screen keeps the frequency it was opened with and nothing
// else ever reaches it.
//
// So this is forced rather than defaulted. A saved 'auto' from before the host
// existed, or a 'stream' left behind by somebody trying to make it work, would
// otherwise be enough to silence the whole feature.
export function resolveAnchor(support, override) {
    if (support && support.host) return 'none';
    return override && override !== 'auto' && ANCHORS.includes(override)
        ? override
        : support.anchor;
}

/**
 * Whether the host — rather than the browser — puts these controls on screen.
 *
 * The Android client (clients/capacitor) has no browser chrome to raise a media
 * widget, so it builds a native one out of whatever this page sets: it provides
 * `navigator.mediaSession`, watches what is assigned to it, and turns that into
 * a notification and a lock-screen session. See clients/capacitor/src/receiver.js.
 *
 * Declared by the host, never sniffed. A page cannot tell from the inside
 * whether anything is listening to a media session, and a wrong guess either
 * way is a feature silently missing or an anchor costing something for nothing.
 */
function hostMediaControls() {
    try {
        return !!(typeof window !== 'undefined' && window.ubersdrDesktop
            && window.ubersdrDesktop.mediaSession);
    } catch (e) {
        return false;
    }
}

// Split out so a test can drive it with any user agent.
export function detectSupport(ua = navigator.userAgent, env = {}) {
    const host = env.hostMedia !== undefined ? env.hostMedia : hostMediaControls();
    const available = env.hasMediaSession !== undefined
        ? env.hasMediaSession
        : (typeof navigator !== 'undefined' && 'mediaSession' in navigator);

    // The Apple *platform*, which is what the default-on decision is about.
    // iPadOS reports itself as Macintosh, which is what we want here: both are
    // places where lock-screen control is the point.
    const apple = /iPhone|iPad|iPod|Macintosh/i.test(ua);

    // Every browser on iOS is WebKit underneath whatever badge it wears, so
    // Chrome there (CriOS) is not Blink and needs what Safari needs.
    const ios = /iPhone|iPad|iPod/i.test(ua);
    const blink = !ios && /Chrome\/|Chromium\/|Edg\//i.test(ua);
    const android = /Android/i.test(ua);
    const androidChrome = android && blink;
    const windows = /Windows/i.test(ua);

    // Feature detection rather than a Firefox sniff: the browsers that cannot
    // point an AudioContext at a device are the same ones that will not show
    // controls without a media element. If that stops being true, this reads
    // the wrong answer for an honest reason and one line fixes it.
    const contextSink = env.hasContextSink !== undefined
        ? env.hasContextSink
        : (typeof AudioContext !== 'undefined' && typeof AudioContext.prototype.setSinkId === 'function');

    // Blink is asked first, and it is never given the bridge.
    //
    // Chromium does not raise media controls for a MediaStream-backed element
    // at all — that is the same behaviour the 'stream' anchor exists to work
    // around on Android, and it is not an Android quirk. Deciding on the
    // platform first is what put Chrome on macOS onto the bridge: its user
    // agent says Macintosh, so it was read as Apple and handed the one anchor
    // that cannot work there, while the same browser on Linux took the 'none'
    // path and was fine. Nothing throws — the controls simply never appear.
    //
    // Within Blink, Windows then wants what Android wants. An audible
    // AudioContext and nothing else is enough to raise the controls on Linux
    // and macOS, but not the Windows SMTC widget, which — like Android's
    // notification — wants a real media resource behind the session. Measured
    // rather than reasoned: 'none' shows nothing there and 'stream' works.
    //
    // It costs something, which is why it is not the answer everywhere: the
    // stream anchor moves the audio off the WebSocket, so the scope, the
    // recorder and the audio filters go quiet while it runs. The panel says so
    // wherever this anchor is the live one, and anyone who would rather keep
    // those can force 'none' from the same control.
    // A host that shows the controls itself needs no anchor at all: every
    // anchor above 'none' exists to talk a *browser* into raising a widget, and
    // there is no browser here to talk into it. Decided before the platform,
    // because on the one platform this happens on the platform's answer is the
    // expensive one.
    let anchor = 'none';
    if (host) anchor = 'none';
    else if (blink) anchor = androidChrome || windows ? 'stream' : 'none';
    else if (apple || !contextSink) anchor = 'bridge';

    return {
        available,
        anchor,
        // Whether the controls are the host's rather than the browser's, which
        // resolveAnchor needs and the panel reads to explain itself.
        host,
        apple,
        blink,
        windows,
        androidChrome,
        android,
        // v1's defaults, kept: Apple has had this working for years and it is
        // where lock-screen control matters most, so it is opt-out there and
        // opt-in everywhere else. Nobody gets a media widget they did not ask
        // for on a desktop.
        //
        // Android was briefly included, on the reasoning that a phone in a
        // pocket is the case the whole feature is for. It is out again, and the
        // reason is what the anchor costs there: Android Chrome needs 'stream',
        // which moves the audio off the WebSocket and takes the scope, the
        // recorder and the client-side filters with it. That is a fair trade for
        // somebody who asked for lock-screen control and a poor one to make on
        // their behalf — and it is a trade Apple does not have to make, because
        // the bridge anchor costs nothing.
        //
        // A host that renders the controls itself is the Android case with that
        // objection removed: it is a phone, it takes the 'none' anchor, and so
        // it costs nothing either.
        defaultEnabled: available && (apple || host),
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
