// One hook for every server-side decoder: attach, read results, detach.
//
// This is the piece the remaining v1 decoders (FSK, NAVTEX, SSTV, WEFAX, CW,
// soundmodem, whisper, FreeDV) all need, so it lives here rather than inside
// FT8. A panel says what it wants and gets a state back:
//
//     const { state, error } = useAudioExtension({
//         name: 'ft8', params: { max_candidates: 100 }, active: running,
//         onResult: (msg) => …,
//     });
//
// `active` is the only control: flip it and the attach or detach is sent. The
// hook owns everything else — holding the socket open, waiting for it to be
// ready, re-attaching after a reconnect, and detaching on unmount so closing a
// window really does stop the decoder rather than leaving it running on the
// server for the rest of the session.
//
// `onResult` is read through a ref, so a panel may pass a fresh closure on
// every render without re-attaching. `params` is compared by value for the same
// reason: an extension whose settings changed must be re-attached (the server
// takes them at creation), but one whose object identity merely changed must
// not be.
//
// Attaching needs a live *audio* session — the server looks it up by the UUID
// the socket was opened with — so `active` should include the audio connection
// being up, not just the receiver being on. Even then the two can disagree for
// a moment: the audio socket reconnecting replaces the session under us, and
// the control socket has no idea. That failure is transient and self-healing,
// so it is retried rather than parked in an error the user has to clear.

import { useEffect, useRef, useState } from '../react.js';
import { dxcluster } from '../radio/dxcluster-connection.js';
import {
    attachMessage, decodeResult, detachMessage, extensionEvent, isTransientAttachError,
} from './protocol.js';

const RETRY_MS = 1500;
const MAX_RETRIES = 6;

export function useAudioExtension({ name, params, active, onResult, onEvent }) {
    // 'idle' before anything is asked for, 'attaching' between the attach and
    // the server's confirmation, 'running' once it has confirmed, 'error' when
    // it refused. The panel shows this; nothing else depends on it.
    const [state, setState] = useState('idle');
    const [error, setError] = useState(null);

    const resultRef = useRef(onResult);
    resultRef.current = onResult;
    const eventRef = useRef(onEvent);
    eventRef.current = onEvent;

    // Value comparison, not identity — see the note above.
    const paramsKey = JSON.stringify(params || {});

    useEffect(() => {
        if (!active || !name) {
            setState('idle');
            setError(null);
            return undefined;
        }

        setState('attaching');
        setError(null);

        const release = dxcluster.hold();
        let attached = false;
        let retries = 0;
        let retryTimer = null;

        const sendAttach = () => {
            clearTimeout(retryTimer);
            retryTimer = null;
            // The attach is looked up by the UUID the socket was opened with,
            // so this is the one place that has to care whether the socket
            // still carries the current one. A reopen fires 'open', which
            // attaches — hence the return rather than sending on the old one.
            if (dxcluster.refresh()) return;
            attached = dxcluster.send(attachMessage(name, JSON.parse(paramsKey)));
        };

        const offBinary = dxcluster.on('binary', (data) => {
            const msg = decodeResult(data);
            if (msg && resultRef.current) resultRef.current(msg);
        });

        const offEvent = dxcluster.on('extension', (raw) => {
            const ev = extensionEvent(raw);
            if (!ev) return;
            if (ev.kind === 'attached') {
                retries = 0;
                setState('running');
                setError(null);
            } else if (ev.kind === 'error') {
                if (isTransientAttachError(ev.error) && retries < MAX_RETRIES) {
                    retries += 1;
                    setState('attaching');
                    clearTimeout(retryTimer);
                    retryTimer = setTimeout(sendAttach, RETRY_MS);
                } else {
                    setState('error');
                    setError(ev.error);
                }
            } else if (ev.kind === 'detached') {
                setState('idle');
            }
            if (eventRef.current) eventRef.current(ev);
        });

        // A reconnect means a new server-side session with no extension in it,
        // so the attach has to be replayed or the decoder silently stops.
        const offOpen = dxcluster.on('open', () => {
            retries = 0;
            setState('attaching');
            sendAttach();
        });

        const offClose = dxcluster.on('close', () => {
            attached = false;
            clearTimeout(retryTimer);
            retryTimer = null;
            setState('attaching');   // the socket reconnects on its own
        });

        if (dxcluster.connected) sendAttach();

        return () => {
            clearTimeout(retryTimer);
            // Only if the socket is still up: after a drop there is nothing to
            // detach from, and the server has already torn the extension down.
            if (attached && dxcluster.connected) dxcluster.send(detachMessage());
            offBinary();
            offEvent();
            offOpen();
            offClose();
            release();
            setState('idle');
        };
    }, [name, active, paramsKey]);

    return { state, error };
}
