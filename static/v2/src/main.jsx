import React, { ReactDOM } from './react.js';
import App from './App.jsx';
import { startAppHeight } from './lib/appHeight.js';
import { startKeyboardReveal } from './lib/keyboardReveal.js';
import './styles.css';

// Before the first render: the shell reads --app-height, and starting this
// afterwards would show one frame at whatever 100dvh came out to.
startAppHeight();
// The other half of the keyboard: the apps shorten the page for it (see
// SystemBars.java and ReceiverViewController), which stops the keys covering
// anything but does not scroll a panel's own scroller to the field being typed
// into. That is this.
startKeyboardReveal();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
