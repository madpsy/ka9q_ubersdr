/* ═══════════════════════════════════════════════════════════════════════════
   ⏳  TIME TRAVEL — 3D perspective waterfall flythrough
   ═══════════════════════════════════════════════════════════════════════════
   Renders the spectrogram as a 3D runway: 0-30 MHz left→right, time recedes
   into the distance. Each row is a perspective-projected trapezoid drawn
   back-to-front (painter's algorithm). Uses the same ImageBitmap (bmp) and
   meta object already loaded by the main Spectrogram tab — no extra API calls
   when the same date/band is selected.

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
var ttReadCtx = null;        /* offscreen canvas for pixel reads (tooltip) */

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

  /* Size the main canvas to fill its wrapper */
  ttResizeCanvas();
  window.addEventListener('resize', ttResizeCanvas);

  /* Setup scrubber interaction */
  ttSetupScrubber();

  /* Attach keyboard handler once */
  if (!ttKeyHandlerAttached) {
    ttKeyHandlerAttached = true;
    document.addEventListener('keydown', ttKeyHandler);
  }

  /* Setup hover tooltip on the 3D canvas */
  ttSetupHover();

  /* Load data */
  ttLoadData();
}

/* ── Canvas sizing ──────────────────────────────────────────────────────── */
function ttResizeCanvas() {
  var wrap = document.getElementById('tt-canvas-wrap');
  var c = document.getElementById('tt-canvas');
  var oc = document.getElementById('tt-overlay');
  if (!wrap || !c) return;
  var w = wrap.getBoundingClientRect().width || 800;
  /* 16:9-ish aspect, capped at 580px tall */
  var h = Math.min(Math.round(w * 0.52), 580);
  if (c.width !== Math.round(w) || c.height !== h) {
    c.width = Math.round(w);
    c.height = h;
    if (oc) { oc.width = Math.round(w); oc.height = h; }
  }
  /* Size scrubber */
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

  /* Try to reuse the main tab's already-loaded data when date+band match */
  var mainDsel = document.getElementById('dsel');
  var mainDate = mainDsel ? mainDsel.value : '';
  var mainBand = (typeof urlBand !== 'undefined') ? urlBand : 'wideband';
  var sameDateBand = (ds === mainDate && ttBand === mainBand);
  if (sameDateBand && typeof bmp !== 'undefined' && bmp && typeof meta !== 'undefined' && meta) {
    ttBmp = bmp;
    ttMeta = meta;
    ttCurrentRow = 0;
    ttBuildReadCtx();
    ttDrawScrubber();
    ttRedraw();
    ttSetStatus(ttMeta.row_count + ' rows loaded (shared)');
    return;
  }

  ttSetStatus('Loading\u2026');

  /* Build meta URL */
  var mparams = [];
  if (isRolling) {
    mparams.push('rolling=1');
  } else if (ds && /^\d{4}-\d{2}-\d{2}$/.test(ds)) {
    mparams.push('date=' + encodeURIComponent(ds));
  }
  if (ttBand && ttBand !== 'wideband') mparams.push('band=' + encodeURIComponent(ttBand));
  var murl = '/api/spectrogram/meta' + (mparams.length ? '?' + mparams.join('&') : '');

  /* Palette from main selector */
  var psel = document.getElementById('psel');
  var pal = psel ? psel.value : 'jet';

  fetch(murl)
    .then(function(r) { if (!r.ok) throw new Error('meta ' + r.status); return r.json(); })
    .then(function(m) {
      ttMeta = m;
      var iurl = m.image_url;
      if (pal && pal !== m.palette) iurl += (iurl.indexOf('?') >= 0 ? '&' : '?') + 'palette=' + encodeURIComponent(pal);
      var today = new Date().toISOString().slice(0, 10);
      if (isRolling || !ds || ds === today) {
        iurl += (iurl.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now();
      }
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

/* ── Playback ───────────────────────────────────────────────────────────── */
function ttTogglePlay() {
  if (ttIsPlaying) ttPause(); else ttPlay();
}

function ttPlay() {
  if (!ttBmp || !ttMeta) { ttSetStatus('No data loaded yet.'); return; }
  /* If at the end, restart from beginning */
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
    var dt = (ts - ttLastFrameTs) / 1000; /* seconds */
    /* Cap dt to 100ms to avoid huge jumps after tab switch or background */
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

/* ── Main 3D draw ───────────────────────────────────────────────────────── */
function ttRedraw() {
  var c = document.getElementById('tt-canvas');
  if (!c) return;
  var ctx = c.getContext('2d');
  if (!ctx) return;

  var W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);

  /* Dark background gradient */
  var bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#000510');
  bg.addColorStop(1, '#000c1a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

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
  var vanishY = H * 0.16;   /* horizon line — upper 16% of canvas */
  var frontY = H;            /* front edge at very bottom of canvas */
  var frontHalfW = W * 0.5; /* front row spans full canvas width */

  var totalRows = ttMeta.row_count;
  var depthRows = Math.min(ttDepthRows, totalRows);

  /* Image source: each row in the PNG is (bmp.height / totalRows) pixels tall */
  var srcRowH = ttBmp.height / totalRows;

  /* Speed-based motion blur: blur increases with speed multiplier */
  var blurPx = Math.max(0, (Math.log2(ttRowsPerSec() / 24)) * 1.6);

  /* Read toggle states */
  var showBandsEl = document.getElementById('tt-show-bands');
  var showGridEl = document.getElementById('tt-show-grid');
  var doBands = showBandsEl ? showBandsEl.checked : true;
  var doGrid = showGridEl ? showGridEl.checked : true;

  /* Frequency range from meta */
  var startHz = ttMeta.start_freq_hz || 0;
  var spanHz = (ttMeta.end_freq_hz || 30e6) - startHz;
  if (spanHz <= 0) spanHz = 30e6;

  /* ── Draw rows back-to-front (painter's algorithm) ──────────────────── */
  for (var di = depthRows - 1; di >= 0; di--) {
    /* d = 0 at front (current row), 1 at back (oldest visible row) */
    var d = di / depthRows;
    var dNext = (di + 1) / depthRows;

    /* Y positions of this row's bottom and top edges */
    var yBot = frontY - (frontY - vanishY) * d;
    var yTop = frontY - (frontY - vanishY) * dNext;
    if (yTop >= yBot) continue; /* degenerate — skip */

    /* X extents — perspective narrowing using power curve */
    var wFrac = Math.pow(1 - d, 1.35);
    var wFracNext = Math.pow(1 - dNext, 1.35);
    var xL = vanishX - frontHalfW * wFrac;
    var xR = vanishX + frontHalfW * wFrac;
    var xLN = vanishX - frontHalfW * wFracNext;
    var xRN = vanishX + frontHalfW * wFracNext;

    /* Source row index in the image */
    var rowIdx = Math.round(ttCurrentRow) - di;
    if (rowIdx < 0 || rowIdx >= totalRows) continue;

    var srcY = rowIdx * srcRowH;

    /* Depth fog: front=full opacity, back=dim */
    var fogAlpha = Math.pow(1 - d, 1.1) * 0.93 + 0.07;

    /* ── Draw the spectrogram row as a perspective-warped trapezoid ──── */
    /* We split into N vertical strips to approximate the perspective warp.
       Each strip is drawn using ctx.setTransform to map the source rect
       into the destination trapezoid strip. */
    var N = Math.max(24, Math.round(W / 14));
    ctx.save();
    if (blurPx > 0.5) ctx.filter = 'blur(' + blurPx.toFixed(1) + 'px)';
    ctx.globalAlpha = fogAlpha;

    for (var si = 0; si < N; si++) {
      var t0 = si / N;
      var t1 = (si + 1) / N;

      /* Source rect in the image */
      var sx = t0 * ttBmp.width;
      var sw = (t1 - t0) * ttBmp.width;

      /* Destination trapezoid strip — interpolate between bottom and top edges */
      var dx0 = xL + t0 * (xR - xL);
      var dx1 = xL + t1 * (xR - xL);
      var dx0t = xLN + t0 * (xRN - xLN);
      /* var dx1t = xLN + t1 * (xRN - xLN); */

      var destW = dx1 - dx0;
      var destH = yBot - yTop;
      if (destW < 0.3 || destH < 0.3) continue;

      /* Horizontal shear per pixel of vertical travel */
      var shearX = (dx0t - dx0) / destH;
      var scaleX = destW / sw;
      var scaleY = destH / srcRowH;

      /* ctx.setTransform(a, b, c, d, e, f) maps:
           x' = a*x + c*y + e
           y' = b*x + d*y + f
         We want: source (sx,0) → dest (dx0, yTop)
                  source (sx+sw,0) → dest (dx1, yTop)
                  source (sx,srcRowH) → dest (dx0+shearX*destH, yBot)
         So: a=scaleX, b=0, c=shearX*scaleX, d=scaleY, e=dx0, f=yTop */
      ctx.setTransform(
        scaleX, 0,
        shearX * scaleX, scaleY,
        dx0, yTop
      );
      ctx.drawImage(ttBmp,
        sx, srcY, sw, srcRowH,
        0, 0, sw, srcRowH
      );
    }

    ctx.restore();
    ctx.filter = 'none';
    ctx.globalAlpha = 1;

    /* ── Band overlays on this row ──────────────────────────────────── */
    if (doBands && typeof BANDS !== 'undefined' && spanHz > 0) {
      ctx.save();
      ctx.globalAlpha = fogAlpha * 0.16;
      var bandColors = [
        'rgba(255,200,0,1)', 'rgba(0,200,255,1)', 'rgba(0,255,120,1)',
        'rgba(255,80,200,1)', 'rgba(255,140,0,1)', 'rgba(100,180,255,1)',
        'rgba(180,255,80,1)', 'rgba(255,80,80,1)'
      ];
      for (var bi = 0; bi < BANDS.length; bi++) {
        var bf0 = (BANDS[bi][0] - startHz) / spanHz;
        var bf1 = (BANDS[bi][1] - startHz) / spanHz;
        if (bf1 < 0 || bf0 > 1) continue;
        bf0 = Math.max(0, bf0);
        bf1 = Math.min(1, bf1);
        var bx0 = xL + bf0 * (xR - xL);
        var bx1 = xL + bf1 * (xR - xL);
        var bx0t = xLN + bf0 * (xRN - xLN);
        var bx1t = xLN + bf1 * (xRN - xLN);
        ctx.fillStyle = bandColors[bi % bandColors.length];
        ctx.beginPath();
        ctx.moveTo(bx0, yBot);
        ctx.lineTo(bx1, yBot);
        ctx.lineTo(bx1t, yTop);
        ctx.lineTo(bx0t, yTop);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /* ── Perspective grid lines ─────────────────────────────────────────── */
  if (doGrid) {
    ctx.save();
    ctx.strokeStyle = 'rgba(0,180,255,0.15)';
    ctx.lineWidth = 1;

    /* Vertical lines at major frequency intervals — converge at vanishing point */
    var gridFreqs = [0, 5e6, 10e6, 15e6, 20e6, 25e6, 30e6];
    for (var gi = 0; gi < gridFreqs.length; gi++) {
      var gf = gridFreqs[gi];
      if (gf < startHz || gf > startHz + spanHz) continue;
      var gfrac = (gf - startHz) / spanHz;
      var gxFront = vanishX - frontHalfW + gfrac * frontHalfW * 2;
      ctx.beginPath();
      ctx.moveTo(gxFront, frontY);
      ctx.lineTo(vanishX, vanishY);
      ctx.stroke();
    }

    /* Horizontal depth lines at regular row intervals */
    var hlineStep = Math.max(1, Math.round(depthRows / 8));
    for (var hi = 0; hi <= depthRows; hi += hlineStep) {
      var hd = hi / depthRows;
      var hyBot = frontY - (frontY - vanishY) * hd;
      var hwFrac = Math.pow(1 - hd, 1.35);
      var hxL = vanishX - frontHalfW * hwFrac;
      var hxR = vanishX + frontHalfW * hwFrac;
      ctx.beginPath();
      ctx.moveTo(hxL, hyBot);
      ctx.lineTo(hxR, hyBot);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ── NOW edge glow ──────────────────────────────────────────────────── */
  ctx.save();
  ctx.shadowColor = '#0ff';
  ctx.shadowBlur = 20;
  ctx.strokeStyle = 'rgba(0,255,255,0.88)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(0, frontY - 1);
  ctx.lineTo(W, frontY - 1);
  ctx.stroke();
  /* Pulsing centre dot */
  var pulse = 0.55 + 0.45 * Math.sin(Date.now() / 380);
  ctx.shadowBlur = 28 * pulse;
  ctx.fillStyle = 'rgba(0,255,255,' + pulse.toFixed(2) + ')';
  ctx.beginPath();
  ctx.arc(W / 2, frontY - 1, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  /* ── Vignette overlays ──────────────────────────────────────────────── */
  /* Top fade — past rows fade to black at the horizon */
  var vigTop = ctx.createLinearGradient(0, 0, 0, H * 0.42);
  vigTop.addColorStop(0, 'rgba(0,5,16,0.94)');
  vigTop.addColorStop(1, 'rgba(0,5,16,0)');
  ctx.fillStyle = vigTop;
  ctx.fillRect(0, 0, W, H * 0.42);

  /* Side vignettes */
  var vigL = ctx.createLinearGradient(0, 0, W * 0.055, 0);
  vigL.addColorStop(0, 'rgba(0,5,16,0.72)');
  vigL.addColorStop(1, 'rgba(0,5,16,0)');
  ctx.fillStyle = vigL;
  ctx.fillRect(0, 0, W * 0.055, H);

  var vigR = ctx.createLinearGradient(W, 0, W * 0.945, 0);
  vigR.addColorStop(0, 'rgba(0,5,16,0.72)');
  vigR.addColorStop(1, 'rgba(0,5,16,0)');
  ctx.fillStyle = vigR;
  ctx.fillRect(W * 0.945, 0, W * 0.055, H);

  /* ── Frequency labels on front row ─────────────────────────────────── */
  ctx.save();
  ctx.fillStyle = 'rgba(0,220,255,0.72)';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  var labelFreqs = [0, 5, 10, 15, 20, 25, 30];
  for (var li = 0; li < labelFreqs.length; li++) {
    var lf = labelFreqs[li] * 1e6;
    if (lf < startHz || lf > startHz + spanHz) continue;
    var lfrac = (lf - startHz) / spanHz;
    var lx = vanishX - frontHalfW + lfrac * frontHalfW * 2;
    ctx.fillText(labelFreqs[li] + ' MHz', lx, H - 6);
  }
  ctx.restore();

  /* ── Update HUD and scrubber ────────────────────────────────────────── */
  ttUpdateHUD();
  ttDrawScrubber();
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

  /* Background */
  ctx.fillStyle = 'rgba(0,0,0,.65)';
  ctx.fillRect(0, 0, W, H);

  /* Draw the full spectrogram as a miniature strip */
  if (ttBmp) {
    ctx.drawImage(ttBmp, 0, 0, W, H);
    /* Darken slightly so the playhead stands out */
    ctx.fillStyle = 'rgba(0,0,0,.38)';
    ctx.fillRect(0, 0, W, H);
  }

  /* Time labels */
  if (ttMeta && ttMeta.rows && ttMeta.rows.length > 0) {
    ctx.fillStyle = 'rgba(255,255,255,.5)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    var labelCount = 8;
    for (var li = 0; li <= labelCount; li++) {
      var lf = li / labelCount;
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
    ctx.moveTo(px, 0);
    ctx.lineTo(px, H);
    ctx.stroke();
    /* Triangle handle at top */
    ctx.fillStyle = '#0ff';
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px, 8);
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
    var x = (e.clientX !== undefined ? e.clientX : e.touches[0].clientX) - rect.left;
    var frac = Math.max(0, Math.min(1, x / rect.width));
    ttCurrentRow = frac * (ttMeta.row_count - 1);
    ttLastFrameTs = null; /* reset frame timer to avoid jump */
    ttRedraw();
  }

  sw.addEventListener('mousedown', function(e) {
    ttScrubDragging = true;
    ttScrubSeek(e);
    e.preventDefault();
  });
  window.addEventListener('mousemove', function(e) {
    if (!ttScrubDragging) return;
    ttScrubSeek(e);
  });
  window.addEventListener('mouseup', function() {
    ttScrubDragging = false;
  });
  /* Touch support */
  sw.addEventListener('touchstart', function(e) {
    ttScrubDragging = true;
    ttScrubSeek(e);
    e.preventDefault();
  }, { passive: false });
  sw.addEventListener('touchmove', function(e) {
    if (!ttScrubDragging) return;
    ttScrubSeek(e);
    e.preventDefault();
  }, { passive: false });
  sw.addEventListener('touchend', function() {
    ttScrubDragging = false;
  });
}

/* ── Hover tooltip on the 3D canvas ────────────────────────────────────── */
function ttSetupHover() {
  var wrap = document.getElementById('tt-canvas-wrap');
  var c = document.getElementById('tt-canvas');
  var tt = document.getElementById('tt');
  if (!wrap || !c || !tt) return;

  wrap.addEventListener('mousemove', function(e) {
    if (!ttMeta || !ttBmp || !ttReadCtx) return;
    var rect = c.getBoundingClientRect();
    var xp = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

    /* Map screen X back to frequency — front row spans full width */
    var startHz = ttMeta.start_freq_hz || 0;
    var spanHz = (ttMeta.end_freq_hz || 30e6) - startHz;
    var hz = startHz + xp * spanHz;
    var mhz = (hz / 1e6).toFixed(4);
    var band = (typeof bandName === 'function') ? bandName(hz) : null;

    /* Current row */
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

    /* Signal level from pixel on the front row */
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
  /* Only handle keys when the TT tab is active */
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
    case ']':
      /* Increase speed */
      var speeds = [1, 2, 4, 8, 16];
      var ci = speeds.indexOf(ttSpeedMult);
      if (ci < speeds.length - 1) ttSetSpeed(speeds[ci + 1]);
      break;
    case '[':
      /* Decrease speed */
      var speeds2 = [1, 2, 4, 8, 16];
      var ci2 = speeds2.indexOf(ttSpeedMult);
      if (ci2 > 0) ttSetSpeed(speeds2[ci2 - 1]);
      break;
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