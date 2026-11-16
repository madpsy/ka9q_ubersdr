// The audio classifier's worker: Go's WebAssembly loader, then the message
// handling in ./workerHost.js. Bundled on its own by static/v2/build.sh to
// dist/audioclass-worker.js, since a Worker loads a script by URL.
//
// One thread, as the browser's Whisper is: anything more needs the page
// cross-origin isolated, which no receiver is.

import './wasm_exec.js';
import { createWorkerHost } from './workerHost.js';

const onMessage = createWorkerHost(self.Go, (msg) => self.postMessage(msg), self);
self.onmessage = (e) => { onMessage(e.data); };
