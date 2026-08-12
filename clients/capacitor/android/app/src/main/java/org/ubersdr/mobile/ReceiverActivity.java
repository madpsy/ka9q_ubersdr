package org.ubersdr.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.net.http.SslError;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import java.util.Collections;
import java.util.Set;

/**
 * One receiver, in a WebView pointed at its loopback proxy.
 *
 * <p>Deliberately not a Capacitor screen. The page is served from
 * http://127.0.0.1:&lt;port&gt;, which is not the app's origin, so the Capacitor
 * bridge is not injected there and would be no use if it were: what the page
 * needs from the host is what the desktop client's receiver windows need, which
 * is a preload, and the Android equivalent of a preload is a document-start
 * script. The chooser keeps the bridge; the receiver gets the script.
 *
 * <p>What that script does is most of what
 * clients/electron/receiver-preload.js does: the receiver's real address for
 * the share button, the saved bypass password, the page API client, and the
 * host flags that tell v2 what kind of place it is running in. What it does not
 * do yet is bridge shared settings between receivers.
 *
 * <p>This Activity is also the middle of three conversations, which is most of
 * what is below: the page reports what it is playing (PlaybackService turns it
 * into the notification and the lock screen), the page raises notifications
 * (Notices puts them in the shade), and both send things back — a transport
 * button, a tapped notification, an answered permission.
 */
public class ReceiverActivity extends Activity {

    private static final String TAG = "UberSDR";

    static final String EXTRA_ID = "id";
    static final String EXTRA_URL = "url";
    static final String EXTRA_LABEL = "label";
    static final String EXTRA_ORIGIN = "origin";
    static final String EXTRA_UPSTREAM = "upstream";
    static final String EXTRA_INSECURE = "insecure";
    static final String EXTRA_PRODUCT = "product";
    static final String EXTRA_NOTICE_TAG = "noticeTag";

    // The one open receiver, so the chooser's Disconnect can end it. Weak
    // because the system may destroy the Activity without this app's help, and
    // a strong static would hold the whole WebView after it.
    private static java.lang.ref.WeakReference<ReceiverActivity> current =
            new java.lang.ref.WeakReference<>(null);

    private WebView web;
    private String instanceId;
    private boolean insecureTLS;
    private String label = "UberSDR";
    private boolean playing;
    private androidx.webkit.JavaScriptReplyProxy reply;

    /** Ends the open receiver, if there is one. */
    static void finishCurrent() {
        ReceiverActivity activity = current.get();
        if (activity != null) activity.finish();
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = new java.lang.ref.WeakReference<>(this);

        Intent intent = getIntent();
        instanceId = intent.getStringExtra(EXTRA_ID);
        String url = intent.getStringExtra(EXTRA_URL);
        String origin = intent.getStringExtra(EXTRA_ORIGIN);
        String upstream = intent.getStringExtra(EXTRA_UPSTREAM);
        String product = intent.getStringExtra(EXTRA_PRODUCT);
        insecureTLS = intent.getBooleanExtra(EXTRA_INSECURE, false);
        if (intent.getStringExtra(EXTRA_LABEL) != null) label = intent.getStringExtra(EXTRA_LABEL);
        setTitle(label);

        web = new WebView(this);
        web.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(web);
        SystemBars.inset(findViewById(android.R.id.content));

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // The receiver's own settings live in localStorage against this origin,
        // which is why the port is stable per instance.
        settings.setDatabaseEnabled(true);
        // v2 gates audio behind its own start overlay, so the gesture has
        // already happened by the time anything plays; this keeps a reconnect
        // from coming up silent.
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setUserAgentString(browserUserAgent(settings.getUserAgentString(), product));
        // Only where it is wanted. A release WebView left inspectable is a
        // receiver anybody with adb can read the session out of, and the flag
        // is process-global, so this decides it for the chooser too.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        // The preload's jobs, before the page's first script runs.
        Set<String> rules = Collections.singleton(origin);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(
                    web, seedScript(upstream, new Secrets(this).get(instanceId), notificationState()),
                    rules);

            // The page API client (src/receiver.js, bundled by build.sh), and
            // the channel it answers on. Both are optional in the sense that
            // the receiver works without them — the back gesture always leaves
            // — so a WebView missing either feature loses the stop button's
            // second meaning and nothing else.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.addWebMessageListener(web, "ubersdrHost", rules,
                        (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                            if (!isMainFrame) return;
                            // Kept so the lock screen can talk back. It is the
                            // page's end of the same channel, so it stays valid
                            // for as long as the page does.
                            reply = replyProxy;
                            runOnUiThread(() -> onPageMessage(message.getData()));
                        });
                String bridge = readAsset("public/receiver-bridge.js");
                if (bridge != null) WebViewCompat.addDocumentStartJavaScript(web, bridge, rules);
            } else {
                Log.w(TAG, "no web message listener: stopping the receiver will not return to the chooser");
            }
        } else {
            // A very old system WebView. The page still works; the share link
            // carries the loopback address, a saved password is not applied,
            // and it does not start itself — all of which are things to do by
            // hand rather than a receiver that will not open.
            Log.w(TAG, "no document-start script support: autostart, share links and saved passwords are unavailable");
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                // Never reached in the normal case: the page is loopback http
                // and the proxy is what talks TLS to the instance. It is here
                // for the v1 popups, which the page opens by absolute URL.
                if (insecureTLS) handler.proceed();
                else handler.cancel();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                // Mirrored only in a debug build. The page is chatty by design
                // and none of it is this host's business — in a release APK it
                // would be somebody's chat and callsign lookups in logcat, for
                // no one's benefit.
                if (BuildConfig.DEBUG) {
                    Log.d(TAG, "page: " + message.message()
                            + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
                }
                return true;
            }
        });

        web.loadUrl(url);
    }

    /**
     * The one runtime permission this app asks for.
     *
     * <p>Two callers, and both are the operator having just asked for something
     * that needs it: audio starting (where the notification becomes the only
     * handle on it) and the page requesting permission from its Notifications
     * panel. Never on launch — a permission dialog over the chooser is a dialog
     * in front of somebody who has not said they want anything yet.
     */
    private void askForNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                == android.content.pm.PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[]{ android.Manifest.permission.POST_NOTIFICATIONS }, 1);
    }

    /**
     * What the page reports about itself (src/receiver.js).
     *
     * <p>`running` is what makes this more than a browser tab: it starts the
     * foreground service, which is the only thing that keeps the process — and
     * so the audio — alive once the screen locks, and it holds the screen awake
     * while the receiver is on top. FLAG_KEEP_SCREEN_ON only defers the idle
     * timeout and only while this window is in front, so pressing the power
     * button still locks the phone; the service is what carries on from there.
     */
    private void onPageMessage(String data) {
        String type;
        String text;
        JSONObject message;
        try {
            message = new JSONObject(data);
            type = message.optString("type");
            text = message.optString("text", "");
        } catch (org.json.JSONException e) {
            Log.w(TAG, "unparseable message from the page: " + data);
            return;
        }

        switch (type) {
            case "metadata":
                // Straight from the page's own media session: v2 composed all
                // of it (receiver, dial, callsign, bookmark) and this only
                // carries it to the notification.
                if (playing) {
                    // The dial is the media session's `artist` — v2's own
                    // choice of field, kept rather than renamed on the way
                    // through (metadata.js says why each line is which).
                    PlaybackService.update(this, orDefault(message.optString("title"), label),
                            message.optString("artist", ""), message.optString("album", ""),
                            strings(message.optJSONArray("actions")));
                }
                break;
            case "artwork":
                if (playing) PlaybackService.artwork(this, decodeDataUrl(message.optString("src")));
                break;
            case "notice":
                Notices.show(this, message.optString("tag", "ubersdr"),
                        orDefault(message.optString("title"), label),
                        message.optString("body", ""),
                        message.optBoolean("ongoing", false),
                        message.optBoolean("silent", false));
                break;
            case "notice-close":
                Notices.close(this, message.optString("tag", ""));
                break;
            case "notice-permission":
                // The page asked, which means the operator pressed something
                // that asks — v2 only requests from a gesture. The answer goes
                // back the way every other host message does.
                askForNotifications();
                break;
            case "running":
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                if (playing) {
                    PlaybackService.update(this, label, text);
                } else {
                    playing = true;
                    // Asked here rather than when the receiver opens: this is
                    // the moment the notification starts being the only way to
                    // stop audio playing with the screen off, and it follows
                    // the operator having pressed Connect. Refused, everything
                    // still works — the service runs and the audio plays — but
                    // the receiver can then only be stopped from the app.
                    askForNotifications();
                    PlaybackService.start(this, label, text);
                }
                break;
            case "tuning":
                if (playing) PlaybackService.update(this, label, text);
                break;
            case "stopped":
                stopPlayback();
                // Back to the chooser. Not finishAndRemoveTask: the chooser is
                // the task, and this Activity is on top of it.
                finish();
                break;
            default:
                Log.w(TAG, "unknown message from the page: " + type);
        }
    }

    /**
     * Run one of the page's media-session handlers.
     *
     * <p>Called from the notification's buttons and from the lock screen, both
     * of which arrive on the service's thread — hence the post. The name is v2's
     * own (`nexttrack`, `pause`, …), so the button does in here exactly what the
     * same button does in a browser.
     */
    static void sendAction(String name) {
        ReceiverActivity activity = current.get();
        if (activity == null || name == null) return;
        activity.runOnUiThread(() -> {
            if (activity.reply != null) activity.reply.postMessage("action:" + name);
        });
    }

    private static String orDefault(String value, String fallback) {
        return value == null || value.isEmpty() ? fallback : value;
    }

    private static String[] strings(org.json.JSONArray array) {
        if (array == null) return new String[0];
        String[] out = new String[array.length()];
        for (int i = 0; i < out.length; i++) out[i] = array.optString(i);
        return out;
    }

    /** The artwork the page fetched, as a bitmap. Null if it did not arrive whole. */
    private static android.graphics.Bitmap decodeDataUrl(String dataUrl) {
        if (dataUrl == null) return null;
        int comma = dataUrl.indexOf(',');
        if (comma < 0) return null;
        try {
            byte[] bytes = android.util.Base64.decode(dataUrl.substring(comma + 1), android.util.Base64.DEFAULT);
            return android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "artwork could not be decoded");
            return null;
        }
    }

    private void stopPlayback() {
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (playing) {
            playing = false;
            PlaybackService.stop(this);
        }
    }

    /** A staged asset as text, or null if it was not built. */
    private String readAsset(String name) {
        try (java.io.InputStream in = getAssets().open(name)) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        } catch (java.io.IOException e) {
            Log.w(TAG, "asset " + name + " is not staged", e);
            return null;
        }
    }

    /**
     * What the host tells the page: where it really is, that it may start
     * itself, and the saved password.
     *
     * <p>`upstreamOrigin` is read by the page (static/v2/src/components/ShareMenu.jsx
     * via lib/share.js): this window's own origin is the loopback proxy, so a
     * link built from it opens nothing on anybody else's device. The desktop
     * client passes the same thing under the same name, so nothing in the UI has
     * to know which host it is in.
     *
     * <p>`autoStart` dismisses the start overlay. That overlay exists for one
     * browser rule — an AudioContext not created from a user gesture is
     * suspended — and a page cannot waive it for itself, because in an ordinary
     * browser it would start into silence. So the host says whether the rule
     * applies, and here it does not: onCreate sets
     * {@code setMediaPlaybackRequiresUserGesture(false)}, which is this
     * platform's version of the switch the desktop client throws with
     * {@code autoplay-policy=no-user-gesture-required}. Somebody who chose this
     * receiver in the chooser has already said what the button asks.
     *
     * <p>v2 does not start on mount but on the answer from /connection, so a
     * full or barred receiver still shows its reason and its password box — and
     * by then the password below has been seeded, which is what makes "with or
     * without a password" one path rather than two. See StartOverlay.jsx.
     *
     * <p>`mediaSession` says this host shows the media controls itself, which
     * changes two answers v2 would otherwise work out from the browser: the
     * feature is on by default (as it is on Apple, and for the same reason —
     * this is a phone and the lock screen is the point), and the anchor is
     * 'none'. Without it, detection sees Android and picks the 'stream' anchor,
     * which moves audio off the WebSocket and takes the scope, the recorder and
     * the client-side filters with it — a trade made to raise a widget this app
     * raises for itself. See static/v2/src/radio/media/support.js.
     *
     * <p>The password goes where the page already looks for one — sessionStorage
     * under `ubersdr.v2.password`, see static/v2/src/radio/session.js — rather
     * than being handed to the page as a value.
     */
    /**
     * Whether Android will show a notification the page raises.
     *
     * <p>Told to the page so its Notifications panel can say what is true —
     * "granted" needs no prompt, "default" offers one, and there is no third
     * state to guess at. Below 13 there is no runtime permission and the answer
     * is always yes.
     */
    private String notificationState() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "granted";
        return checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                == android.content.pm.PackageManager.PERMISSION_GRANTED ? "granted" : "default";
    }

    private static String seedScript(String upstreamOrigin, String password, String notifications) {
        StringBuilder sb = new StringBuilder();
        sb.append("(function(){try{window.ubersdrDesktop={upstreamOrigin:")
          .append(JSONObject.quote(upstreamOrigin == null ? "" : upstreamOrigin))
          .append(",autoStart:true,mediaSession:true,notifications:")
          .append(JSONObject.quote(notifications))
          .append("};}catch(e){}");
        if (password != null && !password.isEmpty()) {
            sb.append("try{sessionStorage.setItem('ubersdr.v2.password',")
              .append(JSONObject.quote(password))
              .append(");}catch(e){}");
        }
        sb.append("})();");
        return sb.toString();
    }

    /**
     * See src/useragent.js, which owns the token: the WebView's own string is
     * kept and ours appended. The UI reads the rest of it — the spoken-frequency
     * voices and the media-control anchor are both gated on `Chrome/` being in
     * there — so it is appended rather than replaced.
     */
    private static String browserUserAgent(String base, String product) {
        if (product == null || product.isEmpty()) return base;
        if (base == null || base.isEmpty()) return product;
        return base.contains(product) ? base : base + " " + product;
    }

    /**
     * A notification the operator tapped.
     *
     * <p>The Activity is singleTask, so this arrives here rather than starting
     * a second one. The tag goes back to the page, which fires whatever it hung
     * off that notification's `onclick` — the same thing clicking it does in a
     * browser.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String tag = intent == null ? null : intent.getStringExtra(EXTRA_NOTICE_TAG);
        if (tag != null && reply != null) reply.postMessage("notice-click:" + tag);
    }

    /** The answer to the notification-permission prompt, back to the page. */
    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != 1 || reply == null) return;
        boolean granted = results.length > 0
                && results[0] == android.content.pm.PackageManager.PERMISSION_GRANTED;
        reply.postMessage("notice-permission:" + (granted ? "granted" : "denied"));
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        // However this Activity ends — the back gesture, the chooser's
        // Disconnect, the system reclaiming it — the notification goes with it.
        // A foreground service outliving the page that was feeding it would be
        // a receiver playing with nothing behind it.
        stopPlayback();
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        UberSdrPlugin.receiverClosed(instanceId);
        super.onDestroy();
    }
}
