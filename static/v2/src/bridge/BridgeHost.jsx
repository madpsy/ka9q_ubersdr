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

import React, { useCallback, useEffect, useMemo, useRef, useState } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useDisplay } from '../display/DisplayContext.jsx';
import { DOCKS, PLACEMENTS, UNHIDEABLE, useLayout } from '../layout/LayoutContext.jsx';
import { PANELS, PANEL_BY_ID } from '../panels/registry.jsx';
import { SOLO, groupsFor } from '../panels/groups.jsx';
import { svgMarkup } from '../lib/svgMarkup.js';
import { useControlContext, useHardware } from '../controls/panel.jsx';
import { runFunction } from '../controls/functions.js';
import { getSessionId } from '../radio/session.js';
import { bandForFrequency } from '../lib/bands.js';
import { getVfos, onVfosChanged, VFO_IDS } from '../lib/vfos.js';
import { pushNotification } from '../lib/notifications.js';
import { subscribeSpots } from '../lib/spotStore.js';
import { collectMarkers, findMarkers } from '../lib/markerNav.js';
import { savedNavTypes } from '../lib/markerNavSettings.js';
import { API_VERSION, EVENT_FROM_PAGE, EVENT_TO_PAGE, LIVE_TOPICS, STATIC_TOPICS, encodeMessage } from './protocol.js';
import { createHost } from './host.js';
import { closingPanels, publishToPanels, setPanelDeps, tickPanels } from '../panels/custom/hosts.js';
import { createClient } from './client.js';
import { COMMAND_NAMES, runCommand } from './commands.js';
import { describePage, snapshotFor } from './snapshots.js';
import { bridgeSettings, onBridgeSettings, setBridgeAttached } from './settings.js';
import { controlState, onControlState, updateControlState } from '../controls/mappings.js';
import { EVENT_AUDIO_PORT, EVENT_SPECTRUM_PORT } from '../controls/surfaces.js';

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

// The same, for a group. Keyed apart from the panels because a group of one
// carries its panel's id and the two would otherwise share a cache entry.
const groupIconCache = new Map();
function groupIconMarkup(group) {
    if (!groupIconCache.has(group.id)) groupIconCache.set(group.id, svgMarkup(group.icon));
    return groupIconCache.get(group.id);
}

/**
 * Hands a client one end of a MessageChannel, and feeds the decoded audio into
 * the other.
 *
 * The port travels by `window.postMessage` rather than on the API's own
 * channel, because a CustomEvent's `detail` cannot transfer anything — it is
 * structured-cloned, and a MessagePort is not cloneable. The message is tagged
 * so the client knows it is the answer to what it asked for.
 *
 * Frames go out as one interleaved Float32Array per callback, transferred
 * rather than copied. Taken ahead of volume, mute and ducking on purpose: see
 * radio/audio-player.js.
 */
let audioTap = null;
function openAudioPort(player, id, deliver) {
    if (audioTap) { audioTap(); audioTap = null; }
    if (!id) return { streaming: false };
    if (!player || typeof player.onAudio !== 'function') {
        return { streaming: false, reason: 'no audio to hand out yet' };
    }

    const channel = new MessageChannel();
    audioTap = player.onAudio((planes, frames, sampleRate) => {
        // Interleaved, because that is what everything downstream of here
        // expects — TCI's frames are L,R,L,R — and mono is sent as two equal
        // channels rather than as half a stereo frame.
        const channels = planes.length;
        const out = new Float32Array(frames * 2);
        const left = planes[0];
        const right = channels > 1 ? planes[1] : planes[0];
        for (let i = 0; i < frames; i++) {
            out[i * 2] = left[i];
            out[i * 2 + 1] = right[i];
        }
        // Sent without a transfer list, deliberately.
        //
        // Transferring the buffer is the obvious thing — it is freshly
        // allocated here and nothing reads it afterwards — but the receiver may
        // not be in this process. The desktop client hands its end of this
        // channel to Electron's main process, whose deserialiser turns a
        // *transferred* ArrayBuffer into null while an ordinary cloned one
        // arrives intact. So the buffer is copied, at a few kilobytes every
        // 37 ms, which is a price worth paying for a port that works wherever
        // it ends up.
        channel.port1.postMessage({ sampleRate, frames, pcm: out.buffer });
    });

    // How the far end is handed its port, and why it is a parameter.
    //
    // Posting to `window` is right for a client that is *in* the page — an
    // extension's content script shares this origin and this window, and that is
    // what BRIDGE_API.md documents. It is exactly wrong for a custom panel: a
    // panel is a sandboxed frame on an opaque origin, so it is neither listening
    // on this window nor able to receive a message targeted at this origin. The
    // command reported `streaming: true` and the panel waited for a port that
    // had gone somewhere it could never see.
    //
    // So the caller says where to put it. panels/custom/hosts.js passes a
    // deliverer that sends it down that panel's own channel.
    if (typeof deliver === 'function') deliver({ [EVENT_AUDIO_PORT]: id }, channel.port2);
    else window.postMessage({ [EVENT_AUDIO_PORT]: id }, window.location.origin, [channel.port2]);
    return { streaming: true, id };
}

/**
 * The spectrum, as the audio is: a port rather than a topic.
 *
 * `spectrum` reports where the view is pointed — centre, span, bin width — and
 * never carried a single bin, so nothing outside the page could draw a scope, a
 * waterfall or a band-activity strip. The page has the frames already; this
 * hands a copy to whoever asks.
 *
 * A port and not a topic for the same reason audio is: a frame is thousands of
 * floats arriving continuously, and JSON on a CustomEvent is the wrong shape for
 * it by two orders of magnitude.
 *
 * `everyNth` is the client's own throttle. The display runs as fast as the
 * receiver sends, which is far more than a slow chart wants, and a client that
 * needs one frame a second should not be made to drop nineteen itself.
 */
let spectrumTap = null;
function openSpectrumPort(connection, id, everyNth, deliver) {
    if (spectrumTap) { spectrumTap(); spectrumTap = null; }
    if (!id) return { streaming: false };
    if (!connection || typeof connection.on !== 'function') {
        return { streaming: false, reason: 'no spectrum to hand out yet' };
    }

    const stride = Math.max(1, Math.min(600, Math.round(Number(everyNth) || 1)));
    const channel = new MessageChannel();
    let seen = 0;

    spectrumTap = connection.on('frame', ({ bins, frequency, timestamp }) => {
        seen += 1;
        if (seen % stride !== 0) return;
        if (!bins || !bins.length) return;
        // A copy, and cloned rather than transferred — the same reasoning as the
        // audio port above: the far end may be in another process, and Electron
        // deserialises a transferred ArrayBuffer as null.
        const out = Float32Array.from(bins);
        channel.port1.postMessage({
            bins: out.buffer,
            binCount: out.length,
            centerFreq: frequency,
            timestamp,
        });
    });

    if (typeof deliver === 'function') deliver({ [EVENT_SPECTRUM_PORT]: id }, channel.port2);
    else window.postMessage({ [EVENT_SPECTRUM_PORT]: id }, window.location.origin, [channel.port2]);
    return { streaming: true, id, everyNth: stride };
}

/**
 * The spot feeds, acquired only while something is listening.
 *
 * The server sends nothing until a stream is *acquired* (lib/spotStore.js), so
 * subscribing on the chance a client might want spots would open three streams
 * for every visitor to a shared receiver. Both the `spots` and `markers` topics
 * need them — markers are built partly from spots — so one refcount serves both,
 * and the feeds stop when the last interested client goes away.
 *
 * Module-level rather than per-host because the page has one set of feeds
 * however many hosts are asking: the bridge's own, and one per custom panel.
 */
const spotFeeds = { refs: 0, offs: [], lists: { dx: [], cw: [], digital: [] } };

function acquireSpots(onUpdate) {
    spotFeeds.refs += 1;
    if (spotFeeds.refs === 1) {
        for (const kind of ['dx', 'cw', 'digital']) {
            spotFeeds.offs.push(subscribeSpots(kind, (list) => {
                spotFeeds.lists = { ...spotFeeds.lists, [kind]: list };
                onUpdate();
            }));
        }
    }
    return () => {
        spotFeeds.refs = Math.max(0, spotFeeds.refs - 1);
        if (spotFeeds.refs > 0) return;
        for (const off of spotFeeds.offs) { try { off(); } catch (e) { /* gone */ } }
        spotFeeds.offs = [];
    };
}

/**
 * What the marker snapshot needs, worked out here rather than in snapshots.js.
 *
 * The merge and the "which of these is at the dial" search are the page's own
 * (lib/markerNav.js), shared with the marker bar and the Markers panel, so a
 * client sees exactly what the operator sees rather than a second opinion
 * assembled from the same parts.
 */
function markerSources(radio) {
    const catalog = radio.catalog || {};
    const markers = collectMarkers({
        dx: spotFeeds.lists.dx,
        cw: spotFeeds.lists.cw,
        bookmarks: catalog.bookmarks || [],
        local: radio.localMarks || [],
    });
    const t = radio.tuning || {};
    return {
        markersAtDial: findMarkers(markers, t.frequency, t.mode, savedNavTypes()),
        markerCount: markers.length,
    };
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
        // How a phone's tab bar arranges the same panels: six groups by the
        // question being asked, and the Multipad on its own. Sent so a client
        // with a menu can offer the panels the way the app already does rather
        // than as one list of fifty — the grouping is a decision this app has
        // already made, and two arrangements of the same panels would be two
        // things to learn. See panels/groups.jsx.
        get groups() {
            return [
                ...(PANEL_BY_ID[SOLO]
                    ? [{
                        id: SOLO,
                        title: PANEL_BY_ID[SOLO].title,
                        // Its own, being a group of one.
                        icon: iconMarkup(PANEL_BY_ID[SOLO]),
                        panels: [SOLO],
                    }]
                    : []),
                ...groupsFor(PANELS).map((g) => ({
                    id: g.id,
                    title: g.title,
                    icon: groupIconMarkup(g),
                    panels: g.items.map((p) => p.id),
                })),
            ];
        },
        snapshot() { return { panels: panels(), docks: this.docks, groups: this.groups }; },
    };
}

export default function BridgeHost() {
    const radio = useRadio();
    const display = useDisplay();
    const layout = useLayout();
    const hw = useHardware();
    const ctx = useControlContext(display.tuneStep || 500);
    const [settings, setSettings] = useState(bridgeSettings);
    // The whole VFO state, not only which one is active: the `vfos` topic
    // reports all four, and a client that wanted the other three could
    // otherwise only reach them by switching to each in turn — which really
    // retunes the receiver.
    // Named apart from lib/vfos.js's own `setVfos`, which writes the store:
    // this only mirrors it into React state for publishing.
    const [vfos, setVfoState] = useState(getVfos);
    const vfo = vfos.active;
    // The Radio Control panel's own settings, which a registered transport reads
    // to know whether it is the selected one and what it was configured with.
    const [controls, setControls] = useState(controlState);

    useEffect(() => onBridgeSettings(setSettings), []);
    useEffect(() => onVfosChanged(setVfoState), []);
    useEffect(() => onControlState(setControls), []);

    // Read by the host on every message, so it always sees the current
    // receiver without the host being rebuilt (which would drop every client).
    const live = useRef(null);
    live.current = { radio, ctx, hw, vfo, vfos, settings, controls, layout: layoutFacade(layout) };

    const capabilities = useMemo(() => [
        ...COMMAND_NAMES,
        'functions',
        ...(hw && hw.rotator ? ['rotator'] : []),
        ...(hw && hw.antenna ? ['antenna'] : []),
    ], [hw]);
    const caps = useRef(capabilities);
    caps.current = capabilities;

    // The dependencies, named rather than inlined, because two hosts are built
    // from them: this one, and one per custom panel. A panel answers from the
    // same describe/snapshot/command/run as the page, so the two can never
    // disagree about what the receiver is doing.
    const hostDeps = useMemo(() => ({
        onDemand: (topic, wanted) => onDemandRef.current(topic, wanted),
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
        command: (name, args, extra) => runCommand(name, args, {
            ...live.current.ctx,
            layout: live.current.layout,
            setRadioControl,
            // The player is the receiver's, not this module's — see
            // RadioContext, which owns it for the life of the page.
            // `extra` is how a caller says where its port should go. Absent
            // for a client in the page, which is served by window.postMessage;
            // supplied by a custom panel's host, whose frame cannot see that.
            openAudioPort: (id) => openAudioPort(live.current.radio.player, id, extra && extra.deliverPort),
            // Through the operator's own notification settings, deliberately:
            // where a notice appears and whether it appears at all is theirs.
            // The source is fixed so they can switch these off as a group
            // without losing the receiver's own notices.
            pushNotice: (spec) => pushNotification({ ...spec, source: 'bridge' }),
            openSpectrumPort: (id, everyNth) => openSpectrumPort(
                live.current.radio.spectrumConn, id, everyNth, extra && extra.deliverPort),
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

    const host = useMemo(() => createHost(hostDeps), [hostDeps]);

    // Spot feeds are held while any client — here or in a panel — is subscribed
    // to a topic that needs them, and released when the last one goes.
    //
    // One hold per report rather than one per topic. Every host reports its own
    // edges — the bridge's own, and one per attached panel — so the same topic
    // arrives `true` several times over, and a single hold keyed by topic would
    // ignore all but the first and then let the *first* host's last unsubscribe
    // shut the feed while a panel was still watching. The releases stack: n
    // trues, n falses, and the feed stops when the last one is popped.
    const spotHolds = useRef({});
    const onDemand = useCallback((topic, wanted) => {
        if (topic !== 'spots' && topic !== 'markers') return;
        const held = spotHolds.current;
        const stack = held[topic] || (held[topic] = []);
        if (wanted) {
            stack.push(acquireSpots(() => {
                publishAllRef.current('spots', snapshotFor('spots', sources(live.current)));
                publishAllRef.current('markers', snapshotFor('markers', sources(live.current)));
            }));
            return;
        }
        const release = stack.pop();
        if (release) release();
    }, []);

    // Custom panels are served by hosts of their own — same commands, same
    // topics, a port each instead of the window events, and none of the bridge's
    // accounting. See panels/custom/hosts.js for why they are not clients here.
    //
    // `send` and `enabled` are theirs rather than these: a panel's messages go
    // down its own port, and the operator's switch for outside clients is not a
    // switch for panels they installed on their own receiver.
    useEffect(() => {
        setPanelDeps(hostDeps);
        return () => setPanelDeps(null);
    }, [hostDeps]);

    const publishAll = useCallback((topic, value) => {
        host.publish(topic, value);
        publishToPanels(topic, value);
    }, [host]);

    // Through refs so `hostDeps` can stay built once: it is what both kinds of
    // host are made from, and rebuilding it would rebuild them.
    const publishAllRef = useRef(publishAll);
    publishAllRef.current = publishAll;
    const onDemandRef = useRef(onDemand);
    onDemandRef.current = onDemand;

    // One listener for the whole page, registered once. Re-registering on every
    // state change would drop a message arriving in the gap.
    useEffect(() => {
        const onEvent = (e) => host.handle(e.detail);
        window.addEventListener(EVENT_TO_PAGE, onEvent);
        // In-page consumers — userscripts, the console — get a client of the
        // same channel rather than a private door into the host.
        window.UberSDR = createClient(window, { id: 'page' });
        const onLeave = () => { host.closing(); closingPanels(); };
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

    useEffect(() => { publishAll('markers', snapshotFor('markers', sources(live.current))); },
        [host, tuning]);

    useEffect(() => { publishAll('vfos', snapshotFor('vfos', sources(live.current))); },
        [host, tuning, vfos]);

    useEffect(() => { publishAll('tuning', snapshotFor('tuning', sources(live.current))); },
        [host, tuning, vfo]);
    useEffect(() => { publishAll('audio', snapshotFor('audio', sources(live.current))); },
        [host, audio, squelch]);
    useEffect(() => { publishAll('spectrum', snapshotFor('spectrum', sources(live.current))); },
        [host, view, followTuning]);
    useEffect(() => { publishAll('session', snapshotFor('session', sources(live.current))); },
        [host, session, running, serverInfo]);

    // The title is derived from the tuning (see App's PageTitle), so this fires
    // with it rather than needing a MutationObserver of its own.
    // Arranging the page is a deliberate act, so this fires rarely — but it has
    // to fire, or a client's menu keeps showing where a panel used to be.
    useEffect(() => { publishAll('layout', snapshotFor('layout', sources(live.current))); },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [host, layout.layout]);

    useEffect(() => { publishAll('radiocontrol', snapshotFor('radiocontrol', sources(live.current))); },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [host, controls]);

    useEffect(() => { publishAll('sdrcontrol', snapshotFor('sdrcontrol', sources(live.current))); },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [host, controls]);

    useEffect(() => { publishAll('page', snapshotFor('page', sources(live.current))); },
        [host, tuning, serverInfo]);

    // --- meters, which React does not track ---------------------------------
    useEffect(() => {
        const timer = setInterval(() => {
            // Nobody attached, nothing to build: this page is already doing an
            // FFT twenty times a second and does not need a second snapshot
            // twenty times a second for an audience of none.
            if (host.clients().length) {
                publishAll('signal', snapshotFor('signal', sources(live.current)));
            }
            // Anything a rate limit held back goes out here, so a meter that
            // stops moving still ends on its true final value.
            host.tick();
            tickPanels();
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
    const { radio: r, hw, vfo, vfos } = l;
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
        vfos: vfos ? { ...vfos, ids: VFO_IDS } : null,
        spots: spotFeeds.lists,
        ...markerSources(r),
        band: bandForFrequency(r.tuning.frequency),
        url: typeof location !== 'undefined' ? location.href : null,
        title: typeof document !== 'undefined' ? document.title : null,
        dspSchemas: r.dsp ? r.dsp.schemas : null,
        hardware: hw,
    };
}
