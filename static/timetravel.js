/* ═══════════════════════════════════════════════════════════════════════════
   ⏳  TIME TRAVEL — 3D mountain terrain waterfall flythrough
   ═══════════════════════════════════════════════════════════════════════════
   Renders the spectrogram as a 3D mountain range: 0-30 MHz left→right, time
   recedes into the distance, signal strength = vertical height.

   Performance design:
   - All row samples are pre-computed ONCE when data loads (ttBuildCache).
     Each row is stored as a Float32Array of imgW (full image width) normalised values.
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
var TT_SAMPLES = 160;        /* fallback sample count — overridden by actual imgW at cache build time */
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

/* Pre-computed sample cache: ttSampleCache[rowIdx] = Float32Array(ttSampleCount) */
var ttSampleCache = null;
/* Actual number of samples per row — set to imgW when cache is built */
var ttSampleCount = TT_SAMPLES;
/* Per-depth-slot reusable screen-point arrays — one pair per depth slot.
   Allocated once (or grown) when ttSampleCount changes; avoids per-frame GC churn. */
var ttSlotPX = [];   /* ttSlotPX[di] = Float32Array(ttSampleCount) */
var ttSlotPY = [];   /* ttSlotPY[di] = Float32Array(ttSampleCount) */

/* Persistent per-frame working arrays — allocated once, overwritten each frame.
   Avoids creating 9 new JS arrays (+ GC of old ones) on every ttRedraw() call. */
var ttAllPtsX    = [];
var ttAllPtsY    = [];
var ttAllNPts    = [];
var ttAllBaseY   = [];
var ttAllWFrac   = [];
var ttAllXL      = [];
var ttAllXR      = [];
var ttAllValid   = [];
var ttAllInRange = [];

/* Pre-built gradient canvas for ridge colouring (palette strip) */
var ttPaletteCanvas = null;
/* Cached per-depth-slot gradients — rebuilt when canvas resizes or palette changes.
   ttRowGradCache[di] = CanvasGradient for that depth slot. */
var ttRowGradCache = [];
var ttRowGradDepth = 0;   /* depthRows value the cache was built for */

/* Cached static gradients (sky, vignette) — rebuilt only on canvas resize */
var ttGradSky  = null;
var ttGradVigTop = null;
var ttGradVigL   = null;
var ttGradVigR   = null;

/* OffscreenCanvas for mountain rendering — avoids Firefox display-list accumulation.
   All drawing goes here; a single drawImage blits it to the visible canvas. */
var ttOffscreen = null;
var ttOffCtx    = null;

/* Cached LUT colour strings — rebuilt only when palette/LUT changes.
   ttLutRGB[i] = 'r,g,b' string; avoids per-frame string allocation. */
var ttLutRGB = null;
var ttLutLastIdx = 0;
var ttLutVersion = 0;   /* bumped when LUT changes to trigger rebuild */

/* Stars */
var ttStars = null;
var ttStarsW = 0, ttStarsH = 0;

/* Shooting stars */
var ttShootingStars = [];
var ttLastShootingStarTime = 0;
var ttStarLastTs = 0;
var ttStarRafId = null;

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

  /* Read TT-specific URL params: ?ttdate=YYYY-MM-DD and ?ttband=<band> */
  var _ttParams = new URLSearchParams(window.location.search);
  var urlTtDate = _ttParams.get('ttdate') || '';
  var urlTtBand = _ttParams.get('ttband') || '';

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
    /* URL param takes priority, then fall back to main selector value */
    if (urlTtDate && dst.querySelector('option[value="' + urlTtDate + '"]')) {
      dst.value = urlTtDate;
    } else {
      dst.value = src.value;
    }
  }

  var bsrc = document.getElementById('bsel');
  var bdst = document.getElementById('tt-bsel');
  if (bsrc && bdst) {
    bdst.innerHTML = '';
    for (var j = 0; j < bsrc.options.length; j++) {
      var bo = document.createElement('option');
      bo.value = bsrc.options[j].value;
      bo.textContent = bsrc.options[j].textContent;
      /* URL param takes priority, then fall back to urlBand */
      var defaultBand = urlTtBand || (typeof urlBand !== 'undefined' ? urlBand : 'wideband');
      if (bsrc.options[j].value === defaultBand) bo.selected = true;
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
  ttUpdateUrlParams(); /* stamp current date+band into URL on first open */
  ttLoadData();
  ttStartStarLoop(); /* animate stars immediately, even before data loads */
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
    ttPaletteCanvas = null; /* rebuild palette + row gradients on next draw */
    ttRowGradCache = [];
    ttLutRGB = null;
    ttGradSky = null; ttGradVigTop = null; ttGradVigL = null; ttGradVigR = null;
    ttOffscreen = null; ttOffCtx = null; /* resize offscreen on next draw */
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
  ttBmp = null; ttMeta = null; ttSampleCache = null; ttRowGradCache = []; ttLutRGB = null;
  ttUpdateUrlParams();
  ttLoadData();
}

function ttOnBandChange() {
  var bdst = document.getElementById('tt-bsel');
  ttBand = bdst ? bdst.value : 'wideband';
  ttBmp = null; ttMeta = null; ttSampleCache = null; ttRowGradCache = []; ttLutRGB = null;
  ttUpdateUrlParams();
  ttLoadData();
}

/* Push current TT date + band into the URL without reloading the page */
function ttUpdateUrlParams() {
  if (typeof history === 'undefined' || !history.replaceState) return;
  var p = new URLSearchParams(window.location.search);
  var dsel = document.getElementById('tt-dsel');
  var ds = dsel ? dsel.value : '';
  if (ds && ds !== 'rolling-24h') {
    p.set('ttdate', ds);
  } else {
    p.delete('ttdate');
  }
  if (ttBand && ttBand !== 'wideband') {
    p.set('ttband', ttBand);
  } else {
    p.delete('ttband');
  }
  /* Always keep tab=tt while we're on this tab */
  p.set('tab', 'tt');
  var qs = p.toString();
  history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
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
      if (!ttIsPlaying) ttStartStarLoop();
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
        if (!ttIsPlaying) ttStartStarLoop();
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

    /* Use the full image width as sample resolution — set once before the loop */
    ttSampleCount = imgW;

    for (; row < end; row++) {
      var samples = new Float32Array(ttSampleCount);
      var srcY = Math.floor(row * srcRowH + srcRowH * 0.5);
      if (srcY >= imgH) srcY = imgH - 1;
      var rowBase = srcY * imgW * 4;

      for (var si = 0; si < ttSampleCount; si++) {
        var xFrac = si / (ttSampleCount - 1);
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

      /* Mark gap rows as null.
         Gap rows in the spectrogram image are uniformly the noise-floor colour
         (dark blue) — NOT pure black. Pure-black sentinel detection misses them.
         Instead: compute the variance of the sample values. A real data row
         has signal variation; a gap/missing row is nearly flat (all samples map
         to the same noise-floor LUT index → variance ≈ 0).
         Also handle the legacy pure-black sentinel just in case. */
      var sentinelCount = 0;
      var sum = 0, sumSq = 0;
      for (var zi = 0; zi < ttSampleCount; zi++) {
        if (samples[zi] < 0) { sentinelCount++; samples[zi] = 1.0; }
        sum += samples[zi];
        sumSq += samples[zi] * samples[zi];
      }
      var mean = sum / ttSampleCount;
      var variance = sumSq / ttSampleCount - mean * mean;
      /* Gap row criteria:
         - More than 30% pure-black sentinels, OR
         - Variance < 0.0004 (std-dev < 0.02) — row is essentially flat/uniform */
      var isGap = (sentinelCount > ttSampleCount * 0.30) || (variance < 0.0004);
      ttSampleCache[row] = isGap ? null : samples;
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
  ttStopStarLoop(); /* playback RAF loop handles redraws */
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
  /* Keep star animation running while paused */
  ttStartStarLoop();
}

/* ── Star animation loop (runs independently of playback) ───────────────── */
function ttStartStarLoop() {
  if (ttStarRafId) return; /* already running */
  function starFrame(ts) {
    if (ttIsPlaying) { ttStarRafId = null; return; } /* playback loop takes over */
    ttStarRafId = requestAnimationFrame(starFrame);
    ttRedraw();
  }
  ttStarRafId = requestAnimationFrame(starFrame);
}

function ttStopStarLoop() {
  if (ttStarRafId) { cancelAnimationFrame(ttStarRafId); ttStarRafId = null; }
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
  var mainCtx = c.getContext('2d');
  if (!mainCtx) return;

  var W = c.width, H = c.height;

  /* ── OffscreenCanvas setup ──────────────────────────────────────────── */
  /* All drawing goes to an offscreen canvas; a single drawImage blits it
     to the visible canvas. This avoids Firefox's canvas display-list
     accumulation bug that causes exponential slowdown with gradient fills. */
  var useOffscreen = (typeof OffscreenCanvas !== 'undefined');
  if (useOffscreen) {
    if (!ttOffscreen || ttOffscreen.width !== W || ttOffscreen.height !== H) {
      ttOffscreen = new OffscreenCanvas(W, H);
      ttOffCtx = ttOffscreen.getContext('2d');
      /* Gradient objects are context-bound — must rebuild when context changes */
      ttRowGradCache = [];
      ttGradSky = null; ttGradVigTop = null; ttGradVigL = null; ttGradVigR = null;
    }
  }
  var ctx = useOffscreen ? ttOffCtx : mainCtx;

  ctx.clearRect(0, 0, W, H);

  /* Sky gradient — cached; only rebuilt on canvas resize */
  if (!ttGradSky) {
    ttGradSky = ctx.createLinearGradient(0, 0, 0, H);
    ttGradSky.addColorStop(0, '#000814');
    ttGradSky.addColorStop(0.6, '#001428');
    ttGradSky.addColorStop(1, '#000a1a');
  }
  ctx.fillStyle = ttGradSky;
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
  /* groundY leaves ~44px at the bottom for the scrubber overlay + 20px for freq labels */
  var scrubberH = 44;
  var groundY = H - scrubberH - 20;
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
  var lut = (typeof V !== 'undefined') ? V : null;

  /* Use cached LUT colour strings — only rebuild if LUT changed */
  if (lut && ttLutRGB === null) {
    ttLutLastIdx = lut.length - 1;
    ttLutRGB = new Array(lut.length);
    for (var li2 = 0; li2 < lut.length; li2++) {
      ttLutRGB[li2] = lut[li2][0] + ',' + lut[li2][1] + ',' + lut[li2][2];
    }
  }
  var lutRGB = ttLutRGB;
  var lutLastIdx = ttLutLastIdx;


  /* Build per-depth-slot gradient cache if stale (canvas resize or depthRows change).
     Gradients are purely a function of geometry + palette — independent of ttCurrentRow,
     so they can be reused every frame without rebuilding. */
  if (lut && lutRGB && (ttRowGradCache.length !== depthRows || ttRowGradDepth !== depthRows)) {
    ttRowGradCache = new Array(depthRows);
    ttRowGradDepth = depthRows;
    var GSTOPS_C = 16;
    for (var gdi = 0; gdi < depthRows; gdi++) {
      var gd = gdi / depthRows;
      var gbY = groundY - (groundY - vanishY) * gd;
      var gwF = 1 - gd * (1 - TT_MIN_WFRAC);
      var gpH = maxPeakH * gwF;
      var gtopY = gbY - gpH;
      var gfogAlpha = gwF * 0.94 + 0.06;
      var gfogStr = gfogAlpha.toFixed(3);
      var grad = ctx.createLinearGradient(0, gbY, 0, gtopY);
      for (var gsi = 0; gsi <= GSTOPS_C; gsi++) {
        var gsv = gsi / GSTOPS_C;
        if (gsv < 0.05) {
          grad.addColorStop(gsv, 'rgba(0,0,0,0)');
        } else {
          var gcIdx = Math.min(lutLastIdx, Math.round(gsv * lutLastIdx));
          grad.addColorStop(gsv, 'rgba(' + lutRGB[gcIdx] + ',' + gfogStr + ')');
        }
      }
      ttRowGradCache[gdi] = grad;
    }
  }

  /* Pre-compute all row screen points into persistent module-level arrays
     (avoids allocating + GC-ing 9 new JS arrays on every frame). */
  var allPtsX    = ttAllPtsX;
  var allPtsY    = ttAllPtsY;
  var allNPts    = ttAllNPts;
  var allBaseY   = ttAllBaseY;
  var allWFrac   = ttAllWFrac;
  var allXL      = ttAllXL;
  var allXR      = ttAllXR;
  var allValid   = ttAllValid;
  var allInRange = ttAllInRange;

  for (var di2 = depthRows - 1; di2 >= 0; di2--) {
    var d2 = di2 / depthRows;
    var bY2 = groundY - (groundY - vanishY) * d2;
    var wF2 = 1 - d2 * (1 - TT_MIN_WFRAC);
    var xL2 = vanishX - frontHalfW * wF2;
    var xR2 = vanishX + frontHalfW * wF2;
    var rowW2 = xR2 - xL2;
    var rowIdx2 = frontRow - di2;
    var inRange2 = (rowIdx2 >= 0 && rowIdx2 < totalRows);
    var samples2 = inRange2 ? ttSampleCache[rowIdx2] : null;
    var peakH2 = maxPeakH * wF2;

    allBaseY[di2] = bY2;
    allWFrac[di2] = wF2;
    allXL[di2] = xL2;
    allXR[di2] = xR2;
    allInRange[di2] = inRange2 && rowW2 >= 1;
    allValid[di2] = !!(samples2 && rowW2 >= 1);

    if (samples2 && rowW2 >= 1) {
      var nSamples2 = samples2.length;
      /* Clamp path points to screen pixel width — no benefit drawing more points
         than there are pixels in the row. Distant (narrow) rows get far fewer points. */
      var nDraw2 = Math.min(nSamples2, Math.max(2, Math.ceil(rowW2)));
      /* Reuse per-slot arrays; grow them if needed */
      if (!ttSlotPX[di2] || ttSlotPX[di2].length < nDraw2) {
        ttSlotPX[di2] = new Float32Array(nDraw2);
        ttSlotPY[di2] = new Float32Array(nDraw2);
      }
      var px2 = ttSlotPX[di2];
      var py2 = ttSlotPY[di2];
      var step2 = nDraw2 > 1 ? (nSamples2 - 1) / (nDraw2 - 1) : 0;
      for (var si2 = 0; si2 < nDraw2; si2++) {
        var srcIdx2 = Math.min(nSamples2 - 1, Math.round(si2 * step2));
        px2[si2] = xL2 + (si2 / (nDraw2 - 1)) * rowW2;
        py2[si2] = bY2 - samples2[srcIdx2] * peakH2;
      }
      allPtsX[di2] = px2;
      allPtsY[di2] = py2;
      allNPts[di2] = nDraw2;
    } else {
      allPtsX[di2] = null;
      allPtsY[di2] = null;
      allNPts[di2] = 0;
    }
  }

  /* Draw back-to-front. */
  for (var di = depthRows - 1; di >= 0; di--) {
    /* Skip rows that are completely out of the data range */
    if (!allInRange[di]) continue;

    var baseY = allBaseY[di];
    var wFrac = allWFrac[di];
    var xL = allXL[di];
    var xR = allXR[di];
    var rowW = xR - xL;
    var ptsX = allPtsX[di];
    var ptsY = allPtsY[di];
    var peakH = maxPeakH * wFrac;
    var fogAlpha = wFrac * 0.94 + 0.06;

    /* Gap/missing-data row: draw a dark trapezoid to bridge the gap,
       but no coloured signal fill. */
    if (!allValid[di]) {
      ctx.beginPath();
      ctx.moveTo(xL, groundY);
      ctx.lineTo(xL, baseY);
      ctx.lineTo(xR, baseY);
      ctx.lineTo(xR, groundY);
      ctx.closePath();
      ctx.fillStyle = '#000810';
      ctx.fill();
      continue;
    }

    /* ── Filled silhouette + ridge line ─────────────────────────────── */
    /* Use the pre-built cached gradient for this depth slot — zero gradient
       construction cost per frame during playback. */
    var rowGrad = (lut && lutRGB && rowW > 1 && ttRowGradCache[di]) ? ttRowGradCache[di] : null;
    var fogStr = fogAlpha.toFixed(3);

    /* Step 1: Fill silhouette from ridge down to groundY */
    var nPts = allNPts[di];
    ctx.beginPath();
    ctx.moveTo(xL, groundY);
    for (var pi = 0; pi < nPts; pi++) {
      ctx.lineTo(ptsX[pi], ptsY[pi]);
    }
    ctx.lineTo(xR, groundY);
    ctx.closePath();
    if (rowGrad) {
      ctx.fillStyle = rowGrad;
    } else if (lut) {
      ctx.fillStyle = 'rgba(' + lutRGB[0] + ',' + fogStr + ')';
    } else {
      ctx.fillStyle = 'rgba(0,8,20,' + fogStr + ')';
    }
    ctx.fill();


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

  /* ── Vignette — cached; only rebuilt on canvas resize ───────────────── */
  if (!ttGradVigTop) {
    ttGradVigTop = ctx.createLinearGradient(0, 0, 0, H * 0.35);
    ttGradVigTop.addColorStop(0, 'rgba(0,8,20,0.88)');
    ttGradVigTop.addColorStop(1, 'rgba(0,8,20,0)');
  }
  ctx.fillStyle = ttGradVigTop;
  ctx.fillRect(0, 0, W, H * 0.35);

  if (!ttGradVigL) {
    ttGradVigL = ctx.createLinearGradient(0, 0, W * 0.05, 0);
    ttGradVigL.addColorStop(0, 'rgba(0,8,20,0.7)'); ttGradVigL.addColorStop(1, 'rgba(0,8,20,0)');
  }
  ctx.fillStyle = ttGradVigL; ctx.fillRect(0, 0, W * 0.05, H);

  if (!ttGradVigR) {
    ttGradVigR = ctx.createLinearGradient(W, 0, W * 0.95, 0);
    ttGradVigR.addColorStop(0, 'rgba(0,8,20,0.7)'); ttGradVigR.addColorStop(1, 'rgba(0,8,20,0)');
  }
  ctx.fillStyle = ttGradVigR; ctx.fillRect(W * 0.95, 0, W * 0.05, H);

  /* ── Time axis labels (left + right sides) ─────────────────────────── */
  if (ttMeta && ttMeta.rows && ttMeta.rows.length > 0) {
    ctx.save();
    ctx.font = 'bold 13px monospace';
    ctx.textBaseline = 'middle';

    /* Pick interval: aim for ~6-8 labels across the visible depth */
    var tlCandidates = [1, 2, 5, 10, 15, 20, 30, 60];
    var tlInterval = 60;
    for (var tli = 0; tli < tlCandidates.length; tli++) {
      if (depthRows / tlCandidates[tli] <= 4) { tlInterval = tlCandidates[tli]; break; }
    }

    for (var tldi = 0; tldi < depthRows; tldi++) {
      var tlRowIdx = frontRow - tldi;
      if (tlRowIdx < 0 || tlRowIdx >= totalRows) continue;

      /* Determine the UTC minute of this row and check it falls on a round boundary */
      var tlRowM = ttMeta.rows[tlRowIdx];
      var tlUtcMin; /* total minutes since midnight UTC */
      var tlStr;
      if (tlRowM && tlRowM.unix) {
        var tlDate = new Date(tlRowM.unix * 1000);
        tlUtcMin = tlDate.getUTCHours() * 60 + tlDate.getUTCMinutes();
        tlStr = String(tlDate.getUTCHours()).padStart(2, '0') + ':' +
                String(tlDate.getUTCMinutes()).padStart(2, '0');
      } else {
        tlUtcMin = tlRowIdx % 1440; /* fallback: treat row index as minutes */
        tlStr = String(Math.floor(tlUtcMin / 60) % 24).padStart(2, '0') + ':' +
                String(tlUtcMin % 60).padStart(2, '0');
      }
      /* Only label rows whose UTC minute is exactly divisible by the interval */
      if (tlUtcMin % tlInterval !== 0) continue;

      var tld = tldi / depthRows;
      var tlbY = groundY - (groundY - vanishY) * tld;
      var tlwF = 1 - tld * (1 - TT_MIN_WFRAC);
      var tlxL = vanishX - frontHalfW * tlwF;
      var tlxR = vanishX + frontHalfW * tlwF;

      /* Fade as rows approach vanishing point */
      var tlAlpha = Math.min(1, tlwF * 1.5 - 0.15);
      if (tlAlpha <= 0.05) continue;

      ctx.globalAlpha = tlAlpha;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'right';
      ctx.fillText(tlStr, tlxL - 5, tlbY);
      ctx.textAlign = 'left';
      ctx.fillText(tlStr, tlxR + 5, tlbY);

      /* Small tick at row edge */
      ctx.strokeStyle = 'rgba(255,255,255,' + (tlAlpha * 0.4).toFixed(2) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tlxL - 4, tlbY); ctx.lineTo(tlxL, tlbY);
      ctx.moveTo(tlxR, tlbY);     ctx.lineTo(tlxR + 4, tlbY);
      ctx.stroke();
    }
    ctx.restore();
  }

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

  /* ── Blit offscreen canvas to visible canvas ────────────────────────── */
  if (useOffscreen && ttOffscreen) {
    mainCtx.clearRect(0, 0, W, H);
    mainCtx.drawImage(ttOffscreen, 0, 0);
  }

  ttUpdateHUD();
  ttDrawScrubber();
}

/* ── Starfield ──────────────────────────────────────────────────────────── */
function ttDrawStars(ctx, W, H) {
  var now = Date.now();

  /* Rebuild static star field if canvas size changed */
  if (!ttStars || ttStarsW !== W || ttStarsH !== H) {
    ttStarsW = W; ttStarsH = H;
    ttStars = [];
    var rng = 0xdeadbeef;
    function rand() { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return (rng >>> 0) / 0xffffffff; }
    /* 300 stars across the sky area (top 45% of canvas) */
    for (var i = 0; i < 300; i++) {
      ttStars.push({
        x: rand() * W,
        y: rand() * H * 0.45,
        r: rand() * 1.4 + 0.2,
        a: rand() * 0.6 + 0.2,
        /* Twinkle: each star has its own phase and speed */
        twinklePhase: rand() * Math.PI * 2,
        twinkleSpeed: rand() * 0.002 + 0.0005,
        twinkleAmp: rand() * 0.35
      });
    }
  }

  ctx.save();

  /* Draw static stars with per-star twinkle */
  for (var si = 0; si < ttStars.length; si++) {
    var s = ttStars[si];
    var twinkle = s.a + Math.sin(now * s.twinkleSpeed + s.twinklePhase) * s.twinkleAmp;
    twinkle = Math.max(0.05, Math.min(1, twinkle));
    ctx.globalAlpha = twinkle;
    /* Slightly warm/cool tint for variety */
    var tint = (si % 5 === 0) ? '#cce8ff' : (si % 7 === 0) ? '#ffe8cc' : '#ffffff';
    ctx.fillStyle = tint;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }

  /* ── Shooting stars ─────────────────────────────────────────────────── */
  /* Spawn a new shooting star every 2.5–6 seconds */
  var spawnInterval = 2500 + Math.sin(now * 0.0003) * 1750; /* 2.5–6s */
  if (now - ttLastShootingStarTime > spawnInterval) {
    ttLastShootingStarTime = now;
    /* Start from a random point in the upper-left portion of the sky */
    var sx = Math.random() * W * 0.8;
    var sy = Math.random() * H * 0.30;
    var angle = Math.PI / 6 + Math.random() * Math.PI / 6; /* 30–60° downward */
    var speed = 400 + Math.random() * 500; /* px/sec */
    var length = 80 + Math.random() * 120;
    ttShootingStars.push({
      x: sx, y: sy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      len: length,
      life: 1.0,   /* 1.0 = fully alive, fades to 0 */
      decay: 0.6 + Math.random() * 0.8  /* life units per second */
    });
  }

  /* Update and draw shooting stars using real elapsed time */
  var dt = ttStarLastTs > 0 ? Math.min(0.1, (now - ttStarLastTs) / 1000) : 0.016;
  ttStarLastTs = now;
  for (var shi = ttShootingStars.length - 1; shi >= 0; shi--) {
    var ss = ttShootingStars[shi];
    ss.x += ss.vx * dt;
    ss.y += ss.vy * dt;
    ss.life -= ss.decay * dt;

    if (ss.life <= 0 || ss.x > W + 50 || ss.y > H * 0.5) {
      ttShootingStars.splice(shi, 1);
      continue;
    }

    /* Draw as a glowing line with a bright head and fading tail */
    var tailX = ss.x - (ss.vx / Math.sqrt(ss.vx * ss.vx + ss.vy * ss.vy)) * ss.len;
    var tailY = ss.y - (ss.vy / Math.sqrt(ss.vx * ss.vx + ss.vy * ss.vy)) * ss.len;

    var grad = ctx.createLinearGradient(tailX, tailY, ss.x, ss.y);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.7, 'rgba(200,230,255,' + (ss.life * 0.5).toFixed(3) + ')');
    grad.addColorStop(1, 'rgba(255,255,255,' + ss.life.toFixed(3) + ')');

    ctx.globalAlpha = 1;
    ctx.strokeStyle = grad;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(ss.x, ss.y);
    ctx.stroke();

    /* Bright head glow */
    ctx.globalAlpha = ss.life * 0.9;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ss.x, ss.y, 1.5, 0, Math.PI * 2);
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
      var si2 = Math.min(samples.length - 1, Math.round(xp * (samples.length - 1)));
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
