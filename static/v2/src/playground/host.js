// Where the graph runs: in a worker, or — where one cannot be made — here.
//
// Both hosts speak workerCore.js's messages and both run its code; the only
// difference is the thread. The page-side one is a fallback rather than a
// choice: a browser that refuses the worker (an old one, a locked-down
// embedding) still gets a playground, at the cost of the main thread's time.

import { createWorkerCore } from './workerCore.js';

// Relative to the page, as the custom panels' runtime is (dist/panel-runtime.js).
export const WORKER_URL = 'dist/playground-worker.js';

class WorkerHost {
    constructor(onMessage, url) {
        this.kind = 'worker';
        this.worker = new Worker(url);
        this.worker.onmessage = (e) => onMessage(e.data);
        // A worker that fails to load, or dies, reports here and nowhere else.
        this.worker.onerror = (e) => {
            onMessage({ t: 'fault', message: (e && e.message) || 'The playground’s worker stopped.' });
        };
    }

    send(message, transfer) {
        this.worker.postMessage(message, transfer || []);
    }

    close() {
        this.worker.terminate();
    }
}

class InlineHost {
    constructor(onMessage) {
        this.kind = 'inline';
        this.core = createWorkerCore((m) => onMessage(m));
    }

    // Synchronous: the reply arrives before this returns.
    send(message) {
        this.core.onMessage(message);
    }

    close() {}
}

/** A host, in a worker if this browser will make one. */
export function createHost(onMessage, { url = WORKER_URL, worker = true } = {}) {
    if (worker && typeof Worker !== 'undefined') {
        try {
            return new WorkerHost(onMessage, url);
        } catch (err) {
            // Fall through to the page.
        }
    }
    return new InlineHost(onMessage);
}
