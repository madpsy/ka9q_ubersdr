// One bundle for the RC-28 test.
//
// The driver, the surface registry and the dispatcher together, for the reason
// dispatch.entry.js gives: bundled apart, each gets its own copy of the surface
// singletons and the test would drive a different RC-28 from the one the
// dispatcher is listening to.

export * from '../src/controls/rc28.js';
export {
    getSurface, getRc28, releaseSurfaceExcept, surfaceKeyLabel,
} from '../src/controls/sources.js';
export {
    DEFAULT_STATE, SURFACES, isMappedSurface, loadState,
} from '../src/controls/mappings.js';
export {
    watchSurface, setControlContext, setSurfaceMappings, tryAutoConnect, _resetDispatch,
} from '../src/controls/dispatch.js';
export { runFunction, isEncoderFunction } from '../src/controls/functions.js';
export * from '../src/controls/rc28leds.js';
export { functionLit } from '../src/controls/functions.js';
