// The playground's worker: dist/playground-worker.js, built by build.sh.
//
// Everything it does is in workerCore.js; this only joins that to the worker's
// message port.

import { createWorkerCore } from './workerCore.js';

const core = createWorkerCore((message, transfer) => self.postMessage(message, transfer || []));
self.onmessage = (e) => core.onMessage(e.data);
