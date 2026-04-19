/* ═══════════════════════════════════════════════════════════════════════════
   ⏳  TIME TRAVEL — 3D mountain terrain waterfall flythrough
   ═══════════════════════════════════════════════════════════════════════════
   Renders the spectrogram as a 3D mountain range: 0-30 MHz left→right, time
   recedes into the distance, signal strength = vertical height.

   Performance design:
   - All row samples are pre-computed ONCE when data loads (ttBuildCache).
     Each row is stored as a Float32Array of TT_SAMPLES normalised values.
   - Per-frame rendering only does canvas drawing — no getImageData calls.
   - Ridge lines are drawn as a single path with a horizontal gradient rather
     than per-segment strokeStyle changes (eliminates GPU state flushes).

   Speed table (1× = 24 rows/sec → 24h in 60 s):
     1×  = 24 r/s  → 60 s
     2×  = 48 r/s  → 30 s
     4×  = 96 r/s  → 15 s
     8×  = 192 r/s → 7.5 s
     16× = 384 r/s → 3.75 s
   ─────────────────────────────────────────────────────────────────────── */

/* ── Constants ──────────────────────────────────────────────────────────── */
var TT_SAMPLES = 160;        /* frequency sample points per row */
var TT_HEIGHT_SCALE = 0.40;  /* peak height as fraction of (groundY - vanishY) */
var TT_MIN_WFRAC = 0.30;     /* width fraction at maximum depth (front=1.0, back=TT_MIN_WFRAC, linear) */

/* ── State ──────────────────────────────────────────────────────────────── */
var ttInited = false;
var ttIsPlaying = false;
var ttCurrentRow = 0;
var ttSpeedMult = 1;
var ttBaseRowsPerSec = 24;
var ttLastFrameTs = null;
var ttRafId = null;
var ttMeta = null;
var ttBmp = null;
var ttDepthRows = 60;
var ttScrubDragging = false;
var ttKeyHandlerAttached = false;
var ttBand = 'wideband';

/* Pre-computed sample cache: ttSampleCache[rowIdx] = Float32Array(TT_SAMPLES) */
var ttSampleCache = null;

/* Pre-built gradient canvas for ridge colouring (palette strip) */
var ttPaletteCanvas = null;

/* Stars */
var ttStars = null;
var ttStarsW = 0, ttStarsH = 0;

/* ── Speed helpers ──────────────────────────────────────────────────────── */
function ttRowsPerSec() { return ttBaseRowsPerSec * ttSpeedMult; }

function ttSetSpeed(mult) {
  ttSpeedMult = mult;
  [1, 2, 4, 8, 16].forEach(function(m) {
    var btn = document.getElementById('tt-spd-' + m);
    if (btn) btn.classList.toggle('active', m === mult);
  });
}

/* ── Init ───────────────────────────────────────────────────────────────── */
function initTimeTravelTab() {
  if (ttInited) return;
  ttInited = true;

  var src = document.getElementById('dsel');
  var dst = document.getElementById('tt-dsel');
  if (src && dst) {
    dst.innerHTML = '';
    for (var i = 0; i < src.options.length; i++) {
      var o = document.createElement('option');
      o.value = src.options[i].value;
      o.textContent = src.options[i].textContent;
      dst.appendChild(o);
    }
    dst.value = src.value;
  }

  var bsrc = document.getElementById('bsel');
  var bdst = document.getElementById('tt-bsel');
  if (bsrc && bdst) {
    bdst.innerHTML = '';
    for (var j = 0; j < bsrc.options.length; j++) {
      var bo = document.createElement('option');
      bo.value = bsrc.options[j].value;
      bo.textContent = bsrc.options[j].textContent;
      if (bsrc.options[j].value === (typeof urlBand !== 'undefined' ? urlBand : 'wideband')) bo.selected = true;
      bdst.appendChild(bo);
    }
    ttBand = bdst.value || 'wideband';
  }

  ttResizeCanvas();
  window.addEventListener('resize', ttResizeCanvas);
  ttSetupScrubber();

  if (!ttKeyHandlerAttached) {
    ttKeyHandlerAttached = true;
    document.addEventListener('keydown', ttKeyHandler);
  }

  ttSetupHover();
  ttLoadData();
}

/* ── Canvas sizing ──────────────────────────────────────────────────────── */
function ttResizeCanvas() {
  var wrap = document.getElementById('tt-canvas-wrap');
  var c = document.getElementById('tt-canvas');
  var oc = document.getElementById('tt-overlay');
  if (!wrap || !c) return;
  var w = wrap.getBoundingClientRect().width || 800;
  var h = Math.min(Math.round(w * 0.54), 600);
  if (c.width !== Math.round(w) || c.height !== h) {
    c.width = Math.round(w);
    c.height = h;
    if (oc) { oc.width = Math.round(w); oc.height = h; }
    ttPaletteCanvas = null; /* rebuild gradient on next draw */
  }
  var sc = document.getElementById('tt-scrubber');
  var sw = document.getElementById('tt-scrubber-wrap');
  if (sc && sw) {
    var sw2 = sw.getBoundingClientRect().width || 800;
    sc.width = Math.round(sw2);
    sc.height = 44;
  }
  if (ttBmp && ttMeta) ttRedraw();
}

/* ── Data loading ───────────────────────────────────────────────────────── */
function ttOnDateChange() {
  ttBmp = null; ttMeta = null; ttSampleCache = null;
  ttLoadData();
}

function ttOnBandChange() {
  var bdst = document.getElementById('tt-bsel');
  ttBand = bdst ? bdst.value : 'wideband';
  ttBmp = null; ttMeta = null; ttSampleCache = null;
  ttLoadData();
}

function ttOnDepthChange() {
  var sel = document.getElementById('tt-depth');
  ttDepthRows = parseInt(sel ? sel.value : '60', 10) || 60;
  if (ttBmp && ttMeta) ttRedraw();
}

function ttSetStatus(s) {
  var el = document.getElementById('tt-status');
  if (el) el.textContent = s;
}

function ttLoadData() {
  var dsel = document.getElementById('tt-dsel');
  var ds = dsel ? dsel.value : '';
  var isRolling = (ds === 'rolling-24h');

  var mainDsel = document.getElementById('dsel');
  var mainDate = mainDsel ? mainDsel.value : '';
  var mainBand = (typeof urlBand !== 'undefined') ? urlBand : 'wideband';
  if (ds === mainDate && ttBand === mainBand &&
      typeof bmp !== 'undefined' && bmp &&
      typeof meta !== 'undefined' && meta) {
    ttBmp = bmp;
    ttMeta = meta;
    ttCurrentRow = 0;
    ttSetStatus('Building cache\u2026');
    ttBuildCache(function() {
      ttDrawScrubber();
      ttRedraw();
      ttSetStatus(ttMeta.row_count + ' rows (shared)');
    });
    return;
  }

  ttSetStatus('Loading\u2026');

  var mparams = [];
  if (isRolling) {
    mparams.push('rolling=1');
  } else if (ds && /^\d{4}-\d{2}-\d{2}$/.test(ds)) {
    mparams.push('date=' + encodeURIComponent(ds));
  }
  if (ttBand && ttBand !== 'wideband') mparams.push('band=' + encodeURIComponent(ttBand));
  var murl = '/api/spectrogram/meta' + (mparams.length ? '?' + mparams.join('&') : '');

  var psel = document.getElementById('psel');
  var pal = psel ? psel.value : 'jet';

  fetch(murl)
    .then(function(r) { if (!r.ok) throw new Error('meta ' + r.status); return r.json(); })
    .then(function(m) {
      ttMeta = m;
      var iurl = m.image_url;
      if (pal && pal !== m.palette) iurl += (iurl.indexOf('?') >= 0 ? '&' : '?') + 'palette=' + encodeURIComponent(pal);
      var today = new Date().toISOString().slice(0, 10);
      if (isRolling || !ds || ds === today) iurl += (iurl.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now();
      return fetch(iurl);
    })
    .then(function(r) { if (!r.ok) throw new Error('image ' + r.status); return r.blob(); })
    .then(function(b) { return createImageBitmap(b); })
    .then(function(b) {
      ttBmp = b;
      ttCurrentRow = 0;
      ttSetStatus('Building cache\u2026');
      ttBuildCache(function() {
        ttDrawScrubber();
        ttRedraw();
        ttSetStatus(ttMeta.row_count + ' rows \u00b7 ' + ttMeta.date);
      });
    })
    .catch(function(e) { ttSetStatus('Error: ' + e.message); });
}

/* ── Pre-compute sample cache ───────────────────────────────────────────── */
/* Reads the entire image once and builds ttSampleCache[row] = Float32Array.
   Done in chunks via setTimeout to avoid blocking the UI thread. */
function ttBuildCache(onDone) {
  if (!ttBmp || !ttMeta) { if (onDone) onDone(); return; }

  var totalRows = ttMeta.row_count;
  var imgW = ttBmp.width;
  var imgH = ttBmp.height;

  /* Draw image to an offscreen canvas for pixel access */
  var off = document.createElement('canvas');
  off.width = imgW; off.height = imgH;
  var offCtx = off.getContext('2d', { willReadFrequently: true });
  offCtx.drawImage(ttBmp, 0, 0);

  /* Read the entire image in one shot */
  var allPixels = offCtx.getImageData(0, 0, imgW, imgH).data;

  var lut = (typeof V !== 'undefined') ? V : null;
  var inv = (typeof INV !== 'undefined') ? INV : {};
  var lutLen = lut ? lut.length : 256;

  ttSampleCache = new Array(totalRows);

  var CHUNK = 100; /* rows per chunk */
  var row = 0;

  function processChunk() {
    var end = Math.min(row + CHUNK, totalRows);
    var srcRowH = imgH / totalRows;

    for (; row < end; row++) {
      var samples = new Float32Array(TT_SAMPLES);
      var srcY = Math.floor(row * srcRowH + srcRowH * 0.5);
      if (srcY >= imgH) srcY = imgH - 1;
      var rowBase = srcY * imgW * 4;

      for (var si = 0; si < TT_SAMPLES; si++) {
        var xFrac = si / (TT_SAMPLES - 1);
        var px = Math.min(Math.floor(xFrac * imgW), imgW - 1);
        var base = rowBase + px * 4;
        var r = allPixels[base], g = allPixels[base + 1], b = allPixels[base + 2];

        /* Pure black = missing data sentinel (not in palette). Mark as -1. */
        if (r === 0 && g === 0 && b === 0) { samples[si] = -1; continue; }

        var idx;
        if (lut) {
          var k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
          idx = inv[k];
          if (idx === undefined) {
            var bestDist = 1e9;
            idx = 0;
            for (var li = 0; li < lutLen; li++) {
              var dr = r - lut[li][0], dg = g - lut[li][1], db2 = b - lut[li][2];
              var dist = dr * dr + dg * dg + db2 * db2;
              if (dist < bestDist) { bestDist = dist; idx = li; }
            }
          }
          /* idx=0 → lut[0] colour (strong signal in jet), idx=255 → noise floor.
             Keep as-is: samples[si]=0 means strong signal, 1.0 means noise floor.
             Height uses (1-samples[si]) so strong signal = tall peak. */
          samples[si] = idx / (lutLen - 1);
        } else {
          samples[si] = g / 255;
        }
      }

      /* Mark gap rows as null. A gap row is one where most samples are the
         missing-data sentinel (-1). Replace sentinels with 0 for rendering. */
      var sentinelCount = 0;
      for (var zi = 0; zi < TT_SAMPLES; zi++) {
        if (samples[zi] < 0) { sentinelCount++; samples[zi] = 0; }
      }
      ttSampleCache[row] = (sentinelCount > TT_SAMPLES * 0.8) ? null : samples;
    }

    if (row < totalRows) {
      ttSetStatus('Building cache\u2026 ' + Math.round(row / totalRows * 100) + '%');
      setTimeout(processChunk, 0);
    } else {
      if (onDone) onDone();
    }
  }

  processChunk();
}

/* ── Build palette gradient canvas ─────────────────────────────────────── */
/* Creates a 1×256 canvas strip with the current palette colours.
   Used to create horizontal gradients for ridge lines efficiently. */
function ttBuildPaletteCanvas() {
  var lut = (typeof V !== 'undefined') ? V : null;
  if (!lut) return null;
  var pc = document.createElement('canvas');
  pc.width = lut.length; pc.height = 1;
  var pctx = pc.getContext('2d');
  var id = pctx.createImageData(lut.length, 1);
  for (var i = 0; i < lut.length; i++) {
    id.data[i * 4]     = Math.min(255, Math.round(lut[i][0] * 1.4));
    id.data[i * 4 + 1] = Math.min(255, Math.round(lut[i][1] * 1.4));
    id.data[i * 4 + 2] = Math.min(255, Math.round(lut[i][2] * 1.4));
    id.data[i * 4 + 3] = 255;
  }
  pctx.putImageData(id, 0, 0);
  return pc;
}

/* ── Playback ───────────────────────────────────────────────────────────── */
function ttTogglePlay() {
  if (ttIsPlaying) ttPause(); else ttPlay();
}

function ttPlay() {
  if (!ttSampleCache) { ttSetStatus('Cache not ready yet.'); return; }
  if (ttMeta && ttCurrentRow >= ttMeta.row_count - 1) ttCurrentRow = 0;
  ttIsPlaying = true;
  ttLastFrameTs = null;
  var btn = document.getElementById('tt-play-btn');
  if (btn) {
    btn.textContent = '\u23F8 Pause';
    btn.style.background = 'rgba(255,100,0,.25)';
    btn.style.borderColor = 'rgba(255,150,0,.6)';
    btn.style.color = '#fa0';
  }
  ttRafId = requestAnimationFrame(ttFrame);
}

function ttPause() {
  ttIsPlaying = false;
  if (ttRafId) { cancelAnimationFrame(ttRafId); ttRafId = null; }
  var btn = document.getElementById('tt-play-btn');
  if (btn) {
    btn.textContent = '\u25B6 Play';
    btn.style.background = 'rgba(0,220,255,.2)';
    btn.style.borderColor = 'rgba(0,220,255,.5)';
    btn.style.color = '#0ff';
  }
}

function ttFrame(ts) {
  if (!ttIsPlaying) return;
  if (ttLastFrameTs !== null) {
    var dt = (ts - ttLastFrameTs) / 1000;
    if (dt > 0.1) dt = 0.1;
    ttCurrentRow += dt * ttRowsPerSec();
    if (ttMeta && ttCurrentRow >= ttMeta.row_count) {
      ttCurrentRow = ttMeta.row_count - 1;
      ttPause();
    }
  }
  ttLastFrameTs = ts;
  ttRedraw();
  if (ttIsPlaying) ttRafId = requestAnimationFrame(ttFrame);
}

/* ── Main 3D mountain terrain draw ─────────────────────────────────────── */
function ttRedraw() {
  var c = document.getElementById('tt-canvas');
  if (!c) return;
  var ctx = c.getContext('2d');
  if (!ctx) return;

  var W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);

  /* Sky gradient */
  var sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#000814');
  sky.addColorStop(0.6, '#001428');
  sky.addColorStop(1, '#000a1a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  ttDrawStars(ctx, W, H);

  if (!ttSampleCache || !ttMeta || ttMeta.row_count === 0) {
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.font = '15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(ttSampleCache === null ? 'Loading\u2026' : 'No data \u2014 select a date and band above', W / 2, H / 2);
    ctx.textAlign = 'left';
    ttUpdateHUD();
    return;
  }

  /* ── Perspective parameters ─────────────────────────────────────────── */
  var vanishX = W * 0.5;
  var vanishY = H * 0.20;
  var groundY = H * 0.86;
  var frontHalfW = W * 0.5;
  var maxPeakH = (groundY - vanishY) * TT_HEIGHT_SCALE;

  var totalRows = ttMeta.row_count;
  var depthRows = Math.min(ttDepthRows, totalRows);

  var showBandsEl = document.getElementById('tt-show-bands');
  var showGridEl = document.getElementById('tt-show-grid');
  var doBands = showBandsEl ? showBandsEl.checked : true;
  var doGrid = showGridEl ? showGridEl.checked : true;

  var startHz = ttMeta.start_freq_hz || 0;
  var spanHz = (ttMeta.end_freq_hz || 30e6) - startHz;
  if (spanHz <= 0) spanHz = 30e6;

  /* Ensure palette canvas is built */
  if (!ttPaletteCanvas) ttPaletteCanvas = ttBuildPaletteCanvas();

  /* ── Perspective grid (behind mountains) ────────────────────────────── */
  if (doGrid) {
    ctx.save();
    ctx.strokeStyle = 'rgba(0,150,220,0.10)';
    ctx.lineWidth = 1;
    /* Vertical grid lines: front edge at groundY, back edge at vanishY row width */
    var backHalfW = frontHalfW * TT_MIN_WFRAC;
    var backY2 = groundY - (groundY - vanishY) * 1.0; /* = vanishY */
    var gridFreqs = [0, 5e6, 10e6, 15e6, 20e6, 25e6, 30e6];
    for (var gi = 0; gi < gridFreqs.length; gi++) {
      var gf = gridFreqs[gi];
      if (gf < startHz || gf > startHz + spanHz) continue;
      var gfrac = (gf - startHz) / spanHz;
      var gxFront = vanishX - frontHalfW + gfrac * frontHalfW * 2;
      var gxBack  = vanishX - backHalfW  + gfrac * backHalfW  * 2;
      ctx.beginPath();
      ctx.moveTo(gxFront, groundY);
      ctx.lineTo(gxBack, backY2);
      ctx.stroke();
    }
    var hStep = Math.max(1, Math.round(depthRows / 8));
    for (var hi = 0; hi <= depthRows; hi += hStep) {
      var hd = hi / depthRows;
      var hy = groundY - (groundY - vanishY) * hd;
      var hwFrac = 1 - hd * (1 - TT_MIN_WFRAC);
      var hxL = vanishX - frontHalfW * hwFrac;
      var hxR = vanishX + frontHalfW * hwFrac;
      ctx.beginPath();
      ctx.moveTo(hxL, hy); ctx.lineTo(hxR, hy);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ── Draw mountain rows back-to-front ───────────────────────────────── */
  var frontRow = Math.round(ttCurrentRow);

  for (var di = depthRows - 1; di >= 0; di--) {
    var d = di / depthRows;
    var baseY = groundY - (groundY - vanishY) * d;
    var wFrac = 1 - d * (1 - TT_MIN_WFRAC);
    var xL = vanishX - frontHalfW * wFrac;
    var xR = vanishX + frontHalfW * wFrac;
    var rowW = xR - xL;
    if (rowW < 1) continue;

    var rowIdx = frontRow - di;
    if (rowIdx < 0 || rowIdx >= totalRows) continue;

    var samples = ttSampleCache[rowIdx];
    if (!samples) continue;

    /* Scale peak height and fog with wFrac so distant rows look proportionally smaller */
    var peakH = maxPeakH * wFrac;
    var fogAlpha = wFrac * 0.94 + 0.06;

    /* ── Compute screen points ──────────────────────────────────────── */
    var ptsX = new Float32Array(TT_SAMPLES);
    var ptsY = new Float32Array(TT_SAMPLES);
    for (var si = 0; si < TT_SAMPLES; si++) {
      ptsX[si] = xL + (si / (TT_SAMPLES - 1)) * rowW;
      ptsY[si] = baseY - samples[si] * peakH;
    }

    ctx.save();
    ctx.globalAlpha = fogAlpha;

    /* ── Filled silhouette (occludes rows behind) ───────────────────── */
    /* Anchor to groundY (not baseY) so the fill extends to the absolute
       canvas bottom, eliminating gaps between consecutive perspective rows. */
    ctx.beginPath();
    ctx.moveTo(xL, groundY);
    ctx.lineTo(xL, baseY);
    for (var pi = 0; pi < TT_SAMPLES; pi++) {
      ctx.lineTo(ptsX[pi], ptsY[pi]);
    }
    ctx.lineTo(xR, baseY);
    ctx.lineTo(xR, groundY);
    ctx.closePath();
    /* Solid dark fill — this is what occludes distant rows */
    ctx.fillStyle = '#000810';
    ctx.fill();

    /* ── Ridge line with vertical gradient ─────────────────────────── */
    /* A vertical gradient from baseY (signal=0) to baseY-peakH (signal=1)
       means each point on the ridge picks up the exact palette colour for
       its signal value — no averaging, no boost distortion.
       lut[0] (often red) sits at the very bottom and is never reached
       because the silhouette fill already covers that area. */
    var lut = (typeof V !== 'undefined') ? V : null;
    if (lut && rowW > 1) {
      /* Gradient runs from baseY (bottom, stop=0) to topY (top, stop=1).
         gsVal=0 → noise floor → stop near 0 (bottom).
         gsVal=1 → strong signal → stop near 1 (top).
         So stopPos = gsVal directly. */
      var topY = baseY - peakH;
      var ridgeGrad = ctx.createLinearGradient(0, baseY, 0, topY);
      var GSTOPS = 16;
      for (var gs = 0; gs <= GSTOPS; gs++) {
        var gsVal = gs / GSTOPS;   /* signal value 0→1 */
        var stopPos = gsVal;       /* stop 0=bottom(baseY), stop 1=top(topY) */
        /* Gradient: stop 0=baseY(bottom,low signal), stop 1=topY(top,high signal).
           gsVal=1 (top/peak) → lut[255], gsVal=0 (bottom/noise) → transparent.
           Fade out the bottom 10%. */
        if (gsVal < 0.10) {
          ridgeGrad.addColorStop(stopPos, 'rgba(0,0,0,0)');
        } else {
          var lutIdx = Math.min(lut.length - 1, Math.round(gsVal * (lut.length - 1)));
          var rc = lut[lutIdx][0], gc2 = lut[lutIdx][1], bc = lut[lutIdx][2];
          ridgeGrad.addColorStop(stopPos, 'rgb(' + rc + ',' + gc2 + ',' + bc + ')');
        }
      }

      ctx.beginPath();
      ctx.moveTo(ptsX[0], ptsY[0]);
      for (var ri = 1; ri < TT_SAMPLES; ri++) {
        ctx.lineTo(ptsX[ri], ptsY[ri]);
      }
      ctx.strokeStyle = ridgeGrad;
      ctx.lineWidth = Math.max(1, 1.8 * wFrac);
      ctx.stroke();
    }

    ctx.restore();

  }

  /* ── Band overlay curtains (drawn ONCE after all rows) ──────────────── */
  /* Each band is a perspective-projected trapezoid spanning the full depth,
     drawn as a very faint tinted "curtain" receding to the vanishing point.
     Alpha is kept very low so it's a subtle tint, not a solid column. */
  if (doBands && typeof BANDS !== 'undefined') {
    var bandColors = [
      'rgba(255,200,0,1)', 'rgba(0,200,255,1)', 'rgba(0,255,120,1)',
      'rgba(255,80,200,1)', 'rgba(255,140,0,1)', 'rgba(100,180,255,1)',
      'rgba(180,255,80,1)', 'rgba(255,80,80,1)'
    ];
    /* Front row geometry (d=0) */
    var frontWFrac = 1.0; /* Math.pow(1-0, 1.3) = 1 */
    var frontXL = vanishX - frontHalfW * frontWFrac;
    var frontXR = vanishX + frontHalfW * frontWFrac;
    var frontRowW = frontXR - frontXL;

    ctx.save();
    ctx.globalAlpha = 0.07;
    for (var bi = 0; bi < BANDS.length; bi++) {
      var bf0 = (BANDS[bi][0] - startHz) / spanHz;
      var bf1 = (BANDS[bi][1] - startHz) / spanHz;
      if (bf1 < 0 || bf0 > 1) continue;
      bf0 = Math.max(0, bf0); bf1 = Math.min(1, bf1);

      /* Front edge X positions */
      var bFrontX0 = frontXL + bf0 * frontRowW;
      var bFrontX1 = frontXL + bf1 * frontRowW;

      /* Back edge at full depth: wFrac = TT_MIN_WFRAC (linear formula) */
      var backWFrac = TT_MIN_WFRAC; /* 1 - 1*(1-TT_MIN_WFRAC) = TT_MIN_WFRAC */
      var backXL2 = vanishX - frontHalfW * backWFrac;
      var backRowW2 = (vanishX + frontHalfW * backWFrac) - backXL2;
      var bBackX0 = backXL2 + bf0 * backRowW2;
      var bBackX1 = backXL2 + bf1 * backRowW2;
      var backY = groundY - (groundY - vanishY) * 1.0;

      ctx.fillStyle = bandColors[bi % bandColors.length];
      ctx.beginPath();
      ctx.moveTo(bFrontX0, groundY);
      ctx.lineTo(bFrontX1, groundY);
      ctx.lineTo(bBackX1, backY);
      ctx.lineTo(bBackX0, backY);
      ctx.closePath();
      ctx.fill();

      /* Also draw a thin vertical line at the band edges for definition */
      ctx.globalAlpha = 0.18;
      ctx.strokeStyle = bandColors[bi % bandColors.length];
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bFrontX0, groundY); ctx.lineTo(bBackX0, backY);
      ctx.moveTo(bFrontX1, groundY); ctx.lineTo(bBackX1, backY);
      ctx.stroke();
      ctx.globalAlpha = 0.07;
    }
    ctx.restore();
  }

  /* ── NOW edge glow ──────────────────────────────────────────────────── */
  ctx.save();
  ctx.shadowColor = '#0ff';
  ctx.shadowBlur = 16;
  ctx.strokeStyle = 'rgba(0,255,255,0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, groundY); ctx.lineTo(W, groundY);
  ctx.stroke();
  var pulse = 0.55 + 0.45 * Math.sin(Date.now() / 380);
  ctx.shadowBlur = 24 * pulse;
  ctx.fillStyle = 'rgba(0,255,255,' + pulse.toFixed(2) + ')';
  ctx.beginPath();
  ctx.arc(W / 2, groundY, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  /* ── Vignette ───────────────────────────────────────────────────────── */
  var vigTop = ctx.createLinearGradient(0, 0, 0, H * 0.35);
  vigTop.addColorStop(0, 'rgba(0,8,20,0.88)');
  vigTop.addColorStop(1, 'rgba(0,8,20,0)');
  ctx.fillStyle = vigTop;
  ctx.fillRect(0, 0, W, H * 0.35);

  var vigL = ctx.createLinearGradient(0, 0, W * 0.05, 0);
  vigL.addColorStop(0, 'rgba(0,8,20,0.7)'); vigL.addColorStop(1, 'rgba(0,8,20,0)');
  ctx.fillStyle = vigL; ctx.fillRect(0, 0, W * 0.05, H);

  var vigR = ctx.createLinearGradient(W, 0, W * 0.95, 0);
  vigR.addColorStop(0, 'rgba(0,8,20,0.7)'); vigR.addColorStop(1, 'rgba(0,8,20,0)');
  ctx.fillStyle = vigR; ctx.fillRect(W * 0.95, 0, W * 0.05, H);

  /* ── Frequency labels ───────────────────────────────────────────────── */
  /* Auto-pick a step size that gives ~5-8 labels across the visible span */
  ctx.save();
  ctx.fillStyle = 'rgba(0,220,255,0.65)';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';

  var endHz = startHz + spanHz;
  /* Choose a nice round step that gives ~20 tick marks across the span.
     The candidate list covers 1 kHz (very narrow) up to 10 MHz (full HF). */
  var rawStep = spanHz / 20;
  var niceSteps = [1e3, 2e3, 5e3, 10e3, 20e3, 25e3, 50e3,
                   100e3, 200e3, 250e3, 500e3,
                   1e6, 2e6, 2.5e6, 5e6, 10e6];
  var labelStep = niceSteps[niceSteps.length - 1];
  for (var ni = 0; ni < niceSteps.length; ni++) {
    if (niceSteps[ni] >= rawStep) { labelStep = niceSteps[ni]; break; }
  }
  /* Format: kHz when span < 2 MHz, MHz otherwise */
  var useKHz = spanHz < 2e6;
  var firstTick = Math.ceil(startHz / labelStep) * labelStep;
  for (var lf = firstTick; lf <= endHz + 1; lf += labelStep) {
    var lfrac = (lf - startHz) / spanHz;
    if (lfrac < 0 || lfrac > 1) continue;
    var lx = vanishX - frontHalfW + lfrac * frontHalfW * 2;
    var labelStr = useKHz
      ? (Math.round(lf / 1e3)) + ' kHz'
      : (Math.round(lf / 1e6 * 10) / 10) + ' MHz';
    ctx.fillText(labelStr, lx, groundY + 14);
  }
  ctx.restore();

  ttUpdateHUD();
  ttDrawScrubber();
}

/* ── Starfield ──────────────────────────────────────────────────────────── */
function ttDrawStars(ctx, W, H) {
  if (!ttStars || ttStarsW !== W || ttStarsH !== H) {
    ttStarsW = W; ttStarsH = H;
    ttStars = [];
    var rng = 0xdeadbeef;
    function rand() { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return (rng >>> 0) / 0xffffffff; }
    for (var i = 0; i < 120; i++) {
      ttStars.push({ x: rand() * W, y: rand() * H * 0.42, r: rand() * 1.2 + 0.3, a: rand() * 0.5 + 0.2 });
    }
  }
  ctx.save();
  for (var si = 0; si < ttStars.length; si++) {
    var s = ttStars[si];
    ctx.globalAlpha = s.a;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/* ── HUD update ─────────────────────────────────────────────────────────── */
function ttUpdateHUD() {
  var hud = document.getElementById('tt-hud');
  var hudDate = document.getElementById('tt-hud-date');
  if (!hud) return;
  if (!ttMeta || !ttMeta.rows || ttMeta.rows.length === 0) {
    hud.textContent = '--:-- UTC';
    return;
  }
  var row = Math.max(0, Math.min(Math.round(ttCurrentRow), ttMeta.row_count - 1));
  var rowMeta = ttMeta.rows[row];
  if (rowMeta && rowMeta.unix) {
    var d = new Date(rowMeta.unix * 1000);
    hud.textContent =
      String(d.getUTCHours()).padStart(2, '0') + ':' +
      String(d.getUTCMinutes()).padStart(2, '0') + ':' +
      String(d.getUTCSeconds()).padStart(2, '0') + ' UTC';
    if (hudDate) hudDate.textContent = ttMeta.date || '';
  } else {
    var utcMin = row;
    hud.textContent =
      String(Math.floor(utcMin / 60) % 24).padStart(2, '0') + ':' +
      String(utcMin % 60).padStart(2, '0') + ':00 UTC';
  }
}

/* ── Scrubber ───────────────────────────────────────────────────────────── */
function ttDrawScrubber() {
  var sc = document.getElementById('tt-scrubber');
  if (!sc) return;
  var ctx = sc.getContext('2d');
  var W = sc.width, H = sc.height;
  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(0,0,0,.65)';
  ctx.fillRect(0, 0, W, H);

  if (ttBmp) {
    ctx.drawImage(ttBmp, 0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,.38)';
    ctx.fillRect(0, 0, W, H);
  }

  if (ttMeta && ttMeta.rows && ttMeta.rows.length > 0) {
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    for (var li = 0; li <= 8; li++) {
      var lf = li / 8;
      var lrow = Math.round(lf * (ttMeta.row_count - 1));
      var lx = lf * W;
      var rowM = ttMeta.rows[lrow];
      if (rowM && rowM.unix) {
        var ld = new Date(rowM.unix * 1000);
        var lt = String(ld.getUTCHours()).padStart(2, '0') + ':' + String(ld.getUTCMinutes()).padStart(2, '0');
        ctx.fillText(lt, lx, H - 3);
      }
    }
  }

  if (ttMeta && ttMeta.row_count > 0) {
    var px = (ttCurrentRow / ttMeta.row_count) * W;
    ctx.save();
    ctx.shadowColor = '#0ff';
    ctx.shadowBlur = 8;
    ctx.strokeStyle = 'rgba(0,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0); ctx.lineTo(px, H);
    ctx.stroke();
    ctx.fillStyle = '#0ff';
    ctx.beginPath();
    ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 8);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function ttSetupScrubber() {
  var sw = document.getElementById('tt-scrubber-wrap');
  var sc = document.getElementById('tt-scrubber');
  if (!sw || !sc) return;

  function ttScrubSeek(e) {
    if (!ttMeta || ttMeta.row_count === 0) return;
    var rect = sc.getBoundingClientRect();
    var clientX = (e.touches && e.touches[0]) ? e.touches[0].clientX : e.clientX;
    var frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    ttCurrentRow = frac * (ttMeta.row_count - 1);
    ttLastFrameTs = null;
    ttRedraw();
  }

  sw.addEventListener('mousedown', function(e) { ttScrubDragging = true; ttScrubSeek(e); e.preventDefault(); });
  window.addEventListener('mousemove', function(e) { if (ttScrubDragging) ttScrubSeek(e); });
  window.addEventListener('mouseup', function() { ttScrubDragging = false; });
  sw.addEventListener('touchstart', function(e) { ttScrubDragging = true; ttScrubSeek(e); e.preventDefault(); }, { passive: false });
  sw.addEventListener('touchmove', function(e) { if (ttScrubDragging) { ttScrubSeek(e); e.preventDefault(); } }, { passive: false });
  sw.addEventListener('touchend', function() { ttScrubDragging = false; });
}

/* ── Hover tooltip ──────────────────────────────────────────────────────── */
function ttSetupHover() {
  var wrap = document.getElementById('tt-canvas-wrap');
  var c = document.getElementById('tt-canvas');
  var tt = document.getElementById('tt');
  if (!wrap || !c || !tt) return;

  wrap.addEventListener('mousemove', function(e) {
    if (!ttMeta || !ttSampleCache) return;
    var rect = c.getBoundingClientRect();
    var xp = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

    var startHz = ttMeta.start_freq_hz || 0;
    var spanHz = (ttMeta.end_freq_hz || 30e6) - startHz;
    var hz = startHz + xp * spanHz;
    var mhz = (hz / 1e6).toFixed(4);
    var band = (typeof bandName === 'function') ? bandName(hz) : null;

    var row = Math.max(0, Math.min(Math.round(ttCurrentRow), ttMeta.row_count - 1));
    var rowMeta = ttMeta.rows && ttMeta.rows[row];
    var tstr;
    if (rowMeta && rowMeta.unix) {
      var d = new Date(rowMeta.unix * 1000);
      tstr = String(d.getUTCHours()).padStart(2, '0') + ':' +
             String(d.getUTCMinutes()).padStart(2, '0') + ' UTC';
    } else {
      tstr = String(Math.floor(row / 60)).padStart(2, '0') + ':' +
             String(row % 60).padStart(2, '0') + ' UTC';
    }

    /* Get signal from cache */
    var sig = null;
    var samples = ttSampleCache[row];
    if (samples) {
      var si2 = Math.min(TT_SAMPLES - 1, Math.round(xp * (TT_SAMPLES - 1)));
      var normVal = samples[si2];
      var dbMin = ttMeta.db_min, dbMax = ttMeta.db_max;
      if (typeof contrastUserChanged !== 'undefined' && contrastUserChanged) {
        dbMin = contrastMin; dbMax = contrastMax;
      }
      sig = dbMin + normVal * (dbMax - dbMin);
    }

    var h = '<div class="tt-freq">' + mhz + ' MHz' +
            (band ? ' <span style="opacity:.55;font-size:.9em">(' + band + ')</span>' : '') + '</div>';
    h += '<div class="tt-time">' + tstr + '</div>';
    if (sig !== null) {
      h += '<div class="tt-sep"></div>';
      h += '<div class="tt-row"><span class="tt-lbl">Signal</span><span class="tt-val">' + sig.toFixed(1) + ' dBFS</span></div>';
    }
    tt.innerHTML = h;
    tt.style.display = 'block';

    var tw = 180, th = 90;
    var tx = e.clientX + 16, ty = e.clientY - 10;
    if (tx + tw > window.innerWidth) tx = e.clientX - tw - 8;
    if (ty + th > window.innerHeight) ty = e.clientY - th - 8;
    tt.style.left = tx + 'px';
    tt.style.top = ty + 'px';
  });

  wrap.addEventListener('mouseleave', function() {
    var tt2 = document.getElementById('tt');
    if (tt2) tt2.style.display = 'none';
  });
}

/* ── Keyboard handler ───────────────────────────────────────────────────── */
function ttKeyHandler(e) {
  var panel = document.getElementById('tt-panel');
  if (!panel || panel.style.display === 'none') return;

  switch (e.key) {
    case ' ':
    case 'Spacebar':
      e.preventDefault();
      ttTogglePlay();
      break;
    case 'ArrowRight':
      e.preventDefault();
      ttPause();
      ttCurrentRow = Math.min((ttMeta ? ttMeta.row_count - 1 : 0), ttCurrentRow + 1);
      ttRedraw();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      ttPause();
      ttCurrentRow = Math.max(0, ttCurrentRow - 1);
      ttRedraw();
      break;
    case ']': {
      var speeds = [1, 2, 4, 8, 16];
      var ci = speeds.indexOf(ttSpeedMult);
      if (ci < speeds.length - 1) ttSetSpeed(speeds[ci + 1]);
      break;
    }
    case '[': {
      var speeds2 = [1, 2, 4, 8, 16];
      var ci2 = speeds2.indexOf(ttSpeedMult);
      if (ci2 > 0) ttSetSpeed(speeds2[ci2 - 1]);
      break;
    }
    case 'Home':
      e.preventDefault();
      ttPause();
      ttCurrentRow = 0;
      ttRedraw();
      break;
    case 'End':
      e.preventDefault();
      ttPause();
      ttCurrentRow = ttMeta ? ttMeta.row_count - 1 : 0;
      ttRedraw();
      break;
  }
}
