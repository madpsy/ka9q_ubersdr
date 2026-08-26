// Entry point for the tuning-range tests.
//
// One bundle on purpose. esbuild gives every entry its own copy of the modules it
// pulls in, so a test that applied the range through `constants.cjs` and then read it
// back through a separately-bundled `format.cjs` would be talking to two unrelated
// copies of the same variable and would pass no matter what the code did.
//
// Bundled together, `applyTuningRange` and the consumers below share the live bindings
// exactly as they do inside the real v2 bundle — which is the property under test, since
// ~40 call sites depend on it and none of them was changed when the range stopped being
// a compile-time constant.
export { MAX_FREQ, MIN_FREQ, RECEIVER_SPAN_HZ, applyTuningRange } from '../src/radio/constants.js';
// Reads MIN_FREQ/MAX_FREQ when called, like most consumers.
export { freqInRange } from '../src/lib/format.js';
// Reads them when called, and derives edges from them.
export { clampCenter } from '../src/lib/zoom.js';
// Pure — takes the limits as arguments. Here because QuickBandsPanel and MultipadPanel
// feed it the live bindings, and that pairing is what puts a 6 m key on screen.
export { bandsInRange } from '../src/lib/bands.js';
