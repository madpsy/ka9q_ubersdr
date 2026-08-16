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
 *
 * <p>The keyboard is the same problem and is dealt with in the same place. An
 * edge-to-edge window is not resized for the IME — that is what edge to edge
 * means — so without this the WebView keeps its full height and the keys are
 * simply drawn over the bottom of the page. Every text field low on the screen
 * was then untypeable: the Multipad's frequency box, the callsign lookup, the
 * bookmark search. Padding for the IME shortens the WebView instead, so the
 * page lays out in what is left and the field being typed into is on it, with
 * no page-side machinery at all — no visual-viewport arithmetic, no scrolling
 * things under the operator's finger, and nothing for a panel to remember to
 * do.
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
            Insets keyboard = insets.getInsets(WindowInsetsCompat.Type.ime());
            // The larger of the two, never their sum: the keyboard is drawn
            // over the navigation bar, so adding both would leave a gap the
            // height of the gesture bar between the page and the keys.
            int bottom = Math.max(bars.bottom, keyboard.bottom);
            view.setPadding(bars.left, bars.top, bars.right, bottom);
            return WindowInsetsCompat.CONSUMED;
        });
    }
}
