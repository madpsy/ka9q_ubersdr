// The page API, connected to the receiver. Renders nothing.
//
// Mounted in App beside LegacyBridge and ShortcutWatch, for the same reason
// both of those are: an outside client has to be able to reach the receiver
// whether or not any particular panel happens to be open, and panels are
// unmounted whenever their section is collapsed.
//
// Everything here is wiring. The protocol is in protocol.js, the serving in
// host.js, the shapes in snapshots.js and the commands in commands.js — all
// pure and all tested. This file's whole job is to turn React state into
// `publish` calls and to put the two CustomEvent listeners on the window.
//
// Commands and `run` share one context object with the MIDI, FlexControl and
// keyboard surfaces (useControlContext), so an extension setting the mode takes
// the same path as the button that does it. There is no second way in.

import React, { useEffect, useMemo, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { DOCKS, PLACEMENTS, UNHIDEABLE, useLayout } from '../layout/LayoutContext.jsx';
import { PANELS } from '../panels/registry.jsx';
import { svgMarkup } from '../lib/svgMarkup.js';
import { useControlContext, useHardware } from '../controls/panel.jsx';
import { runFunction } from '../controls/functions.js';
import { getSessionId } from '../radio/session.js';
import { bandForFrequency } from '../lib/bands.js';
import { getVfos, onVfosChanged } from '../lib/vfos.js';
import { API_VERSION, EVENT_FROM_PAGE, EVENT_TO_PAGE, LIVE_TOPICS, STATIC_TOPICS, encodeMessage } from './protocol.js';
import { createHost } from './host.js';
import { createClient } from './client.js';
import { COMMAND_NAMES, runCommand } from './commands.js';
import { describePage, snapshotFor } from './snapshots.js';
import { bridgeSettings, onBridgeSettings, setBridgeAttached } from './settings.js';
import { controlState, onControlState, updateControlState } from '../controls/mappings.js';

// The meters are a mutable ref written by the audio path rather than React
// state — see RadioContext — so the signal topic is sampled rather than
// subscribed to. Twenty a second at the source, rate-limited per client on the
// way out; the same timer drives the host's flush of anything held back.
const SAMPLE_MS = 50;

// The layout, as the flat thing the bridge talks in.
//
// The context is a dozen callbacks over a nested structure; a client wants a
// list of panels and two verbs. Built here rather than in snapshots.js because
// it is the one place that may touch React state, and kept to plain data so the
// snapshot and the `panel` command are testable without a layout at all.
//
// The registry is the source of the list, not the layout: a panel that is
// hidden still has to be nameable, or nothing could ask for it back.
/**
 * A transport writing back what its own settings are.
 *
 * The panel is the place these are edited, but not the only place they exist —
 * the browser extension has had an flrig host and port in its popup for far
 * longer. Whichever one is touched, both should show the same thing.
 *
 * Written through the same store the panel writes to, so there is one copy and
 * the panel re-renders from it. Values that have not changed are written all
 * the same and cost nothing: the topic upstream diffs by value, so an identical
 * write puts nothing on the wire and cannot echo back to the client that sent
 * it.
 */
function setRadioControl(id, patch) {
    const next = updateControlState((prev) => {
        const rs = prev.radiosync;
        const { config, select, ...rest } = patch;
        return {
            ...prev,
            radiosync: {
                ...rs,
                ...rest,
                ...(select ? { transport: id } : {}),
                ...(config
                    ? { providers: { ...(rs.providers || {}), [id]: { ...((rs.providers || {})[id]), ...config } } }
                    : {}),
            },
        };
    });
    const rs = next.radiosync;
    return {
        transport: rs.transport,
        connect: !!rs.connect,
        direction: rs.direction,
        config: (rs.providers || {})[id] || {},
    };
}

// A panel's icon, as SVG markup.
//
// The registry holds React elements and a native menu wants a picture, so the
// element is walked into markup — see lib/svgMarkup.js, which also explains why
// this is not done by rendering it. The desktop client turns the markup into an
// image itself, in a canvas in its preload, because nativeImage does not read
// SVG and the main process has no renderer.
//
// Cached by panel id: the icons are fixed for the life of the page, and this is
// asked for on every layout snapshot.
const iconCache = new Map();
function iconMarkup(panel) {
    if (!iconCache.has(panel.id)) iconCache.set(panel.id, svgMarkup(panel.icon));
    return iconCache.get(panel.id);
}

function layoutFacade(layout) {
    const panels = () => PANELS.map((p) => ({
        id: p.id,
        title: p.title,
        icon: iconMarkup(p),
        placement: layout.placementOf(p.id),
        hidden: !!(layout.layout.sections[p.id] || {}).hidden,
        unhideable: p.id === UNHIDEABLE,
    }));
    return {
        placements: PLACEMENTS,
        get panels() { return panels(); },
        get docks() {
            return DOCKS.map((d) => ({ id: d, collapsed: !!layout.layout.docks[d].collapsed }));
        },
        setHidden: (id, hidden) => layout.setSectionHidden(id, hidden),
        // movePanel takes 'float' as a placement like the three docks, and on
        // the way it un-hides the panel and opens the dock it landed in — the
        // same thing a drag in the Layout panel does. Index omitted: "put it
        // over there" is the whole of what a menu can say, and that appends.
        move: (id, placement) => layout.movePanel(id, placement),
        snapshot() { return { panels: panels(), docks: this.docks }; },
    };
}

export default function BridgeHost() {
    const radio = useRadio();
    const display = useDisplay();
    const layout = useLayout();
    const hw = useHardware();
    const ctx = useControlContext(display.tuneStep || 500);
    const [settings, setSettings] = useState(bridgeSettings);
    const [vfo, setVfo] = useState(() => getVfos().active);
    // The Radio Control panel's own settings, which a registered transport reads
    // to know whether it is the selected one and what it was configured with.
    const [controls, setControls] = useState(controlState);

    useEffect(() => onBridgeSettings(setSettings), []);
    useEffect(() => onVfosChanged((s) => setVfo(s.active)), []);
    useEffect(() => onControlState(setControls), []);

    // Read by the host on every message, so it always sees the current
    // receiver without the host being rebuilt (which would drop every client).
    const live = useRef(null);
    live.current = { radio, ctx, hw, vfo, settings, controls, layout: layoutFacade(layout) };

    const capabilities = useMemo(() => [
        ...COMMAND_NAMES,
        'functions',
        ...(hw && hw.rotator ? ['rotator'] : []),
        ...(hw && hw.antenna ? ['antenna'] : []),
    ], [hw]);
    const caps = useRef(capabilities);
    caps.current = capabilities;

    const host = useMemo(() => createHost({
        send: (msg) => {
            window.dispatchEvent(new CustomEvent(EVENT_FROM_PAGE, { detail: encodeMessage(msg) }));
        },
        enabled: () => live.current.settings.enabled !== false,
        describe: () => describePage({
            ...sources(live.current),
            api: API_VERSION,
            capabilities: caps.current,
            topics: [...LIVE_TOPICS, ...STATIC_TOPICS],
            commands: COMMAND_NAMES,
        }),
        snapshot: (topic) => snapshotFor(topic, sources(live.current)),
        // The layout rides alongside the control context rather than inside it:
        // useControlContext is the surface the MIDI, FlexControl and keyboard
        // panels share, and none of them arranges the page.
        command: (name, args) => runCommand(name, args, {
            ...live.current.ctx,
            layout: live.current.layout,
            setRadioControl,
        }),
        // Dispatched, not "done": the catalogue's functions are fire-and-forget
        // because a knob has no reply path, so a rotator function on a receiver
        // with no stored password logs to the SDR Control panel and returns
        // like any other. Saying `dispatched` rather than inventing a success
        // keeps that visible at the call site. Anything a client needs a real
        // answer from is a command.
        run: (fn, event) => {
            runFunction(fn, event, live.current.ctx);
            return { dispatched: fn };
        },
    }), []);

    // One listener for the whole page, registered once. Re-registering on every
    // state change would drop a message arriving in the gap.
    useEffect(() => {
        const onEvent = (e) => host.handle(e.detail);
        window.addEventListener(EVENT_TO_PAGE, onEvent);
        // In-page consumers — userscripts, the console — get a client of the
        // same channel rather than a private door into the host.
        window.UberSDR = createClient(window, { id: 'page' });
        const onLeave = () => host.closing();
        window.addEventListener('pagehide', onLeave);
        return () => {
            window.removeEventListener(EVENT_TO_PAGE, onEvent);
            window.removeEventListener('pagehide', onLeave);
            host.closing();
            if (window.UberSDR) {
                window.UberSDR.close();
                delete window.UberSDR;
            }
        };
    }, [host]);

    // --- announce ----------------------------------------------------------
    //
    // On mount and whenever the descriptor's own contents change: the receiver
    // answering /api/description, the session starting, the operator switching
    // the bridge back on. Clients treat an announce as "reset and re-subscribe".
    const running = radio.running;
    const serverInfo = radio.serverInfo;
    useEffect(() => {
        // Switched off, whoever is attached is told rather than left waiting on
        // patches that will never come: a subscriber has no other way to find
        // out, and silence is what a broken page looks like. Harmless to repeat
        // — after the first there is nobody left to tell.
        if (settings.enabled === false) {
            host.closing();
            return;
        }
        host.announce();
    }, [host, settings.enabled, serverInfo, running, capabilities]);

    // --- state that React already tracks ------------------------------------
    const { tuning, audio, squelch, view, followTuning, session } = radio;

    useEffect(() => { host.publish('tuning', snapshotFor('tuning', sources(live.current))); },
        [host, tuning, vfo]);
    useEffect(() => { host.publish('audio', snapshotFor('audio', sources(live.current))); },
        [host, audio, squelch]);
    useEffect(() => { host.publish('spectrum', snapshotFor('spectrum', sources(live.current))); },
        [host, view, followTuning]);
    useEffect(() => { host.publish('session', snapshotFor('session', sources(live.current))); },
        [host, session, running, serverInfo]);

    // The title is derived from the tuning (see App's PageTitle), so this fires
    // with it rather than needing a MutationObserver of its own.
    // Arranging the page is a deliberate act, so this fires rarely — but it has
    // to fire, or a client's menu keeps showing where a panel used to be.
    useEffect(() => { host.publish('layout', snapshotFor('layout', sources(live.current))); },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [host, layout.layout]);

    useEffect(() => { host.publish('radiocontrol', snapshotFor('radiocontrol', sources(live.current))); },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [host, controls]);

    useEffect(() => { host.publish('page', snapshotFor('page', sources(live.current))); },
        [host, tuning, serverInfo]);

    // --- meters, which React does not track ---------------------------------
    useEffect(() => {
        const timer = setInterval(() => {
            // Nobody attached, nothing to build: this page is already doing an
            // FFT twenty times a second and does not need a second snapshot
            // twenty times a second for an audience of none.
            if (host.clients().length) {
                host.publish('signal', snapshotFor('signal', sources(live.current)));
            }
            // Anything a rate limit held back goes out here, so a meter that
            // stops moving still ends on its true final value.
            host.tick();
            // Same timer, because a badge does not deserve one of its own.
            setBridgeAttached(host.clients().length);
        }, SAMPLE_MS);
        return () => clearInterval(timer);
    }, [host]);

    return null;
}

// Everything the snapshots and the descriptor read, in one place, so a topic
// added later needs a line there and nothing here.
function sources(l) {
    const { radio: r, hw, vfo } = l;
    const layout = l.layout ? l.layout.snapshot() : null;
    const m = r.meters ? r.meters.current : null;
    return {
        layout,
        controlSettings: l.controls,
        tuning: r.tuning,
        audio: r.audio,
        squelch: r.squelch,
        view: r.view,
        meters: m,
        squelchOpen: m ? m.squelchOpen : undefined,
        follow: r.followTuning,
        running: r.running,
        session: r.session,
        sessionId: getSessionId(),
        receiverId: r.serverInfo ? r.serverInfo.public_uuid : null,
        serverInfo: r.serverInfo,
        vfo,
        band: bandForFrequency(r.tuning.frequency),
        url: typeof location !== 'undefined' ? location.href : null,
        title: typeof document !== 'undefined' ? document.title : null,
        dspSchemas: r.dsp ? r.dsp.schemas : null,
        hardware: hw,
    };
}
