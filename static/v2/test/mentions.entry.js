// One bundle for the message-parsing test.
//
// splitMessage and applyTuningRange have to be bundled together or the test sets
// the range in a different copy of radio/constants.js from the one mentions.js
// reads — separate esbuild bundles each get their own module instance, and the
// live bindings that make the range work at all would be live in the wrong one.
// Same reason as notifications.entry.js.

export * from '../src/lib/mentions.js';
export { applyTuningRange, MAX_FREQ, MIN_FREQ } from '../src/radio/constants.js';
