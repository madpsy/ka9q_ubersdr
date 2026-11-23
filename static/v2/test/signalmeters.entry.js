// Entry point for the Signal panel meters' test. The hook stub goes first, for
// the reason given in holdpress.entry.js.
import { deep, render, reset, words } from './hookStub.js';
import SignalPanel from '../src/panels/SignalPanel.jsx';
import { DEFAULTS } from '../src/display/DisplayContext.jsx';

module.exports = { deep, render, reset, words, SignalPanel, DEFAULTS };
