import React, { ReactDOM } from './react.js';
import App from './App.jsx';
import { startAppHeight } from './lib/appHeight.js';
import { startKeyboardReveal } from './lib/keyboardReveal.js';
import { refreshPanels, startPanelPolling } from './panels/custom/cache.js';
import './styles.css';

// Before the first render: the shell reads --app-height, and starting this
// afterwards would show one frame at whatever 100dvh came out to.
startAppHeight();
// The other half of the keyboard: the apps shorten the page for it (see
// SystemBars.java and ReceiverViewController), which stops the keys covering
// anything but does not scroll a panel's own scroller to the field being typed
// into. That is this.
startKeyboardReveal();

// The registry has already been built from the cached copy of this, above — the
// import of App pulls in panels/registry.jsx, which reads it synchronously. This
// is the revalidation, and it is deliberately not awaited: a receiver that is
// slow to answer, or too old to have the endpoint, must not hold up the first
// frame. What it learns applies to panels being removed straight away, and to
// panels being added on the next load. See panels/custom/cache.js.
refreshPanels();
// And keep asking, so a panel the operator enables or updates arrives without
// anybody reloading. Quiet while the tab is hidden, and a 304 when nothing has
// changed. See panels/custom/cache.js.
startPanelPolling();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
