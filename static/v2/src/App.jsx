import React, { useEffect } from './react.js';
import { RadioProvider, useRadio } from './radio/RadioContext.jsx';
import { DisplayProvider } from './display/DisplayContext.jsx';
import { LayoutProvider } from './layout/LayoutContext.jsx';
import { MOBILE_QUERY, useMediaQuery } from './lib/useMediaQuery.js';
import Dock from './components/Dock.jsx';
import TopBar from './components/TopBar.jsx';
import SpectrumView from './components/SpectrumView.jsx';
import MobileShell from './components/MobileShell.jsx';
import FloatingLayer from './components/FloatingLayer.jsx';
import { ChatProvider } from './chat/ChatContext.jsx';
import LegacyBridge from './compat/LegacyBridge.jsx';

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

export default function App() {
    const mobile = useMediaQuery(MOBILE_QUERY);
    return (
        <DisplayProvider>
            <LayoutProvider>
                <RadioProvider>
                    <ChatProvider>
                        <PageTitle />
                        <LegacyBridge />
                        {mobile ? <MobileShell /> : <DesktopShell />}
                    </ChatProvider>
                </RadioProvider>
            </LayoutProvider>
        </DisplayProvider>
    );
}
