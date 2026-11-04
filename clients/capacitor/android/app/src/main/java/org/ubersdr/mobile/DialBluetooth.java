package org.ubersdr.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Base64;
import android.util.Log;
import android.util.TypedValue;
import android.widget.ArrayAdapter;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The UberSDR Dial over Bluetooth, for a receiver page that has no Web
 * Bluetooth — the native half of src/hostbluetooth.js, whose header has the
 * protocol.
 *
 * <p>Only the Dial: the chooser scans for the Dial's service and nothing else,
 * a connection is only ever made to a dial the operator picked there (or the
 * one picked last time, remembered), and only that service's characteristics
 * are reachable. The page asking is a remote receiver's.
 *
 * <p>One dial, one connection, one GATT operation at a time. Android's stack
 * refuses a second operation while one is outstanding, so notifications and
 * writes queue here and each answers the page when its callback arrives.
 *
 * <p>Android 12 (API 31) and later only — the Nearby devices permissions. The
 * operator does not care for older phones, and below 12 BLE scanning needs the
 * location permission, which is not worth asking for to turn a knob.
 */
@SuppressLint("MissingPermission") // every path checks granted() first
final class DialBluetooth {
    private static final String TAG = "UberSDR.Dial";

    static final UUID SERVICE = UUID.fromString("89540001-8c77-4d5f-9411-e7534b50c873");
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    static final int REQUEST_PERMISSIONS = 4031;
    static final int REQUEST_ENABLE = 4032;

    private static final long CONNECT_MS = 10000;
    private static final long OP_MS = 5000;
    private static final int MTU = 247;

    private static final String PREFS = "dial";
    private static final String KEY_ADDRESS = "address";
    private static final String KEY_NAME = "name";

    interface Sink {
        void post(String text);
    }

    private final Activity activity;
    private final Sink sink;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final SharedPreferences prefs;

    /** Dials picked in this run, by token: the only addresses connect() accepts. */
    private final Map<String, String> known = new HashMap<>();

    // The chooser, while it is open.
    private int requestId;
    private boolean requestOpen;
    private AlertDialog dialog;
    private ScanCallback scan;
    private final List<String[]> found = new ArrayList<>();   // {address, name}
    private ArrayAdapter<String> foundAdapter;

    // The connection.
    private BluetoothGatt gatt;
    private String gattToken;
    private int connectId;                   // waiting for services, or 0
    private Runnable connectTimeout;
    private final Map<String, BluetoothGattCharacteristic> chars = new HashMap<>();

    // GATT operations, one at a time.
    private final ArrayDeque<Op> ops = new ArrayDeque<>();
    private Op op;
    private Runnable opTimeout;

    private abstract static class Op {
        final int id;
        Op(int id) { this.id = id; }
        /** Starts the operation; false if Android refused to. */
        abstract boolean start();
    }

    DialBluetooth(Activity activity, Sink sink) {
        this.activity = activity;
        this.sink = sink;
        this.prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Whether to offer the Dial over Bluetooth in this receiver at all. */
    static boolean offered(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false;
        if (!context.getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) return false;
        return adapter(context) != null;
    }

    private static BluetoothAdapter adapter(Context context) {
        BluetoothManager manager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    private boolean granted() {
        return activity.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
                && activity.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    // ---- the page --------------------------------------------------------------

    /** A message from the page; always on the main thread. */
    void onMessage(String type, JSONObject message) {
        int id = message.optInt("id", 0);
        String device = message.optString("device", "");
        switch (type) {
            case "ble-request":
                request(id);
                break;
            case "ble-devices":
                devices(id);
                break;
            case "ble-connect":
                connect(id, device);
                break;
            case "ble-notify":
                notify(id, device, message.optString("char", ""));
                break;
            case "ble-write":
                write(id, device, message.optString("char", ""), message.optString("value", ""),
                        message.optBoolean("response", true));
                break;
            case "ble-disconnect":
                // Quietly: the page already knows, and an echo arriving after
                // it had started connecting again would cancel that attempt.
                if (device.equals(gattToken)) disconnect(true);
                break;
            default:
                break;
        }
    }

    private void reply(int id, JSONObject body) {
        try {
            body.put("id", id);
        } catch (JSONException e) {
            return;
        }
        sink.post("ble-reply:" + body);
    }

    private void fail(int id, String name, String message) {
        try {
            JSONObject error = new JSONObject().put("name", name).put("message", message);
            reply(id, new JSONObject().put("error", error));
        } catch (JSONException e) {
            // not reachable with these values
        }
    }

    private static JSONObject deviceJson(String token, String name) throws JSONException {
        return new JSONObject().put("id", token).put("name", name == null || name.isEmpty() ? "UberSDR Dial" : name);
    }

    /** An opaque, stable name for an address: the page never sees the address. */
    static String token(String address) {
        try {
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            byte[] digest = sha.digest(("ubersdr-dial:" + address).getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder("dial-");
            for (int i = 0; i < 8; i++) sb.append(String.format("%02x", digest[i] & 0xff));
            return sb.toString();
        } catch (Exception e) {
            return "dial-" + Integer.toHexString(address.hashCode());
        }
    }

    // ---- remembered dial ---------------------------------------------------------

    private void devices(int id) {
        JSONArray list = new JSONArray();
        String address = prefs.getString(KEY_ADDRESS, null);
        BluetoothAdapter adapter = adapter(activity);
        // Nothing without the permission already held: this is the page's quiet
        // reconnect, and must never be the thing that shows a prompt.
        if (address != null && granted() && adapter != null && adapter.isEnabled()) {
            String token = token(address);
            known.put(token, address);
            try {
                list.put(deviceJson(token, prefs.getString(KEY_NAME, "")));
            } catch (JSONException e) {
                // leave it out
            }
        }
        try {
            reply(id, new JSONObject().put("devices", list));
        } catch (JSONException e) {
            // not reachable
        }
    }

    // ---- the chooser -------------------------------------------------------------

    private void request(int id) {
        if (requestOpen) {
            fail(id, "InvalidStateError", "a device chooser is already open");
            return;
        }
        requestOpen = true;
        requestId = id;
        if (!granted()) {
            activity.requestPermissions(new String[]{
                    Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT,
            }, REQUEST_PERMISSIONS);
            return;
        }
        afterPermission();
    }

    /** ReceiverActivity passes the answer to the Nearby devices prompt here. */
    void onPermissionsResult(boolean ok) {
        if (!requestOpen) return;
        if (!ok || !granted()) {
            endRequest();
            fail(requestId, "NotAllowedError",
                    "the app needs the Nearby devices permission to find the dial — allow it in the app's settings");
            return;
        }
        afterPermission();
    }

    private void afterPermission() {
        BluetoothAdapter adapter = adapter(activity);
        if (adapter == null) {
            endRequest();
            fail(requestId, "NotFoundError", "this phone has no Bluetooth");
            return;
        }
        if (!adapter.isEnabled()) {
            try {
                activity.startActivityForResult(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), REQUEST_ENABLE);
                return;
            } catch (Exception e) {
                endRequest();
                fail(requestId, "NotAllowedError", "Bluetooth is switched off");
                return;
            }
        }
        showChooser();
    }

    /** ReceiverActivity passes the answer to "turn Bluetooth on?" here. */
    void onEnableResult(boolean ok) {
        if (!requestOpen) return;
        BluetoothAdapter adapter = adapter(activity);
        if (!ok || adapter == null || !adapter.isEnabled()) {
            endRequest();
            fail(requestId, "NotAllowedError", "Bluetooth is switched off");
            return;
        }
        showChooser();
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                activity.getResources().getDisplayMetrics());
    }

    private void showChooser() {
        BluetoothAdapter adapter = adapter(activity);
        BluetoothLeScanner scanner = adapter == null ? null : adapter.getBluetoothLeScanner();
        if (scanner == null) {
            endRequest();
            fail(requestId, "NotAllowedError", "Bluetooth is switched off");
            return;
        }
        found.clear();
        foundAdapter = new ArrayAdapter<>(activity, android.R.layout.simple_list_item_1, new ArrayList<>());

        LinearLayout layout = new LinearLayout(activity);
        layout.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        layout.setPadding(pad, dp(8), pad, 0);
        TextView hint = new TextView(activity);
        hint.setText("Looking for dials… On the dial, choose Controller · Bluetooth.");
        hint.setPadding(0, 0, 0, dp(8));
        layout.addView(hint);
        ListView list = new ListView(activity);
        list.setAdapter(foundAdapter);
        list.setMinimumHeight(dp(96));
        layout.addView(list, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        list.setOnItemClickListener((parent, view, position, rowId) -> {
            if (position < 0 || position >= found.size()) return;
            picked(found.get(position));
        });

        dialog = new AlertDialog.Builder(activity)
                .setTitle("Connect to an UberSDR Dial")
                .setView(layout)
                .setNegativeButton(android.R.string.cancel, (d, which) -> d.cancel())
                .setOnCancelListener((d) -> {
                    if (!requestOpen) return;
                    endRequest();
                    fail(requestId, "NotFoundError", "no dial chosen");
                })
                .create();
        dialog.show();

        scan = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                main.post(() -> onFound(result));
            }

            @Override
            public void onBatchScanResults(List<ScanResult> results) {
                main.post(() -> {
                    for (ScanResult r : results) onFound(r);
                });
            }

            @Override
            public void onScanFailed(int errorCode) {
                main.post(() -> {
                    if (!requestOpen) return;
                    Log.w(TAG, "scan failed: " + errorCode);
                    hint.setText("Could not search for dials (error " + errorCode + "). Try again.");
                });
            }
        };
        ScanFilter filter = new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SERVICE)).build();
        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
        try {
            scanner.startScan(Collections.singletonList(filter), settings, scan);
        } catch (Exception e) {
            Log.w(TAG, "could not start a scan", e);
            hint.setText("Could not search for dials. Is Bluetooth on?");
        }
    }

    private void onFound(ScanResult result) {
        if (!requestOpen || foundAdapter == null || result == null || result.getDevice() == null) return;
        String address = result.getDevice().getAddress();
        String name = result.getScanRecord() == null ? null : result.getScanRecord().getDeviceName();
        if (name == null || name.isEmpty()) name = "UberSDR Dial";
        for (int i = 0; i < found.size(); i++) {
            if (found.get(i)[0].equals(address)) {
                // The name arrives with the scan response, after the first sighting.
                if (!found.get(i)[1].equals(name) && !"UberSDR Dial".equals(name)) {
                    found.get(i)[1] = name;
                    foundAdapter.remove(foundAdapter.getItem(i));
                    foundAdapter.insert(name, i);
                }
                return;
            }
        }
        found.add(new String[]{address, name});
        foundAdapter.add(name);
    }

    private void picked(String[] dial) {
        if (!requestOpen) return;
        int id = requestId;
        endRequest();
        String token = token(dial[0]);
        known.put(token, dial[0]);
        // The one remembered, as the desktop app does: the last dial picked.
        prefs.edit().putString(KEY_ADDRESS, dial[0]).putString(KEY_NAME, dial[1]).apply();
        try {
            reply(id, new JSONObject().put("device", deviceJson(token, dial[1])));
        } catch (JSONException e) {
            // not reachable
        }
    }

    private void endRequest() {
        requestOpen = false;
        stopScan();
        if (dialog != null) {
            AlertDialog d = dialog;
            dialog = null;
            try { d.dismiss(); } catch (Exception e) { /* the window has gone */ }
        }
        foundAdapter = null;
    }

    private void stopScan() {
        if (scan == null) return;
        ScanCallback s = scan;
        scan = null;
        try {
            BluetoothAdapter adapter = adapter(activity);
            BluetoothLeScanner scanner = adapter == null ? null : adapter.getBluetoothLeScanner();
            if (scanner != null && granted()) scanner.stopScan(s);
        } catch (Exception e) {
            // Bluetooth went off underneath: there is no scan to stop.
        }
    }

    // ---- the connection ----------------------------------------------------------

    private void connect(int id, String token) {
        String address = known.get(token);
        if (address == null) {
            fail(id, "NotFoundError", "that is not a dial picked here");
            return;
        }
        if (!granted()) {
            fail(id, "NotAllowedError", "the Nearby devices permission is not granted");
            return;
        }
        BluetoothAdapter adapter = adapter(activity);
        if (adapter == null || !adapter.isEnabled()) {
            fail(id, "NetworkError", "Bluetooth is switched off");
            return;
        }
        // One dial at a time: a second connect replaces the first.
        if (gatt != null) disconnect(true);

        BluetoothDevice device;
        try {
            device = adapter.getRemoteDevice(address);
        } catch (IllegalArgumentException e) {
            fail(id, "NotFoundError", "not a Bluetooth address");
            return;
        }
        gattToken = token;
        connectId = id;
        chars.clear();
        gatt = device.connectGatt(activity, false, callback, BluetoothDevice.TRANSPORT_LE);
        if (gatt == null) {
            connectId = 0;
            gattToken = null;
            fail(id, "NetworkError", "Android would not open a connection");
            return;
        }
        final BluetoothGatt mine = gatt;
        connectTimeout = () -> {
            if (gatt != mine || connectId == 0) return;
            int waiting = connectId;
            connectId = 0;
            closeGatt();
            fail(waiting, "NetworkError", "the dial did not answer — is it on, and in Controller · Bluetooth?");
        };
        main.postDelayed(connectTimeout, CONNECT_MS);
    }

    /**
     * Lets go of the dial. `quiet` when the page already knows — it asked, or
     * it has gone; otherwise the page is told the link dropped.
     */
    private void disconnect(boolean quiet) {
        String token = gattToken;
        if (connectId != 0) {
            int waiting = connectId;
            connectId = 0;
            fail(waiting, "AbortError", "the connection was cancelled");
        }
        closeGatt();
        if (!quiet && token != null) {
            sink.post("ble-disconnected:{\"device\":" + JSONObject.quote(token) + "}");
        }
    }

    private void closeGatt() {
        if (connectTimeout != null) {
            main.removeCallbacks(connectTimeout);
            connectTimeout = null;
        }
        failOps("the dial disconnected");
        chars.clear();
        BluetoothGatt g = gatt;
        gatt = null;
        gattToken = null;
        if (g != null) {
            try {
                g.disconnect();
                g.close();
            } catch (Exception e) {
                // already gone
            }
        }
    }

    /** The page has gone (a reload, or the Activity closing): let go of everything. */
    void close() {
        if (requestOpen) {
            endRequest();
            fail(requestId, "AbortError", "the page went away");
        }
        if (gatt != null) disconnect(true);
    }

    private final BluetoothGattCallback callback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            main.post(() -> onState(g, status, newState));
        }

        @Override
        public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
            main.post(() -> {
                if (g != gatt) return;
                Log.i(TAG, "MTU " + mtu + " (status " + status + ")");
                if (!g.discoverServices()) failConnect("could not read the dial's services");
            });
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            main.post(() -> onServices(g, status));
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor d, int status) {
            main.post(() -> {
                if (g == gatt) finishOp(status == BluetoothGatt.GATT_SUCCESS, "status " + status);
            });
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            main.post(() -> {
                if (g == gatt) finishOp(status == BluetoothGatt.GATT_SUCCESS, "status " + status);
            });
        }

        // API 33 and later. Not calling super: its default forwards to the
        // deprecated one below, which would deliver every value twice.
        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
            changed(g, c, value);
        }

        // Below 33, where the value is read off the characteristic, and must be
        // copied before the stack reuses it.
        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            byte[] v = c.getValue();
            changed(g, c, v == null ? new byte[0] : v.clone());
        }
    };

    private void changed(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
        String uuid = c.getUuid().toString();
        String value64 = Base64.encodeToString(value, Base64.NO_WRAP);
        main.post(() -> {
            if (g != gatt || gattToken == null) return;
            sink.post("ble-value:{\"device\":" + JSONObject.quote(gattToken)
                    + ",\"char\":" + JSONObject.quote(uuid)
                    + ",\"value\":" + JSONObject.quote(value64) + "}");
        });
    }

    private void onState(BluetoothGatt g, int status, int newState) {
        if (g != gatt) {
            // A connection already replaced or closed.
            try { g.close(); } catch (Exception e) { /* gone */ }
            return;
        }
        if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
            // A whole 172-byte waterfall line in one write, as the dial asks for.
            if (!g.requestMtu(MTU) && !g.discoverServices()) failConnect("could not read the dial's services");
            return;
        }
        if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
            if (connectId != 0) {
                failConnect("could not connect to the dial (status " + status + ")");
                return;
            }
            Log.i(TAG, "dial disconnected, status " + status);
            disconnect(false);
        }
    }

    private void failConnect(String message) {
        int waiting = connectId;
        connectId = 0;
        closeGatt();
        if (waiting != 0) fail(waiting, "NetworkError", message);
    }

    private void onServices(BluetoothGatt g, int status) {
        if (g != gatt || connectId == 0) return;
        BluetoothGattService service = status == BluetoothGatt.GATT_SUCCESS ? g.getService(SERVICE) : null;
        if (service == null) {
            int waiting = connectId;
            connectId = 0;
            closeGatt();
            fail(waiting, "NotFoundError", "that device is not an UberSDR Dial");
            return;
        }
        if (connectTimeout != null) {
            main.removeCallbacks(connectTimeout);
            connectTimeout = null;
        }
        JSONArray uuids = new JSONArray();
        for (BluetoothGattCharacteristic c : service.getCharacteristics()) {
            String uuid = c.getUuid().toString();
            chars.put(uuid, c);
            uuids.put(uuid);
        }
        int id = connectId;
        connectId = 0;
        try {
            JSONObject s = new JSONObject().put("uuid", SERVICE.toString()).put("chars", uuids);
            reply(id, new JSONObject().put("services", new JSONArray().put(s)));
        } catch (JSONException e) {
            // not reachable
        }
    }

    // ---- operations ----------------------------------------------------------------

    private BluetoothGattCharacteristic charFor(int id, String token, String uuid) {
        if (gatt == null || connectId != 0 || !token.equals(gattToken)) {
            fail(id, "NetworkError", "not connected");
            return null;
        }
        BluetoothGattCharacteristic c = chars.get(uuid.toLowerCase());
        if (c == null) fail(id, "NotFoundError", "no such characteristic on the dial");
        return c;
    }

    @SuppressWarnings("deprecation")
    private void notify(int id, String token, String uuid) {
        BluetoothGattCharacteristic c = charFor(id, token, uuid);
        if (c == null) return;
        enqueue(new Op(id) {
            @Override
            boolean start() {
                if (!gatt.setCharacteristicNotification(c, true)) return false;
                BluetoothGattDescriptor d = c.getDescriptor(CCCD);
                if (d == null) return false;
                byte[] on = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    return gatt.writeDescriptor(d, on) == BluetoothGatt.GATT_SUCCESS;
                }
                d.setValue(on);
                return gatt.writeDescriptor(d);
            }
        });
    }

    @SuppressWarnings("deprecation")
    private void write(int id, String token, String uuid, String value64, boolean response) {
        BluetoothGattCharacteristic c = charFor(id, token, uuid);
        if (c == null) return;
        byte[] value;
        try {
            value = Base64.decode(value64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            fail(id, "TypeError", "not base64");
            return;
        }
        if (value.length > 512) {
            fail(id, "InvalidModificationError", "value too long");
            return;
        }
        int type = response ? BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                : BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE;
        enqueue(new Op(id) {
            @Override
            boolean start() {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    return gatt.writeCharacteristic(c, value, type) == BluetoothGatt.GATT_SUCCESS;
                }
                c.setWriteType(type);
                c.setValue(value);
                return gatt.writeCharacteristic(c);
            }
        });
    }

    private void enqueue(Op next) {
        ops.add(next);
        if (op == null) runNext();
    }

    private void runNext() {
        while (op == null && !ops.isEmpty() && gatt != null) {
            Op next = ops.poll();
            boolean started;
            try {
                started = next.start();
            } catch (Exception e) {
                Log.w(TAG, "GATT operation threw", e);
                started = false;
            }
            if (!started) {
                fail(next.id, "NetworkError", "Android refused the operation");
                continue;
            }
            op = next;
            final Op mine = next;
            opTimeout = () -> {
                if (op != mine) return;
                finishOp(false, "the dial did not acknowledge");
            };
            main.postDelayed(opTimeout, OP_MS);
        }
    }

    private void finishOp(boolean ok, String detail) {
        Op done = op;
        if (done == null) return;
        op = null;
        if (opTimeout != null) {
            main.removeCallbacks(opTimeout);
            opTimeout = null;
        }
        if (ok) reply(done.id, new JSONObject());
        else fail(done.id, "NetworkError", "the dial refused the write (" + detail + ")");
        runNext();
    }

    private void failOps(String message) {
        if (opTimeout != null) {
            main.removeCallbacks(opTimeout);
            opTimeout = null;
        }
        Op current = op;
        op = null;
        if (current != null) fail(current.id, "NetworkError", message);
        while (!ops.isEmpty()) fail(ops.poll().id, "NetworkError", message);
    }
}
