// Entry point for the DRM panel's render test.
//
// The hook stub is imported first and for its side effect: src/react.js reads
// window.React at module scope and a bundler hoists module bodies above inline
// code, so it has to be in place before anything that leads there. Same rule as
// oliviapanel.entry.js.
import { deep, render, reset, walk, words } from './hookStub.js';
import DRMExtension from '../src/extensions/drm/DRMExtension.jsx';
import ExtensionsPanel from '../src/panels/ExtensionsPanel.jsx';
import { EXTENSIONS, EXTENSION_BY_ID } from '../src/extensions/registry.jsx';
import {
    decodeFrame, hasAudioLock, languageName, progressLabel, qualityFraction,
    WMER_THRESHOLD_FRACTION,
} from '../src/extensions/drm/frame.js';
import {
    describeSlot, formatOffsetLabel, formatScheduleFreq, formatSlot, formatSlotTime,
    isTunedTo, localOffsetMinutes, onAirCount, resetSchedule, scheduleDetail,
    scheduleRows, shiftHHMM,
} from '../src/extensions/drm/schedule.js';

module.exports = {
    deep, render, reset, walk, words,
    DRMExtension, ExtensionsPanel, EXTENSIONS, EXTENSION_BY_ID, decodeFrame, hasAudioLock, languageName, progressLabel, qualityFraction,
    WMER_THRESHOLD_FRACTION,
    formatScheduleFreq, formatSlot, formatSlotTime, isTunedTo, onAirCount, resetSchedule, scheduleDetail, scheduleRows,
    describeSlot, formatOffsetLabel, localOffsetMinutes, shiftHHMM,
};
