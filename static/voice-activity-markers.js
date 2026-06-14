// Voice Activity Markers
// ======================
// Draws voice-activity markers on the spectrum display, alongside the bookmark,
// DX-spot and CW-spot markers. Built in to the main page — does NOT require the
// voice widget. Subscribes to the shared window.VoiceActivityService for data.
//
// Each marker shows the spotted callsign when one is known, otherwise "Voice".
// Markers carry their frequency and mode, so clicking one tunes the radio.
//
// Colour: purple — distinct from DX spots (green) and CW spots (cyan).
//
// Exposes:
//   window.drawVoiceActivityOnSpectrum(spectrumDisplay, log)
//   window.voiceActivityPositions  // [{ x, y, width, height, activity }]

(function () {
  'use strict';

  var BG_COLOR     = 'rgba(155, 89, 182, 0.95)';  // purple fill
  var BORDER_COLOR = 'rgba(255, 255, 255, 0.9)';
  var TEXT_COLOR   = '#FFFFFF';

  // The backend keeps each frequency in its results for 90s after it was last
  // detected (resetting that timer on every detection), so the API response is
  // already stable. We just render whatever the latest poll returned.
  var latestActivities = [];
  var lastSignature = null;

  var voiceActivityPositions = [];
  window.voiceActivityPositions = voiceActivityPositions;

  // A voice marker that has been correlated to a callsign is suppressed when a
  // DX-cluster spot already marks that same callsign nearby, so the two layers
  // don't stack a green + purple pair on the same station. DX wins because its
  // callsign is human-confirmed; voice draws last so dxSpotPositions is already
  // populated for this cache rebuild by the time we get here.
  var DEDUP_FREQ_TOLERANCE_HZ = 500;

  // ── Data accessors ─────────────────────────────────────────────────────────
  function activityFreq(act)  { return act.estimated_dial_freq || act.start_freq; }
  function activityMode(act)  { return (act.mode || 'LSB').toLowerCase(); }
  function activityLabel(act) { return act.dx_callsign || 'Voice'; }

  function normCall(call) { return call ? String(call).trim().toUpperCase() : ''; }

  // True when a DX-cluster spot already covers this callsign within tolerance.
  function dxSpotCovers(callsign, freq) {
    var call = normCall(callsign);
    if (!call) return false; // uncorrelated "Voice" markers never dedupe
    var positions = window.dxSpotPositions;
    if (!positions || positions.length === 0) return false;
    return positions.some(function (pos) {
      var spot = pos && pos.spot;
      if (!spot || normCall(spot.dx_call) !== call) return false;
      if (freq == null || spot.frequency == null) return true; // call match, no usable freq
      return Math.abs(spot.frequency - freq) <= DEDUP_FREQ_TOLERANCE_HZ;
    });
  }

  // ── Subscribe to the shared service ────────────────────────────────────────
  function init() {
    if (!window.VoiceActivityService) { setTimeout(init, 200); return; }
    window.VoiceActivityService.subscribe(function (state) {
      // On a transient fetch error keep the last markers (the backend's own
      // persistence means it's just a missed poll, not a real disappearance).
      if (state && state.error) return;
      latestActivities = (state && state.enabled && state.activities) ? state.activities : [];

      // Redraw only when the marker-relevant data actually changed, to avoid
      // needless marker-cache rebuilds on every (5s) poll.
      var sig = latestActivities.map(function (a) {
        return (activityFreq(a) || '') + ':' + activityLabel(a) + ':' + activityMode(a);
      }).join('|');
      if (sig === lastSignature) return;
      lastSignature = sig;
      requestRedraw();
    });
  }

  // Invalidate the spectrum marker cache and redraw so new data shows promptly.
  function requestRedraw() {
    var sd = window.spectrumDisplay;
    if (!sd || typeof sd.invalidateMarkerCache !== 'function') return;
    sd.invalidateMarkerCache();
    if (sd.spectrumData && sd.spectrumData.length > 0 && typeof sd.draw === 'function') {
      sd.draw();
    }
  }

  // ── Draw (called from spectrum-display.js marker cache render) ──────────────
  function drawVoiceActivityOnSpectrum(spectrumDisplay, log) {
    voiceActivityPositions = [];
    window.voiceActivityPositions = voiceActivityPositions;

    if (!spectrumDisplay || !spectrumDisplay.overlayCtx) return;
    var ctx = spectrumDisplay.overlayCtx;
    if (!ctx || !spectrumDisplay.totalBandwidth || !spectrumDisplay.centerFreq) return;

    if (!latestActivities || latestActivities.length === 0) return;

    var startFreq = spectrumDisplay.centerFreq - spectrumDisplay.totalBandwidth / 2;
    var endFreq   = spectrumDisplay.centerFreq + spectrumDisplay.totalBandwidth / 2;

    // Keep only currently-visible markers (backend already deduplicates by bin).
    var visible = [];
    latestActivities.forEach(function (act) {
      var freq = activityFreq(act);
      if (freq == null || freq < startFreq || freq > endFreq) return;

      // Defer to the DX-cluster marker when it already covers this callsign.
      if (dxSpotCovers(act.dx_callsign, freq)) return;

      var label = activityLabel(act);
      var x = ((freq - startFreq) / (endFreq - startFreq)) * spectrumDisplay.width;
      ctx.font = 'bold 10px monospace';
      var labelWidth = ctx.measureText(label).width + 8;
      visible.push({ act: act, label: label, x: x, labelWidth: labelWidth, row: 0 });
    });

    if (visible.length === 0) return;

    // Sort by x, then assign to one of two rows to avoid overlap
    // (same two-row collision algorithm as bookmarks / DX / CW spots).
    visible.sort(function (a, b) { return a.x - b.x; });

    var row0 = [], row1 = [];
    function overlaps(current, others) {
      return others.some(function (other) {
        var cl = current.x - current.labelWidth / 2;
        var cr = current.x + current.labelWidth / 2;
        var ol = other.x - other.labelWidth / 2;
        var or_ = other.x + other.labelWidth / 2;
        return !(cr + 3 < ol || cl - 3 > or_);
      });
    }
    visible.forEach(function (current) {
      if (!overlaps(current, row0)) { current.row = 0; row0.push(current); }
      else if (!overlaps(current, row1)) { current.row = 1; row1.push(current); }
      else { current.row = 0; row0.push(current); }
    });

    var labelHeight = 12;
    var arrowLength = 6;
    var rowSpacing  = 15; // matches bookmark / spot positioning

    // Draw row 1 first so row 0 labels sit on top.
    var sortedByRow = visible.slice().sort(function (a, b) { return b.row - a.row; });

    sortedByRow.forEach(function (item) {
      var x = item.x;
      var labelWidth = item.labelWidth;
      var labelY = 32 - (item.row * rowSpacing);

      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      // Label background + border
      ctx.fillStyle = BG_COLOR;
      ctx.fillRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);
      ctx.strokeStyle = BORDER_COLOR;
      ctx.lineWidth = 1;
      ctx.strokeRect(x - labelWidth / 2, labelY, labelWidth, labelHeight);

      // Label text
      ctx.fillStyle = TEXT_COLOR;
      ctx.fillText(item.label, x, labelY + 2);

      // Downward arrow to the baseline
      var arrowStartY = labelY + labelHeight;
      var arrowTipY   = 32 + labelHeight + arrowLength;
      ctx.fillStyle = BG_COLOR;
      ctx.beginPath();
      ctx.moveTo(x, arrowTipY);
      ctx.lineTo(x - 4, arrowStartY);
      ctx.lineTo(x + 4, arrowStartY);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = BORDER_COLOR;
      ctx.lineWidth = 1;
      ctx.stroke();

      // Store position for hover/click detection, with freq + mode attached
      voiceActivityPositions.push({
        x: x,
        y: labelY,
        width: labelWidth,
        height: labelHeight + (arrowTipY - arrowStartY),
        activity: item.act,
        frequency: activityFreq(item.act),
        mode: activityMode(item.act),
        label: item.label
      });
    });

    window.voiceActivityPositions = voiceActivityPositions;
  }

  window.drawVoiceActivityOnSpectrum = drawVoiceActivityOnSpectrum;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
