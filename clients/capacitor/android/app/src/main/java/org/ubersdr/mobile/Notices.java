package org.ubersdr.mobile;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;

/**
 * The page's own notifications, on the phone's notification shade.
 *
 * <p>v2 raises these for the things worth knowing while you are not looking:
 * your callsign in the chat, voice activity on a watched frequency, a rotator
 * finishing, the recorder running out of disk. In a browser they go through the
 * Notification API. Android's WebView does not implement that API at all, so
 * `nativeSupported()` is false in there and every one of them falls back to an
 * in-page toast — which is a notification you can only see if you are already
 * looking at the page, on the one device most likely to be in a pocket.
 *
 * <p>So src/receiver.js provides `window.Notification`, and what the page raises
 * arrives here. The page decides what to say and when; this only puts it where
 * Android puts notifications.
 *
 * <p>Its own channel, separate from the playback one: these alert and can be
 * silenced or given a sound as a group, and the ongoing "playing" notification
 * should be neither.
 */
final class Notices {

    private static final String CHANNEL = "alerts";

    private Notices() {}

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL, "Alerts", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Chat mentions, voice activity and other notices from a receiver");
        manager.createNotificationChannel(channel);
    }

    /**
     * Show one, or replace the one with the same tag.
     *
     * <p>The tag is the page's, and replacing rather than stacking is what it is
     * for — "the same fact again" (see showNative in
     * static/v2/src/lib/nativeNotices.js), which is why this does not alert a
     * second time either. Its hash is the id, so the same tag lands on the same
     * notification without a table to keep.
     */
    static void show(Context context, String tag, String title, String body,
                     boolean ongoing, boolean silent) {
        ensureChannel(context);
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        // Tapping it opens the receiver and tells the page which one was
        // tapped, so whatever the page hung off `onclick` — showing the marker,
        // opening the chat — happens as it would in a browser.
        Intent open = new Intent(context, ReceiverActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(ReceiverActivity.EXTRA_NOTICE_TAG, tag);
        PendingIntent tap = PendingIntent.getActivity(context, tag.hashCode(), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_ubersdr)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setContentIntent(tap)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setSilent(silent)
                // requireInteraction, as far as it means anything here: it keeps
                // the notification until it is dealt with rather than letting
                // the system time it out.
                .setOngoing(ongoing)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT);

        manager.notify(tag, tag.hashCode(), builder.build());
    }

    static void close(Context context, String tag) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(tag, tag.hashCode());
    }
}
