# Time-code decoders

Ports of ubersdr-ntp's decoders (`~/repos/ubersdr-ntp/src/clock/*.cpp`) for the
playground's Time code decoder block (`blocks/timecode.js`). Each runs on
complex IQ at 12 kHz with the station's carrier at `carrierOffsetHz` (0 when
the dial is on the carrier), one sample at a time, so packet sizes do not
matter. The block decimates wider streams to 12 kHz before them and maps edge
instants back.

Shared, not to be duplicated: `dsp.js` (RBJ biquads, cascades, a phasor
rotator, percentile, ring, parabola), `civil.js` (calendar arithmetic, leap
second possibility, EU summer time) and `voter.js` (TimeFrameVoter, its WWVB
and WWV field maps, `syntheticFrame` for the LF decoders' frames).

## The interface every decoder implements

```js
const d = new XxxDecoder({ sampleRate: 12000, carrierOffsetHz: 0, referenceNow: () => Date.now() /* or null */ });
d.process(re, im, n);   // Float64Array I and Q, n samples
d.reset();              // as new; the sample count restarts at 0
d.drain();              // the events since the last drain, oldest first
d.status();             // { state, station, snrDb, carrierOffsetHz, refusal, frames, detail }
```

`referenceNow` is the plausibility reference for the voter (±1440 minutes), as
Source.cpp arms it from the host clock; null disables the check.

Instants are **input sample indices**: the absolute count of samples given to
`process` since construction or `reset`, fractional where the decoder measures
finer than a sample, already corrected for every filter delay and station bias
the C++ or Source.cpp corrects for — so `edge` is the on-time instant of the
second as received.

Events:

```js
{ type: 'second', edge, measured, servable, symbol, conf, sof }
//   symbol: 'zero' | 'one' | 'marker' | 'unknown'; sof: second of frame, -1 until anchored
//   measured: the edge was measured this second, not coasted
//   servable: this edge is good enough to time by (the C++ edgeServable / tick timing)
{ type: 'frame', utcMs, startEdge, confidence, dut1Tenths, summer, leapPending }
//   a decoded minute: utcMs is UTC (Unix ms) of the frame's s0, startEdge that s0's edge
{ type: 'time', utcMs, edge, quality, sof }
//   the voted, certified time: UTC (Unix ms) at `edge`. Emitted whenever the C++ calls
//   onTime (every second while locked for the LF stations; WWV once a frame), with utcMs
//   composed as Source.cpp does: utc(voted fields) + round((edge - startEdge of the last
//   frame)/fs) s, refused across a possible leap second.
```

`status().state` is `'nosignal' | 'acquiring' | 'locked'`; `refusal` is the
voter's reason when not locked; `detail` is free-form diagnostics for the card
(SNRs, tick lock, carrier offset, frames in window…).
