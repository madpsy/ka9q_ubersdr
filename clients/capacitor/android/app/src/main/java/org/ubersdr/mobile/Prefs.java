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

    /** Where a receiver's own snapshot lives, when settings are not shared. */
    private static final String PER_RECEIVER = "prefs:";
    /** Keys the chooser's settings page may read and write. See readOne. */
    private static final java.util.Set<String> APP_LEVEL =
            java.util.Collections.singleton("ubersdr.v2.shell");

    private final SharedPreferences store;
    /** Which entry this receiver reads and writes — see {@link #keyFor}. */
    private final String key;

    Prefs(Context context, String scope, String instanceId) {
        this.store = context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
        this.key = keyFor(scope, instanceId);
    }

    /**
     * One entry for everybody, or one per receiver — the operator's choice,
     * made in the chooser's settings and carried in with the receiver.
     *
     * <p>Shared is the default and what most people want: arranging the panels
     * once and finding them arranged on the next receiver is the whole reason
     * these settings are the app's rather than the page's. Per receiver is for
     * somebody who uses two very differently — a wideband monitor and an HF
     * station — and wants each to keep its own shape.
     *
     * <p>The two stores never merge and neither is converted into the other:
     * switching scope shows what that scope last held, which is one sentence to
     * explain and is reversible.
     */
    private static String keyFor(String scope, String instanceId) {
        if (!"receiver".equals(scope) || instanceId == null || instanceId.isEmpty()) return KEY;
        return PER_RECEIVER + instanceId;
    }

    /**
     * Throw away every stored snapshot, both scopes.
     *
     * <p>Both, deliberately: "reset settings" is pressed by somebody who wants
     * the interface as it came out of the box, and leaving the other scope's
     * copy behind would hand it back the moment they changed the switch — a
     * reset that did not reset, discovered later.
     */
    static void resetAll(Context context) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().clear().apply();
    }

    /**
     * One setting, read and written from outside a receiver.
     *
     * <p>For the chooser's settings page, which is a different page in a
     * different origin and has no localStorage in common with the receivers.
     * Only whitelisted keys: the snapshot is the page's own store and this app
     * treats it as opaque everywhere else, so the two keys it *does* understand
     * are named rather than left to a caller to choose.
     *
     * <p>Always the shared entry, even when receivers are keeping their
     * settings apart. A setting offered in the app's own settings page is an
     * app-wide answer by definition — so the per-receiver copies of that one
     * key are cleared, or a choice made here would appear to do nothing on
     * every receiver that had ever been arranged by hand.
     */
    static String readOne(Context context, String key) {
        if (!APP_LEVEL.contains(key)) return null;
        SharedPreferences store = context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
        try {
            String saved = store.getString(KEY, null);
            if (saved == null) return null;
            JSONObject snapshot = new JSONObject(saved);
            return snapshot.has(key) ? snapshot.optString(key, null) : null;
        } catch (JSONException e) {
            return null;
        }
    }

    static void writeOne(Context context, String key, String value) {
        if (!APP_LEVEL.contains(key)) return;
        SharedPreferences store = context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
        SharedPreferences.Editor edit = store.edit();
        for (String entry : store.getAll().keySet()) {
            if (!KEY.equals(entry) && !entry.startsWith(PER_RECEIVER)) continue;
            try {
                String saved = store.getString(entry, null);
                JSONObject snapshot = saved == null ? new JSONObject() : new JSONObject(saved);
                // The shared entry gets the value; a receiver's own copy loses
                // the key, so it falls back to this one.
                if (KEY.equals(entry)) snapshot.put(key, value);
                else snapshot.remove(key);
                edit.putString(entry, snapshot.toString());
            } catch (JSONException e) {
                Log.w(TAG, "could not set " + key + " in " + entry, e);
            }
        }
        if (store.getString(KEY, null) == null) {
            try {
                edit.putString(KEY, new JSONObject().put(key, value).toString());
            } catch (JSONException e) {
                Log.w(TAG, "could not create the shared snapshot", e);
            }
        }
        edit.apply();
    }

    /** The snapshot as JSON text, or "null" when nothing has been kept yet. */
    String snapshot() {
        String saved = store.getString(key, null);
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
        store.edit().putString(key, clean.toString()).apply();
    }

    private static boolean shared(String key) {
        return key != null
                && key.startsWith(PREFIX)
                && !key.startsWith(SKIP_PREFIX)
                && !SKIP_RADIO.equals(key)
                && !SKIP_PASSWORD.equals(key);
    }
}
