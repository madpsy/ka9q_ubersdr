// What the receiver remembers between visits.
//
// One key, and the writes **merge**. That is the whole point of this file
// existing rather than two lines inside RadioContext.
//
// The save used to replace the stored object outright, which is fine as long as
// every caller passes every field every time. The spectrum view broke that: it
// is only known once the server has said what it is, so the settings effect
// spread it in conditionally — and the first write of the session, which
// happens on mount before the spectrum has connected, therefore wrote the whole
// settings blob *without* it and erased the view the page was about to resume.
//
// A merge makes that class of bug impossible: a field nobody mentioned keeps
// the value it had. The cost is that a key can never be removed by writing
// around it, which is worth it — nothing removes keys, and the failure mode of
// the alternative is silent data loss.

const KEY = 'ubersdr.v2.radio';

export function loadRadioSettings() {
    try {
        const raw = JSON.parse(localStorage.getItem(KEY));
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (e) {
        return {};
    }
}

/** Merge `patch` into what is stored. Anything not mentioned is left alone. */
export function saveRadioSettings(patch) {
    try {
        localStorage.setItem(KEY, JSON.stringify({ ...loadRadioSettings(), ...patch }));
    } catch (e) {
        // Private mode, or the quota. Nothing here is worth failing a render
        // for — but see the Backup panel, which reports a refused write rather
        // than swallowing it, because that is where losing settings matters.
    }
}
