// Listing the audio output devices the browser will let us play to.
//
// Choosing a sink is not one API. Chrome and Edge can point an AudioContext
// straight at a device; Firefox can only do it on an HTMLMediaElement; Safari
// cannot do it at all. This module answers "is it possible here, and what is
// there" — the routing itself lives in radio/audio-player.js.

// Whether a sink can be chosen at all, and if not, why — the panel shows the
// reason rather than a dropdown that would silently do nothing.
export function sinkSupport() {
    const secure = location.protocol === 'https:' ||
        location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!secure) {
        return { supported: false, reason: 'Choosing an output device needs HTTPS — this page is served over plain HTTP.' };
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
        return { supported: false, reason: 'This browser cannot list audio devices.' };
    }
    const onContext = typeof AudioContext !== 'undefined' &&
        typeof AudioContext.prototype.setSinkId === 'function';
    const onElement = typeof HTMLAudioElement !== 'undefined' &&
        typeof HTMLAudioElement.prototype.setSinkId === 'function';
    if (!onContext && !onElement) {
        // Safari, at the time of writing: WebKit implements neither setSinkId, so
        // there is no way to send this page's audio anywhere but wherever the
        // system is sending it. Said with what to do instead, because "cannot"
        // on its own reads as a fault in the receiver.
        //
        // A feature test rather than a browser test, deliberately: the day WebKit
        // ships setSinkId the dropdown appears here on its own, with no release of
        // ours in between.
        return {
            supported: false,
            reason: 'This browser cannot route audio to a chosen device — pick the output in the system’s sound settings instead.',
        };
    }
    return { supported: true, reason: '' };
}

// Sorted by label, with unlabelled entries last so the readable ones are not
// buried among "Output 3f9a2c…" strings.
function byLabel(a, b) {
    return (a.label || '￿').localeCompare(b.label || '￿');
}

// Is the browser withholding the devices, given what enumerateDevices returned?
//
// Both hold them back until microphone permission is granted, and they do it in
// shapes different enough that testing for one misses the other:
//
//   Firefox returns no audiooutput entries at all.
//   Chrome returns one, as the spec's "at least one device of each kind you have"
//     placeholder — kind 'audiooutput' with an empty deviceId, label and groupId.
//
// The test used to be "some real device, and none of them named", which reads the
// Chrome case as a machine that has one output and nothing to unlock: the
// placeholder has no deviceId, so it is not a real device, so there was nothing
// for `every` to be true of. `hidden` came back false, the panel never asked for
// the microphone, and Refresh on Chrome did nothing at all — no prompt, no
// devices, no explanation.
//
// So the question is asked the other way round, in terms of what would actually
// be worth showing: is there a single output with an id we can point the audio at
// and a name to put in the list. On both browsers, before permission, there is
// not.
export function namesHidden(outputs) {
    // 'default' and '' are the browser's own aliases for the system device, which
    // the panel offers as an option of its own — so neither says anything about
    // what real devices exist.
    return !outputs.some((d) => d && d.deviceId && d.deviceId !== 'default' && d.label);
}

// The device list, plus whether the browser is withholding the names. Unlocking
// them costs a permission prompt, so that is a separate call the operator asks
// for — see unlockDeviceLabels.
export async function listOutputDevices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    const outputs = all.filter((d) => d.kind === 'audiooutput').slice().sort(byLabel);
    return { devices: outputs, hidden: namesHidden(outputs) };
}

// Has the microphone question already been answered? 'granted', 'denied' or
// 'prompt', and null where the browser will not say — Firefox does not accept
// 'microphone' as a permission name and throws, which is not an error worth
// reporting anywhere.
//
// Only used to tell two identical-looking dead ends apart: names still missing
// because nobody has been asked, and names still missing with permission in hand,
// which means this machine really does have nothing else to offer.
export async function micPermission() {
    try {
        const status = await navigator.permissions.query({ name: 'microphone' });
        return status.state;
    } catch (e) {
        return null;
    }
}

// Asks for the microphone purely to unlock the device names, then drops the
// stream immediately — nothing is recorded and nothing is sent anywhere.
export async function unlockDeviceLabels() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
}

export function sinkLabel(dev) {
    if (dev.label) return dev.label;
    if (!dev.deviceId || dev.deviceId === 'default') return 'System Default';
    return `Output ${dev.deviceId.slice(0, 8)}…`;
}
