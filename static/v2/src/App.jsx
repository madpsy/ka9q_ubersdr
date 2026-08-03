import React from './react.js';
import { RadioProvider } from './radio/RadioContext.jsx';
import { DisplayProvider } from './display/DisplayContext.jsx';
import { LayoutProvider } from './layout/LayoutContext.jsx';
import { MOBILE_QUERY, useMediaQuery } from './lib/useMediaQuery.js';
import Dock from './components/Dock.jsx';
import TopBar from './components/TopBar.jsx';
import SpectrumView from './components/SpectrumView.jsx';
import MobileShell from './components/MobileShell.jsx';

function DesktopShell() {
    return (
        <div className="shell">
            <TopBar />
            <div className="shell__main">
                <Dock side="left" />
                <div className="shell__column">
                    <main className="shell__center">
                        <SpectrumView />
                    </main>
                    <Dock side="bottom" />
                </div>
                <Dock side="right" />
            </div>
        </div>
    );
}

export default function App() {
    const mobile = useMediaQuery(MOBILE_QUERY);
    return (
        <DisplayProvider>
            <LayoutProvider>
                <RadioProvider>
                    {mobile ? <MobileShell /> : <DesktopShell />}
                </RadioProvider>
            </LayoutProvider>
        </DisplayProvider>
    );
}
