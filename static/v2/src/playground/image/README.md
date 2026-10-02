# Image decoders (SSTV, WEFAX) and the image contract

Decoders here turn demodulated **audio** (a real signal, any sample rate the
decoder supports — at least 8000–48000 Hz) into pictures, for the playground's
Image viewer block. They are plain classes, no DOM, run in the worker.

## The decoder interface

```js
const d = new XxxDecoder({ sampleRate, ...options });
d.process(x, n);   // Float64Array of audio samples, n of them; any packet size
d.reset();
d.drain();         // the events since the last drain, oldest first
d.status();        // { state, mode, detail } — for the card
```

## Image events (what drain() returns, and what the blocks pass on as messages)

```js
{ type: 'image', event: 'start', id, mode, width, height, colour }
//   id: a string unique to this picture (e.g. `${mode}-${Date.now()}-${n}`)
//   mode: e.g. 'Martin 1', 'Scottie 1', 'Robot 36', 'PD 120', 'WEFAX 120/576'
//   width: pixels a line; height: lines expected, or null if not known (WEFAX)
//   colour: 'gray' (one byte a pixel) or 'rgb' (three bytes a pixel)
{ type: 'image', event: 'line', id, y, pixels }
//   y: the line's row, from 0; pixels: Uint8ClampedArray, width (gray) or 3·width (rgb)
//   A line may be sent again with the same y (a decoder correcting slant redraws).
{ type: 'image', event: 'end', id, complete }
//   complete: true when every line expected arrived; false if cut short
{ type: 'image', event: 'info', id, callsign }
//   Who sent it, learnt after the end (SSTV's FSK ID): attached to the picture
```

Other events a decoder may emit are allowed (e.g. `{ type: 'text', text }` for
the console: "VIS 44 — Martin 1", "START 576", "STOP").
