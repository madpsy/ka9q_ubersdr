// Entry point for the Serial port block's tests: the graph's half
// (blocks/serial.js), the page's (serialLink.js), and the worker's plumbing
// between them.
export { SerialPortBlock, serialNumber, firstNumber } from '../src/playground/blocks/serial.js';
export { SerialLink, serialSupport, portOptions, encodeText, makeDecoder, portLabel, SERIAL_MEMORY_KEY } from '../src/playground/serialLink.js';
export { createWorkerCore } from '../src/playground/workerCore.js';
export { BLOCK_BY_TYPE } from '../src/playground/blocks/index.js';
export { makeBuffer, sanitizeParams } from '../src/playground/block.js';
export { GRAPH_VERSION, compile, parseGraph } from '../src/playground/graph.js';
