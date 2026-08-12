package org.ubersdr.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The per-receiver bypass password.
 *
 * <p>Some receivers have one — handed out by the operator to get past a full
 * house or a ban. In a browser it is typed into v2's start overlay and
 * forgotten when the tab closes (it lives in sessionStorage: see
 * static/v2/src/radio/session.js). The saved list exists so that things are not
 * typed twice, so here it is kept, sealed with a key that never leaves the
 * Android keystore.
 *
 * <p>Two things differ from the desktop client, both in the same direction.
 * There the sealed string sits on the instance's entry in instances.json and
 * the store can read it back; here the value lives only in this class, keyed by
 * instance id, and the JavaScript half of the app has no call that returns one
 * — it can set one, clear one, and ask whether one is set. The receiver
 * Activity reads it directly when it opens a page, so a password the chooser
 * must not hold never travels through it.
 *
 * <p>The stored string is tagged the way the desktop client tags its own, and
 * for the same reason: a value that cannot be opened must read as no password
 * rather than as garbage. {@code enc:} is keystore-sealed; {@code plain:} is
 * the fallback for a device whose keystore refuses to produce a key, where
 * refusing to store it would mean a feature that silently does not work.
 */
final class Secrets {

    private static final String TAG = "UberSDR";
    private static final String FILE = "ubersdr-secrets";
    private static final String KEY_ALIAS = "ubersdr.secrets.v1";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final int GCM_TAG_BITS = 128;
    private static final int IV_BYTES = 12;

    private final SharedPreferences prefs;

    Secrets(Context context) {
        this.prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    boolean has(String id) {
        return prefs.contains(id);
    }

    /** Set it, or clear it with null or an empty string. */
    void set(String id, String value) {
        if (value == null || value.isEmpty()) {
            clear(id);
            return;
        }
        prefs.edit().putString(id, seal(value)).apply();
    }

    void clear(String id) {
        prefs.edit().remove(id).apply();
    }

    /** The password, or an empty string. Native callers only. */
    String get(String id) {
        return open(prefs.getString(id, null));
    }

    private String seal(String value) {
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] sealed = cipher.doFinal(value.getBytes("UTF-8"));
            byte[] joined = new byte[iv.length + sealed.length];
            System.arraycopy(iv, 0, joined, 0, iv.length);
            System.arraycopy(sealed, 0, joined, iv.length, sealed.length);
            return "enc:" + Base64.encodeToString(joined, Base64.NO_WRAP);
        } catch (Exception e) {
            Log.w(TAG, "keystore unavailable, storing the password unsealed", e);
            return "plain:" + value;
        }
    }

    private String open(String stored) {
        if (stored == null) return "";
        if (stored.startsWith("plain:")) return stored.substring(6);
        if (!stored.startsWith("enc:")) return "";
        try {
            byte[] joined = Base64.decode(stored.substring(4), Base64.NO_WRAP);
            if (joined.length <= IV_BYTES) return "";
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(GCM_TAG_BITS, joined, 0, IV_BYTES));
            byte[] plain = cipher.doFinal(joined, IV_BYTES, joined.length - IV_BYTES);
            return new String(plain, "UTF-8");
        } catch (Exception e) {
            // A key that has been invalidated — the screen lock removed, or the
            // app restored onto another device. The password is gone, which is
            // a password to type again rather than an error to show.
            Log.w(TAG, "stored password could not be opened", e);
            return "";
        }
    }

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        gen.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                // Not tied to the lock screen: the app has to be able to open a
                // receiver on a device with no lock set, and a password prompt
                // to reach a password is not what this is for.
                .setUserAuthenticationRequired(false)
                .build());
        return gen.generateKey();
    }
}
