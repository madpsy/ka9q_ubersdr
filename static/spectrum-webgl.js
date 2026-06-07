/**
 * spectrum-webgl.js — True WebGL waterfall renderer for ka9q UberSDR
 *
 * Architecture
 * ────────────
 * The waterfall is stored as a 2-D ring-buffer texture on the GPU.
 * Each row holds one spectrum frame as raw normalised float values [0,1].
 * A 1-D colour-LUT texture (256 × 1 RGBA) maps those values to colours.
 *
 * Every frame:
 *   1. CPU uploads ONE new row of bytes via texSubImage2D  (tiny transfer)
 *   2. Fragment shader reads the ring buffer + LUT and draws the full quad
 *      with a fractional sub-pixel Y offset for smooth scrolling
 *   3. The WebGL offscreen canvas is blitted onto the main Canvas2D canvas
 *      via drawImage — this is necessary because SpectrumDisplay already holds
 *      a '2d' context on the main canvas, and a canvas can only have one context.
 *
 * Nothing else touches the CPU per frame — no ImageData, no per-pixel JS loops.
 *
 * Public API (mirrors the methods SpectrumDisplay delegates to)
 * ─────────────────────────────────────────────────────────────
 *   new WaterfallWebGL(mainCanvas, options)
 *   .isSupported()                → bool
 *   .resize(width, height)
 *   .setColorScheme(name, colorGradient)   // pass the existing 256-entry gradient
 *   .pushRow(spectrumData, minDb, maxDb, contrast, intensity, manualRange)
 *   .render(subPixelOffset, waterfallStartY)  // call every rAF tick
 *   .destroy()
 */

'use strict';

class WaterfallWebGL {
    /**
     * @param {HTMLCanvasElement} mainCanvas - the existing spectrum-display-canvas
     *        (already has a '2d' context — we create a separate offscreen WebGL canvas)
     * @param {object}            options
     * @param {number}  [options.ringRows=2048]  - ring buffer height (power of 2, >= canvas height)
     */
    constructor(mainCanvas, options = {}) {
        // The main canvas already has a Canvas2D context (acquired by SpectrumDisplay).
        // We cannot call getContext('webgl2') on it — a canvas can only have one context.
        // Instead we create a hidden offscreen canvas for WebGL and blit it onto the
        // main canvas via ctx.drawImage() in render().
        this.mainCanvas  = mainCanvas;
        this.mainCtx     = mainCanvas.getContext('2d');  // already exists — just retrieves it

        this.ringRows = options.ringRows || 2048;
        this.width   = mainCanvas.width;
        this.height  = mainCanvas.height;

        // Offscreen canvas that owns the WebGL2 context
        this._glCanvas = document.createElement('canvas');
        this._glCanvas.width  = this.width;
        this._glCanvas.height = this.height;

        // Ring-buffer write pointer (which texture row to write next)
        this._writeRow = 0;

        // WebGL context (on the offscreen canvas)
        this.gl = null;
        this._program = null;
        this._vao = null;

        // Texture handles
        this._ringTex = null;   // R8 ring buffer
        this._lutTex  = null;   // 256×1 RGBA colour LUT

        // Uniform locations
        this._uRingTex    = null;
        this._uLutTex     = null;
        this._uWriteRow   = null;
        this._uRingRows   = null;
        this._uScrollOff  = null;
        this._uWaterfallY = null;  // normalised Y start of waterfall region [0,1]
        this._uWaterfallH = null;  // normalised height of waterfall region [0,1]

        this._supported = false;
        this._init();
    }

    // ── Public ────────────────────────────────────────────────────────────────

    /** Returns true if WebGL initialised successfully */
    isSupported() { return this._supported; }

    /** Resize offscreen canvas and textures when the main canvas changes size */
    resize(width, height) {
        if (!this._supported) return;
        this.width  = width;
        this.height = height;
        this._glCanvas.width  = width;
        this._glCanvas.height = height;
        const gl = this.gl;
        gl.viewport(0, 0, width, height);
        // Ring buffer width must match canvas width; recreate if needed
        this._createRingTexture();
    }

    /**
     * Upload a new 256-entry RGBA colour LUT built from the existing gradient.
     * @param {string}   name          - colour scheme name (informational only)
     * @param {string[]} colorGradient - array of 'rgb(r,g,b)' strings, length 256
     */
    setColorScheme(name, colorGradient) {
        if (!this._supported) return;
        const gl = this.gl;
        const data = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) {
            const str = colorGradient[i] || 'rgb(0,0,0)';
            const m = str.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
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
     *
     * @param {number[]} spectrumData  - raw dB values, one per FFT bin
     * @param {number}   minDb
     * @param {number}   maxDb
     * @param {number}   contrast      - config.contrast (0-255 threshold)
     * @param {number}   intensity     - config.intensity (-1..+1)
     * @param {boolean}  manualRange   - config.manualRangeEnabled
     */
    pushRow(spectrumData, minDb, maxDb, contrast, intensity, manualRange) {
        if (!this._supported || !spectrumData || spectrumData.length === 0) return;

        this._lastRow = spectrumData;

        const gl     = this.gl;
        const W      = this.width;
        const dbRange = maxDb - minDb;
        const row    = new Uint8Array(W);   // one byte per pixel — normalised magnitude

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

            row[x] = Math.round(Math.max(0, Math.min(255, magnitude)));
        }

        // Upload the single row into the ring buffer texture.
        // Internal format is R8 (WebGL2), so the pixel format must be gl.RED — not gl.LUMINANCE.
        gl.bindTexture(gl.TEXTURE_2D, this._ringTex);
        gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,                  // mip level
            0,                  // x offset
            this._writeRow,     // y offset = ring write pointer
            W,                  // width
            1,                  // height (one row)
            gl.RED,             // format — must match R8 internal format
            gl.UNSIGNED_BYTE,
            row
        );
        gl.bindTexture(gl.TEXTURE_2D, null);

        // Advance write pointer (wraps around)
        this._writeRow = (this._writeRow + 1) % this.ringRows;
    }

    /**
     * Render the waterfall.  Call every rAF tick.
     *
     * @param {number} subPixelOffset  - fractional pixel scroll offset [0,1)
     * @param {number} waterfallStartY - pixel Y where waterfall begins (below line graph)
     */
    render(subPixelOffset, waterfallStartY) {
        if (!this._supported) return;
        const gl = this.gl;

        gl.viewport(0, 0, this.width, this.height);
        gl.useProgram(this._program);

        // Bind ring buffer to texture unit 0
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this._ringTex);
        gl.uniform1i(this._uRingTex, 0);

        // Bind LUT to texture unit 1
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this._lutTex);
        gl.uniform1i(this._uLutTex, 1);

        // Uniforms
        gl.uniform1i(this._uWriteRow,  this._writeRow);
        gl.uniform1i(this._uRingRows,  this.ringRows);
        gl.uniform1f(this._uScrollOff, subPixelOffset / this.height);

        // Waterfall region in normalised [0,1] canvas coordinates (Y=0 at top)
        const wfY = waterfallStartY / this.height;
        const wfH = (this.height - waterfallStartY) / this.height;
        gl.uniform1f(this._uWaterfallY, wfY);
        gl.uniform1f(this._uWaterfallH, wfH);

        // Draw full-screen quad onto the offscreen WebGL canvas
        gl.bindVertexArray(this._vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);

        // Blit the WebGL offscreen canvas onto the main Canvas2D canvas.
        // Only overwrite the waterfall region — leave the line graph area untouched.
        this.mainCtx.drawImage(
            this._glCanvas,
            0, waterfallStartY,          // source x, y
            this.width, this.height - waterfallStartY,  // source w, h
            0, waterfallStartY,          // dest x, y
            this.width, this.height - waterfallStartY   // dest w, h
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
        this._supported = false;
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _init() {
        try {
            // Request WebGL2 on the offscreen canvas (not the main canvas which already
            // has a '2d' context — mixing context types on one canvas is not allowed).
            const gl = this._glCanvas.getContext('webgl2', {
                alpha:                 false,
                antialias:             false,
                depth:                 false,
                stencil:               false,
                preserveDrawingBuffer: false,
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

        // ── Vertex shader ──────────────────────────────────────────────────
        // Emits a full-screen quad in clip space from 4 hard-coded positions.
        const vsSource = `#version 300 es
precision highp float;

// Full-screen quad: two triangles as a strip
// Positions in clip space: (-1,-1), (1,-1), (-1,1), (1,1)
const vec2 POSITIONS[4] = vec2[4](
    vec2(-1.0, -1.0),
    vec2( 1.0, -1.0),
    vec2(-1.0,  1.0),
    vec2( 1.0,  1.0)
);

out vec2 vUV;  // [0,1] UV with Y=0 at top

void main() {
    vec2 pos = POSITIONS[gl_VertexID];
    gl_Position = vec4(pos, 0.0, 1.0);
    // Convert clip-space [-1,1] to UV [0,1]; flip Y so UV.y=0 is top of canvas
    vUV = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
}
`;

        // ── Fragment shader ────────────────────────────────────────────────
        // Reads the ring-buffer texture and maps through the colour LUT.
        //
        // Ring buffer layout:
        //   Row _writeRow-1 (mod ringRows) = most recent spectrum frame (top of waterfall)
        //   Row _writeRow   (mod ringRows) = oldest frame (bottom of waterfall)
        //
        // For a canvas pixel at normalised Y offset `py` within the waterfall:
        //   ringRow = (_writeRow + floor(py * visibleRows + scrollOffset)) mod ringRows
        //
        const fsSource = `#version 300 es
precision highp float;
precision highp sampler2D;

uniform sampler2D uRingTex;   // ring buffer: width × ringRows, R8 (single channel)
uniform sampler2D uLutTex;    // colour LUT:  256 × 1, RGBA
uniform int       uWriteRow;  // current ring write pointer
uniform int       uRingRows;  // total ring buffer height
uniform float     uScrollOff; // sub-pixel scroll offset in normalised canvas coords
uniform float     uWaterfallY;// normalised Y where waterfall starts (0=top)
uniform float     uWaterfallH;// normalised height of waterfall region

in  vec2 vUV;
out vec4 fragColor;

void main() {
    float py = vUV.y;

    // Outside waterfall region → black
    if (py < uWaterfallY || py >= uWaterfallY + uWaterfallH) {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    // Normalised position within the waterfall [0,1], top=0
    float wfPos = (py - uWaterfallY) / uWaterfallH;

    // Apply sub-pixel scroll offset (in normalised canvas coords → convert to wf coords)
    float scrollInWf = uScrollOff / uWaterfallH;
    wfPos = wfPos + scrollInWf;

    // Map to ring buffer row
    // Row 0 of the waterfall = most recently written row = uWriteRow - 1
    float ringRowF = wfPos * float(uRingRows);
    int   ringRow  = (uWriteRow - 1 - int(ringRowF) + uRingRows * 2) % uRingRows;

    // Sample ring buffer (R8 format → .r channel holds the normalised magnitude [0,1])
    float u = vUV.x;
    float v = (float(ringRow) + 0.5) / float(uRingRows);
    float magnitude = texture(uRingTex, vec2(u, v)).r;

    // Look up colour from LUT
    float lutU = magnitude * (255.0 / 256.0) + (0.5 / 256.0); // texel-centre sample
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

        // Cache uniform locations
        this._uRingTex    = gl.getUniformLocation(prog, 'uRingTex');
        this._uLutTex     = gl.getUniformLocation(prog, 'uLutTex');
        this._uWriteRow   = gl.getUniformLocation(prog, 'uWriteRow');
        this._uRingRows   = gl.getUniformLocation(prog, 'uRingRows');
        this._uScrollOff  = gl.getUniformLocation(prog, 'uScrollOff');
        this._uWaterfallY = gl.getUniformLocation(prog, 'uWaterfallY');
        this._uWaterfallH = gl.getUniformLocation(prog, 'uWaterfallH');
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
        const gl = this.gl;
        // We use gl_VertexID in the vertex shader so no buffer data is needed —
        // just an empty VAO to satisfy the WebGL2 requirement.
        this._vao = gl.createVertexArray();
    }

    _createRingTexture() {
        const gl = this.gl;
        if (this._ringTex) gl.deleteTexture(this._ringTex);

        this._ringTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._ringTex);

        // Allocate ring buffer: width × ringRows, single-channel R8 (WebGL2 sized internal format)
        // Initialise to zero (black / minimum signal)
        const blank = new Uint8Array(this.width * this.ringRows);
        gl.texImage2D(
            gl.TEXTURE_2D, 0,
            gl.R8,                  // internal format (WebGL2)
            this.width, this.ringRows,
            0,
            gl.RED,                 // format
            gl.UNSIGNED_BYTE,
            blank
        );

        // No mipmaps; linear filtering for smooth sub-pixel scroll.
        // CLAMP_TO_EDGE on both axes — the shader handles ring-buffer wrapping via modulo,
        // so REPEAT is not needed and would cause interpolation artefacts at the seam.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        gl.bindTexture(gl.TEXTURE_2D, null);

        // Reset write pointer when texture is recreated
        this._writeRow = 0;
    }

    _createLutTexture() {
        const gl = this.gl;
        this._lutTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this._lutTex);

        // Default to greyscale until setColorScheme() is called
        const data = new Uint8Array(256 * 4);
        for (let i = 0; i < 256; i++) {
            data[i * 4]     = i;
            data[i * 4 + 1] = i;
            data[i * 4 + 2] = i;
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

// ── Integration helper ────────────────────────────────────────────────────────
//
// Call this after SpectrumDisplay is constructed to monkey-patch the GPU scroll
// path to use WaterfallWebGL instead of the Canvas2D offscreen approach.
//
// Usage (in app.js or index.html, after spectrum-display.js is loaded):
//
//   import { patchSpectrumDisplayWithWebGL } from './spectrum-webgl.js';
//   // or just include spectrum-webgl.js before app.js and call:
//   patchSpectrumDisplayWithWebGL(window.spectrumDisplay);
//
function patchSpectrumDisplayWithWebGL(sd) {
    if (!sd || !(sd instanceof SpectrumDisplay)) {
        console.warn('[WaterfallWebGL] patchSpectrumDisplayWithWebGL: invalid SpectrumDisplay instance');
        return false;
    }

    const wgl = new WaterfallWebGL(sd.canvas, { ringRows: 2048 });
    if (!wgl.isSupported()) {
        console.warn('[WaterfallWebGL] WebGL2 not supported — patch not applied');
        return false;
    }

    // Upload the current colour scheme immediately
    wgl.setColorScheme(sd.config.colorScheme, sd.colorGradient);

    // Re-upload LUT whenever the colour scheme changes.
    // SpectrumDisplay has no setColorScheme() method — colour changes go through
    // updateConfig({ colorScheme: name }) which rebuilds sd.colorGradient internally.
    const origUpdateConfig = sd.updateConfig.bind(sd);
    sd.updateConfig = function(newConfig) {
        origUpdateConfig(newConfig);
        // If colorScheme changed, sd.colorGradient has been rebuilt — sync to GPU LUT
        if (newConfig.colorScheme) {
            wgl.setColorScheme(newConfig.colorScheme, sd.colorGradient);
        }
    };

    // Patch resizeCanvas (called on window resize)
    const origResizeCanvas = sd.resizeCanvas?.bind(sd);
    if (origResizeCanvas) {
        sd.resizeCanvas = function() {
            origResizeCanvas();
            wgl.resize(sd.width, sd.height);
        };
    }

    // Patch setWaterfallHeight (called by drag-resize UI).
    // This method directly sets sd.height and sd.canvas.height without going through
    // resizeCanvas(), so we must hook it separately to keep wgl dimensions in sync.
    const origSetWaterfallHeight = sd.setWaterfallHeight?.bind(sd);
    if (origSetWaterfallHeight) {
        sd.setWaterfallHeight = function(h) {
            origSetWaterfallHeight(h);
            wgl.resize(sd.width, sd.height);
        };
    }

    // Patch toggleLineGraphVisibility (called when the Spectrum checkbox is toggled).
    // This also resizes the canvas directly, changing sd.height.
    const origToggleLineGraph = sd.toggleLineGraphVisibility?.bind(sd);
    if (origToggleLineGraph) {
        sd.toggleLineGraphVisibility = function(visible) {
            origToggleLineGraph(visible);
            wgl.resize(sd.width, sd.height);
        };
    }

    // Replace scrollWaterfallGPU() — called when a whole pixel boundary is crossed
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
        // Recreate ring texture (clears history)
        wgl._createRingTexture();
    };

    // Store reference for debugging
    sd._webglWaterfall = wgl;

    console.log('[WaterfallWebGL] Patch applied — GPU waterfall active');
    return true;
}

// Expose globally so index.html can call it without ES module syntax
if (typeof window !== 'undefined') {
    window.WaterfallWebGL = WaterfallWebGL;
    window.patchSpectrumDisplayWithWebGL = patchSpectrumDisplayWithWebGL;
}
