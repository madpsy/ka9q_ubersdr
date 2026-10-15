// Bundle entry for the WebAssembly decoder's wiring test. One bundle, so the
// loader the test waits on is the one audio-connection.js started.
const { AudioConnection } = require('../src/radio/audio-connection.js');
const { PCMv4StreamDecoder } = require('../src/radio/pcm-v4.js');
const { loadPCMv4Wasm } = require('../src/radio/pcm-v4-wasm.js');
module.exports = { AudioConnection, PCMv4StreamDecoder, loadPCMv4Wasm };
