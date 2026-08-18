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
// not be. That second rule is what makes a decoder with live settings work at
// all: FSK's shift and baud are attach-time parameters server-side, so editing
// one has to tear the extension down and build it again, and doing that is
// simply passing different `params`.
//
// Result frames are JSON by default, because that is what the decoders written
// since have used. The older ones speak a packed binary format of their own
// (FSK's is a type byte and a payload), so `parse` takes the raw frame and
// returns whatever the panel wants to handle — or null to drop it.
//
// Attaching needs a live *audio* session — the server looks it up by the UUID
// the socket was opened with — so `active` should include the audio connection
// being up, not just the receiver being on. Even then the two can disagree for
// a moment: the audio socket reconnecting replaces the session under us, and
// the control socket has no idea. That failure is transient and self-healing,
// so it is retried rather than parked in an error the user has to clear.

import { useEffect, useRef, useState } from '../react.js';
import { dxcluster } from '../radio/dxcluster-connection.js';
import { logEvent } from '../lib/eventLog.js';
import {
    attachMessage, decodeResult, detachMessage, extensionEvent, isTransientAttachError,
} from './protocol.js';

const RETRY_MS = 1500;
const MAX_RETRIES = 6;

export function useAudioExtension({ name, params, active, onResult, onEvent, parse }) {
    // 'idle' before anything is asked for, 'attaching' between the attach and
    // the server's confirmation, 'running' once it has confirmed, 'error' when
    // it refused. The panel shows this; nothing else depends on it.
    const [state, setState] = useState('idle');
    const [error, setError] = useState(null);

    const resultRef = useRef(onResult);
    resultRef.current = onResult;
    const eventRef = useRef(onEvent);
    eventRef.current = onEvent;
    // Through a ref for the same reason as the callbacks: a panel that names
    // its frame decoder inline must not re-attach on every render.
    const parseRef = useRef(parse);
    parseRef.current = parse || decodeResult;

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
            const msg = parseRef.current(data);
            if (msg && resultRef.current) resultRef.current(msg);
        });

        const offEvent = dxcluster.on('extension', (raw) => {
            const ev = extensionEvent(raw);
            if (!ev) return;
            if (ev.kind === 'attached') {
                retries = 0;
                setState('running');
                setError(null);
                // Every decoder on the page comes through here — SSTV, FT8,
                // FSK, NAVTEX, morse, WEFAX, whisper — so this one line is the
                // whole extension layer's presence in the log. Worth having:
                // a decoder that never attaches looks exactly like a band with
                // nothing on it.
                // The server names the one it attached; the rest of its
                // replies do not, so only this line can be sure.
                logEvent('good', `${ev.name || name} decoder started`);
            } else if (ev.kind === 'error') {
                if (isTransientAttachError(ev.error) && retries < MAX_RETRIES) {
                    retries += 1;
                    setState('attaching');
                    logEvent('warn', `${name} decoder retrying (${retries}/${MAX_RETRIES}): ${ev.error}`);
                    clearTimeout(retryTimer);
                    retryTimer = setTimeout(sendAttach, RETRY_MS);
                } else {
                    setState('error');
                    setError(ev.error);
                    logEvent('error', `${name} decoder failed: ${ev.error}`);
                }
            } else if (ev.kind === 'detached') {
                setState('idle');
                logEvent('info', `${name} decoder stopped`);
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
            if (attached && dxcluster.connected) {
                dxcluster.send(detachMessage());
                // Logged here rather than waiting for the server's `detached`.
                // That reply arrives after the listeners below have been
                // removed, so on this path — the panel closing, or the decoder
                // being switched off — nothing would ever have said it stopped.
                logEvent('info', `${name} decoder stopped`);
            }
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
