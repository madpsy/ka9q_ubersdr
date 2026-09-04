// Bundle entry for the reduced-depth margin validation test.
const c = require('../src/radio/constants.js');
module.exports = {
    clampMargin: c.clampMargin,
    MARGIN_MIN_DB: c.MARGIN_MIN_DB,
    MARGIN_MAX_DB: c.MARGIN_MAX_DB,
    MARGIN_DEFAULT_DB: c.MARGIN_DEFAULT_DB,
    MARGIN_LOSSLESS: c.MARGIN_LOSSLESS,
    MARGIN_STEP_DB: c.MARGIN_STEP_DB,
    marginFromSlider: c.marginFromSlider,
    sliderFromMargin: c.sliderFromMargin,
    marginForMode: c.marginForMode,
};
