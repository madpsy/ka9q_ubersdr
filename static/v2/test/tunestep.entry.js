// Entry point for the per-mode tuning step's render test.
//
// The hook stub goes first and for its side effect — src/react.js reads
// window.React at module scope and the bundler hoists module bodies above
// inline code, so it has to be in place before anything that leads there. Same
// rule as filterreset.entry.js.
import { deep, render, reset, walk } from './hookStub.js';
import TuneStepWatch from '../src/components/TuneStepWatch.jsx';
import ReceiverPanel from '../src/panels/ReceiverPanel.jsx';
import MultipadPanel from '../src/panels/MultipadPanel.jsx';
import { DEFAULTS, withTuneStep } from '../src/display/DisplayContext.jsx';
import { DEFAULT_STEP_BY_MODE, MODES, TUNING_STEPS, defaultStepFor } from '../src/radio/constants.js';

module.exports = {
    deep, render, reset, walk,
    TuneStepWatch, ReceiverPanel, MultipadPanel, DEFAULTS, withTuneStep, TUNING_STEPS,
    DEFAULT_STEP_BY_MODE, MODES, defaultStepFor,
};
