// Keeps hardware control running whether or not its panels are on screen.
//
// A collapsed section is unmounted, so anything a panel owns stops when it is
// collapsed. That is right for a mapping table and wrong for the mapping itself:
// a MIDI surface or a FlexControl is enabled once and then expected to keep
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
import { isCCKey, midiKeyLabel } from '../controls/webmidi.js';
import { flexAvailable, flexKeyLabel } from '../controls/flexcontrol.js';
import { getSurface, getSync } from '../controls/sources.js';

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

    // Named here because naming a function needs the DSP schemas and the
    // hardware list, and dispatch.js has neither.
    useEffect(() => {
        setControlDescriber((id, key, fn) => {
            const isMidi = id === 'midi';
            const label = (isMidi ? midiKeyLabel : flexKeyLabel)(key);
            const why = isMidi && isCCKey(key)
                ? 'if it is an endless encoder, press “fader” on its row to say so'
                : 'that function cannot be driven by this control';
            return `${label} → ${functionLabel(fn, dspSchemas, hw)} ignored — ${why}`;
        });
    }, [dspSchemas, hw]);

    useEffect(() => watchSurface(surface), [surface]);

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
        // Web Serial's own hotplug event. Without it a FlexControl plugged in
        // after load would wait for a reload.
        if (!flexAvailable()) return undefined;
        navigator.serial.addEventListener('connect', attempt);
        return () => navigator.serial.removeEventListener('connect', attempt);
    }, [surface]);

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
