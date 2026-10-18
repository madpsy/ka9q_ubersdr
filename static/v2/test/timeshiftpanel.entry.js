// Entry point for the Timeshift panel's render test. hookStub first, for its
// side effect — see measurepanel.entry.js.
import { deep, render, reset, words } from './hookStub.js';
import TimeshiftPanel, { TimeshiftBadge } from '../src/panels/TimeshiftPanel.jsx';
import TimeshiftWatch from '../src/components/TimeshiftWatch.jsx';
import { getTimeshift } from '../src/lib/timeshift.js';
import { tuningNote } from '../src/lib/useTimeshift.js';

module.exports = {
    deep, render, reset, words, TimeshiftPanel, TimeshiftBadge, TimeshiftWatch, getTimeshift, tuningNote,
};
