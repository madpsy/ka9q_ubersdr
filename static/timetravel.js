/* ═══════════════════════════════════════════════════════════════════════════
   ⏳  TIME TRAVEL — 3D mountain terrain waterfall flythrough
   ═══════════════════════════════════════════════════════════════════════════
   Renders the spectrogram as a 3D mountain range: 0-30 MHz left→right, time
   recedes into the distance, and signal strength becomes vertical HEIGHT —
   strong signals rise as peaks, the noise floor is flat.

   Each row is drawn as a filled polygon (mountain silhouette) coloured with
   the spectrogram palette, drawn back-to-front so nearer rows occlude distant
   ones (painter's algorithm).

   Speed table (1× = 24 rows/sec → 24h in 60 s):
     1×  = 24 r/s  → 60 s
     2×  = 48 r/s  → 30 s
     4×  = 96 r/s  → 15 s
     8×  = 192 r/s → 7.5 s
     16× = 384 r/s → 3.75 s
   ─────────────────────────────────────────────────────────────────────── */

/* ── State ──────────────────────────────────────────────────────────────── */
var ttInited = false;
var ttIsPlaying = false;
var ttCurrentRow = 0;        /* float — current "front" row index */
var ttSpeedMult = 1;         /* speed multiplier (1,2,4,8,16) */
var ttBaseRowsPerSec = 24;   /* rows/sec at 1× — gives 60 s for 1440 rows */
var ttLastFrameTs = null;    /* DOMHighResTimeStamp of last rAF */
var ttRafId = null;
var ttMeta = null;           /* metadata for the current TT date/band */
var ttBmp = null;            /* ImageBitmap for the current TT date/band */
var ttDepthRows = 60;        /* how many rows visible in depth */
var ttScrubDragging = false;
var ttKeyHandlerAttached = false;
var ttBand = 'wideband';     /* current band for TT */
var ttReadCtx = null;        /* offscreen canvas for pixel reads */

/* Number of frequency sample points per row — higher = smoother mountains
   but slower. 200 is a good balance for a 1500px wide canvas. */
var TT_SAMPLES = 200;

/* Height scale: how many canvas pixels a full-scale signal peak rises.
   Expressed as a fraction of the canvas height. */
var TT_HEIGHT_SCALE = 0.38;

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

  /* Mirror date options from main selector */
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

  /* Mirror band options */
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
  ttBmp = null; ttMeta = null;
  ttLoadData();
}

function ttOnBandChange() {
  var bdst = document.getElementById('tt-bsel');
  ttBand = bdst ? bdst.value : 'wideband';
  ttBmp = null; ttMeta = null;
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

  /* Reuse main tab data if same date+band */
  var mainDsel = document.getElementById('dsel');
  var mainDate = mainDsel ? mainDsel.value : '';
  var mainBand = (typeof urlBand !== 'undefined') ? urlBand : 'wideband';
  if (ds === mainDate && ttBand === mainBand &&
      typeof bmp !== 'undefined' && bmp &&
      typeof meta !== 'undefined' && meta) {
    ttBmp = bmp;
    ttMeta = meta;
    ttCurrentRow = 0;
    ttBuildReadCtx();
    ttDrawScrubber();
    ttRedraw();
    ttSetStatus(ttMeta.row_count + ' rows (shared)');
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
      ttBuildReadCtx();
      ttDrawScrubber();
      ttRedraw();
      ttSetStatus(ttMeta.row_count + ' rows \u00b7 ' + ttMeta.date);
    })
    .catch(function(e) { ttSetStatus('Error: ' + e.message); });
}

function ttBuildReadCtx() {
  if (!ttBmp) return;
  var off = document.createElement('canvas');
  off.width = ttBmp.width;
  off.height = ttBmp.height;
  ttReadCtx = off.getContext('2d', { willReadFrequently: true });
  ttReadCtx.drawImage(ttBmp, 0, 0);
}

/* ── Sample one row from the offscreen canvas ───────────────────────────── */
/* Returns an array of TT_SAMPLES normalised signal values [0..1].
   0 = noise floor colour, 1 = peak colour.
   Uses the raw RGB → palette index lookup (same as pxToDb but returns
   normalised index directly, avoiding the dB conversion overhead). */
function ttSampleRow(rowIdx) {
  var result = new Float32Array(TT_SAMPLES);
  if (!ttReadCtx || !ttMeta || rowIdx < 0 || rowIdx >= ttMeta.row_count) return result;

  var imgW = ttReadCtx.canvas.width;
  var imgH = ttReadCtx.canvas.height;
  var srcRowH = imgH / ttMeta.row_count;
  var srcY = Math.floor(rowIdx * srcRowH + srcRowH * 0.5); /* sample mid-row */
  if (srcY >= imgH) srcY = imgH - 1;

  /* Read the entire row in one getImageData call — much faster than N individual reads */
  var rowData = ttReadCtx.getImageData(0, srcY, imgW, 1).data;

  var lut = (typeof V !== 'undefined') ? V : null;

  for (var si = 0; si < TT_SAMPLES; si++) {
    var xFrac = si / (TT_SAMPLES - 1);
    var px = Math.min(Math.floor(xFrac * imgW), imgW - 1);
    var base = px * 4;
    var r = rowData[base], g = rowData[base + 1], b = rowData[base + 2];

    /* Pure black = no-data sentinel → 0 */
    if (r === 0 && g === 0 && b === 0) { result[si] = 0; continue; }

    /* Fast palette index lookup */
    var idx = 0;
    if (lut) {
      var k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      var inv = (typeof INV !== 'undefined') ? INV : {};
      idx = inv[k];
      if (idx === undefined) {
        /* Nearest-neighbour fallback */
        var bestDist = 1e9;
        for (var li = 0; li < lut.length; li++) {
          var dr = r - lut[li][0], dg = g - lut[li][1], db2 = b - lut[li][2];
          var dist = dr * dr + dg * dg + db2 * db2;
          if (dist < bestDist) { bestDist = dist; idx = li; }
        }
      }
      result[si] = idx / (lut.length - 1);
    } else {
      /* Fallback: use green channel as proxy for brightness */
      result[si] = g / 255;
    }
  }
  return result;
}

/* ── Playback ───────────────────────────────────────────────────────────── */
function ttTogglePlay() {
  if (ttIsPlaying) ttPause(); else ttPlay();
}

function ttPlay() {
  if (!ttBmp || !ttMeta) { ttSetStatus('No data loaded yet.'); return; }
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

  /* Sky gradient background */
  var sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#000814');
  sky.addColorStop(0.55, '#001428');
  sky.addColorStop(1, '#000a1a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  /* Stars in the upper portion */
  ttDrawStars(ctx, W, H);

  if (!ttBmp || !ttMeta || ttMeta.row_count === 0) {
    ctx.fillStyle = 'rgba(255,255,255,.35)';
    ctx.font = '15px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data \u2014 select a date and band above', W / 2, H / 2);
    ctx.textAlign = 'left';
    ttUpdateHUD();
    return;
  }

  /* ── Perspective parameters ─────────────────────────────────────────── */
  var vanishX = W * 0.5;
  var vanishY = H * 0.22;   /* horizon */
  var groundY = H * 0.88;   /* where the front row baseline sits */
  var frontHalfW = W * 0.5;

  var totalRows = ttMeta.row_count;
  var depthRows = Math.min(ttDepthRows, totalRows);

  /* Maximum peak height in canvas pixels (at the front row) */
  var maxPeakH = (groundY - vanishY) * TT_HEIGHT_SCALE;

  /* Read toggle states */
  var showBandsEl = document.getElementById('tt-show-bands');
  var showGridEl = document.getElementById('tt-show-grid');
  var doBands = showBandsEl ? showBandsEl.checked : true;
  var doGrid = showGridEl ? showGridEl.checked : true;

  var startHz = ttMeta.start_freq_hz || 0;
  var spanHz = (ttMeta.end_freq_hz || 30e6) - startHz;
  if (spanHz <= 0) spanHz = 30e6;

  /* ── Draw perspective grid FIRST (behind mountains) ────────────────── */
  if (doGrid) {
    ctx.save();
    ctx.strokeStyle = 'rgba(0,150,220,0.12)';
    ctx.lineWidth = 1;
    var gridFreqs = [0, 5e6, 10e6, 15e6, 20e6, 25e6, 30e6];
    for (var gi = 0; gi < gridFreqs.length; gi++) {
      var gf = gridFreqs[gi];
      if (gf < startHz || gf > startHz + spanHz) continue;
      var gfrac = (gf - startHz) / spanHz;
      var gxFront = vanishX - frontHalfW + gfrac * frontHalfW * 2;
      ctx.beginPath();
      ctx.moveTo(gxFront, groundY);
      ctx.lineTo(vanishX, vanishY);
      ctx.stroke();
    }
    /* Horizontal depth lines */
    var hStep = Math.max(1, Math.round(depthRows / 8));
    for (var hi = 0; hi <= depthRows; hi += hStep) {
      var hd = hi / depthRows;
      var hy = groundY - (groundY - vanishY) * hd;
      var hwFrac = Math.pow(1 - hd, 1.3);
      var hxL = vanishX - frontHalfW * hwFrac;
      var hxR = vanishX + frontHalfW * hwFrac;
      ctx.beginPath();
      ctx.moveTo(hxL, hy); ctx.lineTo(hxR, hy);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ── Draw mountain rows back-to-front ───────────────────────────────── */
  for (var di = depthRows - 1; di >= 0; di--) {
    var d = di / depthRows;           /* 0=front, 1=back */

    /* Perspective: baseline Y and width at this depth */
    var baseY = groundY - (groundY - vanishY) * d;
    var wFrac = Math.pow(1 - d, 1.3);
    var xL = vanishX - frontHalfW * wFrac;
    var xR = vanishX + frontHalfW * wFrac;
    var rowW = xR - xL;
    if (rowW < 1) continue;

    /* Source row index */
    var rowIdx = Math.round(ttCurrentRow) - di;
    if (rowIdx < 0 || rowIdx >= totalRows) continue;

    /* Sample signal values for this row */
    var samples = ttSampleRow(rowIdx);

    /* Peak height scales with perspective (front rows are taller) */
    var peakH = maxPeakH * Math.pow(1 - d, 0.7);

    /* Depth fog: front=bright, back=dim */
    var fogAlpha = Math.pow(1 - d, 0.9) * 0.92 + 0.08;

    /* ── Build the mountain polygon ─────────────────────────────────── */
    /* The polygon: baseline left → peaks → baseline right → close.
       We draw it as a filled path, then stroke the ridge line on top. */

    /* Compute screen X and peak Y for each sample point */
    var pts = new Array(TT_SAMPLES);
    for (var si = 0; si < TT_SAMPLES; si++) {
      var xFrac = si / (TT_SAMPLES - 1);
      var sx = xL + xFrac * rowW;
      var sy = baseY - samples[si] * peakH;
      pts[si] = { x: sx, y: sy };
    }

    /* ── Fill: use a vertical gradient from peak colour to dark base ── */
    ctx.save();
    ctx.globalAlpha = fogAlpha;

    /* Filled silhouette — dark fill so mountains occlude rows behind */
    ctx.beginPath();
    ctx.moveTo(xL, baseY);
    for (var pi = 0; pi < TT_SAMPLES; pi++) {
      ctx.lineTo(pts[pi].x, pts[pi].y);
    }
    ctx.lineTo(xR, baseY);
    ctx.closePath();

    /* Fill with a dark-to-slightly-lighter gradient so the base is solid black */
    var fillGrad = ctx.createLinearGradient(0, baseY - peakH, 0, baseY);
    fillGrad.addColorStop(0, 'rgba(0,8,20,0.0)');
    fillGrad.addColorStop(1, 'rgba(0,4,12,0.98)');
    ctx.fillStyle = fillGrad;
    ctx.fill();

    /* ── Ridge line: colour each segment individually ───────────────── */
    /* We draw short line segments, colouring each by the palette colour
       of the signal at that point. This gives the "coloured mountain ridge"
       effect — the ridge glows with the spectrogram colours. */
    ctx.lineWidth = Math.max(1, 1.5 * (1 - d * 0.6));

    for (var ri = 0; ri < TT_SAMPLES - 1; ri++) {
      var v0 = samples[ri];
      var v1 = samples[ri + 1];
      var vMid = (v0 + v1) * 0.5;

      /* Get palette colour for this signal level */
      var lut2 = (typeof V !== 'undefined') ? V : null;
      var r2 = 100, g2 = 100, b2 = 200; /* default blue */
      if (lut2) {
        var lutIdx = Math.min(lut2.length - 1, Math.round(vMid * (lut2.length - 1)));
        r2 = lut2[lutIdx][0]; g2 = lut2[lutIdx][1]; b2 = lut2[lutIdx][2];
      }

      /* Boost brightness for the ridge line so it glows */
      var boost = 1.0 + vMid * 0.8;
      r2 = Math.min(255, Math.round(r2 * boost));
      g2 = Math.min(255, Math.round(g2 * boost));
      b2 = Math.min(255, Math.round(b2 * boost));

      ctx.strokeStyle = 'rgb(' + r2 + ',' + g2 + ',' + b2 + ')';
      ctx.beginPath();
      ctx.moveTo(pts[ri].x, pts[ri].y);
      ctx.lineTo(pts[ri + 1].x, pts[ri + 1].y);
      ctx.stroke();
    }

    ctx.restore();

    /* ── Band overlays ──────────────────────────────────────────────── */
    if (doBands && typeof BANDS !== 'undefined' && spanHz > 0) {
      ctx.save();
      ctx.globalAlpha = fogAlpha * 0.12;
      var bandColors = [
        'rgba(255,200,0,1)', 'rgba(0,200,255,1)', 'rgba(0,255,120,1)',
        'rgba(255,80,200,1)', 'rgba(255,140,0,1)', 'rgba(100,180,255,1)',
        'rgba(180,255,80,1)', 'rgba(255,80,80,1)'
      ];
      for (var bi = 0; bi < BANDS.length; bi++) {
        var bf0 = (BANDS[bi][0] - startHz) / spanHz;
        var bf1 = (BANDS[bi][1] - startHz) / spanHz;
        if (bf1 < 0 || bf0 > 1) continue;
        bf0 = Math.max(0, bf0); bf1 = Math.min(1, bf1);
        var bx0 = xL + bf0 * rowW;
        var bx1 = xL + bf1 * rowW;
        ctx.fillStyle = bandColors[bi % bandColors.length];
        ctx.fillRect(bx0, baseY - peakH * 1.05, bx1 - bx0, peakH * 1.05);
      }
      ctx.restore();
    }
  }

  /* ── NOW edge glow at the front baseline ────────────────────────────── */
  ctx.save();
  ctx.shadowColor = '#0ff';
  ctx.shadowBlur = 16;
  ctx.strokeStyle = 'rgba(0,255,255,0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, groundY);
  ctx.lineTo(W, groundY);
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
  vigTop.addColorStop(0, 'rgba(0,8,20,0.85)');
  vigTop.addColorStop(1, 'rgba(0,8,20,0)');
  ctx.fillStyle = vigTop;
  ctx.fillRect(0, 0, W, H * 0.35);

  var vigL = ctx.createLinearGradient(0, 0, W * 0.05, 0);
  vigL.addColorStop(0, 'rgba(0,8,20,0.7)');
  vigL.addColorStop(1, 'rgba(0,8,20,0)');
  ctx.fillStyle = vigL; ctx.fillRect(0, 0, W * 0.05, H);

  var vigR = ctx.createLinearGradient(W, 0, W * 0.95, 0);
  vigR.addColorStop(0, 'rgba(0,8,20,0.7)');
  vigR.addColorStop(1, 'rgba(0,8,20,0)');
  ctx.fillStyle = vigR; ctx.fillRect(W * 0.95, 0, W * 0.05, H);

  /* ── Frequency labels on front baseline ────────────────────────────── */
  ctx.save();
  ctx.fillStyle = 'rgba(0,220,255,0.65)';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  var labelFreqs = [0, 5, 10, 15, 20, 25, 30];
  for (var li = 0; li < labelFreqs.length; li++) {
    var lf = labelFreqs[li] * 1e6;
    if (lf < startHz || lf > startHz + spanHz) continue;
    var lfrac = (lf - startHz) / spanHz;
    var lx = vanishX - frontHalfW + lfrac * frontHalfW * 2;
    ctx.fillText(labelFreqs[li] + ' MHz', lx, groundY + 14);
  }
  ctx.restore();

  ttUpdateHUD();
  ttDrawScrubber();
}

/* ── Starfield (static, seeded by canvas size) ──────────────────────────── */
var ttStars = null;
var ttStarsW = 0, ttStarsH = 0;

function ttDrawStars(ctx, W, H) {
  /* Regenerate star positions only when canvas size changes */
  if (!ttStars || ttStarsW !== W || ttStarsH !== H) {
    ttStarsW = W; ttStarsH = H;
    ttStars = [];
    var rng = 0xdeadbeef;
    function rand() { rng ^= rng << 13; rng ^= rng >> 17; rng ^= rng << 5; return (rng >>> 0) / 0xffffffff; }
    for (var i = 0; i < 120; i++) {
      ttStars.push({ x: rand() * W, y: rand() * H * 0.45, r: rand() * 1.2 + 0.3, a: rand() * 0.5 + 0.2 });
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

  /* Time labels */
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

  /* Playhead */
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
    var x = clientX - rect.left;
    var frac = Math.max(0, Math.min(1, x / rect.width));
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
    if (!ttMeta || !ttBmp || !ttReadCtx) return;
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

    var sig = null;
    if (typeof pxToDb === 'function' && typeof contrastMin !== 'undefined') {
      var px2 = Math.floor(xp * ttReadCtx.canvas.width);
      var py2 = Math.floor((row / ttMeta.row_count) * ttReadCtx.canvas.height);
      var ttMin = (typeof contrastUserChanged !== 'undefined' && contrastUserChanged) ? contrastMin : ttMeta.db_min;
      var ttMax = (typeof contrastUserChanged !== 'undefined' && contrastUserChanged) ? contrastMax : ttMeta.db_max;
      sig = pxToDb(ttReadCtx, px2, py2, ttMin, ttMax);
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
