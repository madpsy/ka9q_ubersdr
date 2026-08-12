package org.ubersdr.mobile;

import android.content.Context;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.Voice;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Spoken announcements, which the WebView cannot do at all.
 *
 * <p>v2 speaks the frequency, the mode and a looked-up callsign through the Web
 * Speech API (static/v2/src/lib/announce.js). Android's WebView implements none
 * of it — `speechSynthesis` is simply absent, so `speechAvailable()` is false
 * and the Announcements panel correctly reports the feature as unavailable
 * while saying nothing. The desktop client had the same shape of problem for a
 * different reason and solved it the same way: Electron ships no voices, so it
 * switches on speech-dispatcher and uses the system's.
 *
 * <p>Here the system's voices are Android's. This wraps TextToSpeech and
 * src/receiver.js presents it to the page as the API it expects, so the panel,
 * the voice picker and the announcements all work unchanged.
 *
 * <p>Two things about TTS shape the design. It initialises asynchronously, so
 * there is a window where the page has asked for voices and there are none —
 * which is exactly what `voiceschanged` is for in a browser, and what this fires
 * when the engine reports itself ready. And its voice names are identifiers
 * rather than labels ("en-gb-x-gbb#female_1"), so they are given readable ones;
 * see nameFor.
 */
final class Speech {

    private static final String TAG = "UberSDR";
    /** Google's engine, whose voices are the ones v2's preference chain names. */
    private static final String GOOGLE_ENGINE = "com.google.android.tts";

    interface Ready {
        void onReady(String voicesJson);
    }

    private final TextToSpeech tts;
    private final List<Voice> voices = new ArrayList<>();
    private boolean ready;

    Speech(Context context, Ready callback) {
        tts = new TextToSpeech(context, (status) -> {
            if (status != TextToSpeech.SUCCESS) {
                Log.w(TAG, "no text-to-speech engine: announcements will be unavailable");
                return;
            }
            ready = true;
            collect();
            if (callback != null) callback.onReady(voicesJson());
        });
    }

    private void collect() {
        voices.clear();
        try {
            Set<Voice> all = tts.getVoices();
            if (all == null) return;
            for (Voice v : all) {
                // English only, as usableVoices does in the page: the
                // announcements are English text, and a Spanish voice reading
                // "fourteen point zero seven four megahertz" is not a choice
                // anybody wants offered.
                String lang = v.getLocale() == null ? "" : v.getLocale().getLanguage();
                if (!"en".equalsIgnoreCase(lang)) continue;
                // Installed voices only. A network voice with no network is a
                // pick that produces silence, which is the one failure mode
                // announce.js works hardest to avoid.
                if (v.isNetworkConnectionRequired()) continue;
                if (v.getFeatures() != null
                        && v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) {
                    continue;
                }
                voices.add(v);
            }
        } catch (Exception e) {
            // Some engines throw rather than answering; the panel then says
            // there are no voices, which is true of this device.
            Log.w(TAG, "could not list voices", e);
        }
    }

    /**
     * A readable name for a voice whose own is an identifier.
     *
     * <p>Prefixed with the engine's brand when it is Google's, because that is
     * both true and what v2's preference chain looks for — it ranks a voice
     * carrying a brand above an unbranded system one (pickVoice in
     * lib/announce.js), having been written against desktop Chrome where the
     * good voices are the Google ones. The same voices are the good ones here.
     */
    private String nameFor(Voice v, boolean google) {
        Locale locale = v.getLocale();
        String place = locale == null ? "English" : locale.getDisplayName(Locale.ENGLISH);
        String id = v.getName() == null ? "" : v.getName();
        // "en-gb-x-gbb#female_1" -> "female 1"
        String variant = id.contains("#") ? id.substring(id.indexOf('#') + 1).replace('_', ' ') : "";
        String label = variant.isEmpty() ? place : place + " " + variant;
        return google ? "Google " + label : label;
    }

    /** The voice list as the page's getVoices() shape. */
    String voicesJson() {
        boolean google = false;
        try {
            google = GOOGLE_ENGINE.equals(tts.getDefaultEngine());
        } catch (Exception ignored) {
            // An engine that will not name itself is treated as unbranded.
        }
        JSONArray out = new JSONArray();
        for (Voice v : voices) {
            JSONObject o = new JSONObject();
            try {
                o.put("name", nameFor(v, google));
                o.put("lang", v.getLocale() == null ? "en" : v.getLocale().toLanguageTag());
                o.put("id", v.getName());
                o.put("localService", true);
                o.put("default", false);
                out.put(o);
            } catch (JSONException e) {
                Log.w(TAG, "voice " + v.getName() + " could not be described", e);
            }
        }
        return out.toString();
    }

    /**
     * Say something, in the voice the page chose.
     *
     * <p>`voiceId` is the engine's own name, which the page carries back from
     * the list above — matching on the readable label would break the moment two
     * engines produced the same one.
     */
    void speak(String text, String voiceId, float rate, float volume) {
        if (!ready || text == null || text.isEmpty()) return;
        if (voiceId != null && !voiceId.isEmpty()) {
            for (Voice v : voices) {
                if (voiceId.equals(v.getName())) {
                    tts.setVoice(v);
                    break;
                }
            }
        }
        tts.setSpeechRate(rate > 0 ? rate : 1f);
        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume > 0 ? volume : 1f);
        // Flushing, not queueing: v2 cancels before it speaks, because an
        // announcement about a frequency you have already left is worse than
        // none. QUEUE_FLUSH is that cancel.
        tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, "ubersdr");
    }

    void stop() {
        if (ready) tts.stop();
    }

    void release() {
        try {
            tts.stop();
            tts.shutdown();
        } catch (Exception ignored) {
            // Shutting down an engine that never started.
        }
    }
}
