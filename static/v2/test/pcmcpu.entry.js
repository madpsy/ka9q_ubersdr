// Bundle entry for the decode-cost comparison: both lossless decoders, so the
// test can time them against identical content.
const { PCMStreamDecoder, isZstdFrame } = require('../src/radio/pcm-stream.js');
const { PCMv4StreamDecoder, isV4Frame } = require('../src/radio/pcm-v4.js');
module.exports = { PCMStreamDecoder, isZstdFrame, PCMv4StreamDecoder, isV4Frame };
