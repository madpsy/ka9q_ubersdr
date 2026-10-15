package org.ubersdr.mobile;

import android.util.Log;

import com.google.mlkit.common.model.DownloadConditions;
import com.google.mlkit.common.model.RemoteModelManager;
import com.google.mlkit.nl.translate.TranslateLanguage;
import com.google.mlkit.nl.translate.TranslateRemoteModel;
import com.google.mlkit.nl.translate.Translator;
import com.google.mlkit.nl.translate.TranslatorOptions;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Translating transcribed lines on the device, for v2's Whisper extension in
 * local mode — `window.ubersdrDesktop.translate` (see src/hostspeech.js). The
 * iOS half is OnDeviceTranslation.swift.
 *
 * <p>Google's ML Kit, which translates on the device once a language's model
 * is there, and fetches models by itself without showing anything — which is
 * the contract the page wants: never an interface, never a prompt. The text
 * never leaves the phone; only the models come down.
 *
 * <p>Models are about 30 MB a language, so they are fetched over Wi-Fi only,
 * and only once somebody is actually translating — the first line asked for
 * starts the download, not a question about availability. Until it has
 * finished the pair is reported as 'downloadable', which is the truth, and a
 * line asked for meanwhile fails with a sentence saying so: the page shows it
 * as spoken, with that sentence beside it, and takes the note down by itself
 * when lines start to translate (translate.js createLineTranslator).
 *
 * <p>The library is in the build only when it is asked for — see the
 * dependency in android/app/build.gradle for why — so nothing outside this
 * file may name an ML Kit class, and ReceiverActivity checks that the classes
 * are there, by name, before it makes one of these (translationPackaged).
 *
 * <p>Main thread only. ML Kit's tasks answer there by default, and the work —
 * the download and the translating — is done on its own threads.
 */
final class Translation {

    private static final String TAG = "UberSDR";

    interface Sink {
        void send(String message);
    }

    private final Sink sink;
    /** Translators by pair, kept because opening one loads two models. */
    private final Map<String, Translator> translators = new HashMap<>();
    /** Pairs with a download running, so a line each does not start another. */
    private final Set<String> downloading = new HashSet<>();
    private boolean closed;

    Translation(Sink sink) {
        this.sink = sink;
    }

    /**
     * 'available' — both models are on the phone and it translates now;
     * 'downloadable' — ML Kit translates the pair but a model has still to be
     * fetched (or is being fetched); 'unavailable' — not a pair ML Kit does.
     */
    void availability(int id, String source, String target) {
        String from = language(source);
        String to = language(target);
        if (from == null || to == null || from.equals(to)) {
            replyStatus(id, "unavailable");
            return;
        }
        downloaded(from, to, (have) -> replyStatus(id, have ? "available" : "downloadable"));
    }

    void translate(int id, String text, String source, String target) {
        String from = language(source);
        String to = language(target);
        if (from == null || to == null || from.equals(to)) {
            replyError(id, "this language pair is not one the phone can translate");
            return;
        }
        downloaded(from, to, (have) -> {
            if (closed) return;
            String key = from + ">" + to;
            Translator translator = translators.get(key);
            if (translator == null) {
                translator = com.google.mlkit.nl.translate.Translation.getClient(new TranslatorOptions.Builder()
                        .setSourceLanguage(from)
                        .setTargetLanguage(to)
                        .build());
                translators.put(key, translator);
            }
            if (!have) {
                fetch(key, translator);
                replyError(id, "the translation models aren't on this phone yet — they download by themselves "
                        + "over Wi-Fi, about 30 MB a language, and lines are shown as spoken until then");
                return;
            }
            final Translator using = translator;
            translator.translate(text)
                    .addOnSuccessListener((out) -> replyText(id, out == null ? "" : out))
                    .addOnFailureListener((e) -> {
                        Log.w(TAG, "translation failed", e);
                        // Not reused: a translator that has failed may have
                        // lost its models, and the next line should get a
                        // fresh one.
                        if (translators.get(key) == using) {
                            translators.remove(key);
                            using.close();
                        }
                        String why = e.getMessage();
                        replyError(id, why == null || why.isEmpty() ? "the translator failed" : why);
                    });
        });
    }

    /** Every translator closed, and nothing more said. */
    void close() {
        closed = true;
        for (Translator t : translators.values()) {
            try {
                t.close();
            } catch (RuntimeException ignored) {
                // Already closed.
            }
        }
        translators.clear();
    }

    /**
     * Start fetching a pair's models, once. Wi-Fi only: on mobile data the
     * download waits for Wi-Fi rather than spending somebody's allowance on a
     * feature they may not have known needed one.
     */
    private void fetch(String key, Translator translator) {
        if (!downloading.add(key)) return;
        Log.i(TAG, "translation: fetching the models for " + key + " (Wi-Fi only)");
        translator.downloadModelIfNeeded(new DownloadConditions.Builder().requireWifi().build())
                .addOnSuccessListener((ok) -> {
                    downloading.remove(key);
                    Log.i(TAG, "translation: the models for " + key + " are here");
                })
                .addOnFailureListener((e) -> {
                    // Asked again by the next line.
                    downloading.remove(key);
                    Log.w(TAG, "translation: the models for " + key + " did not download", e);
                });
    }

    private interface Have {
        void answer(boolean downloaded);
    }

    /** Whether both languages' models are on the phone. */
    private static void downloaded(String from, String to, Have done) {
        RemoteModelManager.getInstance().getDownloadedModels(TranslateRemoteModel.class)
                .addOnSuccessListener((models) -> {
                    Set<String> have = new HashSet<>();
                    for (TranslateRemoteModel m : models) have.add(m.getLanguage());
                    // English is the language every model translates through,
                    // and ML Kit keeps it on the phone.
                    have.add(TranslateLanguage.ENGLISH);
                    done.answer(have.contains(from) && have.contains(to));
                })
                .addOnFailureListener((e) -> {
                    Log.w(TAG, "translation: could not list the downloaded models", e);
                    done.answer(false);
                });
    }

    /**
     * A page tag ('en', 'de', 'zh-Hant', 'nb') as ML Kit's language code, or
     * null for one it does not translate.
     *
     * <p>The page's tags are translatorTag's (static/v2/src/extensions/whisper/
     * local.js): a bare language, except Traditional Chinese, which is its own
     * model there and is not in ML Kit at all — ML Kit's Chinese is Simplified,
     * and writing Traditional readers' lines in Simplified is not what they
     * asked for. A few names differ between the two: Bokmål is 'no' to ML Kit,
     * Filipino 'tl' and Hebrew 'he'.
     */
    static String language(String tag) {
        if (tag == null) return null;
        String t = tag.trim().replace('_', '-').toLowerCase(Locale.ROOT);
        if (t.isEmpty() || t.startsWith("zh-hant") || t.equals("zh-tw") || t.equals("zh-hk")) return null;
        String primary = t.contains("-") ? t.substring(0, t.indexOf('-')) : t;
        switch (primary) {
            case "nb": case "nn": primary = "no"; break;
            case "fil": primary = "tl"; break;
            case "iw": primary = "he"; break;
            default: break;
        }
        return TranslateLanguage.fromLanguageTag(primary);
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
