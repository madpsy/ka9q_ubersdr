package org.ubersdr.mobile;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Where a file the page saved actually goes.
 *
 * The Downloads folder, which is the answer a phone expects: it is what the
 * browser's own downloads do, it survives the app being uninstalled, and it is
 * reachable from Files, from a USB cable and from every share sheet on the
 * device. The app's own storage would be none of those things — a recording
 * nobody can get at is not a saved recording.
 *
 * Two ways in, because the API changed under a rule this app still supports.
 * On Android 10 and later a download is a row in MediaStore and needs no
 * permission at all; before that it is a plain file in the public Downloads
 * directory, which needs WRITE_EXTERNAL_STORAGE and is why the manifest asks
 * for it up to API 28 and not beyond.
 */
final class Downloads {

    private static final String TAG = "UberSDR";

    private Downloads() { }

    /**
     * Copies `body` into Downloads under `name`, and returns the name it ended
     * up with — which may differ, because both routes below avoid overwriting
     * whatever is already there.
     */
    static String save(Context context, String name, String mime, InputStream body) throws IOException {
        String type = (mime == null || mime.isEmpty()) ? guessMime(name) : mime;
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? saveViaMediaStore(context, name, type, body)
                : saveToPublicDir(name, body);
    }

    /**
     * Android 10+: hand it to MediaStore and let it place the file.
     *
     * IS_PENDING while it is being written, so nothing else sees a half-copied
     * recording, and cleared at the end — a row left pending is invisible and
     * eventually swept away, which is exactly what a failed copy should be.
     */
    private static String saveViaMediaStore(Context context, String name, String mime, InputStream body)
            throws IOException {
        ContentResolver resolver = context.getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, name);
        values.put(MediaStore.Downloads.MIME_TYPE, mime);
        values.put(MediaStore.Downloads.IS_PENDING, 1);

        Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        Uri item = resolver.insert(collection, values);
        if (item == null) throw new IOException("the Downloads folder refused the file");

        try (OutputStream out = resolver.openOutputStream(item)) {
            if (out == null) throw new IOException("could not open the file for writing");
            copy(body, out);
        } catch (IOException e) {
            resolver.delete(item, null, null);
            throw e;
        }

        values.clear();
        values.put(MediaStore.Downloads.IS_PENDING, 0);
        resolver.update(item, values, null, null);
        return name;
    }

    /** Android 9 and earlier: a real file, in the real folder. */
    private static String saveToPublicDir(String name, InputStream body) throws IOException {
        File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("no Downloads folder");

        File file = new File(dir, name);
        // Rather than overwrite: a second recording saved a minute after the
        // first has the same name only because the page had no reason to think
        // about it, and losing the first is not what anybody meant.
        int n = 1;
        String stem = name;
        String ext = "";
        int dot = name.lastIndexOf('.');
        if (dot > 0) { stem = name.substring(0, dot); ext = name.substring(dot); }
        while (file.exists() && n < 1000) file = new File(dir, stem + "-" + (n++) + ext);

        try (OutputStream out = new FileOutputStream(file)) {
            copy(body, out);
        }
        return file.getName();
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[64 * 1024];
        int n;
        while ((n = in.read(buffer)) > 0) out.write(buffer, 0, n);
        out.flush();
    }

    /**
     * A type from the extension, for the case where the page did not say.
     *
     * It matters more than it looks: MediaStore files a download by its MIME
     * type, so an `application/octet-stream` zip lands somewhere less obvious
     * than a `application/zip` one and opens with nothing when tapped.
     */
    private static String guessMime(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) return "application/octet-stream";
        String ext = name.substring(dot + 1).toLowerCase();
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (mime != null) return mime;
        if (ext.equals("zip")) return "application/zip";
        Log.d(TAG, "no MIME type known for ." + ext);
        return "application/octet-stream";
    }
}
