package org.ubersdr.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
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
 * <p>What that script does is the small half of
 * clients/electron/receiver-preload.js — the receiver's real address, for the
 * share button, and the saved bypass password. Shared settings, the page-API
 * bridge and the media session are the rest of that file and are not here yet.
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

    // The one open receiver, so the chooser's Disconnect can end it. Weak
    // because the system may destroy the Activity without this app's help, and
    // a strong static would hold the whole WebView after it.
    private static java.lang.ref.WeakReference<ReceiverActivity> current =
            new java.lang.ref.WeakReference<>(null);

    private WebView web;
    private String instanceId;
    private boolean insecureTLS;

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
        setTitle(intent.getStringExtra(EXTRA_LABEL));

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
        WebView.setWebContentsDebuggingEnabled(true);

        // The preload's jobs, before the page's first script runs.
        Set<String> rules = Collections.singleton(origin);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(
                    web, seedScript(upstream, new Secrets(this).get(instanceId)), rules);

            // The page API client (src/receiver.js, bundled by build.sh), and
            // the channel it answers on. Both are optional in the sense that
            // the receiver works without them — the back gesture always leaves
            // — so a WebView missing either feature loses the stop button's
            // second meaning and nothing else.
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.addWebMessageListener(web, "ubersdrHost", rules,
                        (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                            if (isMainFrame && "stopped".equals(message.getData())) {
                                // Back to the chooser. Not finishAndRemoveTask:
                                // the chooser is the task, and this Activity is
                                // on top of it.
                                runOnUiThread(this::finish);
                            }
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
                Log.d(TAG, "page: " + message.message() + " (" + message.sourceId() + ":" + message.lineNumber() + ")");
                return true;
            }
        });

        web.loadUrl(url);
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
     * <p>The password goes where the page already looks for one — sessionStorage
     * under `ubersdr.v2.password`, see static/v2/src/radio/session.js — rather
     * than being handed to the page as a value.
     */
    private static String seedScript(String upstreamOrigin, String password) {
        StringBuilder sb = new StringBuilder();
        sb.append("(function(){try{window.ubersdrDesktop={upstreamOrigin:")
          .append(JSONObject.quote(upstreamOrigin == null ? "" : upstreamOrigin))
          .append(",autoStart:true};}catch(e){}");
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

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        UberSdrPlugin.receiverClosed(instanceId);
        super.onDestroy();
    }
}
