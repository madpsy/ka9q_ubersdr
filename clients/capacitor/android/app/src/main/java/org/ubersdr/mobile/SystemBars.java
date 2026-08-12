package org.ubersdr.mobile;

import android.view.View;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

/**
 * Keeps the page out from under the status and navigation bars.
 *
 * <p>Android draws an app edge to edge from targetSdk 35, so without this the
 * chooser's header sits behind the clock and the footer behind the gesture bar.
 *
 * <p>It has to be done here rather than in CSS, which is the surprise: a WebView
 * maps only the <em>display cutout</em> to {@code env(safe-area-inset-*)}, never
 * the system bars. A page can therefore inset itself around a notch and has no
 * way to learn that there is a status bar above it — on a phone without a
 * cutout, every safe-area inset is zero while the top 24 dp of the page is
 * behind the clock.
 *
 * <p>So the two are split, and deliberately do not overlap: this pads for the
 * system bars only, and the cutout stays the page's business through
 * {@code env()} — mobile.css for the chooser, static/v2/src/styles.css for the
 * receiver, which already does it. Padding for both here would double the
 * inset in landscape, where the cutout is beside the bars rather than under
 * them.
 *
 * <p>The padding goes on the content view with the app's own background behind
 * it, so the strip under the status bar is the page's colour rather than
 * whatever the theme left there.
 */
final class SystemBars {

    // chooser.css's --bg, and static/v2's page background. Behind the bars,
    // where a mismatch reads as a band across the top of the screen.
    private static final int BACKGROUND = 0xFF0B0E14;

    private SystemBars() {}

    static void inset(View content) {
        content.setBackgroundColor(BACKGROUND);
        ViewCompat.setOnApplyWindowInsetsListener(content, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
    }
}
