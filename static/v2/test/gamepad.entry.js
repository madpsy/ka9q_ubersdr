// One bundle for the game controller test.
//
// The driver, the surface registry and the dispatcher together, for the reason
// dispatch.entry.js gives: bundled apart, each gets its own copy of the surface
// singletons and the test would drive a different pad from the one the
// dispatcher is listening to.

export * from '../src/controls/gamepad.js';
export {
    getSurface, getGamepad, releaseSurfaceExcept, surfaceKeyLabel,
} from '../src/controls/sources.js';
export {
    DEFAULT_STATE, SURFACES, isMappedSurface, loadState,
} from '../src/controls/mappings.js';
export {
    watchSurface, setControlContext, setSurfaceMappings, tryAutoConnect, onControlResult, _resetDispatch,
} from '../src/controls/dispatch.js';
export { runFunction, functionIsContinuous, findFunction } from '../src/controls/functions.js';
