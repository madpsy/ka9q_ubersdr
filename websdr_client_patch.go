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
}

var websdrWaterfallJSWarnOnce sync.Once

// websdrPatchWaterfallJS applies websdrWaterfallJSPatches, returning the patched script
// and the `why` of every substitution that found nothing to replace.
func websdrPatchWaterfallJS(js []byte) ([]byte, []string) {
	var missed []string
	for _, p := range websdrWaterfallJSPatches {
		if !bytes.Contains(js, p.from) {
			missed = append(missed, p.why)
			continue
		}
		js = bytes.Replace(js, p.from, p.to, 1)
	}
	return js, missed
}

// serveWaterfallJS serves websdr-waterfall.js with the pan clamp enabled.
func (h *WebSDRHandler) serveWaterfallJS(w http.ResponseWriter, r *http.Request) {
	filePath := h.findStaticFile("websdr-waterfall.js")
	if filePath == "" {
		http.NotFound(w, r)
		return
	}
	data, err := os.ReadFile(filePath)
	if err != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	patched, missed := websdrPatchWaterfallJS(data)
	if len(missed) > 0 {
		websdrWaterfallJSWarnOnce.Do(func() {
			log.Printf("WebSDR: websdr-waterfall.js not patched (%v); zoom and pan can leave the band", missed)
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
	http.ServeContent(w, r, "websdr-waterfall.js", time.Time{}, bytes.NewReader(patched))
}
