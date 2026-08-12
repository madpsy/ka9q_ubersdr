package org.ubersdr.mobile;

import android.content.Intent;

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

    @Override
    public void load() {
        instance = this;
        secrets = new Secrets(getContext());
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

        Intent intent = new Intent(getContext(), ReceiverActivity.class);
        intent.putExtra(ReceiverActivity.EXTRA_ID, id);
        intent.putExtra(ReceiverActivity.EXTRA_URL, started.origin() + "/v2/");
        intent.putExtra(ReceiverActivity.EXTRA_ORIGIN, started.origin());
        intent.putExtra(ReceiverActivity.EXTRA_UPSTREAM, started.upstreamOrigin());
        intent.putExtra(ReceiverActivity.EXTRA_LABEL, label);
        intent.putExtra(ReceiverActivity.EXTRA_INSECURE, insecure);
        intent.putExtra(ReceiverActivity.EXTRA_PRODUCT, product);
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

    @PluginMethod
    public void receiverState(PluginCall call) {
        JSObject out = new JSObject();
        out.put("id", openId);
        call.resolve(out);
    }

    /** Called by ReceiverActivity.onDestroy, however it came to be destroyed. */
    static void receiverClosed(String id) {
        UberSdrPlugin self = instance;
        if (self == null) return;
        if (id != null && id.equals(self.openId)) {
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
