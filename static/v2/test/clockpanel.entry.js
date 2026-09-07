// Entry point for the time-signal panel's render test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// drmpanel.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import ClockExtension from '../src/extensions/clock/ClockExtension.jsx';
import { EXTENSIONS, EXTENSION_BY_ID } from '../src/extensions/registry.jsx';
import {
    CLOCK_FREQUENCIES, STRIP_LENGTH, WWVB_CEILING_HZ,
    alignmentSeries, appendSecond, correctedNowMs, decodeFrame, formatClock, formatDate,
    formatDay, formatDut1, formatOffset, frameFlags, funnelStages, localIsUtc, offsetSense,
    offsetTone, polylinePoints, stateLabel, stateTone, stationFor, stationLabel, symbolTone,
    tunedClockOption, zoneLabel,
} from '../src/extensions/clock/frames.js';

module.exports = {
    deep, render, reset, walk, words,
    ClockExtension, EXTENSIONS, EXTENSION_BY_ID,
    CLOCK_FREQUENCIES, STRIP_LENGTH, WWVB_CEILING_HZ,
    alignmentSeries, appendSecond, correctedNowMs, decodeFrame, formatClock, formatDate,
    formatDay, formatDut1, formatOffset, frameFlags, funnelStages, localIsUtc, offsetSense,
    offsetTone, polylinePoints, stateLabel, stateTone, stationFor, stationLabel, symbolTone,
    tunedClockOption, zoneLabel,
};
