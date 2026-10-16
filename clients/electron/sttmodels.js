'use strict';

// The Whisper models the local speech-to-text runs on: which there are, which
// are on this computer, which one is in use, and fetching the one that is not
// shipped.
//
// Two speech models, both multilingual, both pinned in whisper/models.json by
// URL, size and SHA-256 (see the note at its top):
//
//   base    built in. 60 MB, packaged beside the helper (extraResources), and
//           quick enough to keep up on any machine with AVX2 or an Apple chip.
//   small   190 MB, three times the download for everybody if it were shipped,
//           so it is fetched on request instead — from the Speech-to-Text
//           extension's Model setting. Noticeably better on a weak signal, and
//           three to four times the CPU.
//
// A download goes to userData/whisper-models/, which an update leaves alone,
// so it is fetched once per computer rather than once per version. It is
// written to a .part file beside the final name and renamed only once its size
// and hash match the pins: a file with the final name is a good file, and the
// helper is never pointed at half a model. An interrupted .part is kept and
// carried on from with a Range request — the URL names a fixed commit, so the
// bytes on either side of the break are the same file's — and the hash, taken
// over the whole file at the end, is what proves it.
//
// The voice-activity model is in models.json too, but is not a choice anybody
// makes: it is shipped, and is not listed here.
//
// Plain Node: the network is whatever `fetch` is passed (Electron's net.fetch
// in the app, which goes through Chromium's proxy settings and certificate
// store; Node's own in the tests), and nothing here requires Electron.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const LABELS = { base: 'Base', small: 'Small' };

// cancel()'s owner for "everybody": remove() and quitting.
const ALL = Symbol('all');

// Progress is for a bar on screen. Every chunk would be thousands of IPC
// messages for one download; four a second moves the bar as smoothly as anyone
// can see.
const PROGRESS_MS = 250;

/**
 * models.json's entries for this client, in its order, as `{id, file, url,
 * size, sha256, bundled}`. `//` keys are its notes. The file is shared with the
 * browser's Whisper (static/v2), and an entry's `clients` says which of the two
 * offer it — tiny is the browser's alone. An entry without one is for both.
 */
function readPins(pins) {
    const out = [];
    for (const [id, v] of Object.entries(pins || {})) {
        if (id.startsWith('//') || !v || typeof v !== 'object') continue;
        if (Array.isArray(v.clients) && !v.clients.includes('desktop')) continue;
        out.push({
            id,
            file: String(v.file || ''),
            url: String(v.url || ''),
            size: Number(v.size) || 0,
            sha256: String(v.sha256 || '').toLowerCase(),
            bundled: !!v.bundled,
        });
    }
    return out;
}

/** An Error whose message is shown to the user as it stands. */
function said(message, code) {
    const e = new Error(message);
    if (code) e.code = code;
    return e;
}

function sizeOf(file) {
    try {
        const st = fs.statSync(file);
        return st.isFile() ? st.size : -1;
    } catch {
        return -1;
    }
}

class ModelManager {
    /**
     * @param {object} o
     * @param {object} o.pins         models.json, parsed
     * @param {string} o.builtinDir   where the shipped models are
     * @param {string} o.dir          where downloads go (userData/whisper-models)
     * @param {Function} o.getActive  () => the chosen model's id, or null
     * @param {Function} o.setActive  (id|null) => void; null means the default
     * @param {Function} [o.fetch]    a WHATWG fetch
     * @param {number} [o.progressMs]
     */
    constructor({ pins, builtinDir, dir, getActive, setActive, fetch: fetchImpl, progressMs = PROGRESS_MS }) {
        this.all = readPins(pins);
        // Every model but the VAD's is a speech model the user can choose.
        this.speech = this.all.filter((p) => p.id !== 'vad');
        this.vadPin = this.all.find((p) => p.id === 'vad') || null;
        this.builtinDir = builtinDir;
        this.dir = dir;
        this.getActive = getActive || (() => null);
        this.setActiveId = setActive || (() => {});
        this.fetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
        this.progressMs = progressMs;
        // Downloads in progress, by model id: {promise, controller, waiters,
        // cancelled}. A second install of the same model — another receiver
        // window, say — joins the first as another waiter, and the download
        // is only abandoned once every waiter has cancelled.
        this.jobs = new Map();
    }

    pin(id) {
        return this.speech.find((p) => p.id === id) || null;
    }

    /** The first shipped speech model: what runs when nothing else can. */
    get defaultId() {
        const b = this.speech.find((p) => p.bundled);
        return b ? b.id : null;
    }

    /** Where a model's file is, or would be once downloaded. */
    fileFor(id) {
        const p = id === 'vad' ? this.vadPin : this.pin(id);
        if (!p) return null;
        return path.join(p.bundled ? this.builtinDir : this.dir, p.file);
    }

    /**
     * Whether a model can be run. A shipped one only has to be there; a
     * downloaded one has to be the pinned size as well — the hash was checked
     * when it arrived, and re-reading 190 MB on every start to check it again
     * would cost more than it could ever catch.
     */
    installed(id) {
        const p = id === 'vad' ? this.vadPin : this.pin(id);
        if (!p) return false;
        const size = sizeOf(this.fileFor(id));
        if (p.bundled) return size > 0;
        return size === p.size;
    }

    /**
     * The model a session should use: the chosen one if it is installed,
     * otherwise the built-in one, with `fallback` saying which was chosen and
     * could not be had.
     */
    resolve() {
        const chosen = this.getActive();
        const fallbackId = this.defaultId;
        if (chosen && chosen !== fallbackId && this.pin(chosen)) {
            if (this.installed(chosen)) return { id: chosen, file: this.fileFor(chosen), fallback: null };
            return { id: fallbackId, file: this.fileFor(fallbackId), fallback: chosen };
        }
        return { id: fallbackId, file: fallbackId ? this.fileFor(fallbackId) : null, fallback: null };
    }

    /** The Model setting's list: `[{id, label, sizeBytes, installed, active, builtIn}]`. */
    list() {
        const active = this.resolve().id;
        return this.speech.map((p) => ({
            id: p.id,
            label: LABELS[p.id] || p.id,
            sizeBytes: p.size,
            installed: this.installed(p.id),
            active: p.id === active,
            builtIn: p.bundled,
            downloading: this.jobs.has(p.id) && !this.jobs.get(p.id).cancelled,
        }));
    }

    /**
     * Make `id` the model sessions start with. Only an installed one: choosing
     * a model that is not there would make every start a fallback, and the
     * page asks for the download first.
     */
    async setActive(id) {
        const p = this.pin(id);
        if (!p) throw said(`There is no "${id}" model.`, 'unknown-model');
        if (!this.installed(id)) throw said(`The ${LABELS[id] || id} model is not downloaded yet.`, 'not-installed');
        this.setActiveId(id === this.defaultId ? null : id);
    }

    /**
     * Delete a downloaded model, and any half-download of it. If it was the
     * one in use, the built-in one is from now on. A session already running
     * on it carries on — the helper read the file at start and holds it in
     * memory — until it is next started.
     */
    async remove(id) {
        const p = this.pin(id);
        if (!p) throw said(`There is no "${id}" model.`, 'unknown-model');
        if (p.bundled) throw said(`The ${LABELS[id] || id} model is built in and can't be removed.`, 'built-in');
        this.cancel(id, ALL);
        const job = this.jobs.get(id);
        // Let a cancelled download finish unwinding before deleting what it
        // was writing, or its last write can recreate the .part.
        if (job) await job.promise.catch(() => {});
        const file = this.fileFor(id);
        for (const f of [file, `${file}.part`]) {
            try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') throw said(`Couldn't remove the model: ${e.message}`); }
        }
        if (this.getActive() === id) this.setActiveId(null);
    }

    /**
     * `owner`'s part in a download. The download itself stops only if nobody
     * else is waiting on it — one window's Cancel is not another's — and then
     * its installs are answered 'cancelled' once it has stopped writing, its
     * .part kept for next time. If others are still waiting, `owner`'s
     * installs are answered 'cancelled' at once and the rest carry on.
     * `ALL`, or no owner, stops it for everybody.
     */
    cancel(id, owner = ALL) {
        const job = this.jobs.get(id);
        if (!job || job.cancelled) return;
        const mine = [...job.waiters].filter((w) => owner === ALL || w.owner === owner);
        if (mine.length < job.waiters.size) {
            for (const w of mine) {
                job.waiters.delete(w);
                w.reject(said('Download cancelled.', 'cancelled'));
            }
            return;
        }
        job.cancelled = true;
        job.controller.abort();
    }

    /** Stop every download: the app is quitting. */
    cancelAll() {
        for (const id of [...this.jobs.keys()]) this.cancel(id, ALL);
    }

    /**
     * A downloaded model the helper would not load: is the file itself bad?
     * 'bad' if it is not the pinned size or hash — then it is deleted, and
     * stops being the chosen one — 'good' if it is, and 'unknown' if it could
     * not be read to tell.
     *
     * The helper's model-missing and model-invalid say only that the load
     * failed, and a load fails for passing reasons too: on Windows a virus
     * scanner holding the file open, anywhere too little memory for the
     * model. Deleting 190 MB the user waited for on that evidence would be
     * the wrong way round, so the file is judged by the same pins it was
     * accepted on, and kept unless it fails them.
     */
    async verify(id) {
        const p = this.pin(id);
        if (!p || p.bundled) return 'unknown';
        const file = this.fileFor(id);
        const size = sizeOf(file);
        if (size < 0) {
            // Nothing there to judge, or nothing that can be looked at.
            return fs.existsSync(file) ? 'unknown' : 'bad';
        }
        if (size === p.size) {
            const hash = crypto.createHash('sha256');
            try {
                await hashFile(file, hash);
            } catch {
                return 'unknown';
            }
            if (hash.digest('hex') === p.sha256) return 'good';
        }
        try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') return 'unknown'; }
        if (this.getActive() === id) this.setActiveId(null);
        return 'bad';
    }

    /**
     * Download `id`, calling `onProgress({received, total})` as it goes.
     * Resolves once it is installed; rejects with an Error whose message is
     * for the user — including for a cancel, whose `code` is 'cancelled'.
     * `owner` is who is asking (a window), for cancel(); each call without
     * one is its own.
     */
    install(id, onProgress, owner = Symbol('install')) {
        const p = this.pin(id);
        if (!p) return Promise.reject(said(`There is no "${id}" model.`, 'unknown-model'));
        if (this.installed(id)) return Promise.resolve();
        if (p.bundled) return Promise.reject(said(`The ${LABELS[id] || id} model is missing from this installation — reinstall UberSDR.`, 'missing'));
        let job = this.jobs.get(id);
        // One being cancelled is still unwinding: a fresh one once it has,
        // carrying on from the piece it leaves, rather than joining it to be
        // told 'cancelled'.
        if (job && job.cancelled) {
            return job.promise.catch(() => {}).then(() => this.install(id, onProgress, owner));
        }
        if (!job) {
            job = { controller: new AbortController(), waiters: new Set(), cancelled: false, promise: null };
            this.jobs.set(id, job);
            job.promise = this.download(p, job).finally(() => {
                if (this.jobs.get(id) === job) this.jobs.delete(id);
            });
            // Whoever is still waiting when it ends; a waiter that cancelled
            // has had its answer already.
            const settle = (fn) => {
                const waiters = [...job.waiters];
                job.waiters.clear();
                for (const w of waiters) fn(w);
            };
            job.promise.then(() => settle((w) => w.resolve()), (e) => settle((w) => w.reject(e)));
        }
        return new Promise((resolve, reject) => {
            job.waiters.add({ owner, onProgress: typeof onProgress === 'function' ? onProgress : null, resolve, reject });
        });
    }

    async download(p, job) {
        const label = LABELS[p.id] || p.id;
        if (!this.fetch) throw said(`Couldn't download the ${label} model: no network access here.`);
        const final = path.join(this.dir, p.file);
        const part = `${final}.part`;
        const tell = (received) => {
            for (const w of job.waiters) {
                if (!w.onProgress) continue;
                try { w.onProgress({ received, total: p.size }); } catch { /* a closed window */ }
            }
        };

        let fh = null;
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            let have = sizeOf(part);
            // Longer than the file can be: not a piece of it.
            if (have > p.size) { fs.unlinkSync(part); have = -1; }
            if (have < 0) have = 0;

            const hash = crypto.createHash('sha256');
            if (have > 0) await hashFile(part, hash);

            // All of it already there from last time: only the check is left.
            if (have < p.size) {
                const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
                const res = await this.fetch(p.url, { headers, signal: job.controller.signal, redirect: 'follow' });
                // 206 carries on from what is there. A 200 is the whole file —
                // the first request, or a server that ignored the Range — and
                // starts again rather than being appended to the piece.
                const append = res.status === 206 && have > 0;
                if (!append && res.status !== 200) {
                    throw new Error(`the server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`);
                }
                if (!res.body) throw new Error('the server sent nothing');
                const h = append ? hash : crypto.createHash('sha256');
                let received = append ? have : 0;
                fh = await fs.promises.open(part, append ? 'a' : 'w');
                tell(received);
                let last = Date.now();
                const reader = res.body.getReader();
                for (;;) {
                    // eslint-disable-next-line no-await-in-loop
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
                    received += chunk.length;
                    if (received > p.size) throw new Error('the server sent more than the model\'s size');
                    h.update(chunk);
                    // eslint-disable-next-line no-await-in-loop
                    await fh.write(chunk);
                    const now = Date.now();
                    if (now - last >= this.progressMs) { last = now; tell(received); }
                }
                await fh.close();
                fh = null;
                tell(received);
                return this.finish(p, part, final, received, h.digest('hex'));
            }
            tell(have);
            return this.finish(p, part, final, have, hash.digest('hex'));
        } catch (e) {
            if (fh) await fh.close().catch(() => {});
            if (job.cancelled) throw said('Download cancelled.', 'cancelled');
            if (e && e.code === 'corrupt') throw e;
            throw said(`Couldn't download the ${label} model: ${(e && e.message) || e}`, 'download-failed');
        }
    }

    finish(p, part, final, received, digest) {
        if (received !== p.size || digest !== p.sha256) {
            // Not a piece of the right file, so nothing to carry on from.
            try { fs.unlinkSync(part); } catch { /* already gone */ }
            const why = received !== p.size
                ? `it is ${received} bytes rather than ${p.size}`
                : 'its checksum does not match';
            throw said(`The ${LABELS[p.id] || p.id} model downloaded damaged (${why}), so it was thrown away. Try again.`, 'corrupt');
        }
        fs.renameSync(part, final);
    }
}

function hashFile(file, hash) {
    return new Promise((resolve, reject) => {
        fs.createReadStream(file)
            .on('data', (d) => hash.update(d))
            .on('end', resolve)
            .on('error', reject);
    });
}

module.exports = { ModelManager, readPins, LABELS, ALL };
