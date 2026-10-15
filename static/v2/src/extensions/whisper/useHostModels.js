// The host recogniser's models, for the Model setting in local mode.
//
// Only a host that offers them has one: the desktop client runs Whisper and
// ships its base model, with small — better on a weak signal, three times the
// CPU — a download away. The calls are the optional half of the host contract
// (./engines/host.js): `models`, `installModel`, `cancelInstall`,
// `removeModel`, `setModel`. Which model is in use is the host's to remember,
// not this page's: it is a fact about the computer, the same in every receiver
// window, and the host is what has the file.
//
// The menu lists every model, downloaded or not. Choosing one that is there
// switches to it; choosing one that is not only selects it, and the button
// beside the menu becomes Download — a 190 MB download is not something a
// change of selection should start by itself. Once it has arrived it is
// switched to, since that is what choosing it meant.
//
// `applied` counts the times the model in use changed. The host takes a new
// model at the next start, so the panel restarts its engine on it — that is
// what makes choosing a model take effect now rather than at the next Start.
//
// The host's list is shared by every receiver window and changes behind this
// one's back — another window downloads, removes or switches, or the host
// falls back to the built-in model because the chosen one would not load — so
// it is asked again when the window comes back into view, and whenever the
// panel calls `refresh` (on the host's 'model-fallback' note). A download
// that is already running — started in another window, or before the panel
// was last closed — is followed rather than offered again: the list says
// `downloading`, and installModel joins it.

import { useEffect, useRef, useState } from '../../react.js';
import { hostHasModels } from './engines/index.js';

export function useHostModels({ stt, enabled }) {
    const on = !!enabled && hostHasModels(stt);
    // `{epoch, items}`: the host's list as of `epoch`, or null until it has
    // answered. Asked again whenever `epoch` moves — after anything that
    // changes it.
    const [answer, setAnswer] = useState(null);
    const [epoch, setEpoch] = useState(0);
    // A model chosen in the menu that is not downloaded yet, so the button
    // offers its download. Null when the menu shows the one in use.
    const [picked, setPicked] = useState(null);
    // The download in progress, `{id, received, total}`, or null.
    const [job, setJob] = useState(null);
    const [note, setNote] = useState(null);
    const [applied, setApplied] = useState(0);
    // Set by Cancel, so the rejection it causes is not shown as a failure.
    const cancelled = useRef(false);
    // Downloads this panel let go of while somebody else's carries on — not
    // followed again just because the list still says `downloading`.
    const declined = useRef(new Set());

    useEffect(() => {
        if (!on) return undefined;
        let live = true;
        const asked = epoch;
        Promise.resolve()
            .then(() => stt.models())
            .then((list) => { if (live) setAnswer({ epoch: asked, items: Array.isArray(list) ? list : [] }); })
            .catch(() => { if (live) setAnswer({ epoch: asked, items: [] }); });
        return () => { live = false; };
    }, [on, stt, epoch]);

    const refresh = () => setEpoch((n) => n + 1);

    // Back into view: whatever another window did meanwhile.
    useEffect(() => {
        if (!on) return undefined;
        const w = typeof window !== 'undefined' ? window : null;
        const d = typeof document !== 'undefined' ? document : null;
        const onFocus = () => refresh();
        const onVisible = () => { if (!d || d.visibilityState !== 'hidden') refresh(); };
        try {
            if (w && w.addEventListener) w.addEventListener('focus', onFocus);
            if (d && d.addEventListener) d.addEventListener('visibilitychange', onVisible);
        } catch (e) { /* no window to watch: asked after actions only */ }
        return () => {
            try {
                if (w && w.removeEventListener) w.removeEventListener('focus', onFocus);
                if (d && d.removeEventListener) d.removeEventListener('visibilitychange', onVisible);
            } catch (e) { /* as above */ }
        };
    }, [on]);

    const items = answer ? answer.items : [];
    const active = items.find((m) => m.active) || null;
    // A pick is only an offer to download: once the model is there — another
    // window fetched it — the menu shows the one in use again, and choosing
    // the pick switches to it.
    const pickedItem = picked ? items.find((m) => m.id === picked) : null;
    const pickedLive = pickedItem && !pickedItem.installed ? picked : null;
    const selectedId = pickedLive || (active ? active.id : (items[0] ? items[0].id : ''));
    const selected = items.find((m) => m.id === selectedId) || null;

    const failed = (e) => setNote((e && e.message) || String(e));

    const switchTo = (id) => Promise.resolve()
        .then(() => stt.setModel(id))
        .then(() => {
            setPicked(null);
            setApplied((n) => n + 1);
            refresh();
        });

    const choose = (id) => {
        setNote(null);
        const m = items.find((x) => x.id === id);
        if (!m) return;
        // Back to the one in use: nothing to switch, only the Download offer
        // to take away.
        if (active && active.id === id) { setPicked(null); return; }
        if (!m.installed) { setPicked(id); return; }
        switchTo(id).catch(failed);
    };

    // Download `m`, or join its download already running; either way, switch
    // to it once it is there, since choosing it is what started it.
    const follow = (m) => {
        declined.current.delete(m.id);
        cancelled.current = false;
        setJob({ id: m.id, received: 0, total: m.sizeBytes || 0 });
        Promise.resolve()
            .then(() => stt.installModel(m.id, (p) => {
                if (p) setJob({ id: m.id, received: Number(p.received) || 0, total: Number(p.total) || m.sizeBytes || 0 });
            }))
            .then(() => {
                setJob(null);
                return switchTo(m.id);
            })
            .catch((e) => {
                setJob(null);
                // Quiet for a cancel — this panel's, or one from elsewhere
                // that ended the download (the host marks it 'cancelled').
                if (!cancelled.current && !(e && e.code === 'cancelled')) failed(e);
                refresh();
            });
    };

    const download = () => {
        const m = selected;
        if (!m || m.installed || job) return;
        setNote(null);
        follow(m);
    };

    // A download the list says is running and this panel is not following.
    const running = items.find((m) => m.downloading && !m.installed) || null;
    const runningId = running && !job && !declined.current.has(running.id) ? running.id : null;
    useEffect(() => {
        if (!on || !runningId) return;
        const m = items.find((x) => x.id === runningId);
        if (m) follow(m);
    }, [on, runningId]);
    // Forget a decline once that download has ended, so the next is followed.
    for (const id of [...declined.current]) {
        if (!items.some((m) => m.id === id && m.downloading)) declined.current.delete(id);
    }

    const cancel = () => {
        if (!job) return;
        cancelled.current = true;
        declined.current.add(job.id);
        try { stt.cancelInstall(job.id); } catch (e) { /* it ends either way */ }
    };

    const remove = () => {
        const m = selected;
        if (!m || !m.installed || m.builtIn) return;
        setNote(null);
        const wasActive = !!m.active;
        Promise.resolve()
            .then(() => stt.removeModel(m.id))
            .then(() => {
                setPicked(null);
                if (wasActive) setApplied((n) => n + 1);
                refresh();
            })
            .catch(failed);
    };

    return {
        on,
        ready: !!answer,
        items,
        selected,
        selectedId,
        job,
        note,
        applied,
        refresh,
        choose,
        download,
        cancel,
        remove,
    };
}
