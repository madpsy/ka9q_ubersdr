// One bundle for the Time panel's tests.
//
// The hook stub is imported first and for its side effect: src/react.js reads window.React
// at module scope and a bundler hoists module bodies above inline code, so it has to be in
// place before anything that leads there. Same rule as drmpanel.entry.js.
//
// The registry comes along because a panel that renders is only half the claim — the other
// half is that it is registered, gated on the addon, and named in a group, and all three
// are assertions about the registry rather than about the panel.
import { deep, render, reset, walk, words } from './hookStub.js';
import TimePanel from '../src/panels/TimePanel.jsx';
import { PANELS, PANEL_BY_ID } from '../src/panels/registry.jsx';
import { GROUPS } from '../src/panels/groups.jsx';
import {
    BURST_GAP_MS, DIAL_MIN_MS, MAX_SAMPLE_AGE_MS, PHI, POLL_MS, STATUS_MAX_MS, STATUS_MIN_MS,
    STEP_MS, WINDOW,
    addSample, addonUrl, bestEstimate, carriedTheta, clockAsleep, clockParts, deviceError,
    deviceLabel, deviceTone, deviceWithin, dialEdge, dialPos, dialSpan, dispersionTone,
    CLOCK_KEYS, browserZone, clockFaces, faceDateAt, facePartsAt, faceFor, faceText,
    formatDur, formatMs, localIsUtc, newClock, nextFaceKey, nextSecondDelay, ntpAvailable,
    offsetText, receiverOffsetMin, referenceKey, referenceOf, sampleFrom, saveBigClock,
    saveShowRef, saveShowMs, savedBigClock, savedShowRef, savedShowMs, servingNote,
    staleStatus, stationMix, statusUrl, timeUrl, utcOffsetText, zoneOffsetMin,
} from '../src/lib/ntpTime.js';

module.exports = {
    deep, render, reset, walk, words,
    TimePanel, PANELS, PANEL_BY_ID, GROUPS,
    BURST_GAP_MS, DIAL_MIN_MS, MAX_SAMPLE_AGE_MS, PHI, POLL_MS, STATUS_MAX_MS, STATUS_MIN_MS,
    STEP_MS, WINDOW,
    addSample, addonUrl, bestEstimate, carriedTheta, clockAsleep, clockParts, deviceError,
    deviceLabel, deviceTone, deviceWithin, dialEdge, dialPos, dialSpan, dispersionTone,
    CLOCK_KEYS, browserZone, clockFaces, faceDateAt, facePartsAt, faceFor, faceText,
    formatDur, formatMs, localIsUtc, newClock, nextFaceKey, nextSecondDelay, ntpAvailable,
    offsetText, receiverOffsetMin, referenceKey, referenceOf, sampleFrom, saveBigClock,
    saveShowRef, saveShowMs, savedBigClock, savedShowRef, savedShowMs, servingNote,
    staleStatus, stationMix, statusUrl, timeUrl, utcOffsetText, zoneOffsetMin,
};
