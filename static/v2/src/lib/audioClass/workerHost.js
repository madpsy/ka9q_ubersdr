// The audio classifier's worker, minus the Worker: the messages it answers,
// as a function of whatever posts them. worker.entry.js wires it to the
// worker's own scope; the tests wire it to a plain object and drive the real
// WebAssembly module through it under node.
//
// Messages in (from ./classifier.js):
//
//   { type: 'init', wasm: ArrayBuffer, model: ArrayBuffer }
//   { type: 'reset', rate }               new stream rate, or a retune
//   { type: 'push', samples: Float32Array }
//   { type: 'classify', seconds, epoch }
//
// Messages out:
//
//   { type: 'ready' }  or  { type: 'error', error }
//   { type: 'result', epoch, result }      result is null when too little audio is held
//
// `Go` is the class wasm_exec.js puts on the global scope; it is passed in
// rather than read so a test can say which one it means.

export function createWorkerHost(Go, post, scope = globalThis) {
    let api = null;
    let failed = null;

    async function init(msg) {
        try {
            const go = new Go();
            const { instance } = await WebAssembly.instantiate(msg.wasm, go.importObject);
            // run() resolves only when the Go program exits, and this one
            // never does: it parks in select{} with its functions exported.
            go.run(instance);
            api = scope.audioclass;
            if (!api) throw new Error('the module did not start');
            const err = api.load(new Uint8Array(msg.model));
            if (err) throw new Error(err);
            post({ type: 'ready' });
        } catch (e) {
            failed = String((e && e.message) || e);
            api = null;
            post({ type: 'error', error: failed });
        }
    }

    return function onMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'init') return init(msg);
        if (!api) return undefined;
        switch (msg.type) {
            case 'reset':
                api.reset(msg.rate | 0);
                break;
            case 'push': {
                const s = msg.samples;
                if (s && s.length) api.push(new Uint8Array(s.buffer, s.byteOffset, s.byteLength));
                break;
            }
            case 'classify': {
                let result = null;
                try {
                    const json = api.classify(msg.seconds);
                    result = json ? JSON.parse(json) : null;
                } catch (e) {
                    result = null;
                }
                post({ type: 'result', epoch: msg.epoch, result });
                break;
            }
            default:
        }
        return undefined;
    };
}
