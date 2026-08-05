// One bundle for the dispatch test.
//
// dispatch.js and sources.js must be bundled together or the test drives a
// different surface singleton from the one the dispatcher listens to — separate
// esbuild bundles each get their own copy of the module.

export * from '../src/controls/dispatch.js';
export { getSurface } from '../src/controls/sources.js';
