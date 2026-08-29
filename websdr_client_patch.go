package main

// websdr_client_patch.go — serve-time fix-ups for the vendored WebSDR client.
//
// The files in websdr/ are PA3FWM's client, kept byte-for-byte as vendored so that a
// newer drop can replace them wholesale. Where the emulation needs one of them to behave
// differently, the change is made here, on the way out, rather than in the file — a fresh
// vendor drop then cannot silently lose it, and a substitution that stops matching is a
// test failure instead of a waterfall that goes quietly wrong.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"net/http"
	"os"
	"sync"
	"time"
)

// websdrJSPatch is one substitution, and the reason it exists.
type websdrJSPatch struct {
	from []byte
	to   []byte
	why  string
}

// websdrWaterfallJSPatches make the waterfall keep its view inside the band.
//
// websdr-waterfall.js declares a module-level flag `H` and gates all three of its offset
// clamps on it: drag (function N), wheel zoom (function w) and setzoom (function L). With
// the flag set the offset is bound to [0, band − screen] — at zoom 0 that is exactly 0, so
// a full zoom-out always lands on the whole band. With it clear, which is how the client
// ships, drag and zoom instead allow half a screen of overhang either side, and setzoom
// does not clamp at all.
//
// Zoom is anchored under the pointer, so with the overhang allowed a zoom-out leaves the
// band wherever the pointer happened to be and nothing ever brings it back. On the wide
// bands this emulation advertises that is very visible: 0 Hz stranded in the middle of the
// screen with negative frequencies to its left, or a 60 MHz receiver whose right-hand edge
// reads 50 MHz — a different wrong answer each time, because it depends on the mouse.
//
// websdrBand.ClampStart is the same rule applied server-side, for the clients this cannot
// reach.
var websdrWaterfallJSPatches = []websdrJSPatch{
	{
		from: []byte(",B=1,H=0;"),
		to:   []byte(",B=1,H=1;"),
		why:  "enable the client's own pan clamp",
	},
	{
		// The drag clamp measures the visible window as a hardcoded 1024 screen pixels
		// while the zoom clamp beside it uses a.width, the real canvas width. On a
		// desktop the two agree. websdr/m.html sizes its waterfall to the device width,
		// and there the wrong one pins the drag limit to 0 at zoom 0 and stops short of
		// the top of the band at every other zoom — so with the clamp switched on a
		// phone could no longer reach the right-hand end of the spectrum.
		from: []byte("g=(1024<<a.maxzoom)-(1024<<a.maxzoom-a.b)"),
		to:   []byte("g=(1024<<a.maxzoom)-(a.width<<a.maxzoom-a.b)"),
		why:  "measure the drag limit against the real waterfall width",
	},
	{
		// The client ships with its waterfall rate at the slowest of the three the
		// Speed selector offers, and websdr-controls.html leaves that option first
		// and unmarked so the browser selects it. Both carry the default and both
		// have to move, or the dropdown reads "fast" while the waterfall crawls.
		//
		// This costs CPU now in a way it did not before: the rate is no longer
		// advisory. applyPollDivisor turns it into session.PollDivisor, so radiod is
		// polled at the rate the client asks for, and each poll is a whole spectrum
		// response. Fast is four times slow. See websdrConn.applyPollDivisor.
		//
		// websdr/m.html is unaffected: it calls setslow(8) explicitly at load, which
		// overrides whatever this initialises.
		from: []byte(";b.A=4;b.setslow="),
		to:   []byte(";b.A=1;b.setslow="),
		why:  "default the waterfall rate to fast",
	},
}

// websdrControlsHTMLPatches keep the Speed selector showing what the client is
// actually doing.
//
// Same rule as the waterfall script: the vendored file stays byte-for-byte, the
// change is made on the way out, and a vendor drop that stops matching is a test
// failure rather than a control that quietly lies about the rate.
var websdrControlsHTMLPatches = []websdrJSPatch{
	{
		// No option carries `selected`, so the browser picks the first -- slow. The
		// waterfall script's initial rate is patched to match above.
		from: []byte(`<option value="1">fast</option>`),
		to:   []byte(`<option value="1" selected>fast</option>`),
		why:  "show fast as the selected waterfall speed",
	},
}

// websdrBaseJSPatches carry the waterfall rate that actually survives a zoom.
//
// The rate is written down in three places and they are not equivalent:
//
//	websdr-controls.html   which option the Speed selector shows
//	websdr-waterfall.js    b.A, the applet's own starting rate
//	websdr-base.js         waterslowness, the page's rate, and the one that wins
//
// waterfallspeed() returns early while waitingforwaterfalls > 0, so at page load it
// only records waterslowness and sends nothing -- the applet's b.A governs and the
// waterfall starts fast. But setband() and allwaterfallappletsstarted() call
// waterfallspeed(waterslowness) again later, and by then it does fire setslow(), which
// pushes the page-level default back over the applet's. So patching only the first two
// gives a waterfall that is fast until the first zoom and slow afterwards, until the
// user picks another speed and comes back -- which is the one action that finally
// assigns waterslowness.
var websdrBaseJSPatches = []websdrJSPatch{
	{
		from: []byte("var waterslowness=4;"),
		to:   []byte("var waterslowness=1;"),
		why:  "default the page's waterfall rate to fast",
	},
}

// websdrPatchControlsHTML applies websdrControlsHTMLPatches, returning the patched
// markup and the `why` of every substitution that found nothing to replace.
func websdrPatchControlsHTML(h []byte) ([]byte, []string) {
	return websdrApplyPatches(h, websdrControlsHTMLPatches)
}

// websdrApplyPatches makes each substitution once, and reports the `why` of any that
// found nothing to replace -- which is how a vendor drop that moved the anchor becomes
// a warning and a test failure rather than a silent loss of the behaviour.
func websdrApplyPatches(src []byte, patches []websdrJSPatch) ([]byte, []string) {
	var missed []string
	for _, p := range patches {
		if !bytes.Contains(src, p.from) {
			missed = append(missed, p.why)
			continue
		}
		src = bytes.Replace(src, p.from, p.to, 1)
	}
	return src, missed
}

var websdrControlsHTMLWarnOnce sync.Once

var websdrWaterfallJSWarnOnce sync.Once

// websdrPatchWaterfallJS applies websdrWaterfallJSPatches, returning the patched script
// and the `why` of every substitution that found nothing to replace.
func websdrPatchWaterfallJS(js []byte) ([]byte, []string) {
	return websdrApplyPatches(js, websdrWaterfallJSPatches)
}

// websdrPatchBaseJS applies websdrBaseJSPatches.
func websdrPatchBaseJS(js []byte) ([]byte, []string) {
	return websdrApplyPatches(js, websdrBaseJSPatches)
}

var websdrBaseJSWarnOnce sync.Once

// serveWaterfallJS serves websdr-waterfall.js with the pan clamp enabled.
func (h *WebSDRHandler) serveWaterfallJS(w http.ResponseWriter, r *http.Request) {
	h.servePatchedJS(w, r, "websdr-waterfall.js", websdrWaterfallJSPatches, &websdrWaterfallJSWarnOnce,
		"zoom and pan can leave the band")
}

// serveBaseJS serves websdr-base.js with the waterfall rate defaulted to fast.
func (h *WebSDRHandler) serveBaseJS(w http.ResponseWriter, r *http.Request) {
	h.servePatchedJS(w, r, "websdr-base.js", websdrBaseJSPatches, &websdrBaseJSWarnOnce,
		"the waterfall drops to the slowest rate on the first zoom")
}

func (h *WebSDRHandler) servePatchedJS(w http.ResponseWriter, r *http.Request, name string, patches []websdrJSPatch, once *sync.Once, consequence string) {
	filePath := h.findStaticFile(name)
	if filePath == "" {
		http.NotFound(w, r)
		return
	}
	data, err := os.ReadFile(filePath)
	if err != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	patched, missed := websdrApplyPatches(data, patches)
	if len(missed) > 0 {
		once.Do(func() {
			log.Printf("WebSDR: %s not patched (%v); %s", name, missed, consequence)
		})
	}

	// The bytes differ from the file on disk, and every browser that has already loaded
	// this page holds the unpatched copy, so identity has to come from the content
	// rather than from the file's mtime: no-cache to force the revalidation, an ETag so
	// that revalidation is a 304 on every load after the first.
	sum := sha256.Sum256(patched)
	w.Header().Set("Content-Type", "application/javascript")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("ETag", `"`+hex.EncodeToString(sum[:8])+`"`)
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(patched))
}
