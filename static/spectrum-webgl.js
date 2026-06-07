/**
 * spectrum-webgl.js — True WebGL waterfall renderer for ka9q UberSDR
 *
 * Architecture
 * ────────────
 * The waterfall is stored as a 2-D ring-buffer texture on the GPU.
 * Each row holds one spectrum frame as normalised magnitude bytes (1..255).
 * Value 0 is reserved as a "no data" sentinel → rendered as black.
 * A 1-D colour-LUT texture (256 × 1 RGBA) maps magnitudes to colours.
 *
 * Every 30fps tick:
 *   1. CPU uploads ONE new row of bytes via texSubImage2D  (tiny transfer)
 *   2. Fragment shader maps each visible pixel to the correct ring-buffer row
 *      using the write pointer (integer pixel rows — no scroll in shader)
 *   3. The WebGL offscreen canvas is blitted onto the main Canvas2D canvas
 *      via drawImage() with a fractional Y offset for sub-pixel smooth scroll
 *
 * Key design decisions
 * ────────────────────
 * • Separate offscreen <canvas> for WebGL2 — the main canvas already has a
 *   '2d' context; a canvas can only have one rendering context type.
 * • Ring buffer maps 1 texture row : 1 visible waterfall pixel.  The shader
 *   uses uVisibleRows (not uRingRows) for the pixel→row mapping so the scroll
 *   is always 1:1 regardless of ring buffer size.
 * • Sub-pixel scroll is applied in the drawImage blit (dest Y += scrollPixels),
 *   not in the shader — avoids per-pixel fractional row lookups and jitter.
 * • Magnitude 0 = no data → black.  Real data stored as 1..255.
 */

'use strict';

class WaterfallWebGL {
    /**
     * @param {HTMLCanvasElement} mainCanvas - the existing spectrum-display-canvas
     *        (already has a '2d' context — we create a separate offscreen WebGL canvas)
     * @param {object} options
     * @param {number} [options.ringRows=2048] - ring buffer height (power of 2, >= canvas height)
     */
    constructor(mainCanvas, options = {}) {
        this.mainCanvas = mainCanvas;
        this.mainCtx    = mainCanvas.getContext('2d');  // retrieves existing context

        this.ringRows = options.ringRows || 2048;
        this.width    = mainCanvas.width;
        this.height   = mainCanvas.height;

        // Actual texture width — kept in sync with this.width only after _createRingTexture().
        // pushRow() uses this value (not this.width) to avoid uploading rows whose width
        // doesn't match the currently-allocated GPU texture.
        this._texWidth = this.width;

        // Offscreen canvas that owns the WebGL2 context
        this._glCanvas        = document.createElement('canvas');
        this._glCanvas.width  = this.width;
        this._glCanvas.height = this.height;

        // Ring-buffer write pointer
        this._writeRow  = 0;
        this._hasData   = false;  // true once first row is pushed

        // WebGL state
        this.gl        = null;
        this._program  = null;
        this._vao      = null;
        this._ringTex  = null;
        this._lutTex   = null;

        // Uniform locations
        this._uRingTex     = null;
        this._uLutTex      = null;
        this._uWriteRow    = null;
        this._uRingRows    = null;
        this._uVisibleRows = null;  // waterfall height in pixels
        this._uWaterfallY  = null;  // normalised Y start of waterfall [0,1]
        this._uWaterfallH  = null;  // normalised height of waterfall [0,1]

        this._supported = false;
        this._init();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    isSupported() { return this._supported; }

    /** Resize offscreen canvas and ring texture when the main canvas changes size */
    resize(width, height) {
        if (!this._supported) return;
        if (width === this.width && height === this.height) return; // no-op
        this.width  = width;
        this.height = height;
        this._glCanvas.width  = width;
        this._glCanvas.height = height;
        this.gl.viewport(0, 0, width, height);
        this._createRingTexture();  // recreates at new width; resets write pointer + _texWidth
    }

    /**
     * Upload a 256-entry RGBA colour LUT from the existing gradient array.
     * @param {string}   name          - colour scheme name (informational)
     * @param {string[]} colorGradient - array of 'rgb(r,g,b)' strings, length 256
     */
    setColorScheme(name, colorGradient) {
        if (!this._supported) return;
        const gl   = this.gl;
        const data = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) {
            const str = colorGradient[i] || 'rgb(0,0,0)';
            const m   = str.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
            if (m) {
                data[i * 4]     = parseInt(m[1]);
                data[i * 4 + 1] = parseInt(m[2]);
                data[i * 4 + 2] = parseInt(m[3]);
                data[i * 4 + 3] = 255;
            }
        }
        gl.bindTexture(gl.TEXTURE_2D, this._lutTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    /**
     * Push one new spectrum row into the ring buffer.
     * Applies the same contrast/intensity/range normalisation as the CPU path.
     * Magnitude is stored as 1..255 (0 is reserved as "no data" → black).
     */
    pushRow(spectrumData, minDb, maxDb, contrast, intensity, manualRange) {
        if (!this._supported || !spectrumData || spectrumData.length === 0) return;

        const gl      = this.gl;
        // Use _texWidth (the width the GPU texture was actually allocated at) rather than
        // this.width, which may have been updated by resize() before the new texture is
        // fully in place.  This prevents texSubImage2D from writing outside texture bounds.
        const W       = this._texWidth;
        if (W <= 0) return;

        // Safety: _writeRow must be within [0, ringRows).  If somehow it drifted out of
        // range (e.g. ringRows changed), clamp it back rather than issuing an invalid GL call.
        if (this._writeRow < 0 || this._writeRow >= this.ringRows) {
            this._writeRow = 0;
        }

        const dbRange = maxDb - minDb;
        const row     = new Uint8Array(W);

        for (let x = 0; x < W; x++) {
            const binPos   = (x / W) * spectrumData.length;
            const binIndex = Math.floor(binPos);
            const binFrac  = binPos - binIndex;

            let db;
            if (binIndex >= 0 && binIndex < spectrumData.length - 1) {
                db = spectrumData[binIndex] + (spectrumData[binIndex + 1] - spectrumData[binIndex]) * binFrac;
            } else if (binIndex === spectrumData.length - 1) {
                db = spectrumData[binIndex];
            } else {
                db = minDb;
            }

            let normalized = Math.max(0, Math.min(1, (db - minDb) / dbRange));
            let magnitude  = normalized * 255;

            if (!manualRange && magnitude < contrast) {
                magnitude = 0;
            } else if (!manualRange) {
                magnitude = ((magnitude - contrast) / (255 - contrast)) * 255;
            }

            if (intensity < 0) {
                magnitude = magnitude * (1 + intensity);
            } else if (intensity > 0) {
                magnitude = Math.min(255, magnitude * (1 + intensity * 2));
            }

            // Store as 1..255 — 0 is reserved as "no data" sentinel (renders black).
            // Add 1 and clamp so that even a true-zero magnitude stores as 1 (not black).
            row[x] = Math.max(1, Math.min(255, Math.round(magnitude) + 1));
        }

        // Upload one row to the ring buffer texture (gl.RED matches gl.R8 internal format)
        gl.bindTexture(gl.TEXTURE_2D, this._ringTex);
        gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,               // mip level
            0,               // x offset
            this._writeRow,  // y offset = ring write pointer
            W, 1,            // width, height
            gl.RED, gl.UNSIGNED_BYTE,
            row
        );
        gl.bindTexture(gl.TEXTURE_2D, null);

        this._writeRow = (this._writeRow + 1) % this.ringRows;
        this._hasData  = true;
    }

    /**
     * Render the waterfall onto the main canvas.  Call every rAF tick.
     *
     * @param {number} scrollPixels    - sub-pixel scroll offset in pixels [0,1)
     * @param {number} waterfallStartY - pixel Y where waterfall begins
     */
    render(scrollPixels, waterfallStartY) {
        if (!this._supported) return;
        const gl = this.gl;

        const visibleRows = this.height - waterfallStartY;
        if (visibleRows <= 0) return;

        gl.viewport(0, 0, this.width, this.height);
        gl.useProgram(this._program);

        // Texture unit 0 — ring buffer
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._ringTex);
        gl.uniform1i(this._uRingTex, 0);

        // Texture unit 1 — colour LUT
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._lutTex);
        gl.uniform1i(this._uLutTex, 1);

        // Uniforms — no scroll offset in shader; sub-pixel shift is applied in the blit
        gl.uniform1i(this._uWriteRow,    this._writeRow);
        gl.uniform1i(this._uRingRows,    this.ringRows);
        gl.uniform1i(this._uVisibleRows, visibleRows);

        // Waterfall region in normalised [0,1] canvas coordinates (Y=0 at top)
        gl.uniform1f(this._uWaterfallY, waterfallStartY / this.height);
        gl.uniform1f(this._uWaterfallH, visibleRows / this.height);

        // Draw full-screen quad onto offscreen WebGL canvas
        gl.bindVertexArray(this._vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);

        // Blit WebGL offscreen canvas → main Canvas2D canvas with sub-pixel Y shift.
        // The destination Y is offset by scrollPixels (0..1) to give smooth sub-pixel
        // scrolling — same technique as the original Canvas2D GPU composite path.
        // Source is 1px taller to fill the gap left by the shift.
        const srcH = Math.min(visibleRows - scrollPixels, visibleRows);
        this.mainCtx.drawImage(
            this._glCanvas,
            0, waterfallStartY,                    // source x, y (no shift — image is at correct position)
            this.width, srcH,                      // source w, h (clip bottom to avoid overflow)
            0, waterfallStartY + scrollPixels,     // dest x, y (shifted down by sub-pixel amount)
            this.width, srcH                       // dest w, h
        );
    }

    /** Release all WebGL resources */
    destroy() {
        if (!this._supported) return;
        const gl = this.gl;
        gl.deleteTexture(this._ringTex);
        gl.deleteTexture(this._lutTex);
        gl.deleteProgram(this._program);
        gl.deleteVertexArray(this._vao);
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        this._supported = false;
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _init() {
        try {
            const gl = this._glCanvas.getContext('webgl2', {
                alpha:                 false,
                antialias:             false,
                depth:                 false,
                stencil:               false,
                preserveDrawingBuffer: true,   // required: drawImage reads the framebuffer after drawArrays
                powerPreference:       'high-performance',
            });

            if (!gl) {
                console.warn('[WaterfallWebGL] WebGL2 not available — falling back to Canvas2D');
                return;
            }

            this.gl = gl;
            this._buildShaders();
            this._buildQuad();
            this._createRingTexture();
            this._createLutTexture();

            this._supported = true;
            console.log('[WaterfallWebGL] Initialised — true GPU waterfall active');
        } catch (e) {
            console.error('[WaterfallWebGL] Init failed:', e);
        }
    }

    _buildShaders() {
        const gl = this.gl;

        // Vertex shader — full-screen quad via gl_VertexID (no vertex buffer needed)
        const vsSource = `#version 300 es
precision highp float;

const vec2 POSITIONS[4] = vec2[4](
    vec2(-1.0, -1.0),
    vec2( 1.0, -1.0),
    vec2(-1.0,  1.0),
    vec2( 1.0,  1.0)
);

out vec2 vUV;

void main() {
    vec2 pos = POSITIONS[gl_VertexID];
    gl_Position = vec4(pos, 0.0, 1.0);
    // UV: x=[0,1] left→right, y=[0,1] top→bottom
    vUV = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
}
`;

        // Fragment shader
        //
        // Ring buffer layout:
        //   _writeRow - 1  (mod ringRows) = most recently written row  → top of waterfall
        //   _writeRow      (mod ringRows) = oldest row                 → bottom of waterfall
        //
        // Pixel-to-ring-row mapping (1:1, independent of ringRows size):
        //   pixelY (0 = top of waterfall) → ring row index
        //   ringRow = (writeRow - 1 - pixelY) mod ringRows
        //
        // Sub-pixel scroll is handled by the drawImage blit (not in the shader).
        // The shader always maps integer pixel rows to ring rows.
        //
        // Magnitude encoding: 0 = no data (→ black), 1..255 = real data.
        //   Shader decodes: realMag = (storedByte - 1) / 254.0
        //
        const fsSource = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uRingTex;     // ring buffer: width × ringRows, R8
uniform sampler2D uLutTex;      // colour LUT:  256 × 1, RGBA
uniform int       uWriteRow;    // ring write pointer
uniform int       uRingRows;    // total ring buffer rows
uniform int       uVisibleRows; // waterfall height in pixels
uniform float     uWaterfallY;  // normalised Y start of waterfall [0,1]
uniform float     uWaterfallH;  // normalised height of waterfall [0,1]

in  vec2 vUV;
out vec4 fragColor;

void main() {
    float py = vUV.y;

    // Outside waterfall region → black
    if (py < uWaterfallY || py >= uWaterfallY + uWaterfallH) {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    // Integer pixel position within the waterfall, top=0
    int pixelRow = int((py - uWaterfallY) / uWaterfallH * float(uVisibleRows));

    // Map to ring buffer row (1:1 — one ring row per visible pixel)
    int ringRow = ((uWriteRow - 1 - pixelRow) % uRingRows + uRingRows) % uRingRows;

    // Sample ring buffer
    float u = vUV.x;
    float v = (float(ringRow) + 0.5) / float(uRingRows);
    float stored = texture(uRingTex, vec2(u, v)).r * 255.0;  // 0..255

    // 0 = no data → black
    if (stored < 0.5) {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    // Decode: stored 1..255 → magnitude 0..254 → normalised 0..1
    float magnitude = (stored - 1.0) / 254.0;

    // Look up colour from LUT (texel-centre sampling)
    float lutU = magnitude * (255.0 / 256.0) + (0.5 / 256.0);
    vec4  color = texture(uLutTex, vec2(lutU, 0.5));

    fragColor = vec4(color.rgb, 1.0);
}
`;

        const vs = this._compileShader(gl.VERTEX_SHADER,   vsSource);
        const fs = this._compileShader(gl.FRAGMENT_SHADER, fsSource);

        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);

        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            throw new Error('[WaterfallWebGL] Shader link error: ' + gl.getProgramInfoLog(prog));
        }

        gl.deleteShader(vs);
        gl.deleteShader(fs);

        this._program = prog;

        this._uRingTex     = gl.getUniformLocation(prog, 'uRingTex');
        this._uLutTex      = gl.getUniformLocation(prog, 'uLutTex');
        this._uWriteRow    = gl.getUniformLocation(prog, 'uWriteRow');
        this._uRingRows    = gl.getUniformLocation(prog, 'uRingRows');
        this._uVisibleRows = gl.getUniformLocation(prog, 'uVisibleRows');
        this._uWaterfallY  = gl.getUniformLocation(prog, 'uWaterfallY');
        this._uWaterfallH  = gl.getUniformLocation(prog, 'uWaterfallH');
    }

    _compileShader(type, source) {
        const gl     = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(`[WaterfallWebGL] Shader compile error (${type === gl.VERTEX_SHADER ? 'VS' : 'FS'}): ${log}`);
        }
        return shader;
    }

    _buildQuad() {
        // gl_VertexID-based quad — no vertex buffer needed, just an empty VAO
        this._vao = this.gl.createVertexArray();
    }

    _createRingTexture() {
        const gl = this.gl;
        if (this._ringTex) gl.deleteTexture(this._ringTex);

        this._ringTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._ringTex);

        // R8: single-channel, 8-bit unsigned.  Initialise to 0 (= no data).
        const blank = new Uint8Array(this.width * this.ringRows);
        gl.texImage2D(
            gl.TEXTURE_2D, 0,
            gl.R8,
            this.width, this.ringRows,
            0,
            gl.RED, gl.UNSIGNED_BYTE,
            blank
        );

        // Nearest in X (crisp pixels), nearest in Y (no interpolation across ring rows —
        // each ring row is exactly one waterfall pixel, so linear would blur history).
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        gl.bindTexture(gl.TEXTURE_2D, null);

        // Record the width the texture was actually allocated at.
        // pushRow() reads _texWidth (not this.width) so it never uploads a row
        // whose byte-length doesn't match the live GPU texture.
        this._texWidth = this.width;

        this._writeRow = 0;
        this._hasData  = false;
    }

    _createLutTexture() {
        const gl = this.gl;
        this._lutTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._lutTex);

        // Default greyscale until setColorScheme() is called
        const data = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) {
            data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = i;
            data[i * 4 + 3] = 255;
        }
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
    }
}

// ── Integration patch ─────────────────────────────────────────────────────────
//
// Monkey-patches the GPU scroll methods on an existing SpectrumDisplay instance
// to use WaterfallWebGL instead of the Canvas2D offscreen approach.
// Falls back silently if WebGL2 is unavailable.
//
function patchSpectrumDisplayWithWebGL(sd) {
    if (!sd || !(sd instanceof SpectrumDisplay)) {
        console.warn('[WaterfallWebGL] invalid SpectrumDisplay instance');
        return false;
    }

    const wgl = new WaterfallWebGL(sd.canvas, { ringRows: 512 });
    if (!wgl.isSupported()) {
        console.warn('[WaterfallWebGL] WebGL2 not supported — patch not applied');
        return false;
    }

    // Sync colour scheme immediately
    wgl.setColorScheme(sd.config.colorScheme, sd.colorGradient);

    // Hook updateConfig to re-sync LUT when colour scheme changes.
    // (SpectrumDisplay has no setColorScheme() — changes go through updateConfig.)
    const origUpdateConfig = sd.updateConfig.bind(sd);
    sd.updateConfig = function(newConfig) {
        origUpdateConfig(newConfig);
        if (newConfig.colorScheme) {
            wgl.setColorScheme(newConfig.colorScheme, sd.colorGradient);
        }
    };

    // ── Resize handling ──────────────────────────────────────────────────────
    // The SpectrumDisplay constructor installs a debounced window 'resize' listener
    // that directly mutates sd.width / sd.height / canvas.width / canvas.height
    // without going through any single method we can easily hook.  Rather than
    // trying to intercept every code path, we use a ResizeObserver on the canvas
    // element itself: it fires whenever the canvas pixel dimensions actually change,
    // regardless of what triggered the change (window resize, waterfall height drag,
    // split-mode toggle, etc.).
    const _syncSize = () => {
        const w = sd.canvas.width;
        const h = sd.canvas.height;
        if (w > 0 && h > 0) {
            wgl.resize(w, h);
        }
    };

    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(_syncSize);
        ro.observe(sd.canvas);
        // Store so destroy() can disconnect it
        wgl._resizeObserver = ro;
    } else {
        // Fallback: hook the three named resize methods (older browsers)
        const origResizeCanvas = sd.resizeCanvas?.bind(sd);
        if (origResizeCanvas) {
            sd.resizeCanvas = function() { origResizeCanvas(); _syncSize(); };
        }

        const origSetWaterfallHeight = sd.setWaterfallHeight?.bind(sd);
        if (origSetWaterfallHeight) {
            sd.setWaterfallHeight = function(h) { origSetWaterfallHeight(h); _syncSize(); };
        }

        const origToggleLineGraph = sd.toggleLineGraphVisibility?.bind(sd);
        if (origToggleLineGraph) {
            sd.toggleLineGraphVisibility = function(v) { origToggleLineGraph(v); _syncSize(); };
        }
    }

    // Clear the ring buffer when the tab becomes visible again after a
    // visibility-triggered WebSocket disconnect.  Without this, up to ringRows
    // rows of stale data (from before the tab was hidden) scroll through the
    // waterfall before fresh data fills the ring.
    //
    // resumeAnimation() is called exactly when the tab becomes visible — at that
    // point the WebSocket is about to reconnect and no new rows have been pushed,
    // so clearing here is safe and immediate.
    //
    // We only clear when _visibilityDisconnected was true (the WebSocket actually
    // closed after the 5s grace period) — not for brief tab switches that resumed
    // within 5s without closing the connection.
    const origResumeAnimation = sd.resumeAnimation?.bind(sd);
    if (origResumeAnimation) {
        sd.resumeAnimation = function() {
            const wasDisconnected = sd._visibilityDisconnected;
            origResumeAnimation();
            if (wasDisconnected) {
                wgl._createRingTexture();
                console.log('[WaterfallWebGL] Ring buffer cleared on visibility reconnect');
            }
        };
    }

    // Replace scrollWaterfallGPU() — called once per whole-pixel boundary crossed
    sd.scrollWaterfallGPU = function() {
        if (!sd.spectrumData || sd.spectrumData.length === 0) return;
        if (sd.config.autoRange) sd.updateAutoRange();

        wgl.pushRow(
            sd.spectrumData,
            sd.actualMinDb,
            sd.actualMaxDb,
            sd.config.contrast,
            sd.config.intensity,
            sd.config.manualRangeEnabled
        );
        sd.waterfallLineCount = (sd.waterfallLineCount || 0) + 1;
    };

    // Replace scrollWaterfallGPUComposite() — called every rAF tick
    sd.scrollWaterfallGPUComposite = function() {
        const lineGraphVisible = sd.lineGraphCanvas && sd.lineGraphCanvas.style.display !== 'none';
        const waterfallStartY  = lineGraphVisible ? 0 : 75;
        wgl.render(sd.gpuScrollOffset, waterfallStartY);
    };

    // Replace resetGPUScroll()
    sd.resetGPUScroll = function() {
        sd.gpuScrollOffset     = 0;
        sd.gpuScrollBaseOffset = 0;
        wgl._createRingTexture();  // clears ring buffer and resets write pointer
    };

    sd._webglWaterfall = wgl;
    console.log('[WaterfallWebGL] Patch applied — GPU waterfall active');
    return true;
}

// Expose globally (no ES module syntax needed)
if (typeof window !== 'undefined') {
    window.WaterfallWebGL = WaterfallWebGL;
    window.patchSpectrumDisplayWithWebGL = patchSpectrumDisplayWithWebGL;
}
