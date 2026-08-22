// The body of a custom panel: a sandboxed frame, and the port that reaches it.
//
// `sandbox="allow-scripts"` without `allow-same-origin`, which gives the frame an
// opaque origin. It cannot read this document, its storage or its cookies, it
// cannot see another panel, and it can only reach the receiver through the one
// port handed to it. That isolation is what the frame is for; it is not what
// limits a panel, which may do anything a built-in panel may do. See
// CUSTOM_PANELS.md §5.1 and §6.
//
// Nothing here is mounted until the panel is opened — Section only renders an
// open panel's body — so an enabled panel that is collapsed costs one line in a
// dock and no fetch, no document and no code running.

import React, { useEffect, useRef, useState } from '../../react.js';
import { attachPanel, detachPanel } from './hosts.js';
import { onPanels, panelVersion } from './cache.js';
import { buildSrcdoc, themeDeclarations } from './srcdoc.js';

// Until the panel says otherwise. Tall enough to show a line of its own error
// message, short enough not to shove a dock about while it works out its size.
const INITIAL_HEIGHT = 90;
const MIN_HEIGHT = 40;
const MAX_HEIGHT = 4000;

// The runtime is the same for every panel and changes only when the app is
// rebuilt, so it is fetched once for the page rather than once per frame.
let runtimePromise = null;
function panelRuntime() {
    if (!runtimePromise) {
        runtimePromise = fetch('dist/panel-runtime.js', { cache: 'force-cache' })
            .then((res) => {
                if (!res.ok) throw new Error('runtime ' + res.status);
                return res.text();
            })
            .catch((e) => { runtimePromise = null; throw e; });
    }
    return runtimePromise;
}

// Bodies are cached per version: reopening a panel, or moving it between docks,
// should not re-fetch what cannot have changed. A new version replaces the entry
// because the key includes it.
const bodies = new Map();
function panelBody(id, version) {
    const key = id + '@' + version;
    if (!bodies.has(key)) {
        const path = 'api/v2/panels/' + encodeURIComponent(id.replace(/^x:/, ''));
        bodies.set(key, fetch('/' + path, { cache: 'no-cache' })
            .then((res) => {
                if (!res.ok) throw new Error('panel ' + res.status);
                return res.text();
            })
            .catch((e) => { bodies.delete(key); throw e; }));
    }
    return bodies.get(key);
}

/**
 * The version this panel is on *now*.
 *
 * Not the one on the registry entry: that is built once at module init and
 * carries whatever was current then, so a panel whose author has published since
 * would go on running the old bundle until somebody reloaded the page. The cache
 * is what the poll keeps current, so the frame follows it.
 *
 * A panel the receiver no longer serves keeps the last version it had rather
 * than dropping to nothing — it is about to be unmounted anyway, and remounting
 * it on the way out would fetch a body that has just been withdrawn.
 */
function useLiveVersion(id, fallback) {
    const read = () => {
        const live = id ? panelVersion(id) : null;
        return live === null ? fallback : live;
    };
    const [version, setVersion] = useState(read);
    useEffect(() => {
        setVersion(read());
        return onPanels(() => setVersion(read()));
    }, [id, fallback]);
    return version;
}

export default function CustomPanel({ panel, minimal }) {
    const frame = useRef(null);
    const [doc, setDoc] = useState(null);
    const [failed, setFailed] = useState(null);
    const [height, setHeight] = useState(INITIAL_HEIGHT);

    const id = panel ? panel.id : null;
    const version = useLiveVersion(id, (panel && panel.custom && panel.custom.version) || 0);

    // Assemble the document. Re-run when the panel's version changes — the
    // author has published, and losing whatever the frame held is the correct
    // semantics for an update — or when the operator switches the minimal view,
    // which the panel is told about at startup.
    useEffect(() => {
        if (!id) return undefined;
        let alive = true;
        setFailed(null);
        setDoc(null);

        Promise.all([panelRuntime(), panelBody(id, version)])
            .then(([runtime, body]) => {
                if (!alive) return;
                setDoc(buildSrcdoc({
                    runtime,
                    body,
                    theme: themeDeclarations(),
                    minimal,
                }));
            })
            .catch(() => {
                if (!alive) return;
                // Shown, not hidden. A panel that silently disappeared would be
                // indistinguishable from one the operator removed, and they
                // would go looking in admin for something that is not wrong.
                setFailed('This panel could not be loaded.');
            });

        return () => { alive = false; };
    }, [id, version, minimal]);

    // Hand the port over, once the frame's document exists.
    //
    // `load` rather than immediately: the frame must be listening before the
    // port is sent, and the runtime registers its listener while the document is
    // still parsing, because srcdoc.js puts it in the head. The channel is
    // created here so the frame never chooses its own identity — the panel id
    // travels with the parent's end, not with anything the frame can say.
    useEffect(() => {
        const el = frame.current;
        if (!el || !doc || !id) return undefined;

        let detach = null;
        const onLoad = () => {
            const channel = new MessageChannel();
            detach = attachPanel({
                id,
                port: channel.port1,
                onHeight: (px) => setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, px))),
            });
            try {
                el.contentWindow.postMessage({ 'ubersdr.panel-port': true }, '*', [channel.port2]);
            } catch (e) {
                setFailed('This panel could not be started.');
            }
        };

        el.addEventListener('load', onLoad);
        return () => {
            el.removeEventListener('load', onLoad);
            if (detach) detach();
            else detachPanel(id);
        };
    }, [doc, id]);

    if (failed) {
        return (
            <div className="stack">
                <div className="note note--tight">{failed}</div>
                {panel && panel.custom && panel.custom.callsign && (
                    <div className="note note--tight">Published by {panel.custom.callsign}.</div>
                )}
            </div>
        );
    }

    if (!doc) return <div className="note note--tight">Loading…</div>;

    return (
        <iframe
            // Keyed on the version, so an update replaces the element rather
            // than reusing one whose document has already run. Nothing of the
            // old bundle can survive into the new one.
            key={id + '@' + version}
            ref={frame}
            className="custompanel"
            title={panel ? panel.title : 'Panel'}
            // No allow-same-origin: that is the whole point, and adding it would
            // give the frame this document, this origin's storage and the
            // operator's session.
            sandbox="allow-scripts"
            srcDoc={doc}
            style={{ height: panel && panel.fill ? '100%' : height + 'px' }}
        />
    );
}
