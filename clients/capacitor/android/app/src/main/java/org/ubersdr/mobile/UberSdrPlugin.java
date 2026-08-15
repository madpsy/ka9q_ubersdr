package org.ubersdr.mobile;

import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.util.List;

/**
 * The chooser's platform half: everything window.ubersdr needs that a WebView
 * cannot do.
 *
 * <p>The desktop client answers the same surface from 32 IPC handlers in its
 * main process (clients/electron/main.js). Rather less is needed here, because
 * the store, the discovery logic and the row shapes stayed in JavaScript — see
 * src/api.js. What is left is what genuinely needs the platform: HTTP with
 * per-receiver certificate trust, the local network, the keystore, and opening
 * a receiver.
 */
@CapacitorPlugin(name = "UberSdr")
public class UberSdrPlugin extends Plugin {

    private static UberSdrPlugin instance;

    private Secrets secrets;
    private LocalProxy proxy;
    private String openId;
    // Which receiver launch is the current one. See receiverClosed.
    private int epoch;

    @Override
    public void load() {
        instance = this;
        secrets = new Secrets(getContext());
    }

    // --- deep links ----------------------------------------------------------

    /** Whether a ubersdr:// link started or reached this run. */
    private boolean linkSeen = false;

    /**
     * A followed ubersdr:// link, on its way to src/deeplink.js.
     *
     * <p>Capacitor calls this for the intent that started the Activity as well
     * as for one delivered to it while it was running (BridgeActivity.load ends
     * with onNewIntent(getIntent())), so cold start and warm start are the same
     * path here. They differ in who is listening: on a cold start the page has
     * not been parsed yet, let alone registered anything, which is what
     * retainUntilConsumed is for — the event waits in the plugin until the
     * listener exists and is delivered then.
     *
     * <p>The one intent deliberately ignored is a relaunch from the recents
     * list. Android re-delivers the original VIEW intent when the app is
     * resumed that way after its process has gone, and following it would mean
     * a receiver the operator disconnected from yesterday reconnecting itself
     * today because the link that first opened it is still attached to the task.
     */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null) return;
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;

        Uri uri = intent.getData();
        if (uri == null || !"ubersdr".equalsIgnoreCase(uri.getScheme())) return;

        // Consumed: the same Intent object is what getIntent() keeps returning,
        // so clearing it stops a second delivery within this Activity's life
        // from being read as a second tap.
        intent.setData(null);

        // Remembered for the chooser, which has an "open the last receiver on
        // launch" setting and must stand aside for a link: the link names a
        // receiver somebody asked for now, where the setting names one they
        // asked for last time. Never cleared — the setting it guards is only
        // ever read once, as the page starts.
        linkSeen = true;

        JSObject data = new JSObject();
        data.put("url", uri.toString());
        notifyListeners("deepLink", data, true);
    }

    /**
     * Has a link been followed this run?
     *
     * <p>Answered from the Intent rather than from whether the page has
     * received the event yet, which is the whole point: on a cold start the two
     * race, and a chooser that asked "is a receiver open?" would find the
     * answer no while a directory lookup was still in flight and open a
     * different one.
     */
    @PluginMethod
    public void linkPending(PluginCall call) {
        JSObject out = new JSObject();
        out.put("pending", linkSeen);
        call.resolve(out);
    }

    // --- HTTP ----------------------------------------------------------------

    @PluginMethod
    public void getJson(PluginCall call) {
        final String host = call.getString("host", "");
        final int port = call.getInt("port", 0);
        final boolean tls = Boolean.TRUE.equals(call.getBoolean("tls", false));
        final boolean insecure = Boolean.TRUE.equals(call.getBoolean("insecureTLS", false));
        final String path = call.getString("path", "/");
        final int timeoutMs = call.getInt("timeoutMs", 8000);
        // From src/useragent.js, which owns the token — one spelling of this
        // client's name, shared by the probes and the receiver's WebView.
        final String userAgent = call.getString("userAgent", "UberSDR-Android");

        if (host.isEmpty() || port <= 0) {
            call.reject("a host and port are required");
            return;
        }

        // Off the main thread: this is a network call, and Capacitor runs
        // plugin methods on the caller's thread.
        getBridge().execute(() -> {
            Http.Result result = Http.getJson(host, port, tls, insecure, path, timeoutMs, userAgent);
            JSObject out = new JSObject();
            out.put("ok", result.ok);
            out.put("status", result.status);
            if (result.ok) {
                out.put("body", result.body);
            } else {
                out.put("code", result.code);
                out.put("error", result.error);
                out.put("certError", result.certError);
            }
            // Resolved either way. A receiver that is not there is an answer,
            // not an exception, and the discovery layer reads the fields.
            call.resolve(out);
        });
    }

    // --- the local network ---------------------------------------------------

    @PluginMethod
    public void mdnsBrowse(PluginCall call) {
        final int timeoutMs = call.getInt("timeoutMs", 3000);
        getBridge().execute(() -> {
            JSArray services = new JSArray();
            for (Mdns.Service svc : Mdns.browse(timeoutMs)) {
                JSObject o = new JSObject();
                o.put("name", svc.name);
                o.put("host", svc.host);
                o.put("port", svc.port);
                services.put(o);
            }
            JSObject out = new JSObject();
            out.put("services", services);
            call.resolve(out);
        });
    }

    // --- the bypass password -------------------------------------------------
    //
    // Set, cleared and asked about. There is no method that returns one: the
    // receiver Activity reads it from Secrets directly when it opens a page, so
    // a value the chooser must not hold never passes through JavaScript.

    @PluginMethod
    public void secretSet(PluginCall call) {
        String id = call.getString("id", "");
        if (id.isEmpty()) { call.reject("an id is required"); return; }
        secrets.set(id, call.getString("value", ""));
        call.resolve();
    }

    @PluginMethod
    public void secretHas(PluginCall call) {
        JSObject out = new JSObject();
        out.put("has", secrets.has(call.getString("id", "")));
        call.resolve(out);
    }

    @PluginMethod
    public void secretClear(PluginCall call) {
        secrets.clear(call.getString("id", ""));
        call.resolve();
    }

    // --- receivers -----------------------------------------------------------

    /**
     * Start this instance's loopback proxy and open a receiver on it.
     *
     * <p>Returns the port actually bound, which is the stored one unless
     * something else had it. The caller persists what comes back: the port is
     * the origin, and the origin is where the v2 UI keeps this receiver's
     * settings.
     */
    @PluginMethod
    public void openReceiver(PluginCall call) {
        final String id = call.getString("id", "");
        final String host = call.getString("host", "");
        final int port = call.getInt("port", 0);
        final boolean tls = Boolean.TRUE.equals(call.getBoolean("tls", false));
        final boolean insecure = Boolean.TRUE.equals(call.getBoolean("insecureTLS", false));
        final int preferredPort = call.getInt("localPort", 0);
        final String label = call.getString("label", "UberSDR");
        final String product = call.getString("product", "");

        if (id.isEmpty() || host.isEmpty() || port <= 0) {
            call.reject("an id, host and port are required");
            return;
        }

        // This receiver is already open: bring it forward and leave it alone.
        //
        // Restarting the proxy under a page that is using it would drop every
        // socket the receiver has — the audio, the spectrum, the session — and
        // then the page would reconnect through the new one, so the visible
        // effect of asking for what is already there would be a gap in the
        // audio. Two callers reach this: the chooser's button, which says
        // "Show" rather than "Connect" for a running receiver, and a link
        // followed for the receiver that is already playing.
        //
        // The Activity is singleTask, so an Intent carrying no id comes out at
        // its onNewIntent, which ignores it and simply arrives in front.
        if (proxy != null && id.equals(openId) && ReceiverActivity.isOpen()) {
            getActivity().startActivity(new Intent(getContext(), ReceiverActivity.class));
            JSObject shown = new JSObject();
            shown.put("localPort", proxy.localPort());
            call.resolve(shown);
            return;
        }

        // One receiver at a time. A phone shows one thing, and two receivers
        // playing at once would be two claims on the audio focus.
        stopProxy();

        LocalProxy started = new LocalProxy(host, port, tls, insecure, getContext().getAssets());
        int bound;
        try {
            bound = started.start(preferredPort);
        } catch (IOException e) {
            call.reject("could not start the local proxy: " + e.getMessage());
            return;
        }
        proxy = started;
        openId = id;
        epoch++;

        Intent intent = new Intent(getContext(), ReceiverActivity.class);
        intent.putExtra(ReceiverActivity.EXTRA_ID, id);
        intent.putExtra(ReceiverActivity.EXTRA_EPOCH, epoch);
        intent.putExtra(ReceiverActivity.EXTRA_URL, started.origin() + "/v2/");
        intent.putExtra(ReceiverActivity.EXTRA_ORIGIN, started.origin());
        intent.putExtra(ReceiverActivity.EXTRA_UPSTREAM, started.upstreamOrigin());
        intent.putExtra(ReceiverActivity.EXTRA_LABEL, label);
        intent.putExtra(ReceiverActivity.EXTRA_INSECURE, insecure);
        intent.putExtra(ReceiverActivity.EXTRA_PRODUCT, product);
        // Whose settings this receiver reads and writes. Decided in the
        // chooser and carried in, because the page is seeded before its first
        // script runs and there is nothing to ask by then.
        intent.putExtra(ReceiverActivity.EXTRA_PREFS_SCOPE, call.getString("prefsScope"));
        getActivity().startActivity(intent);

        JSObject out = new JSObject();
        out.put("localPort", bound);
        call.resolve(out);
    }

    @PluginMethod
    public void closeReceiver(PluginCall call) {
        // The Activity's onDestroy calls receiverClosed, which stops the proxy
        // — the same path the back gesture takes, so there is one way a
        // receiver ends rather than two that must agree.
        ReceiverActivity.finishCurrent();
        call.resolve();
    }

    /**
     * Throw away the interface settings the receivers share.
     *
     * <p>Only what this app stored on the page's behalf — the v2 snapshot in
     * Prefs. Not the saved receivers, not their passwords, and not what a
     * receiver keeps in its own localStorage: those belong to the chooser and
     * to the page, and a "reset settings" that quietly took the receiver list
     * with it would be a button nobody could risk pressing.
     */
    /** One app-level setting, for the chooser's settings page. See Prefs. */
    @PluginMethod
    public void prefGet(PluginCall call) {
        JSObject out = new JSObject();
        out.put("value", Prefs.readOne(getContext(), call.getString("key")));
        call.resolve(out);
    }

    @PluginMethod
    public void prefSet(PluginCall call) {
        Prefs.writeOne(getContext(), call.getString("key"), call.getString("value"));
        call.resolve();
    }

    @PluginMethod
    public void resetPrefs(PluginCall call) {
        Prefs.resetAll(getContext());
        call.resolve();
    }

    /**
     * This app's page in Android's settings.
     *
     * <p>Notifications are the reason it exists: a refusal is remembered, and
     * from Android 13 a second request is not even shown — so an operator who
     * said no has no way back from inside the app, and no way of knowing that
     * is where the answer lives.
     */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(android.net.Uri.fromParts("package", getContext().getPackageName(), null));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("no settings page on this device", e);
        }
    }

    @PluginMethod
    public void receiverState(PluginCall call) {
        JSObject out = new JSObject();
        out.put("id", openId);
        call.resolve(out);
    }

    /**
     * Called by ReceiverActivity.onDestroy, however it came to be destroyed.
     *
     * <p>The epoch is which launch that Activity belonged to, and is the whole
     * reason it exists: an Activity on its way out can report after the next one
     * has started. Following a link for the receiver that is already open does
     * exactly that — MainActivity is singleTask, so the launch itself destroys
     * the Activity above it, and the connect that follows can start a new proxy
     * before that Activity's onDestroy has run. Comparing ids would then have
     * this stop the proxy it had just been given, for a receiver that is
     * starting rather than one that has ended.
     */
    static void receiverClosed(String id, int closingEpoch) {
        UberSdrPlugin self = instance;
        if (self == null) return;
        if (closingEpoch == self.epoch) {
            self.stopProxy();
            self.openId = null;
        }
        JSObject data = new JSObject();
        data.put("id", id);
        self.notifyListeners("receiverClosed", data);
    }

    private void stopProxy() {
        if (proxy != null) {
            proxy.stop();
            proxy = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopProxy();
        instance = null;
        super.handleOnDestroy();
    }
}
