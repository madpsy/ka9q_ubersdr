// One bundle for the TM-2 test: the driver, its frame and display modules, the
// surface registry, the mapping store and the function catalogue together — the
// same reason rc28.entry.js gives: bundled apart, each would carry its own copy
// of the surface singletons.

export * from '../src/controls/tm2.js';
export * as frame from '../src/controls/tm2frame.js';
export * as display from '../src/controls/tm2display.js';
export {
    getSurface, getTm2, releaseSurfaceExcept, surfaceKeyLabel,
} from '../src/controls/sources.js';
export {
    DEFAULT_STATE, SURFACES, isMappedSurface, loadState,
} from '../src/controls/mappings.js';
export { findFunction, runFunction, nextBand } from '../src/controls/functions.js';
export { bandsInRange } from '../src/lib/bands.js';
export { TUNING_STEPS, defaultEdges } from '../src/radio/constants.js';
