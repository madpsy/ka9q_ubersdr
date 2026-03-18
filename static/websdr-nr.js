// websdr-nr.js - Spectral Noise Reduction
// Copyright 2026 joshuah.rainstar@gmail.com
// Licensed under the following terms:
// MIT license terms apply, with the caveat that if the author is impoverished(true unless evaluated otherwise)
// you agree to admit commercial use without recompensation according to your ability would be a wrong doing.
// commercial use shall be defined as any use where either access is paid for or installation is paid for
// or the program is bundled in any product that has a price, inclusive of any modifications or rewrites of the program.


(function() {
    "use strict";

    // ================================================================
    //  CONSTANTS
    // ================================================================
    var N_FFT = 512;
    var HALF = 256;
    var N_BINS = 257; // N_FFT/2 + 1
    var HOP = 128;
    var N_FRAMES = 192;
    var OUTPUT_FRAMES = 32; // 4096 / HOP
    // Output slice: frames [OUTPUT_START .. OUTPUT_START+OUTPUT_FRAMES)
    // Gives ~170 ms lookahead (64 frames * 128 / 48000)
    var OUTPUT_START = N_FRAMES - OUTPUT_FRAMES - 64; // = 96
    var TIME_PAD = 13;
    var FREQ_PAD = 3;
    var AUDIO_BUF = 24576; // 3 * 8192

    // ================================================================
    //  FFT  (in-place radix-2 Cooley-Tukey, 512-point)
    // ================================================================
    var bitrev = new Uint16Array(N_FFT);
    (function() {
        for (var i = 0; i < N_FFT; i++) {
            var j = 0;
            for (var k = 0; k < 9; k++) j = (j << 1) | ((i >> k) & 1);
            bitrev[i] = j;
        }
    })();


    // Forward twiddle factors (negative exponent)
    var twRe = new Float64Array(HALF);
    var twIm = new Float64Array(HALF);
    (function() {
        for (var i = 0; i < HALF; i++) {
            var a = (-2 * Math.PI * i) / N_FFT;
            twRe[i] = Math.cos(a);
            twIm[i] = Math.sin(a);
        }
    })();

    function fft512(re, im) {
        var i, j, s, len, half, step, idx1, idx2, twIdx;
        var tRe, tIm, uRe, uIm, vRe, vIm, t;
        for (i = 0; i < N_FFT; i++) {
            j = bitrev[i];
            if (i < j) {
                t = re[i];
                re[i] = re[j];
                re[j] = t;
                t = im[i];
                im[i] = im[j];
                im[j] = t;
            }
        }
        for (s = 1, len = 2; len <= N_FFT; s++, len <<= 1) {
            half = len >> 1;
            step = N_FFT >> s;
            for (i = 0; i < N_FFT; i += len) {
                for (j = 0; j < half; j++) {
                    twIdx = j * step;
                    tRe = twRe[twIdx];
                    tIm = twIm[twIdx];
                    idx1 = i + j;
                    idx2 = idx1 + half;
                    uRe = re[idx1];
                    uIm = im[idx1];
                    vRe = re[idx2] * tRe - im[idx2] * tIm;
                    vIm = re[idx2] * tIm + im[idx2] * tRe;
                    re[idx1] = uRe + vRe;
                    im[idx1] = uIm + vIm;
                    re[idx2] = uRe - vRe;
                    im[idx2] = uIm - vIm;
                }
            }
        }
    }

    function ifft512(re, im) {
        var i, inv;
        for (i = 0; i < N_FFT; i++) im[i] = -im[i];
        fft512(re, im);
        inv = 1.0 / N_FFT;
        for (i = 0; i < N_FFT; i++) {
            re[i] *= inv;
            im[i] = -im[i] * inv;
        }
    }

    // rfft: real input -> first 257 complex bins
    function rfft(inp, outRe, outIm) {
        var re = _wkRe,
            im = _wkIm;
        for (var i = 0; i < N_FFT; i++) {
            re[i] = inp[i];
            im[i] = 0;
        }
        fft512(re, im);
        for (var i = 0; i < N_BINS; i++) {
            outRe[i] = re[i];
            outIm[i] = im[i];
        }
    }

    // irfft: first 257 complex bins -> 512 real output
    function irfft(inRe, inIm, out) {
        var re = _wkRe,
            im = _wkIm;
        for (var i = 0; i < N_BINS; i++) {
            re[i] = inRe[i];
            im[i] = inIm[i];
        }
        for (var i = 1; i < HALF; i++) {
            re[N_FFT - i] = inRe[i];
            im[N_FFT - i] = -inIm[i];
        }
        ifft512(re, im);
        for (var i = 0; i < N_FFT; i++) out[i] = re[i];
    }

    var _wkRe = new Float64Array(N_FFT);
    var _wkIm = new Float64Array(N_FFT);

    // ================================================================
    //  WINDOW (Hann)
    // ================================================================
    var hannWin = new Float64Array(N_FFT);
    (function() {
        for (var i = 0; i < N_FFT; i++)
            hannWin[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N_FFT - 1)));
    })();

    var synthWin = new Float64Array(N_FFT);
    (function() {
        for (var k = 0; k < N_FFT; k++) {
            var sumSq = 0;
            for (var m = k % HOP; m < N_FFT; m += HOP) {
                sumSq += hannWin[m] * hannWin[m];
            }
            synthWin[k] = sumSq > 0 ? hannWin[k] / sumSq : 0;
        }
    })();

    // Overlap-add normalisation for Hann^2 at 75% overlap = 1.5

    // ================================================================
    //  NOISE REDUCTION ENGINE
    // ================================================================
    function NREngine() {
        this.nbins = 37;
        this.threshold = 0.057; // entropy const
        this.mult = 0.1; // peak detection strength  (maps to the slider)
        this.enabled = false;
        this.squelchMode = true;

        // Audio ring
        this.audio = new Float64Array(AUDIO_BUF);

        // STFT frames [N_FRAMES][N_BINS]
        this.fRe = alloc2d(N_FRAMES, N_BINS);
        this.fIm = alloc2d(N_FRAMES, N_BINS);
        this.fMag = alloc2d(N_FRAMES, N_BINS);

        // Mask + smoothed magnitude
        this.mask = alloc2d(N_FRAMES, N_BINS);
        this.smoothed = alloc2d(N_FRAMES, N_BINS);

        // Entropy
        this.entropyRaw = new Float64Array(N_FRAMES);
        this.entropySmoothed = new Float64Array(N_FRAMES);
        this.entropyThresh = new Int8Array(N_FRAMES);

        // Logistic reference distributions
        this.logistic1 = new Float64Array(N_BINS);
        this.logistic3 = new Float64Array(N_BINS * 3);
        this.max1 = 1;
        this.max3 = 1;

        // ISTFT overlap tail
        this.olaBuf = new Float64Array(N_FFT - HOP); // 384

        // Internal flag (0=quiet, 1=trailing, 2=active)
        this.flag = 0;
        this._prevNbins = -1;

        // Temp arrays (pre-allocated to avoid GC in hot path)
        this._t512 = new Float64Array(N_FFT);
        this._tBins = new Float64Array(N_BINS);
        this._t3Bins = new Float64Array(N_BINS * 3);
        this._tSort = new Float64Array(N_BINS * N_FRAMES);
        this._tDiff = new Float64Array(N_BINS * N_FRAMES);
        this._t192 = new Float64Array(N_FRAMES);

        // Pre-allocated for _smoothAndMask
        this._work = alloc2d(N_FRAMES, N_BINS);
        this._mask2 = alloc2d(N_FRAMES, N_BINS);

        // Pre-allocated for _convolve2d
        var pH = N_FRAMES + 2 * TIME_PAD;
        var pW = N_BINS + 2 * FREQ_PAD;
        this._c2dVert = alloc2d(pH, pW);
        this._c2dHoriz = alloc2d(pH, pW);
        this._c2dTmpRow = new Float64Array(pW);
        this._c2dCol = new Float64Array(pH);
        this._c2dColOut = new Float64Array(pH);

        // Pre-allocated for sawtoothSmooth1d
        this._sawPad = new Float64Array(N_FRAMES + 14);
        this._sawOut = new Float64Array(N_FRAMES);

        // Delay buffer: we hold one block of raw output to provide lookahead
        this._delayBuf = new Float32Array(4096);
        this._delayReady = false;

        this._updateBins();
    }

    function alloc2d(rows, cols) {
        var a = new Array(rows);
        for (var i = 0; i < rows; i++) a[i] = new Float64Array(cols);
        return a;
    }

    NREngine.prototype._updateBins = function() {
        if (this.nbins === this._prevNbins) return;
        var nb = this.nbins;
        if (nb < 4) nb = 4;
        if (nb > 257) nb = 257;
        this.nbins = nb;
        this._prevNbins = nb;
        generateLogistic(this.logistic1, nb);
        generateLogistic(this.logistic3, nb * 3);
        this.max1 = entropyMaximum(this.logistic1, nb);
        this.max3 = entropyMaximum(this.logistic3, nb * 3);
        // Clear smoothed storage since bin count changed
        for (var i = 0; i < N_FRAMES; i++) this.smoothed[i].fill(0);
    };

    // ---- Logistic distribution (odd-reflected endpoints) ----
    function generateLogistic(out, n) {
        if (n < 4) return;
        var i;
        for (i = 0; i < n; i++) out[i] = i / (n - 1);
        for (i = 1; i < n - 1; i++) out[i] = Math.log(out[i] / (1 - out[i]));
        out[n - 1] = 2 * out[n - 2] - out[n - 3];
        out[0] = -out[n - 1];
        var mn = out[0],
            mx = out[n - 1],
            rng = mx - mn;
        if (rng === 0) return;
        for (i = 0; i < n; i++) out[i] = (out[i] - mn) / rng;
    }

    // ---- Pearson correlation ----
    function pearson(x, xOff, y, yOff, n) {
        var sx = 0,
            sy = 0,
            sxy = 0,
            sx2 = 0,
            sy2 = 0,
            i, xi, yi;
        for (i = 0; i < n; i++) {
            xi = x[xOff + i];
            yi = y[yOff + i];
            sx += xi;
            sy += yi;
            sxy += xi * yi;
            sx2 += xi * xi;
            sy2 += yi * yi;
        }
        var d = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
        return d === 0 ? 0 : (n * sxy - sx * sy) / d;
    }

    function entropyMaximum(logistic, n) {
        var tmp = new Float64Array(n);
        tmp[n - 1] = 1;
        return 1 - pearson(tmp, 0, logistic, 0, n);
    }

    // ---- MAN (Median Absolute deviation from mediaN) ----
    function median(arr, n) {
        if (n === 0) return 0;
        // We sort a copy
        var s = arr.slice(0, n).sort(function(a, b) {
            return a - b;
        });
        return n % 2 === 0 ? (s[n / 2] + s[n / 2 - 1]) / 2 : s[(n - 1) / 2];
    }

    // 1D MAN: median of absolute deviations from median (non-zero values)
    function man1d(data, nb) {
        var vals = [],
            i, v;
        for (i = 0; i < nb; i++) {
            v = data[i];
            if (v !== 0 && !isNaN(v)) vals.push(v);
        }
        if (vals.length === 0) return 0;
        vals.sort(function(a, b) {
            return a - b;
        });
        var n = vals.length;
        var med = n % 2 === 0 ? (vals[n / 2] + vals[n / 2 - 1]) / 2 : vals[(n - 1) / 2];
        var diffs = new Array(n);
        for (i = 0; i < n; i++) diffs[i] = Math.abs(vals[i] - med);
        diffs.sort(function(a, b) {
            return a - b;
        });
        return n % 2 === 0 ? (diffs[n / 2] + diffs[n / 2 - 1]) / 2 : diffs[(n - 1) / 2];
    }

    // 2D MAN over mag[frames][bins]
    function man2d(mag, frames, nb, sortBuf, diffBuf) {
        var n = 0,
            i, j, v;
        for (j = 0; j < frames; j++)
            for (i = 0; i < nb; i++) {
                v = mag[j][i];
                if (v !== 0) sortBuf[n++] = v;
            }
        if (n === 0) return 0;
        var s = sortBuf.subarray(0, n);
        s.sort();
        var med = n % 2 === 0 ? (s[n / 2] + s[n / 2 - 1]) / 2 : s[(n - 1) / 2];
        for (i = 0; i < n; i++) diffBuf[i] = Math.abs(s[i] - med);
        var d = diffBuf.subarray(0, n);
        d.sort();
        return n % 2 === 0 ? (d[n / 2] + d[n / 2 - 1]) / 2 : d[(n - 1) / 2];
    }

    // ATD (root-mean-square deviation from MAN)
    function atd1d(data, manVal, nb) {
        var sum = 0,
            n = 0,
            i, d;
        for (i = 0; i < nb; i++) {
            d = data[i] - manVal;
            sum += d * d;
            n++;
        }
        return n === 0 ? 0 : Math.sqrt(sum / n);
    }

    function atd2d(mag, manVal, frames, nb) {
        var sum = 0,
            cnt = frames * nb,
            j, i, d;
        for (j = 0; j < frames; j++)
            for (i = 0; i < nb; i++) {
                d = Math.abs(mag[j][i] - manVal);
                sum += d * d;
            }
        return cnt === 0 ? 0 : Math.sqrt(sum / cnt) - manVal;
    }

    // ---- STFT / ISTFT ----
    NREngine.prototype._stftFull = function() {
        // Pad audio: 256 reflect on each side
        var padLen = AUDIO_BUF + 512;
        if (!this._padBuf || this._padBuf.length < padLen)
            this._padBuf = new Float64Array(padLen);
        var pb = this._padBuf,
            au = this.audio;
        // Centre copy
        for (var i = 0; i < AUDIO_BUF; i++) pb[256 + i] = au[i];
        // Left reflect
        for (var i = 1; i <= 256; i++) pb[256 - i] = au[i];
        // Right reflect
        for (var i = 1; i <= 255; i++) pb[256 + AUDIO_BUF - 1 + i] = au[AUDIO_BUF - 1 - i];

        var win = hannWin,
            wf = this._t512;
        for (var seg = 0; seg < N_FRAMES; seg++) {
            var start = seg * HOP;
            // Window and copy
            for (var i = 0; i < N_FFT; i++) wf[i] = pb[start + i] * win[i];
            rfft(wf, this.fRe[seg], this.fIm[seg]);
        }
    };

    NREngine.prototype._updateMagnitudes = function() {
        var nb = this.nbins,
            j, i, re, im;
        for (j = 0; j < N_FRAMES; j++)
            for (i = 0; i < nb; i++) {
                re = this.fRe[j][i];
                im = this.fIm[j][i];
                this.fMag[j][i] = Math.sqrt(re * re + im * im);
            }
    };

    NREngine.prototype._istftBlock = function(outBuf) {
        // Synthesise OUTPUT_FRAMES frames starting at OUTPUT_START
        // into outBuf[4096], using overlap-add with this.olaBuf
        var win = synthWin,
            re, im, tBuf = this._t512;
        var olaBuf = this.olaBuf;
        var outIdx = 0;

        for (var f = 0; f < OUTPUT_FRAMES; f++) {
            var fi = OUTPUT_START + f;
            // Reconstruct time-domain frame
            irfft(this.fRe[fi], this.fIm[fi], tBuf);
            // Apply synthesis window
            for (var i = 0; i < N_FFT; i++) tBuf[i] *= win[i];

            // Overlap-add: first HOP samples go to output
            for (var i = 0; i < HOP; i++) {
                outBuf[outIdx + i] = (olaBuf[i] + tBuf[i]);
            }
            outIdx += HOP;

            // Shift olaBuf left by HOP
            for (var i = 0; i < HALF; i++) olaBuf[i] = olaBuf[i + HOP];
            for (var i = 0; i < HOP; i++) olaBuf[HALF + i] = 0;

            // Accumulate tail into olaBuf
            for (var i = 0; i < N_FFT - HOP; i++) olaBuf[i] += tBuf[HOP + i];
        }
    };

    // ---- Entropy (logistic correlation measure) ----
    NREngine.prototype._fastEntropy = function() {
        var nb = this.nbins,
            mag = this.fMag;
        var raw = this.entropyRaw;
        var buf3 = this._t3Bins,
            buf1 = this._tBins;
        var log3 = this.logistic3,
            log1 = this.logistic1;
        var n3 = nb * 3;
        var i, j, dx, v;

        // Middle frames: use 3-frame context
        for (i = 1; i < N_FRAMES - 1; i++) {
            for (j = 0; j < nb; j++) {
                buf3[j] = mag[i - 1][j];
                buf3[j + nb] = mag[i][j];
                buf3[j + 2 * nb] = mag[i + 1][j];
            }
            buf3.subarray(0, n3).sort();
            dx = buf3[n3 - 1] - buf3[0];
            if (dx === 0) {
                raw[i] = 0;
                continue;
            }
            var base = buf3[0];
            for (j = 0; j < n3; j++) buf3[j] = (buf3[j] - base) / dx;
            v = pearson(buf3, 0, log3, 0, n3);
            raw[i] = isNaN(v) ? 0 : 1 - v;
        }

        // Edge: frame 0
        for (j = 0; j < nb; j++) buf1[j] = mag[0][j];
        buf1.subarray(0, nb).sort();
        dx = buf1[nb - 1] - buf1[0];
        if (dx === 0) {
            raw[0] = 0;
        } else {
            var base0 = buf1[0];
            for (j = 0; j < nb; j++) buf1[j] = (buf1[j] - base0) / dx;
            v = pearson(buf1, 0, log1, 0, nb);
            raw[0] = isNaN(v) ? 0 : 1 - v;
        }

        // Edge: last frame
        for (j = 0; j < nb; j++) buf1[j] = mag[N_FRAMES - 1][j];
        buf1.subarray(0, nb).sort();
        dx = buf1[nb - 1] - buf1[0];
        if (dx === 0) {
            raw[N_FRAMES - 1] = 0;
        } else {
            var baseL = buf1[0];
            for (j = 0; j < nb; j++) buf1[j] = (buf1[j] - baseL) / dx;
            v = pearson(buf1, 0, log1, 0, nb);
            raw[N_FRAMES - 1] = isNaN(v) ? 0 : 1 - v;
        }
    };

    // Entropy smoothing (3-tap box convolution with 6-sample padding)
    NREngine.prototype._smoothEntropy = function() {
        var inp = this.entropyRaw,
            out = this.entropySmoothed;
        // Simple 3-tap moving average
        out[0] = (inp[0] + inp[1]) / 2;
        for (var i = 1; i < N_FRAMES - 1; i++)
            out[i] = (inp[i - 1] + inp[i] + inp[i + 1]) / 3;
        out[N_FRAMES - 1] = (inp[N_FRAMES - 2] + inp[N_FRAMES - 1]) / 2;
    };

    // Process entropy: detect voice activity
    NREngine.prototype._processEntropy = function() {
        this._fastEntropy();
        this._smoothEntropy();

        var thresh = this.entropyThresh;
        var sm = this.entropySmoothed;
        var cnst = this.threshold;
        var count = 0;
        thresh.fill(0);

        for (var i = 0; i < N_FRAMES; i++) {
            if (sm[i] > cnst) {
                thresh[i] = 1;
                if (i > 31 && i < 161) count++;
            }
        }

        if (count > 22 || longestConsecutive(thresh) > 16) {
            this.flag = 2;
            removeOutliers(thresh, 0, 6, 1);
            removeOutliers(thresh, 1, 2, 0);
        }
    };

    function longestConsecutive(arr) {
        var cur = 0,
            best = 0;
        for (var i = 0; i < arr.length; i++) {
            if (arr[i] === 1) {
                cur++;
            } else {
                if (cur > best) best = cur;
                cur = 0;
            }
        }
        if (cur > best) best = cur;
        return best;
    }

    function removeOutliers(a, value, threshold, replace) {
        var first = 0,
            end, idx;
        while (first < a.length) {
            if (a[first] === value) {
                idx = first;
                while (idx < a.length && a[idx] === value) idx++;
                end = idx;
                if (end - first + 1 < threshold) {
                    for (var i = first; i < end; i++) a[i] = replace;
                }
                first = end;
            } else {
                idx = first;
                while (idx < a.length && a[idx] !== value) idx++;
                first = idx;
            }
        }
    }

    // ---- Sawtooth temporal smoothing (triangular 15-tap) ----
    var sawKernel = [0, 0.14285714, 0.28571429, 0.42857143, 0.57142857,
        0.71428571, 0.85714286, 1.0, 0.85714286, 0.71428571,
        0.57142857, 0.42857143, 0.28571429, 0.14285714, 0
    ];
    var sawKernelSum = 6.916666666666667;

    function sawtoothSmooth1d(arr, n, padBuf, outBuf) {
        // Convolve arr[0..n-1] in-place with sawKernel, same-mode
        var kLen = 15,
            pad = 7;
        padBuf.fill(0);
        for (var i = 0; i < n; i++) padBuf[i + pad] = arr[i];
        for (var i = 0; i < n; i++) {
            var s = 0;
            for (var k = 0; k < kLen; k++) s += padBuf[i + k] * sawKernel[k];
            outBuf[i] = s / sawKernelSum;
        }
        for (var i = 0; i < n; i++) arr[i] = outBuf[i];
    }

    // Sawtooth convolve each frequency column across time
    NREngine.prototype._sawtoothConvolve = function(src, dst) {
        var nb = this.nbins,
            tmp = this._t192;
        var padBuf = this._sawPad,
            outBuf = this._sawOut;
        for (var i = 0; i < nb; i++) {
            for (var j = 0; j < N_FRAMES; j++) tmp[j] = src[j][i];
            sawtoothSmooth1d(tmp, N_FRAMES, padBuf, outBuf);
            for (var j = 0; j < N_FRAMES; j++) dst[j][i] = tmp[j];
        }
    };

    // ---- 2D mask smoothing (3x freq, 13x time, 3 iterations) ----
    NREngine.prototype._convolve2d = function(data) {
        var nb = this.nbins,
            nf = N_FRAMES;
        var pH = nf + 2 * TIME_PAD;
        var pW = nb + 2 * FREQ_PAD;
        var vert = this._c2dVert,
            horiz = this._c2dHoriz;
        var tmp = this._c2dTmpRow,
            col = this._c2dCol,
            colOut = this._c2dColOut;
        var i, j, e, s;

        for (e = 0; e < 3; e++) {
            // Zero padded arrays then fill centre
            for (i = 0; i < pH; i++) {
                vert[i].fill(0);
                horiz[i].fill(0);
            }
            for (i = 0; i < nf; i++)
                for (j = 0; j < nb; j++) {
                    vert[i + TIME_PAD][j + FREQ_PAD] = data[i][j];
                    horiz[i + TIME_PAD][j + FREQ_PAD] = data[i][j];
                }
            for (i = 0; i < nf; i++) {
                var row = i + TIME_PAD;
                var leftVal = data[i][0];
                var rightVal = data[i][nb - 1];
                for (j = 0; j < FREQ_PAD; j++) {
                    vert[row][j] = leftVal;
                    vert[row][nb + FREQ_PAD + j] = rightVal;
                    horiz[row][j] = leftVal;
                    horiz[row][nb + FREQ_PAD + j] = rightVal;
                }
            }


            // Frequency-wise 3-tap box on vert
            for (i = 0; i < pH; i++) {
                tmp.fill(0);
                for (j = 1; j < pW - 1; j++)
                    tmp[j] = (vert[i][j - 1] + vert[i][j] + vert[i][j + 1]) / 3;
                tmp[0] = (vert[i][0] + vert[i][1]) / 2;
                tmp[pW - 1] = (vert[i][pW - 2] + vert[i][pW - 1]) / 2;
                for (j = 0; j < pW; j++) vert[i][j] = tmp[j];
            }

            // Time-wise 13-tap box on horiz
            for (j = 0; j < pW; j++) {
                for (i = 0; i < pH; i++) col[i] = horiz[i][j];
                for (i = 0; i < pH; i++) {
                    s = 0;
                    var cnt = 0;
                    for (var k = -6; k <= 6; k++) {
                        var ii = i + k;
                        if (ii >= 0 && ii < pH) {
                            s += col[ii];
                            cnt++;
                        }
                    }
                    colOut[i] = cnt > 0 ? s / cnt : 0;
                }
                for (i = 0; i < pH; i++) horiz[i][j] = colOut[i];
            }

            // Average vert and horiz
            for (i = 0; i < pH; i++)
                for (j = 0; j < pW; j++) {
                    var avg = (vert[i][j] + horiz[i][j]) / 2;
                    vert[i][j] = avg;
                    horiz[i][j] = avg;
                }
        }

        // Extract centre
        for (i = 0; i < nf; i++)
            for (j = 0; j < nb; j++)
                data[i][j] = vert[i + TIME_PAD][j + FREQ_PAD];
    };

    // ---- Fast peaks (statistical gating) ----
    NREngine.prototype._fastPeaks = function(smoothed, mask, manG, atdG) {
        var nb = this.nbins,
            mx3 = this.max3;
        var ent = this.entropyRaw,
            et = this.entropyThresh;
        var alpha = 0.5,
            mult = this.mult;
        var tBins = this._tBins;

        for (var each = 0; each < N_FRAMES; each++) {
            if (et[each] === 0 && this.squelchMode) continue;
            if (et[each] === 0 && ent[each] < this.threshold) continue;

            for (var j = 0; j < nb; j++) tBins[j] = smoothed[each][j];
            var manLocal = man1d(tBins, nb);
            var atdLocal = atd1d(tBins, manLocal, nb);

            var entFrac = ent[each] / mx3;
            if (entFrac > 1) entFrac = 1;
            var atdG2 = atdG * (1 - entFrac);
            var manG2 = manG * (1 - entFrac);

            var w1 = Math.exp(-alpha * Math.abs(manG2 - manLocal));
            var manFix = manLocal * w1 + manG2 * (1 - w1);
            var w2 = Math.exp(-alpha * Math.abs(atdG2 - atdLocal));
            var atdFix = atdLocal * w2 + atdG2 * (1 - w2);

            var thresh = manFix + atdFix * mult;

            for (var i = 0; i < nb; i++) {
                if (tBins[i] > thresh) mask[each][i] = 1;
            }
        }
    };

    // ---- Find max / min over 2D ----
    function findMax2d(data, frames, nb) {
        var mx = -Infinity;
        for (var j = 0; j < frames; j++)
            for (var i = 0; i < nb; i++)
                if (data[j][i] > mx) mx = data[j][i];
        return mx;
    }

    function findMin2d(data, frames, nb) {
        var mn = Infinity;
        for (var j = 0; j < frames; j++)
            for (var i = 0; i < nb; i++)
                if (data[j][i] < mn) mn = data[j][i];
        return mn;
    }

    // ---- Main smooth-and-mask pipeline ----
    NREngine.prototype._smoothAndMask = function() {
        var nb = this.nbins,
            mag = this.fMag,
            mask = this.mask;
        var smoothed = this.smoothed;
        var sortBuf = this._tSort,
            diffBuf = this._tDiff;

        // Zero the mask
        for (var i = 0; i < N_FRAMES; i++) mask[i].fill(0);

        // First pass: sawtooth smooth, then peaks
        this._sawtoothConvolve(mag, smoothed);
        var manG = man2d(smoothed, N_FRAMES, nb, sortBuf, diffBuf);
        var atdG = atd2d(smoothed, manG, N_FRAMES, nb);
        this._fastPeaks(smoothed, mask, manG, atdG);

        // Zero out mag where mask is 0 (into pre-allocated work copy)
        var work = this._work;
        for (var i = 0; i < N_FRAMES; i++)
            for (var j = 0; j < nb; j++)
                work[i][j] = mask[i][j] === 0 ? 0 : mag[i][j];

        var initial = findMax2d(mag, N_FRAMES, nb);
        var maxWork = findMax2d(work, N_FRAMES, nb);
        var multiplier = initial > 0 ? maxWork / initial : 1;
        if (multiplier > 1) multiplier = 1;

        // Second pass on masked data
        manG = man2d(work, N_FRAMES, nb, sortBuf, diffBuf);
        atdG = atd2d(work, manG, N_FRAMES, nb);
        this._sawtoothConvolve(work, smoothed);

        var mask2 = this._mask2;
        for (var i = 0; i < N_FRAMES; i++) mask2[i].fill(0);
        this._fastPeaks(smoothed, mask2, manG, atdG);

        // Combine: mask = min(mask * multiplier, mask2)
        for (var i = 0; i < N_FRAMES; i++)
            for (var j = 0; j < nb; j++) {
                var v1 = mask2[i][j] * multiplier;
                if (mask[i][j] > v1) mask[i][j] = v1;
                else mask[i][j] = Math.max(mask[i][j], mask2[i][j]);
            }

        // Final smoothing of the soft mask
        this._sawtoothConvolve(mask, mask);
        this._convolve2d(mask);
    };

    // ================================================================
    //  MAIN PROCESS (called per 4096-sample block)
    // ================================================================
    NREngine.prototype.processBlock = function(samples) {
        // samples: Float32Array of length 4096
        // Returns: Float32Array of length 4096 (processed)

        this._updateBins();
        var nb = this.nbins;

        // Guard: if bins too small, pass through
        if (nb < 4) return samples;

        // Shift audio left by 4096, append new samples
        var au = this.audio;
        for (var i = 0; i < AUDIO_BUF - 4096; i++) au[i] = au[i + 4096];
        for (var i = 0; i < 4096; i++) au[AUDIO_BUF - 4096 + i] = samples[i];

        // Full STFT
        this._stftFull();
        this._updateMagnitudes();

        // Entropy-based VAD
        this.flag = 0;
        this._processEntropy();

        var out = new Float32Array(4096);

        if (this.flag === 2 || !this.squelchMode) {
            // Compute mask
            this._smoothAndMask();

            // Apply mask to complex STFT for output frames
            for (var f = 0; f < OUTPUT_FRAMES; f++) {
                var fi = OUTPUT_START + f;
                for (var j = 0; j < nb; j++) {
                    this.fRe[fi][j] *= this.mask[fi][j];
                    this.fIm[fi][j] *= this.mask[fi][j];
                }
                for (var j = nb; j < N_BINS; j++) {
                    this.fRe[fi][j] = 0;
                    this.fIm[fi][j] = 0;
                }
            }


            // ISTFT
            this._istftBlock(out);
        } else if (this.squelchMode) {
            // Silence: output zeros, clear overlap buffer
            this.olaBuf.fill(0);
            out.fill(0);
        }

        return out;
    };

    // ================================================================
    //  DELAY MANAGEMENT
    //  We need 1 block of lookahead (~85ms). The engine processes
    //  block N while outputting the result of block N-1.
    // ================================================================
    NREngine.prototype.processWithDelay = function(samples) {
        var result;
        if (!this._delayReady) {
            // First call: process but output silence; store result
            this._delayBuf = this.processBlock(samples);
            this._delayReady = true;
            return null; // signal: use original audio this one time
        }
        // Return the previous processed block; process new
        result = this._delayBuf;
        this._delayBuf = this.processBlock(samples);
        return result;
    };

    // ================================================================
    //  UBERSDR INTEGRATION
    //
    //  Exposes a single NREngine instance as window.websdrNR.
    //
    //  UberSDR's app.js calls this from initNoiseReduction() instead
    //  of NR2Processor.  The ScriptProcessorNode onaudioprocess
    //  callback should call:
    //
    //      var processed = window.websdrNR.process(inputFloat32);
    //      if (processed !== null) outputBuffer.set(processed);
    //      else outputBuffer.set(inputFloat32);   // first-block passthrough
    //
    //  Control surface (mirrors NR2Processor's setParameters API):
    //
    //      window.websdrNR.setEnabled(bool)
    //      window.websdrNR.setMult(0.05..0.99)      // peak detection strength
    //      window.websdrNR.setThreshold(0.01..0.30) // entropy VAD threshold
    //      window.websdrNR.setSquelch(bool)          // suppress full-noise frames
    //      window.websdrNR.syncBins(bandwidthHz, sampleRate)
    //                                                // sync active bins to filter BW
    //      window.websdrNR.reset()                   // flush on freq/mode change
    //
    //  Read-only:
    //      window.websdrNR.engine   — the raw NREngine for debugging
    // ================================================================

    var _engine = new NREngine();

    window.websdrNR = {
        engine: _engine,

        /** Enable or disable processing. When disabled, process() returns null. */
        setEnabled: function(enabled) {
            _engine.enabled = !!enabled;
        },

        /**
         * Peak detection strength.
         * Maps to NREngine.mult.  Range [0.05, 0.99].
         * Higher = more aggressive peak gating (more noise removed, more signal risk).
         */
        setMult: function(mult) {
            mult = parseFloat(mult);
            if (mult < 0.05) mult = 0.05;
            if (mult > 0.99) mult = 0.99;
            _engine.mult = mult;
        },

        /**
         * Entropy VAD threshold.
         * Maps to NREngine.threshold.  Range [0.01, 0.30].
         * Lower = more sensitive (triggers on weaker signals).
         */
        setThreshold: function(thresh) {
            thresh = parseFloat(thresh);
            if (thresh < 0.01) thresh = 0.01;
            if (thresh > 0.30) thresh = 0.30;
            _engine.threshold = thresh;
        },

        /**
         * Squelch mode: when true, frames classified as pure noise are
         * output as silence rather than passed through.
         */
        setSquelch: function(enabled) {
            _engine.squelchMode = !!enabled;
        },

        /**
         * Sync the number of active FFT bins to the current filter bandwidth.
         * Call this whenever the demodulator bandwidth or mode changes.
         *
         * @param {number} bandwidthHz  filter passband in Hz (e.g. 2700)
         * @param {number} sampleRate   audio sample rate in Hz (e.g. 12000, 48000)
         */
        syncBins: function(bandwidthHz, sampleRate) {
            if (!bandwidthHz || !sampleRate || sampleRate <= 0) return;
            // N_FFT = 512; bin width = sampleRate / N_FFT
            var binWidth = sampleRate / N_FFT;
            var bins = Math.ceil(bandwidthHz / binWidth) + 1;
            if (bins < 4)   bins = 4;
            if (bins > 257) bins = 257;
            _engine.nbins = bins;
        },

        /**
         * Reset engine state (flush ring buffer, OLA tail, delay buffer).
         * Call on frequency change, mode change, or sample-rate change —
         * mirrors NR2Processor.resetLearning() in the existing NR2 integration.
         */
        reset: function() {
            _engine.audio.fill(0);
            _engine.olaBuf.fill(0);
            _engine._delayReady = false;
            _engine._delayBuf = new Float32Array(4096);
            for (var i = 0; i < N_FRAMES; i++) {
                _engine.fRe[i].fill(0);
                _engine.fIm[i].fill(0);
                _engine.fMag[i].fill(0);
                _engine.mask[i].fill(0);
                _engine.smoothed[i].fill(0);
            }
            _engine.entropyRaw.fill(0);
            _engine.entropySmoothed.fill(0);
            _engine.entropyThresh.fill(0);
        },

        /**
         * Process one block of audio.
         *
         * @param {Float32Array} samples  mono audio at the server sample rate.
         *                                Length MUST be 4096 samples.
         *                                (If your ScriptProcessorNode uses a
         *                                different buffer size, accumulate/drain
         *                                in 4096-sample chunks — see note below.)
         * @returns {Float32Array|null}   processed block of the same length,
         *                                or null on the very first call (use
         *                                original audio as passthrough that time).
         *
         * NOTE ON BUFFER SIZE
         * The engine is tuned for 4096-sample blocks (AUDIO_BUF = 3×8192,
         * OUTPUT_FRAMES = 32 = 4096/HOP).  UberSDR's NR2 ScriptProcessorNode
         * uses bufferSize=2048.  The simplest fix is to change that to 4096:
         *
         *   noiseReductionProcessor = audioContext.createScriptProcessor(4096, 1, 2);
         *
         * Alternatively, accumulate two 2048-sample callbacks before calling
         * process(), then split the 4096-sample result back across two outputs.
         */
        process: function(samples) {
            if (!_engine.enabled) return null;
            return _engine.processWithDelay(samples);
        }
    };

    console.log("[websdr-nr] NREngine ready — access via window.websdrNR");

})();