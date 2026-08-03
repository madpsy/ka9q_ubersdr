// The audio-extension wire protocol, as pure functions.
//
// An "audio extension" is a decoder that runs on the server: the client asks
// for one by name, the server taps that session's demodulated audio into it,
// and every decode comes back as a binary frame on the same `/ws/dxcluster`
// socket. See audio_extension_manager.go — the client's whole side of it is
// four message types and one frame decoder.
//
// Rules worth knowing before writing an extension against this:
//
//   * A session may have exactly one extension attached. Attaching a second
//     tears the first down server-side without telling it, which is why the UI
//     only ever has one extension open at a time.
//   * Attaching needs a live audio session — the server looks the session up by
//     the UUID the socket was opened with — so the receiver must be running.
//   * `params` are the extension's own settings. The server adds the tuned
//     frequency, mode, passband, receiver locator and CTY database itself, so
//     none of those belong here.
//   * Results are binary frames holding UTF-8 JSON, not a binary struct. They
//     are undistinguished from any other extension's frames: only one extension
//     can be attached, so the frame is by definition ours.

export const ATTACH = 'audio_extension_attach';
export const DETACH = 'audio_extension_detach';
export const CONTROL = 'audio_extension_control';
export const STATUS = 'audio_extension_status';

// Replies. `audio_extension_status` doubles as a request and a reply.
export const ATTACHED = 'audio_extension_attached';
export const DETACHED = 'audio_extension_detached';
export const ERROR = 'audio_extension_error';

export function attachMessage(name, params) {
    const msg = { type: ATTACH, extension_name: name };
    // An empty params object is valid but pointless; leave it out so the wire
    // form matches what v1 sends for a parameterless decoder.
    if (params && Object.keys(params).length) msg.params = params;
    return msg;
}

export function detachMessage() {
    return { type: DETACH };
}

export function controlMessage(controlType, payload) {
    return { type: CONTROL, control_type: controlType, ...(payload || {}) };
}

export function statusMessage() {
    return { type: STATUS };
}

const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

/**
 * Parse one binary result frame into the decode it carries.
 *
 * Returns null for anything that is not a JSON object — a truncated frame, a
 * keepalive, or an extension that has started speaking a format we do not know.
 * Null is the only failure signal on purpose: a decoder result is best-effort
 * data, and one malformed frame must not take the panel down with it.
 */
export function decodeResult(data) {
    let text;
    if (typeof data === 'string') {
        text = data;
    } else if (data instanceof ArrayBuffer) {
        text = decoder ? decoder.decode(new Uint8Array(data)) : '';
    } else if (ArrayBuffer.isView(data)) {
        text = decoder ? decoder.decode(data) : '';
    } else {
        return null;
    }
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (e) {
        return null;
    }
}

/**
 * Normalise a control reply into { kind, name, error }.
 *
 * `kind` is one of 'attached' | 'detached' | 'error' | 'status', or null for a
 * message this client does not act on. The server spells failures two ways —
 * an `audio_extension_error`, or a status with `active: false` — and both mean
 * the same thing to a panel, so they are flattened here rather than in the hook.
 */
export function extensionEvent(msg) {
    if (!msg || typeof msg.type !== 'string') return null;
    switch (msg.type) {
        case ATTACHED:
            return { kind: 'attached', name: msg.extension_name || '', error: null };
        case DETACHED:
            return { kind: 'detached', name: '', error: null };
        case ERROR:
            return { kind: 'error', name: '', error: String(msg.error || 'extension error') };
        case STATUS:
            return {
                kind: 'status',
                name: msg.extension_name || '',
                active: !!msg.active,
                error: null,
            };
        default:
            return null;
    }
}
