package org.ubersdr.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Iterator;

/**
 * One arrangement of the interface, on every receiver.
 *
 * <p>A port of clients/electron/prefs.js, and the same reasoning. Each instance
 * has its own loopback port, which makes it its own origin, which gives it its
 * own localStorage — so without this every receiver would open at the defaults.
 * That isolation is a property of how the proxy works rather than anything
 * anybody asked for: somebody who has spent an evening arranging panels means it
 * for their client, not for one receiver, and finding the next receiver back at
 * the defaults reads as the settings having been lost.
 *
 * <p>Always on, with no switch, as on the desktop. There was one sensible answer
 * and a control offering the other.
 *
 * <p>What is deliberately never shared is where the judgement is, and it is the
 * same list the desktop client keeps:
 *
 * <ul>
 *   <li>{@code ubersdr.v2.radio} — frequency, mode, filter edges, spectrum view,
 *       squelch and volume. Carrying a frequency across would tune a receiver to
 *       a band it may not cover, and a squelch set against one receiver's noise
 *       floor can gate another's audio to silence, which reads as a broken
 *       receiver rather than as a setting.
 *   <li>the news panel's article cache, which is bulk rather than settings.
 *   <li>anything outside the {@code ubersdr.v2.} prefix. That is what keeps the
 *       rotator and antenna-switch passwords per receiver: they are stored under
 *       v1's keys ({@code rotctl_password}, {@code ant_switch_password}) so that
 *       a password typed into /rotator.html still works in v2, and a credential
 *       for one operator's hardware must never be handed to another's.
 *   <li>{@code ubersdr.v2.password}, the session bypass. It lives in
 *       sessionStorage and so cannot reach here anyway; named because "this key
 *       is deliberately not shared" is a decision, not an accident of where a
 *       value happens to sit today.
 * </ul>
 *
 * <p>The filter is applied here as well as in the page (src/receiver.js) for the
 * reason the desktop client gives: the sender is a WebView showing a remote
 * instance's own code, so what it reports is checked rather than trusted.
 */
final class Prefs {

    private static final String TAG = "UberSDR";
    private static final String FILE = "ubersdr-shared-prefs";
    private static final String KEY = "prefs";

    private static final String PREFIX = "ubersdr.v2.";
    private static final String SKIP_PREFIX = "ubersdr.v2.news.cache.";
    private static final String SKIP_RADIO = "ubersdr.v2.radio";
    private static final String SKIP_PASSWORD = "ubersdr.v2.password";

    private final SharedPreferences store;

    Prefs(Context context) {
        this.store = context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /** The snapshot as JSON text, or "null" when nothing has been kept yet. */
    String snapshot() {
        String saved = store.getString(KEY, null);
        return saved == null ? "null" : saved;
    }

    /** Replaces the snapshot with what a receiver reported, filtered. */
    void update(JSONObject reported) {
        if (reported == null) return;
        JSONObject clean = new JSONObject();
        for (Iterator<String> keys = reported.keys(); keys.hasNext(); ) {
            String key = keys.next();
            if (!shared(key)) continue;
            String value = reported.optString(key, null);
            if (value == null) continue;
            try {
                clean.put(key, value);
            } catch (JSONException e) {
                Log.w(TAG, "shared setting " + key + " could not be kept", e);
            }
        }
        store.edit().putString(KEY, clean.toString()).apply();
    }

    private static boolean shared(String key) {
        return key != null
                && key.startsWith(PREFIX)
                && !key.startsWith(SKIP_PREFIX)
                && !SKIP_RADIO.equals(key)
                && !SKIP_PASSWORD.equals(key);
    }
}
