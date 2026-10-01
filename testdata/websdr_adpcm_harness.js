// Runs PA3FWM's unmodified websdr-sound.js under node and plays /~~stream messages
// into it, for websdr_adpcm_test.go.
//
//   node websdr_adpcm_harness.js websdr-sound.js [skip] < messages
//
// stdin is a run of [uint32 LE length][message]. stdout is JSON: the PCM the client
// decoded (int16 LE, base64, from its own recorder), its S-meter, and its rate.
//
// The recorder resamples from the rate it saw when recording started, so it keeps
// every sample only if the rate does not change after that. The 2014 client starts
// at 8000 Hz and keeps every sample only below 10 kHz; the 2025 client takes the rate
// in force at rec_start, so pass skip=N to start recording after the first N
// messages, once their 0x81 has arrived.
'use strict';
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(process.argv[2], 'utf8');
const skip = parseInt(process.argv[3] || '0', 10);
const input = fs.readFileSync(0);

// Just enough Web Audio for the client to set up a graph that never runs: the 2025
// client reads the context's state from its message handler.
const node = () => ({ connect() {}, disconnect() {} });
function AudioContext() {
  this.sampleRate = 48000;
  this.state = 'running';
  this.destination = node();
  this.createScriptProcessor = node;
  this.createConvolver = node;
  this.createGain = () => Object.assign(node(), { gain: { value: 1 } });
  this.createChannelMerger = node;
  this.createBuffer = () => ({ getChannelData: () => ({ set() {} }) });
  this.resume = () => {};
}

let ws = null;
const sandbox = {
  navigator: { userAgent: 'node' },
  location: { host: 'localhost' },
  document: {
    getElementById: (id) => (id === 'audiostartbutton' ? null : { innerHTML: '', style: {} }),
  },
  AudioContext,
  WebSocket: function (url) {
    ws = this;
    this.url = url;
    this.send = () => {};
    this.close = () => {};
  },
  newXMLHttpRequest: () => ({ open() {}, send() {} }), // 2025 client telemetry
  soundappletstarted: () => {},
  console,
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const applet = sandbox.soundapplet;
let fed = 0;
if (skip === 0) applet.rec_start();
for (let off = 0; off < input.length; ) {
  const n = input.readUInt32LE(off);
  off += 4;
  const msg = new Uint8Array(n);
  msg.set(input.subarray(off, off + n));
  off += n;
  ws.onmessage({ data: msg.buffer });
  if (++fed === skip) applet.rec_start();
}
const rec = applet.rec_finish();
const pcm = Buffer.concat(rec.wavdata.map((b) => Buffer.from(b)));
process.stdout.write(JSON.stringify({
  pcm: pcm.toString('base64'),
  smeter: applet.smeter(),
  rate: rec.sr,
  url: ws.url,
}));
