// Entry point for the browser's own Whisper: the page's half (engines/wasm.js),
// the hash it checks downloads with, the engine order, the source default, and
// the generated description of the committed module.
export * from '../src/extensions/whisper/engines/wasm.js';
export { createSha256 } from '../src/extensions/whisper/sha256.js';
export { WASM_BUILD, WASM_PINS } from '../src/extensions/whisper/wasm/build.generated.js';
export { contractStt, createLocalEngine, localEngineKind, usableLocalKind } from '../src/extensions/whisper/engines/index.js';
export { pickSource } from '../src/extensions/whisper/local.js';
