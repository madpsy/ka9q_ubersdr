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
    static final String EXTRA_EPOCH = "epoch";
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
    // Which launch this Activity is, so that reporting its end cannot be read
    // as the end of the one after it. See UberSdrPlugin.receiverClosed.
    private int epoch;
    private boolean insecureTLS;
    // The instance's own hostname. Kept because a link to it belongs in this
    // WebView — v1's popups are opened by absolute URL — while a link anywhere
    // else belongs in a browser. See openExternally.
    private final AppLoad appLoad = new AppLoad();
    private String upstreamHost;
    /** Scheme, host and port — what a popup's loopback URL is rewritten to. */
    private String upstreamOrigin;
    private String label = "UberSDR";
    private boolean playing;
    private androidx.webkit.JavaScriptReplyProxy reply;
    private Prefs prefs;
    private Speech speech;

    /** Ends the open receiver, if there is one. */
    static void finishCurrent() {
        ReceiverActivity activity = current.get();
        if (activity != null) activity.finish();
    }

    /**
     * Whether there is a receiver on screen right now.
     *
     * <p>Not simply "the reference is non-null": it is set in onCreate and never
     * cleared, so between an Activity finishing and the collector getting to it
     * this answers for something that has already gone. What the caller is
     * asking is whether an Intent sent now would land on a live Activity, and
     * for one on its way out it would not — it would start a new one.
     */
    static boolean isOpen() {
        ReceiverActivity activity = current.get();
        return activity != null && !activity.isFinishing() && !activity.isDestroyed();
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = new java.lang.ref.WeakReference<>(this);

        prefs = new Prefs(this);
        // Started now because the engine takes a moment to come up, and the
        // page asks for voices as soon as the Announcements panel is drawn.
        // When it is ready the list is pushed, which is what fires the page's
        // `voiceschanged` — the same event a browser uses to say the same thing.
        speech = new Speech(this, (voicesJson) -> runOnUiThread(() -> {
            if (reply != null) reply.postMessage("voices:" + voicesJson);
        }));

        Intent intent = getIntent();
        instanceId = intent.getStringExtra(EXTRA_ID);
        epoch = intent.getIntExtra(EXTRA_EPOCH, 0);
        String url = intent.getStringExtra(EXTRA_URL);
        String origin = intent.getStringExtra(EXTRA_ORIGIN);
        String upstream = intent.getStringExtra(EXTRA_UPSTREAM);
        String product = intent.getStringExtra(EXTRA_PRODUCT);
        insecureTLS = intent.getBooleanExtra(EXTRA_INSECURE, false);
        try {
            if (upstream != null) upstreamHost = android.net.Uri.parse(upstream).getHost();
            upstreamOrigin = upstream;
        } catch (Exception e) {
            Log.w(TAG, "could not read the instance host from " + upstream, e);
        }
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
                    web, seedScript(upstream, new Secrets(this).get(instanceId), notificationState(),
                            prefs.snapshot()),
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
                return openExternally(request.getUrl()) ? true : false;
            }
        });

        // The Links menu, the Share menu and the callsign lookup all open with
        // window.open, and a WebView ignores it unless told otherwise — so
        // without this the whole menu did nothing at all, silently.
        web.getSettings().setSupportMultipleWindows(true);

        web.setWebChromeClient(new WebChromeClient() {
            /**
             * A new window, which this app does not have.
             *
             * <p>Everything goes to the browser, the receiver's own pages
             * included. They belong to the receiver as much as v2 does, but a
             * phone has no second window and no browser chrome: loading one in
             * place would replace the receiver with a page having no way back
             * to it — the interface, the audio and the session gone, for a link
             * somebody expected to open beside what they were listening to.
             *
             * <p>The URL is not a parameter here, which is why this is more
             * than three lines: WebView reports the *window*, and the address
             * only arrives when something tries to load it. So a throwaway
             * WebView is handed back to take delivery, and its first navigation
             * is the URL that was asked for.
             */
            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog,
                                          boolean isUserGesture, android.os.Message resultMsg) {
                WebView catcher = new WebView(ReceiverActivity.this);
                catcher.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        handOver(outsideUri(request.getUrl()));
                        // Not from inside its own callback: the WebView is in
                        // the middle of using itself.
                        v.post(v::destroy);
                        return true;
                    }
                });
                android.webkit.WebView.WebViewTransport transport =
                        (android.webkit.WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(catcher);
                resultMsg.sendToTarget();
                return true;
            }

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
        tidyForScreenshot();
    }

    /**
     * Tidy the page for a store screenshot, through the page's own controls.
     *
     * <p>Two things have to go before a receiver is photographed:
     *
     * <ul>
     *   <li><b>The stats readout</b>, always. It prints the operator's public
     *       IP over the waterfall, and a screenshot on a store listing is about
     *       as public as a thing can get. Its own "Hide the stats" button is
     *       clicked rather than the element being hidden, so what is captured
     *       is a state the app can actually be in.
     *   <li><b>The Multipad</b>, in landscape only. There the layout is the
     *       docked one and the panel takes half the screen; collapsed, the
     *       waterfall gets the room, which is what the screenshot is for. In
     *       portrait it is the sheet the phone layout opens with and belongs
     *       there.
     * </ul>
     *
     * <p>Opt-in through a global setting rather than a build flag, so that one
     * debug APK can be used both ways:
     *
     * <pre>adb shell settings put global ubersdr_shot 1</pre>
     *
     * <p>Debug builds only, and the iOS client has the same hook driven by its
     * launch environment (ReceiverViewController.tidyForScreenshot) — the two
     * screenshot passes are meant to produce the same pictures.
     */
    private void tidyForScreenshot() {
        if (!BuildConfig.DEBUG) return;
        if (!"1".equals(android.provider.Settings.Global.getString(
                getContentResolver(), "ubersdr_shot"))) {
            return;
        }
        final boolean landscape = getResources().getConfiguration().orientation
                == android.content.res.Configuration.ORIENTATION_LANDSCAPE;

        final String js =
                "(function(){"
                + "try{var h=document.querySelector('[aria-label=\"Hide the stats\"]');"
                + "if(h)h.click();}catch(e){}"
                + "if(" + landscape + "){try{"
                + "var t=document.querySelectorAll('.section__title');"
                + "for(var i=0;i<t.length;i++){"
                + "if(t[i].textContent.trim()!=='Multipad')continue;"
                + "var head=t[i].closest('.section__toggle');"
                + "var sec=t[i].closest('.section');"
                + "if(head&&sec&&!sec.className.match(/is-collapsed|collapsed/))head.click();"
                + "}}catch(e){}}"
                + "})();";

        // Late, and repeatedly: the panels are React and arrive when they
        // arrive, and the stats readout only exists once the spectrum is
        // running. Clicking something that is not there yet is silent.
        for (int delay : new int[]{ 4000, 8000, 14000, 22000 }) {
            web.postDelayed(() -> {
                if (web != null) web.evaluateJavascript(js, null);
            }, delay);
        }
    }

    /**
     * Somebody else's website goes to the browser, not into this WebView.
     *
     * <p>The Links and Share menus are full of them — Reddit, the ARRL, a
     * WhatsApp share, a QRZ lookup — and until this they opened inside the
     * receiver, replacing it. That is wrong twice over: the receiver is
     * running, with audio and a session, and a page that has navigated away
     * from it has stopped it; and a chat client inside a radio app has none of
     * the things a browser has for getting back out.
     *
     * <p>Two origins stay in: the loopback proxy, which is the receiver itself,
     * and the instance's own host, because v1's popups — the callsign lookup,
     * the map, the CW graph — are opened by absolute URL and belong to the
     * receiver as much as anything served through the proxy does.
     *
     * @return true when the URL was handed to the system, meaning the WebView
     *         should not load it.
     */
    private boolean openExternally(android.net.Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        if (scheme == null) return false;
        scheme = scheme.toLowerCase(java.util.Locale.ROOT);
        // The page's own content, not a place to go: about:blank is how a page
        // closes itself, data: and blob: are things it made.
        if ("about".equals(scheme) || "data".equals(scheme)
                || "blob".equals(scheme) || "file".equals(scheme)) {
            return false;
        }
        // Anything that is not http at all belongs to the system, and this is
        // the case that is easy to miss: the Share menu offers email
        // (lib/share.js builds a mailto:), a WebView cannot load one, and
        // treating "not http" as "not ours" means the button does nothing and
        // says nothing about why. tel:, sms: and the messenger schemes are the
        // same shape of problem.
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            return handOver(uri);
        }

        String host = uri.getHost();
        if (host == null) return false;
        if ("127.0.0.1".equals(host) || "localhost".equals(host)) return false;
        if (upstreamHost != null && upstreamHost.equalsIgnoreCase(host)) return false;

        return handOver(uri);
    }

    /**
     * The same page, addressed the way something outside this app can reach it.
     *
     * <p>v2's own pages are relative, so a popup resolves against the page's
     * origin — which is the loopback proxy, on a port that means nothing once
     * the receiver is closed and nothing at all to another device. The
     * instance's own origin is the address of the same page.
     */
    private android.net.Uri outsideUri(android.net.Uri uri) {
        if (uri == null || upstreamOrigin == null) return uri;
        String host = uri.getHost();
        if (host == null) return uri;
        if (!"127.0.0.1".equals(host) && !"localhost".equals(host)) return uri;
        try {
            android.net.Uri up = android.net.Uri.parse(upstreamOrigin);
            if (up.getHost() == null) return uri;
            return uri.buildUpon()
                    .scheme(up.getScheme())
                    .encodedAuthority(up.getEncodedAuthority())
                    .build();
        } catch (Exception e) {
            return uri;
        }
    }

    /** Hands a URL to whatever the system has for it. Always reports handled. */
    private boolean handOver(android.net.Uri uri) {
        try {
            Intent out = new Intent(Intent.ACTION_VIEW, uri);
            out.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(out);
        } catch (Exception e) {
            // Nothing installed that will take it. Better to leave the receiver
            // alone than to navigate it somewhere it cannot come back from, so
            // this still reports the URL as handled.
            Log.w(TAG, "no app would open " + uri, e);
        }
        return true;
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
            case "speak":
                speech.speak(message.optString("text", ""), message.optString("voice", ""),
                        (float) message.optDouble("rate", 1), (float) message.optDouble("volume", 1));
                break;
            case "speak-cancel":
                speech.stop();
                break;
            case "voices":
                // The page asking again — it may have mounted after the engine
                // was ready, in which case the push above has been and gone.
                if (reply != null) reply.postMessage("voices:" + speech.voicesJson());
                break;
            case "prefs":
                prefs.update(message.optJSONObject("map"));
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
            case "stats":
                // Measured on the way past rather than on a timer: the page
                // only asks while the stats readout is open. See AppLoad.
                if (reply != null) reply.postMessage("stats:" + appLoad.json(this));
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

    private static String seedScript(String upstreamOrigin, String password, String notifications,
                                     String sharedPrefs) {
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
        // The shared settings, applied before the page's first script reads
        // localStorage — which is the whole reason this runs at document start.
        //
        // Overwrite, don't clear: a key this receiver has and the snapshot lacks
        // is a feature the template receiver never used, not a difference in how
        // the shared ones are set. `prefsSeeded` tells src/receiver.js whether
        // there was a snapshot at all, because the first receiver ever opened is
        // the one that supplies it.
        sb.append("try{var s=").append(sharedPrefs == null ? "null" : sharedPrefs).append(";")
          .append("window.ubersdrDesktop.prefsSeeded=!!s;")
          .append("if(s){for(var k in s){try{localStorage.setItem(k,s[k]);}catch(e){}}}")
          .append("}catch(e){}");
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
     * A notification the operator tapped, or a different receiver to show.
     *
     * <p>The Activity is singleTask, so both arrive here rather than starting a
     * second one. A notification's tag goes back to the page, which fires
     * whatever it hung off that notification's `onclick` — the same thing
     * clicking it does in a browser.
     *
     * <p>An Intent naming a different receiver is the chooser (or a followed
     * link) asking for a second receiver while this one is showing. The proxy
     * behind this WebView has already been replaced by the time this runs, so
     * the page on screen is pointed at an origin that now leads somewhere else:
     * everything below it has to be built again, which is what recreate() does
     * with the Intent set just above. Reloading the WebView instead would leave
     * the label, the notification and the speech engine belonging to the
     * receiver that had gone.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);

        String id = intent == null ? null : intent.getStringExtra(EXTRA_ID);
        if (id != null && !id.equals(instanceId)) {
            recreate();
            return;
        }

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
        if (speech != null) {
            speech.release();
            speech = null;
        }
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        UberSdrPlugin.receiverClosed(instanceId, epoch);
        super.onDestroy();
    }
}
