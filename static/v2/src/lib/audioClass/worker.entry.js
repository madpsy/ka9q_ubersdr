// The audio classifier's worker: the message handling in ./workerHost.js,
// which carries the WebAssembly module itself. Bundled on its own by
// static/v2/build.sh to dist/audioclass-worker.js, since a Worker loads a
// script by URL.
//
// One thread, as the browser's Whisper is: anything more needs the page
// cross-origin isolated, which no receiver is.

import { createWorkerHost } from './workerHost.js';

const onMessage = createWorkerHost((msg) => self.postMessage(msg));
self.onmessage = (e) => { onMessage(e.data); };
