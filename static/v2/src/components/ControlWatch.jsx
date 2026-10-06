// Keeps hardware control running whether or not its panels are on screen.
//
// A collapsed section is unmounted, so anything a panel owns stops when it is
// collapsed. That is right for a mapping table and wrong for the mapping itself:
// a MIDI surface, a FlexControl or an RC-28 is enabled once and then expected to keep
// working, and the badge above the spectrum says it is — so it has to be true.
// The same for a synced radio, whose live view of the receiver was owned by the
// Radio control panel and froze when that panel closed.
//
// Mounted for the life of the page beside the other watchers. It renders
// nothing: it holds the radio facade and points the two things that need it at
// it. Setup — picking a surface, learning a control, choosing a rig — stays in
// the panels, where it belongs.

import { useEffect, useRef } from '../react.js';
import { useRadio } from '../radio/RadioContext.jsx';
import { useControlContext, useControlState, useHardware } from '../controls/panel.jsx';
import {
    setControlContext, setControlDescriber, setSurfaceMappings, tryAutoConnect, watchSurface,
} from '../controls/dispatch.js';
import { functionLabel } from '../controls/functions.js';
import { isCCKey } from '../controls/webmidi.js';
import { flexAvailable } from '../controls/flexcontrol.js';
import { rc28Available } from '../controls/rc28.js';
import { indicatorLeds, ledSettings } from '../controls/rc28leds.js';
import { squelchEnabled } from '../radio/constants.js';
import { getRecorder } from '../lib/recorder.js';
import {
    getRc28, getSurface, getSync, releaseSurfaceExcept, surfaceKeyLabel,
} from '../controls/sources.js';

// How often the RC-28's lamps are brought up to date. Polled rather than
// subscribed because what they show is spread over three places — the radio
// state, the squelch meter (a mutable object nothing re-renders for) and the
// recorder — and a quarter-second late is not late for a lamp. The driver only
// writes when the byte changes, so a poll that finds nothing new costs nothing.
const LED_POLL_MS = 250;

export default function ControlWatch() {
    const radio = useRadio();
    const [cfg] = useControlState();
    const hw = useHardware();
    const ctx = useControlContext(cfg.stepHz);

    const surface = cfg.surface;
    const dspSchemas = radio.dsp.schemas;

    // During render, not in an effect: the facade's identity never changes, and
    // a surface that moves between this render and the effect that would have
    // published it should act on the receiver as it is now.
    setControlContext(ctx);
    // The radio sync reads the receiver through the same facade. It used to be
    // handed the Radio control panel's, which stopped being updated the moment
    // that panel was collapsed.
    const sync = getSync();
    sync.setContext(ctx);

    useEffect(() => {
        setSurfaceMappings(surface, cfg[surface]?.mappings);
    }, [surface, cfg]);

    // Which CC addresses are endless encoders rather than faders. The surface
    // needs this to tell a delta from a position, and it is not cosmetic: a
    // position arriving on a dial function is *refused* — turning it into a
    // press would tune one way whichever way the wheel went — so without this
    // every encoder on the surface is dead. It was the panel's, which is why a
    // page loaded with the panel collapsed connected the dial and then ignored
    // everything it sent.
    useEffect(() => {
        if (surface !== 'midi') return;
        const rel = {};
        for (const [key, m] of Object.entries(cfg.midi?.mappings || {})) {
            if (m.relative) rel[key] = true;
        }
        getSurface('midi').setRelative(rel);
    }, [surface, cfg]);

    // Named here because naming a function needs the DSP schemas and the
    // hardware list, and dispatch.js has neither.
    useEffect(() => {
        setControlDescriber((id, key, fn) => {
            const isMidi = id === 'midi';
            const label = surfaceKeyLabel(id)(key);
            const why = isMidi && isCCKey(key)
                ? 'if it is an endless encoder, press “fader” on its row to say so'
                : 'that function cannot be driven by this control';
            return `${label} → ${functionLabel(fn, dspSchemas, hw)} ignored — ${why}`;
        });
    }, [dspSchemas, hw]);

    useEffect(() => watchSurface(surface), [surface]);

    // Exactly one surface may hold hardware. Released when the choice changes
    // and at no other time — never on unmount, because a panel unmounts every
    // time it is dragged to another dock and a dock drag must not close a
    // serial port. Here rather than in the panel because it is a fact about the
    // setting, not about anything being on screen.
    useEffect(() => { releaseSurfaceExcept(surface); }, [surface]);

    // Connecting on its own: on arrival, and again whenever the hardware turns
    // up. Both were the panel's, and the panel does not open by default — so a
    // receiver left running reconnected its dial only if somebody happened to
    // expand the section.
    //
    // The settings are read through a ref because these subscriptions are made
    // once per surface and must see the current ones, not the render that
    // happened to set them up.
    const confRef = useRef(null);
    confRef.current = cfg[surface];

    useEffect(() => {
        if (!surface || surface === 'off') return undefined;
        const attempt = () => tryAutoConnect(surface, confRef.current);
        attempt();

        if (surface === 'midi') {
            const s = getSurface(surface);
            // MIDI has no device list until access is granted, and the list
            // changing is also the hotplug signal.
            s.open().then((granted) => { if (granted) attempt(); }).catch(() => {});
            return s.on('devices', attempt);
        }
        // WebHID's own hotplug event, for the same reason as Web Serial's below.
        if (surface === 'rc28') {
            if (!rc28Available()) return undefined;
            navigator.hid.addEventListener('connect', attempt);
            return () => navigator.hid.removeEventListener('connect', attempt);
        }
        // Web Serial's own hotplug event. Without it a FlexControl plugged in
        // after load would wait for a reload.
        if (!flexAvailable()) return undefined;
        navigator.serial.addEventListener('connect', attempt);
        return () => navigator.serial.removeEventListener('connect', attempt);
    }, [surface]);

    // The RC-28's lamps. Read through a ref because the poll is set up once per
    // surface and must see the current render's receiver and settings.
    const ledRef = useRef(null);
    ledRef.current = {
        conf: cfg.rc28,
        receiverUp: radio.audioState === 'open',
        squelchOn: squelchEnabled(radio.squelch.value),
        meters: radio.meters,
        player: radio.player,
    };
    useEffect(() => {
        if (surface !== 'rc28') return undefined;
        const rc28 = getRc28();
        const update = () => {
            const l = ledRef.current;
            const settings = ledSettings(l.conf && l.conf.leds);
            rc28.setHoldFeedback(settings.hold);
            rc28.setIndicators(indicatorLeds({
                settings,
                mappings: l.conf && l.conf.mappings,
                ctx,
                receiverUp: l.receiverUp,
                // The meter reads open whenever no threshold is set, because
                // nothing is gating the audio. That is not a signal, so the
                // lamp only means anything with the squelch on.
                squelchOpen: l.squelchOn && !!(l.meters.current && l.meters.current.squelchOpen),
                recording: getRecorder(l.player).state === 'recording',
            }));
        };
        update();
        const t = setInterval(update, LED_POLL_MS);
        return () => clearInterval(t);
    }, [surface, ctx]);

    // What the sync does with a link, as opposed to how it opens one. These were
    // the Radio control panel's, which meant a page loaded with that panel
    // collapsed left the singleton on its defaults — the operator's choice of
    // direction and of which fields follow the rig applied only once they
    // happened to open the panel.
    const rs = cfg.radiosync || {};
    useEffect(() => {
        sync.setDirection(rs.direction);
        sync.setMuteOnTx(rs.muteOnTx);
    }, [sync, rs.direction, rs.muteOnTx]);

    useEffect(() => {
        sync.setSyncFields({ frequency: rs.syncFrequency, mode: rs.syncMode });
    }, [sync, rs.syncFrequency, rs.syncMode]);

    return null;
}
