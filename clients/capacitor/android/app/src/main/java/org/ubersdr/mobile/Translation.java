package org.ubersdr.mobile;

import android.app.PendingIntent;
import android.content.Context;
import android.icu.util.ULocale;
import android.os.Build;
import android.os.CancellationSignal;
import android.os.SystemClock;
import android.util.Log;
import android.util.SparseArray;
import android.view.translation.TranslationCapability;
import android.view.translation.TranslationContext;
import android.view.translation.TranslationManager;
import android.view.translation.TranslationRequest;
import android.view.translation.TranslationRequestValue;
import android.view.translation.TranslationResponse;
import android.view.translation.TranslationResponseValue;
import android.view.translation.TranslationSpec;
import android.view.translation.Translator;

import androidx.annotation.RequiresApi;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Translating transcribed lines on the device, for v2's Whisper extension in
 * local mode — `window.ubersdrDesktop.translate` (see src/hostspeech.js). The
 * iOS half is OnDeviceTranslation.swift.
 *
 * <p>Android's own on-device translator: {@link TranslationManager}, public
 * since Android 12, no permission, and nothing in the APK — on a Pixel the
 * models belong to Android System Intelligence. The app cannot download a
 * language: the person adds it in that service's settings, which
 * {@link #settingsIntent} opens. Until then the pair is reported as
 * 'downloadable' (or 'downloading'), and the page says where to add it.
 *
 * <p>Measured on a Pixel 8a: the capability list is 552 pairs over 24
 * languages and takes about 400 ms to fetch; downloading a language enables
 * only its pairs with English. Opening a translator takes 2.5-3.6 s the first
 * time after a download and well under half a second after; a line takes
 * 60-180 ms warm, about 2 s for the very first. The page allows four seconds
 * to open and six a line (translate.js LIMITS), so the translator is opened —
 * and warmed with a word — as soon as availability says the pair is there,
 * which the page asks at Start, long before the first line settles.
 *
 * <p>The state belongs to one worker thread, where the service's callbacks
 * are delivered too. Opening a translator and asking it for a line go through
 * a second thread, because they hold the calling thread — opening for seconds
 * — and the page's availability questions, about other pairs, should not wait
 * behind them.
 */
@RequiresApi(Build.VERSION_CODES.S)
final class Translation {

    private static final String TAG = "UberSDR";

    interface Sink {
        void send(String message);
    }

    /**
     * Whether the page should be offered a translator — the `translateHost`
     * flag, decided synchronously at document start. Only the cheap question:
     * the service is there. Which pairs it has is availability()'s answer.
     */
    static boolean offered(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false;
        try {
            return context.getSystemService(TranslationManager.class) != null;
        } catch (RuntimeException e) {
            Log.w(TAG, "could not ask for a translation service", e);
            return false;
        }
    }

    /**
     * The service's page for adding languages, or null. A PendingIntent the
     * system made; it has to be sent from an activity on screen.
     */
    static PendingIntent settingsIntent(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null;
        try {
            TranslationManager tm = context.getSystemService(TranslationManager.class);
            return tm == null ? null : tm.getOnDeviceTranslationSettingsActivityIntent();
        } catch (RuntimeException e) {
            Log.w(TAG, "translation: no settings page", e);
            return null;
        }
    }

    /** A pair's translator: being opened (with lines waiting), or open. */
    private static final class Entry {
        Translator translator;
        boolean opening;
        final List<Runnable> waiting = new ArrayList<>();
    }

    private final Sink sink;
    private final TranslationManager manager;
    private final ExecutorService worker = thread("translation");
    /** For the calls that block: opening, translating. In order. */
    private final ExecutorService caller = thread("translation-calls");
    /**
     * Where the service's callbacks go: the worker, or — once it has shut down
     * — the service's own thread, rather than throwing there. Every callback
     * checks {@link #closed}, and one that brings a translator after close
     * destroys it.
     */
    private final java.util.concurrent.Executor deliver = (r) -> {
        try {
            worker.execute(r);
        } catch (java.util.concurrent.RejectedExecutionException e) {
            r.run();
        }
    };
    /** By pair, "en>de". Worker thread only. */
    private final Map<String, Entry> translators = new HashMap<>();
    private volatile boolean closed;

    Translation(Context context, Sink sink) {
        this.sink = sink;
        this.manager = context.getApplicationContext().getSystemService(TranslationManager.class);
    }

    // ---- from the page -----------------------------------------------------

    /**
     * 'available' — the pair's model is on the phone; 'downloadable' — the
     * service translates it once the person adds the language;
     * 'downloading' — being added; 'unavailable' — not a pair it does.
     *
     * <p>An available pair's translator is opened now, so the first line does
     * not pay for it. The answer does not wait for that.
     */
    void availability(int id, String source, String target) {
        run(() -> {
            TranslationCapability cap = capability(source, target);
            String status = cap == null ? "unavailable" : word(cap.getState());
            replyStatus(id, status);
            if ("available".equals(status)) open(cap, null);
        });
    }

    void translate(int id, String text, String source, String target) {
        run(() -> {
            // An open translator needs no question first; the list costs a
            // couple of hundred milliseconds a line.
            Entry open = translators.get(canonical(source) + ">" + canonical(target));
            if (open != null && open.translator != null && !open.translator.isDestroyed()) {
                line(id, text, open.translator, canonical(source) + ">" + canonical(target));
                return;
            }
            TranslationCapability cap = capability(source, target);
            if (cap == null) {
                replyError(id, "this language pair is not one the phone can translate");
                return;
            }
            if (cap.getState() != TranslationCapability.STATE_ON_DEVICE) {
                replyError(id, missing());
                return;
            }
            open(cap, (translator) -> {
                if (translator == null) {
                    replyError(id, missing());
                    return;
                }
                line(id, text, translator, key(cap));
            });
        });
    }

    private void line(int id, String text, Translator translator, String key) {
        request(translator, text, (out, why) -> {
            if (out != null) {
                replyText(id, out);
                return;
            }
            // Not reused: the next line gets a fresh one.
            forget(key, translator);
            replyError(id, why);
        });
    }

    /** Every translator destroyed, and nothing more said. */
    void close() {
        closed = true;
        try {
            worker.execute(() -> {
                for (Entry e : translators.values()) destroy(e.translator);
                translators.clear();
            });
        } catch (RuntimeException ignored) {
            // Already shut down.
        }
        worker.shutdown();
        caller.shutdown();
    }

    private static ExecutorService thread(String name) {
        return Executors.newSingleThreadExecutor((r) -> {
            Thread t = new Thread(r, name);
            t.setDaemon(true);
            return t;
        });
    }

    // ---- translators -------------------------------------------------------

    private interface Opened {
        void with(Translator translator);
    }

    /**
     * The pair's translator, opening it if need be, then {@code then} with it
     * (or null if the service would not make one). Worker thread.
     */
    private void open(TranslationCapability cap, Opened then) {
        String key = key(cap);
        Entry e = translators.get(key);
        if (e == null) {
            e = new Entry();
            translators.put(key, e);
        }
        final Entry entry = e;
        if (entry.translator != null && !entry.translator.isDestroyed()) {
            if (then != null) then.with(entry.translator);
            return;
        }
        if (then != null) entry.waiting.add(() -> then.with(entry.translator));
        if (entry.opening) return;
        entry.opening = true;
        entry.translator = null;
        long began = SystemClock.elapsedRealtime();
        TranslationContext context = new TranslationContext.Builder(
                new TranslationSpec(cap.getSourceSpec().getLocale(), TranslationSpec.DATA_FORMAT_TEXT),
                new TranslationSpec(cap.getTargetSpec().getLocale(), TranslationSpec.DATA_FORMAT_TEXT)).build();
        Runnable failed = () -> {
            entry.opening = false;
            translators.remove(key);
            List<Runnable> waiting = new ArrayList<>(entry.waiting);
            entry.waiting.clear();
            for (Runnable r : waiting) r.run();
        };
        call(failed, () -> manager.createOnDeviceTranslator(context, deliver, (translator) -> {
                long ms = SystemClock.elapsedRealtime() - began;
                if (closed) {
                    destroy(translator);
                    return;
                }
                entry.opening = false;
                List<Runnable> waiting = new ArrayList<>(entry.waiting);
                entry.waiting.clear();
                if (translator == null) {
                    // The model is not ready after all. Not cached, so the
                    // next question asks the service again.
                    Log.i(TAG, "translation: no translator for " + key + " (" + ms + " ms)");
                    translators.remove(key);
                    for (Runnable r : waiting) r.run();
                    return;
                }
                Log.i(TAG, "translation: opened " + key + " in " + ms + " ms");
                entry.translator = translator;
                for (Runnable r : waiting) r.run();
                // The first line after opening is slow; this is that line, so
                // a real one is not.
                if (waiting.isEmpty()) {
                    long w = SystemClock.elapsedRealtime();
                    request(translator, "Hello.", (out, why) ->
                            Log.i(TAG, "translation: warmed " + key + " in " + (SystemClock.elapsedRealtime() - w) + " ms"));
                }
            }));
    }

    /**
     * A blocking call to the service, made on the caller thread; {@code failed}
     * back on the worker if it throws — a translator destroyed under us, or a
     * service that has gone.
     */
    private void call(Runnable failed, Runnable blocking) {
        try {
            caller.execute(() -> {
                try {
                    blocking.run();
                } catch (RuntimeException e) {
                    Log.w(TAG, "translation: the service refused a call", e);
                    run(failed);
                }
            });
        } catch (RuntimeException e) {
            // Closed.
        }
    }

    private interface Answer {
        void with(String text, String why);
    }

    /** One line, one request: lines come back in order, and a batch is no quicker. */
    private void request(Translator translator, String text, Answer answer) {
        TranslationRequest req = new TranslationRequest.Builder()
                .setTranslationRequestValues(Collections.singletonList(TranslationRequestValue.forText(text)))
                .build();
        call(() -> answer.with(null, "the phone's translator failed"),
                () -> translator.translate(req, new CancellationSignal(), deliver, (TranslationResponse resp) -> {
                if (closed) return;
                String out = null;
                if (resp != null && resp.getTranslationStatus() == TranslationResponse.TRANSLATION_STATUS_SUCCESS) {
                    SparseArray<TranslationResponseValue> values = resp.getTranslationResponseValues();
                    if (values.size() > 0) {
                        TranslationResponseValue v = values.valueAt(0);
                        if (v.getStatusCode() == TranslationResponseValue.STATUS_SUCCESS && v.getText() != null) {
                            out = v.getText().toString();
                        }
                    }
                }
                if (out != null) {
                    answer.with(out, null);
                } else {
                    Log.w(TAG, "translation: failed, status "
                            + (resp == null ? "none" : String.valueOf(resp.getTranslationStatus())));
                    answer.with(null, "the phone's translator failed");
                }
            }));
    }

    private void forget(String key, Translator translator) {
        Entry e = translators.get(key);
        if (e != null && e.translator == translator) translators.remove(key);
        destroy(translator);
    }

    private static void destroy(Translator t) {
        if (t == null) return;
        try {
            if (!t.isDestroyed()) t.destroy();
        } catch (RuntimeException ignored) {
            // Already gone.
        }
    }

    // ---- languages ---------------------------------------------------------

    /**
     * The service's capability for a pair of page tags, or null. Asked afresh
     * each time — a few hundred milliseconds — because what is installed
     * changes while the receiver is open: the person goes to add a language and
     * comes back. Worker thread.
     */
    private TranslationCapability capability(String source, String target) {
        String from = canonical(source);
        String to = canonical(target);
        if (manager == null || from == null || to == null || from.equals(to)) return null;
        Set<TranslationCapability> caps;
        try {
            caps = manager.getOnDeviceTranslationCapabilities(
                    TranslationSpec.DATA_FORMAT_TEXT, TranslationSpec.DATA_FORMAT_TEXT);
        } catch (RuntimeException e) {
            Log.w(TAG, "translation: could not list what the phone translates", e);
            return null;
        }
        if (caps == null) return null;
        for (TranslationCapability c : caps) {
            if (from.equals(canonical(c.getSourceSpec().getLocale()))
                    && to.equals(canonical(c.getTargetSpec().getLocale()))) {
                return c;
            }
        }
        return null;
    }

    private static String word(int state) {
        switch (state) {
            case TranslationCapability.STATE_ON_DEVICE: return "available";
            case TranslationCapability.STATE_AVAILABLE_TO_DOWNLOAD: return "downloadable";
            case TranslationCapability.STATE_DOWNLOADING: return "downloading";
            default: return "unavailable";
        }
    }

    private static String key(TranslationCapability c) {
        return canonical(c.getSourceSpec().getLocale()) + ">" + canonical(c.getTargetSpec().getLocale());
    }

    private static String canonical(ULocale locale) {
        return locale == null ? null : canonical(locale.toLanguageTag());
    }

    /**
     * A language tag reduced to what tells two translation models apart: the
     * language, and for Chinese the script. Applied to the page's tags
     * (translatorTag's, static/v2/src/extensions/whisper/local.js — 'en',
     * 'zh-Hant', 'nb') and to the service's ('no', 'fil', 'zh', 'zh-Hant') alike,
     * and the two matched; the service is then given its own locale back.
     *
     * <p>Traditional Chinese is its own model, named by script or by a region
     * that writes it; anything else Chinese is Simplified. Bokmål and Nynorsk
     * are 'no' to the service; the old codes for Hebrew, Indonesian and
     * Filipino are folded into the new.
     */
    static String canonical(String tag) {
        if (tag == null) return null;
        String t = tag.trim().replace('_', '-').toLowerCase(Locale.ROOT);
        if (t.isEmpty() || t.equals("und")) return null;
        String[] parts = t.split("-");
        String lang = parts[0];
        switch (lang) {
            case "nb": case "nn": return "no";
            case "iw": return "he";
            case "in": return "id";
            case "tl": return "fil";
            case "zh":
                for (int i = 1; i < parts.length; i++) {
                    String p = parts[i];
                    if (p.equals("hant") || p.equals("tw") || p.equals("hk") || p.equals("mo")) return "zh-Hant";
                }
                return "zh";
            default:
                return lang;
        }
    }

    private static String missing() {
        return "the translation languages aren't on this phone yet — add them in Android's settings";
    }

    // ---- to the page -------------------------------------------------------

    private void run(Runnable r) {
        if (closed) return;
        try {
            worker.execute(r);
        } catch (RuntimeException ignored) {
            // Closed meanwhile.
        }
    }

    private void replyStatus(int id, String status) {
        if (closed) return;
        try {
            sink.send("translate-availability:" + new JSONObject().put("id", id).put("status", status));
        } catch (org.json.JSONException ignored) {
            // A number and a string.
        }
    }

    private void replyText(int id, String text) {
        if (closed) return;
        try {
            sink.send("translate-result:" + new JSONObject().put("id", id).put("text", text));
        } catch (org.json.JSONException ignored) {
            // A number and a string.
        }
    }

    private void replyError(int id, String error) {
        if (closed) return;
        try {
            sink.send("translate-result:" + new JSONObject().put("id", id).put("error", error));
        } catch (org.json.JSONException ignored) {
            // A number and a string.
        }
    }
}
