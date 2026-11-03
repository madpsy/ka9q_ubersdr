// One bundle for the Dial test: the driver, the surface registry and the
// dispatcher together, so the test drives the same Dial singleton the
// dispatcher listens to (see dispatch.entry.js for why that matters).

export * from '../src/controls/dial.js';
export {
    getSurface, getDial, releaseSurfaceExcept, surfaceKeyLabel,
} from '../src/controls/sources.js';
export {
    DEFAULT_STATE, SURFACES, isMappedSurface, loadState,
} from '../src/controls/mappings.js';
export {
    watchSurface, setControlContext, setSurfaceMappings, _resetDispatch,
} from '../src/controls/dispatch.js';
export { findFunction } from '../src/controls/functions.js';
