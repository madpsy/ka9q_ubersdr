package org.ubersdr.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * The chooser.
 *
 * <p>The whole of window.ubersdr is registered here rather than installed as a
 * package: the plugin is this client's own platform half, not a library, and
 * publishing it to npm to be consumed by the one app in the repository that
 * uses it would be ceremony. Registration has to happen before super.onCreate,
 * which is where the bridge is built.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(UberSdrPlugin.class);
        super.onCreate(savedInstanceState);
        SystemBars.inset(findViewById(android.R.id.content));
    }
}
