import React, { useEffect, useRef } from './react.js';
import { RadioProvider, useRadio } from './radio/RadioContext.jsx';
import { DisplayProvider } from './display/DisplayContext.jsx';
import { onShell, readShell, resolveShell } from './lib/shellPref.js';
import { LayoutProvider, useLayout } from './layout/LayoutContext.jsx';
import { MOBILE_QUERY, useMediaQuery } from './lib/useMediaQuery.js';
import Dock from './components/Dock.jsx';
import TopBar from './components/TopBar.jsx';
import SpectrumView from './components/SpectrumView.jsx';
import MobileShell from './components/MobileShell.jsx';
import FloatingLayer from './components/FloatingLayer.jsx';
import IdleWatch from './components/IdleWatch.jsx';
import VisibilityWatch from './components/VisibilityWatch.jsx';
import AnnounceWatch from './components/AnnounceWatch.jsx';
import CallsignAnnounceWatch from './components/CallsignAnnounceWatch.jsx';
import Toasts from './components/Toasts.jsx';
import NativeNotices from './components/NativeNotices.jsx';
import HardwareNoticeWatch from './components/HardwareNoticeWatch.jsx';
import AddonNoticeWatch from './components/AddonNoticeWatch.jsx';
import ShortcutWatch from './components/ShortcutWatch.jsx';
import HapticWatch from './components/HapticWatch.jsx';
import ControlWatch from './components/ControlWatch.jsx';
import TopFreqWatch from './components/TopFreqWatch.jsx';
import StartOverlay from './components/StartOverlay.jsx';
import { ChatProvider } from './chat/ChatContext.jsx';
import { ExtensionsProvider } from './extensions/ExtensionsContext.jsx';
import DXClusterWatch from './components/DXClusterWatch.jsx';
import { MediaSessionProvider } from './radio/media/MediaSessionContext.jsx';
import LegacyBridge from './compat/LegacyBridge.jsx';
import BridgeHost from './bridge/BridgeHost.jsx';
import { useDisplay } from './display/DisplayContext.jsx';
import { subscribeSpots } from './lib/spotStore.js';

/**
 * The centre, which is also where a panel goes to become a floating window.
 *
 * The docks have taken a dragged panel from each other for a while — a header is
 * `draggable` and every dock body answers the drop. This is the third
 * destination, and the one people reach for first: pull a panel out onto the
 * map and let go.
 *
 * The drop point is where the window lands, rather than the cascade `movePanel`
 * seeds a first float with. Offset by a little so the title bar arrives under
 * the cursor instead of the window's top-left corner sitting on it, which reads
 * as the window having jumped down and right on release.
 */
function Centre() {
    const { movePanel, setFloat } = useLayout();
    const [over, setOver] = React.useState(false);

    const carrying = (e) => e.dataTransfer.types.includes('text/ubersdr-panel');

    return (
        <main
            className={`shell__center${over ? ' is-dropping' : ''}`}
            onDragOver={(e) => {
                if (!carrying(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setOver(true);
            }}
            onDragLeave={(e) => {
                // dragleave fires crossing between children too, and clearing
                // then flickers the outline off and on across the spectrum.
                if (e.currentTarget.contains(e.relatedTarget)) return;
                setOver(false);
            }}
            onDrop={(e) => {
                setOver(false);
                if (!carrying(e)) return;
                e.preventDefault();
                const id = e.dataTransfer.getData('text/ubersdr-panel');
                if (!id) return;
                const r = e.currentTarget.getBoundingClientRect();
                movePanel(id, 'float', null);
                setFloat(id, {
                    x: Math.max(0, e.clientX - r.left - GRAB_X),
                    y: Math.max(0, e.clientY - r.top - GRAB_Y),
                });
            }}
        >
            <SpectrumView />
            <FloatingLayer />
        </main>
    );
}

// Where the cursor sits on the window it just dropped: a little in from the
// left, and on the title bar rather than above it.
const GRAB_X = 60;
const GRAB_Y = 12;

function DesktopShell() {
    return (
        <div className="shell">
            <TopBar />
            <div className="shell__main">
                <Dock side="left" />
                <div className="shell__column">
                    <Centre />
                    <Dock side="bottom" />
                </div>
                <Dock side="right" />
            </div>
        </div>
    );
}

// Keeps the browser tab in step with the dial, in v1's format (app.js
// updatePageTitle): "<callsign> UberSDR - 14.175 MHz USB", with the callsign
// dropped until /api/description answers. Renders nothing.
function PageTitle() {
    const { tuning, serverInfo } = useRadio();

    useEffect(() => {
        const mhz = (tuning.frequency / 1000000).toFixed(3);
        const callsign = serverInfo && serverInfo.receiver && serverInfo.receiver.callsign;
        const prefix = callsign ? `${callsign} ` : '';
        document.title = `${prefix}UberSDR - ${mhz} MHz ${String(tuning.mode).toUpperCase()}`;
    }, [tuning.frequency, tuning.mode, serverInfo]);

    return null;
}

// Holds the DX and CW spot streams open for the whole session, rather than
// leaving them to whichever panel or marker layer happens to be showing.
//
// Both are low-rate — a busy cluster is a few spots a minute — so the traffic
// costs nothing, and subscribing once here means the marker toggles and the
// Spots tabs only decide what is *drawn*. Without it, turning a marker on would
// start from an empty list and stay blank until the next spot arrived, which on
// a quiet band is minutes of looking at nothing.
//
// Digital spots are deliberately not held: that feed can run to thousands an
// hour, so it is subscribed only while its tab is on screen.
function SpotStreams() {
    const { serverInfo, running } = useRadio();
    const dx = !!(serverInfo && serverInfo.dx_cluster);
    const cw = !!(serverInfo && serverInfo.cw_skimmer);

    // The socket needs a registered session, which only exists once the
    // receiver has been started.
    useEffect(() => {
        if (!running || !dx) return undefined;
        return subscribeSpots('dx', () => {});
    }, [running, dx]);

    useEffect(() => {
        if (!running || !cw) return undefined;
        return subscribeSpots('cw', () => {});
    }, [running, cw]);

    return null;
}

// The operator's default audio buffer, for anyone who has never set their own.
//
// v1 does this in ui-config.js: it seeds localStorage with `default_buffer`
// only when the key is absent, so the operator's value is a *default* and a
// listener's own choice always wins. Applied here rather than in either
// context, so the display settings and the signal path stay unaware of each
// other — the same reason PageTitle and SpotStreams live at this level.
function AudioDefaults() {
    const { audio, actions } = useRadio();
    const { server } = useDisplay();
    const done = useRef(false);

    useEffect(() => {
        if (done.current || audio.bufferFromUser) return;
        if (!server.loaded || server.bufferSec == null) return;
        done.current = true;
        actions.setBufferSec(server.bufferSec);
    }, [server.loaded, server.bufferSec, audio.bufferFromUser, actions]);

    return null;
}

// Which layout is drawn.
//
// The width still decides on a narrow screen — the docks do not fit and there
// is nothing to choose between. Above that the operator chooses, from the start
// overlay, the Display panel, or the apps' own settings page; never having
// chosen means the docks, as it always did.
//
// Subscribed rather than read once: the Display panel changes this while the
// receiver is running, and swapping shell is exactly the sort of change that
// must not need a reload to appear.
function Shell() {
    const narrow = useMediaQuery(MOBILE_QUERY);
    const [shell, setShell] = React.useState(readShell);
    React.useEffect(() => onShell(setShell), []);
    return resolveShell(shell, narrow) === 'minimal' ? <MobileShell /> : <DesktopShell />;
}

export default function App() {
    return (
        <DisplayProvider>
            <LayoutProvider>
                <RadioProvider>
                    <ChatProvider>
                        <ExtensionsProvider>
                            <MediaSessionProvider>
                                <PageTitle />
                                <AudioDefaults />
                                <IdleWatch />
                                {/* Beside IdleWatch and not part of it: one is
                                    about an operator who is here and idle, the
                                    other about a tab nobody is looking at. */}
                                <VisibilityWatch />
                                <AnnounceWatch />
                                {/* The other announcer: the receiver reads out its
                                    own tuning, this one reads out who a lookup
                                    found. Both here for the same reason — a panel
                                    that is collapsed is unmounted. */}
                                <CallsignAnnounceWatch />
                                {/* The toast layer. Here rather than in the
                                    Notifications panel because a panel is
                                    unmounted whenever its dock is collapsed, and
                                    notifications that only worked while their own
                                    panel was open would be no notifications at
                                    all. */}
                                <Toasts />
                                {/* The same notifications, handed to the browser instead when
                                    the operator has asked for desktop ones — which is how a
                                    notification reaches somebody whose tab is hidden, the case
                                    a toast cannot serve at all. */}
                                <NativeNotices />
                                {/* Watches the rotator and the antenna switch for the
                                    two changes worth a notification, with or without
                                    their panels open. */}
                                <HardwareNoticeWatch />
                                {/* And the addon feeds that raise one: new
                                    callsigns from the voice skimmer, strikes from
                                    the lightning detector. Both ship off, so this
                                    holds nothing open until asked. */}
                                <AddonNoticeWatch />
                                <ShortcutWatch />
                                {/* One delegated listener gives every button
                                    in the app its haptic tap; the gestures on
                                    the spectrum fire their own. */}
                                <HapticWatch />
                                {/* Hardware control outlives its panels: a
                                    collapsed section is unmounted, and a knob
                                    that was tuning the receiver has to go on
                                    doing it. */}
                                <ControlWatch />
                                {/* The cluster session, for the same reason: the
                                    panel is collapsed most of the time, and a
                                    remembered callsign has to log in anyway. */}
                                <DXClusterWatch />
                                {/* The "most used" leaderboard counts minutes on
                                    a frequency, and a dock that is collapsed has
                                    unmounted the panel that used to do the
                                    counting — so the clock is here and the panel
                                    only draws what it finds. */}
                                <TopFreqWatch />
                                <StartOverlay />
                                <LegacyBridge />
                                <BridgeHost />
                                <SpotStreams />
                                <Shell />
                            </MediaSessionProvider>
                        </ExtensionsProvider>
                    </ChatProvider>
                </RadioProvider>
            </LayoutProvider>
        </DisplayProvider>
    );
}
