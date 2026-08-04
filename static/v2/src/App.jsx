import React, { useEffect, useRef } from './react.js';
import { RadioProvider, useRadio } from './radio/RadioContext.jsx';
import { DisplayProvider } from './display/DisplayContext.jsx';
import { LayoutProvider } from './layout/LayoutContext.jsx';
import { MOBILE_QUERY, useMediaQuery } from './lib/useMediaQuery.js';
import Dock from './components/Dock.jsx';
import TopBar from './components/TopBar.jsx';
import SpectrumView from './components/SpectrumView.jsx';
import MobileShell from './components/MobileShell.jsx';
import FloatingLayer from './components/FloatingLayer.jsx';
import IdleWatch from './components/IdleWatch.jsx';
import { ChatProvider } from './chat/ChatContext.jsx';
import { ExtensionsProvider } from './extensions/ExtensionsContext.jsx';
import LegacyBridge from './compat/LegacyBridge.jsx';
import { useDisplay } from './display/DisplayContext.jsx';
import { subscribeSpots } from './lib/spotStore.js';

function DesktopShell() {
    return (
        <div className="shell">
            <TopBar />
            <div className="shell__main">
                <Dock side="left" />
                <div className="shell__column">
                    <main className="shell__center">
                        <SpectrumView />
                        <FloatingLayer />
                    </main>
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

export default function App() {
    const mobile = useMediaQuery(MOBILE_QUERY);
    return (
        <DisplayProvider>
            <LayoutProvider>
                <RadioProvider>
                    <ChatProvider>
                        <ExtensionsProvider>
                            <PageTitle />
                            <AudioDefaults />
                            <IdleWatch />
                            <LegacyBridge />
                            <SpotStreams />
                            {mobile ? <MobileShell /> : <DesktopShell />}
                        </ExtensionsProvider>
                    </ChatProvider>
                </RadioProvider>
            </LayoutProvider>
        </DisplayProvider>
    );
}
