// Entry point for the on-device speech-to-text engine tests.
//
// The engine factory and detection are the public surface (engines/index.js);
// resultsFromEvent is the browser engine's one pure helper, which index.js
// has no reason to re-export to the panel but the tests want directly.
export * from '../src/extensions/whisper/engines/index.js';
export { resultsFromEvent } from '../src/extensions/whisper/engines/browser.js';
