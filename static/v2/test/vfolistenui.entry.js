// Entry point for the simultaneous-VFO interface: the VFOs panel's listening
// controls, the Receiver panel's VFO bar, the spectrum's and marker bar's pure
// helpers, the colour palette and the control-surface functions.
//
// The hook stub first, for the reason given in wavlossless.entry.js. One bundle
// for all of it so the VFO store, the session's VFO count and the engine are a
// single instance each — split across bundles, a test that set the count in one
// would be reading the default in another.
import { deep, render, reset, walk, words } from './hookStub.js';
import VfosPanel, { listenNote, outLabel } from '../src/panels/VfosPanel.jsx';
import ReceiverPanel, { canToggleListen } from '../src/panels/ReceiverPanel.jsx';
import StatusPanel from '../src/panels/StatusPanel.jsx';
import { DEFAULTS } from '../src/display/DisplayContext.jsx';
import { getVfos, setVfos } from '../src/lib/vfos.js';
import { getSubReceivers } from '../src/radio/subReceivers.js';
import { connectionCheck, getVfoLimit, newSessionId } from '../src/radio/session.js';
import * as colours from '../src/lib/vfoColours.js';
import * as marks from '../src/lib/vfoMarks.js';
import {
    catalogue, muteAllListening, nextListeningVfo, runFunction,
} from '../src/controls/functions.js';

module.exports = {
    deep, render, reset, walk, words,
    VfosPanel, listenNote, outLabel, ReceiverPanel, canToggleListen, StatusPanel, DEFAULTS,
    getVfos, setVfos, getSubReceivers, connectionCheck, getVfoLimit, newSessionId,
    colours, marks, catalogue, muteAllListening, nextListeningVfo, runFunction,
};
