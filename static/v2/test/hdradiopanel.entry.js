// Entry point for the HD Radio panel's render test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope. Same rule as drmpanel.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import HDRadioExtension, { HDRadioView } from '../src/extensions/hdradio/HDRadioExtension.jsx';
import CallsignMap from '../src/components/CallsignMap.jsx';
import { EXTENSIONS, EXTENSION_BY_ID } from '../src/extensions/registry.jsx';
import { extensionEvent } from '../src/extensions/protocol.js';
import {
    alertAreas, decodeFrame, describeHereMap, formatBer, formatDevice, formatLeapSecond,
    formatUtcOffset, imageMime, pictureFor, programLabel, safeUrl, selectedProgram,
    stationClock, stationZone,
} from '../src/extensions/hdradio/frame.js';

module.exports = {
    deep, render, reset, walk, words,
    HDRadioExtension, HDRadioView, CallsignMap, EXTENSIONS, EXTENSION_BY_ID, extensionEvent,
    alertAreas, decodeFrame, describeHereMap, formatBer, formatDevice, formatLeapSecond,
    formatUtcOffset, imageMime, pictureFor, programLabel, safeUrl, selectedProgram,
    stationClock, stationZone,
};
