// Bundle entry for the reduced-depth wire-request test.
const { AudioConnection } = require('../src/radio/audio-connection.js');
const c = require('../src/radio/constants.js');
module.exports = {
    AudioConnection,
    MARGIN_LOSSLESS: c.MARGIN_LOSSLESS,
    MARGIN_DEFAULT_DB: c.MARGIN_DEFAULT_DB,
    marginFromSlider: c.marginFromSlider,
};
