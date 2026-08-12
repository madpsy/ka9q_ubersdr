package org.ubersdr.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.IBinder;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import android.support.v4.media.MediaMetadataCompat;

import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;

/**
 * Keeps a receiver playing while the phone is asleep.
 *
 * <p>Without this, listening ends the moment the screen locks. The Activity
 * stops being visible, its process becomes cacheable, and Android freezes it —
 * audio, spectrum and the session with it. A foreground service is the only
 * thing that says "this app is doing something the user asked for", and the
 * media type is the honest one: it is playing audio.
 *
 * <p>It is also what puts the receiver on the lock screen. A WebView does not
 * surface the page's own `navigator.mediaSession` the way Chrome does, so
 * although v2 sets artwork and metadata for the browser, none of it reaches the
 * notification shade here. The page tells the host what it is doing over the
 * page API (src/receiver.js), the Activity passes it on, and this turns it into
 * a MediaSessionCompat — so the two say the same thing without the page having
 * been changed to know about Android.
 *
 * <p>The transport controls are the page's own handlers, and only the ones it
 * registered: next and previous step the dial or hop bookmarks depending on the
 * operator's setting, and play/pause is v2's mute, because there is no pausing
 * a live receiver. The one control this adds is Stop, which leaves the receiver
 * — with the screen off, the notification is the only handle on the app.
 */
public class PlaybackService extends Service {

    private static final String CHANNEL = "receiver";
    private static final int NOTIFICATION = 1;

    static final String ACTION_START = "org.ubersdr.mobile.START";
    static final String ACTION_UPDATE = "org.ubersdr.mobile.UPDATE";
    static final String ACTION_STOP = "org.ubersdr.mobile.STOP";
    static final String ACTION_TRANSPORT = "org.ubersdr.mobile.TRANSPORT";
    static final String EXTRA_ACTION = "action";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_ALBUM = "album";
    static final String EXTRA_ACTIONS = "actions";

    // The media-session actions v2 registers, in the names it uses. Which of
    // them exist is the page's business — it says so with every metadata
    // update, and only those are offered.
    private static final String NEXT = "nexttrack";
    private static final String PREVIOUS = "previoustrack";
    private static final String PLAY = "play";
    private static final String PAUSE = "pause";

    private MediaSessionCompat session;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private String title = "UberSDR";
    private String text = "";
    private String album = "";
    private java.util.Set<String> actions = java.util.Collections.emptySet();
    private android.graphics.Bitmap artwork;

    static void start(Context context, String title, String text) {
        Intent intent = new Intent(context, PlaybackService.class)
                .setAction(ACTION_START)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_TEXT, text);
        // startForegroundService, because this is started while the Activity is
        // still visible but may outlive its visibility by hours.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
        else context.startService(intent);
    }

    static void update(Context context, String title, String text) {
        update(context, title, text, null, null);
    }

    /** A metadata update from the page's own media session. */
    static void update(Context context, String title, String text, String album, String[] actions) {
        Intent intent = new Intent(context, PlaybackService.class)
                .setAction(ACTION_UPDATE)
                .putExtra(EXTRA_TITLE, title)
                .putExtra(EXTRA_TEXT, text);
        if (album != null) intent.putExtra(EXTRA_ALBUM, album);
        if (actions != null) intent.putExtra(EXTRA_ACTIONS, actions);
        context.startService(intent);
    }

    /**
     * The artwork, as the page fetched it: the operator's photo where the
     * callsign lookup found one, the receiver's logo otherwise.
     *
     * <p>Handed over as a decoded bitmap rather than a URL because the page's
     * copy is a blob: — see the note in src/receiver.js about why v2 uses one.
     */
    static void artwork(Context context, android.graphics.Bitmap bitmap) {
        Instance held = instance;
        if (held == null || held.service == null) return;
        held.service.artwork = opaque(bitmap);
        held.service.publish();
    }

    /**
     * Artwork with no transparency in it, filling its own frame.
     *
     * <p>Android draws whatever it is given onto a black card. An operator's
     * photo is an opaque JPEG and looks right; the receiver's logo is a PNG of a
     * rounded tile — transparent corners, and a margin of a few per cent all
     * round — so it arrives as a picture with black down both sides and black in
     * every corner. Nothing is wrong with the image; it is a launcher icon,
     * drawn to sit on whatever is behind it, and a media card is not behind it.
     *
     * <p>So a transparent one is flattened: its opaque content is measured,
     * scaled to cover the frame, and drawn over a background sampled from the
     * artwork itself — the tile's own colour, whatever an instance's logo
     * happens to be, rather than a constant that would be wrong for anybody
     * else's. A bitmap with no alpha is returned untouched, which is the photo.
     */
    private static android.graphics.Bitmap opaque(android.graphics.Bitmap src) {
        if (src == null || !src.hasAlpha()) return src;
        final int w = src.getWidth();
        final int h = src.getHeight();
        if (w <= 0 || h <= 0) return src;

        int[] pixels = new int[w * h];
        src.getPixels(pixels, 0, w, 0, 0, w, h);

        // The box the picture actually occupies. Anything below a token alpha is
        // the margin rather than the mark — antialiased edges are not content.
        int left = w, top = h, right = -1, bottom = -1;
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                if ((pixels[y * w + x] >>> 24) < 24) continue;
                if (x < left) left = x;
                if (x > right) right = x;
                if (y < top) top = y;
                if (y > bottom) bottom = y;
            }
        }
        if (right < left || bottom < top) return src;   // nothing opaque in it

        // A colour from just inside the top edge of the content: for a tile with
        // a mark on it that is the tile, which is what the corners should be.
        int sample = pixels[(top + Math.max(1, (bottom - top) / 40)) * w + (left + right) / 2];
        int bg = 0xFF000000 | (sample & 0x00FFFFFF);

        android.graphics.Bitmap out = android.graphics.Bitmap.createBitmap(
                w, h, android.graphics.Bitmap.Config.ARGB_8888);
        android.graphics.Canvas canvas = new android.graphics.Canvas(out);
        canvas.drawColor(bg);

        // Cover, not fit: the margin is cropped away rather than painted over,
        // so the mark reaches the edges the way the photo does.
        float boxW = right - left + 1;
        float boxH = bottom - top + 1;
        float scale = Math.max(w / boxW, h / boxH);
        android.graphics.Matrix m = new android.graphics.Matrix();
        m.setScale(scale, scale);
        m.preTranslate(-left, -top);
        m.postTranslate((w - boxW * scale) / 2f, (h - boxH * scale) / 2f);
        android.graphics.Paint paint = new android.graphics.Paint(
                android.graphics.Paint.FILTER_BITMAP_FLAG | android.graphics.Paint.ANTI_ALIAS_FLAG);
        canvas.drawBitmap(src, m, paint);
        return out;
    }

    // A handle on the running service, so artwork — which arrives whenever the
    // page has fetched it — does not need an Intent round trip carrying a
    // megabyte of image.
    private static final class Instance {
        PlaybackService service;
    }

    private static final Instance instance = new Instance();

    static void stop(Context context) {
        context.startService(new Intent(context, PlaybackService.class).setAction(ACTION_STOP));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance.service = this;
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        session = new MediaSessionCompat(this, "UberSDR");
        // Every transport control runs the page's own handler, so the lock
        // screen does what the same button does in a browser: next and previous
        // step the dial (or the bookmarks, per the operator's setting), and
        // play/pause is v2's mute. Nothing here decides what they mean.
        session.setCallback(new MediaSessionCompat.Callback() {
            @Override public void onSkipToNext() { ReceiverActivity.sendAction(NEXT); }
            @Override public void onSkipToPrevious() { ReceiverActivity.sendAction(PREVIOUS); }
            @Override public void onPlay() { ReceiverActivity.sendAction(PLAY); }
            @Override public void onPause() { ReceiverActivity.sendAction(PAUSE); }
            // Not the page's `stop`, which only switches its media session off.
            // From here, stop means leave the receiver — the notification is
            // the only handle on an app whose screen is off.
            @Override public void onStop() { stopReceiver(); }
        });
        session.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_STOP : intent.getAction();
        if (ACTION_TRANSPORT.equals(action)) {
            // A notification button: run it as the page's own handler and
            // leave everything else alone.
            ReceiverActivity.sendAction(intent.getStringExtra(EXTRA_ACTION));
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(action)) {
            abandonFocus();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (intent.hasExtra(EXTRA_TITLE)) title = intent.getStringExtra(EXTRA_TITLE);
        if (intent.hasExtra(EXTRA_TEXT)) text = intent.getStringExtra(EXTRA_TEXT);
        if (intent.hasExtra(EXTRA_ALBUM)) album = intent.getStringExtra(EXTRA_ALBUM);
        if (intent.hasExtra(EXTRA_ACTIONS)) {
            String[] names = intent.getStringArrayExtra(EXTRA_ACTIONS);
            actions = names == null
                    ? java.util.Collections.emptySet()
                    : new java.util.HashSet<>(java.util.Arrays.asList(names));
        }

        if (ACTION_START.equals(action)) requestFocus();

        publish();
        startForeground(NOTIFICATION, buildNotification());
        // Not sticky: a receiver is a live session, and a service restarted by
        // the system after the process died would be a notification for audio
        // that is not playing.
        return START_NOT_STICKY;
    }

    /** Push the current metadata and state into the session, and redraw. */
    private void publish() {
        if (session == null) return;
        MediaMetadataCompat.Builder metadata = new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, text)
                .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album);
        if (artwork != null) {
            metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artwork);
            metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, artwork);
        }
        session.setMetadata(metadata.build());

        long available = PlaybackStateCompat.ACTION_STOP;
        if (actions.contains(NEXT)) available |= PlaybackStateCompat.ACTION_SKIP_TO_NEXT;
        if (actions.contains(PREVIOUS)) available |= PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS;
        if (actions.contains(PLAY)) available |= PlaybackStateCompat.ACTION_PLAY;
        if (actions.contains(PAUSE)) available |= PlaybackStateCompat.ACTION_PAUSE;
        session.setPlaybackState(new PlaybackStateCompat.Builder()
                .setActions(available)
                // Always playing, never paused: v2's pause is a mute, and the
                // audio behind this notification is a live stream that does not
                // stop arriving. A paused state would also let Android dismiss
                // the notification, taking the only stop button with it.
                .setState(PlaybackStateCompat.STATE_PLAYING, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1f)
                .build());

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NOTIFICATION, buildNotification());
    }

    private Notification buildNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL, "Receiver", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shown while a receiver is playing");
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }

        // Tapping it returns to the receiver rather than launching a second
        // copy of anything: the Activity is singleTask, so this brings the
        // existing one forward.
        Intent open = new Intent(this, ReceiverActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, PlaybackService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_ubersdr)
                .setContentTitle(title)
                .setContentText(text)
                .setSubText(album)
                .setLargeIcon(artwork)
                .setContentIntent(tap)
                .setOngoing(true)
                .setShowWhen(false)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT);

        // Only what the page registered. v2 maps previous/next to a tuning step
        // or a bookmark hop depending on the operator's setting, so these are
        // whatever they are in the browser.
        int compact = 0;
        if (actions.contains(PREVIOUS)) {
            builder.addAction(android.R.drawable.ic_media_previous, "Previous",
                    action(PREVIOUS));
            compact++;
        }
        if (actions.contains(PAUSE)) {
            builder.addAction(android.R.drawable.ic_media_pause, "Mute",
                    action(PAUSE));
            compact++;
        }
        if (actions.contains(NEXT)) {
            builder.addAction(android.R.drawable.ic_media_next, "Next",
                    action(NEXT));
            compact++;
        }
        builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stop);

        int[] inCompact = compact == 0 ? new int[]{ 0 } : new int[]{ 0, Math.min(compact, 2) };
        return builder
                .setStyle(new MediaStyle()
                        .setMediaSession(session.getSessionToken())
                        .setShowActionsInCompactView(inCompact))
                .build();
    }

    /**
     * A transport button in the notification.
     *
     * <p>Its own intent back into this service rather than a media-button
     * broadcast: those need a receiver declared in the manifest to be routed
     * to, and there is nothing here that a broadcast would reach which this
     * does not. The lock screen's own controls come through the session
     * callback and end up in the same place.
     */
    private PendingIntent action(String name) {
        return PendingIntent.getService(this, name.hashCode(),
                new Intent(this, PlaybackService.class)
                        .setAction(ACTION_TRANSPORT)
                        .putExtra(EXTRA_ACTION, name),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /**
     * Stop from the notification or the lock screen.
     *
     * <p>Ends the receiver rather than only this service: the page is what owns
     * the session, and a notification that went away while the audio carried on
     * would be the worst of both.
     */
    private void stopReceiver() {
        ReceiverActivity.finishCurrent();
        abandonFocus();
        stopForeground(true);
        stopSelf();
    }

    // --- audio focus ---------------------------------------------------------
    //
    // Asked for so the rest of the phone behaves: a call, a navigation prompt or
    // another player interacts with this the way it would with any media app.
    // Focus lost for good stops the receiver — a receiver quietly holding a
    // session while something else plays is a slot nobody is using.

    private final AudioManager.OnAudioFocusChangeListener focusListener = (change) -> {
        if (change == AudioManager.AUDIOFOCUS_LOSS) stopReceiver();
    };

    private void requestFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                            .build())
                    .setOnAudioFocusChangeListener(focusListener)
                    .build();
            audioManager.requestAudioFocus(focusRequest);
        } else {
            audioManager.requestAudioFocus(focusListener,
                    AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
    }

    private void abandonFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focusRequest != null) audioManager.abandonAudioFocusRequest(focusRequest);
        } else {
            audioManager.abandonAudioFocus(focusListener);
        }
        focusRequest = null;
    }

    @Override
    public void onDestroy() {
        abandonFocus();
        if (session != null) {
            session.setActive(false);
            session.release();
            session = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
