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
        return { supported: false, reason: 'This browser cannot choose an audio output device.' };
    }
    return { supported: true, reason: '' };
}

// Sorted by label, with unlabelled entries last so the readable ones are not
// buried among "Output 3f9a2c…" strings.
function byLabel(a, b) {
    return (a.label || '￿').localeCompare(b.label || '￿');
}

// The device list, plus whether the browser is withholding the names.
//
// Until microphone permission is granted, Chrome returns the outputs with empty
// labels and Firefox returns none at all — in both cases there is nothing worth
// showing, which is what `hidden` reports. Unlocking them costs a permission
// prompt, so that is a separate call the operator asks for.
export async function listOutputDevices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    const outputs = all.filter((d) => d.kind === 'audiooutput').slice().sort(byLabel);
    // 'default' and '' are the browser's own aliases for the system device and
    // carry a label of their own, so they say nothing about the real devices.
    const real = outputs.filter((d) => d.deviceId && d.deviceId !== 'default');
    const hidden = outputs.length === 0 || (real.length > 0 && real.every((d) => !d.label));
    return { devices: outputs, hidden };
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
