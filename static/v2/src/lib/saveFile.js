// Handing a file to whatever is running this page.
//
// A browser has one answer: an anchor with a `download` attribute, pointed at a
// blob URL, clicked from script. It is the only route there has ever been and
// it works in every desktop browser and in Electron, which is a browser.
//
// It does nothing at all in an app. A WKWebView ignores the `download`
// attribute outright — the click lands, no file appears, no error is raised —
// and Android's WebView only hands a download to its DownloadListener when the
// URL is http or https, which a blob is not. So every export in this interface
// — the recorder's ZIP, the decoders' logs and images, the bookmark and control
// exports — silently did nothing on a phone, which is worse than a button that
// says it cannot.
//
// The way out is that both apps already run an HTTP server in front of this
// page, so the page can simply POST the bytes to its own origin and let the
// host put them where that platform puts files: the share sheet on iOS, the
// Downloads folder on Android. The client installs `window.ubersdrSaveFile`
// when it can do that (see clients/capacitor/src/receiver.js); everything here
// does is prefer it when it is there.
//
// Not a check for "is this an app". A host that can save is not the same
// question as which host it is — Electron is an app and wants the anchor,
// because Chromium's download machinery is right there and already points at
// the user's Downloads folder with their own prompt in front of it.

/**
 * Save `blob` as `filename`, by whatever route this host has.
 *
 * Resolves when the file has been handed over — which on a phone means the
 * bytes have reached the app, not that the person has finished choosing where
 * to put them. Rejects if the host tried and failed, so a caller can show it;
 * the anchor route cannot fail loudly and does not.
 */
export async function saveFile(blob, filename) {
    const host = typeof window !== 'undefined' ? window.ubersdrSaveFile : null;
    if (typeof host === 'function') {
        await host(blob, filename);
        return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    // Revoked late rather than immediately: some browsers cancel a download
    // whose URL is revoked before they have finished reading it.
    setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
    }, 10000);
}

/** The same, for text that is being written as a file. */
export function saveText(text, filename, type = 'text/plain') {
    return saveFile(new Blob([text], { type }), filename);
}
