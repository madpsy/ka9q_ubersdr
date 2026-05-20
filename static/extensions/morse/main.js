// CW Decoder Extension — powered by ggmorse (cw-decoder subprocess)
// Single-channel, auto-detects pitch and speed.
//
// Binary wire protocol (backend → frontend):
//
//   0x10  Decode event
//         [type:1=0x10][confidence:1][cost:4 float32 BE][pitch:4 float32 BE][speed:4 float32 BE]
//         [text_len:4 uint32 BE][text: UTF-8]
//         confidence: 0=high 1=medium 2=low 3=poor
//
//   0x11  Stats event (pitch/speed update, no text)
//         [type:1=0x11][pitch:4 float32 BE][speed:4 float32 BE]
//
//   0x12  Error event (subprocess crash or binary not found)
//         [type:1=0x12][msg_len:4 uint32 BE][msg: UTF-8]
//
// Text (JSON) messages from the backend that we also handle:
//   audio_extension_attached  — server confirmed attach
//   audio_extension_error     — server-side error before binary data starts

class MorseExtension extends DecoderExtension {
    constructor() {
        super('morse', {
            displayName: 'CW Decoder',
            autoTune: false,
            requiresMode: 'usb',
            preferredBandwidth: 2400
        });

        this.running = false;
        this.textBuffer = '';

        // Intercept binary WS messages while running
        this._origHandler  = null;
        this._ourHandler   = null;
        this._handlersSet  = false; // guard against duplicate addEventListener calls
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    onInitialize() {
        this._renderTemplate();
        this._waitForDOM(() => {
            this._setupHandlers();
        });
    }

    onActivate() {
        // DOM may have been rebuilt — re-wire handlers only if not already set
        this._waitForDOM(() => {
            this._setupHandlers();
        });
    }

    onDeactivate() {
        if (this.running) this._stopDecoder();
    }

    onDisable() {
        if (this.running) this._stopDecoder();
        this._restoreBinaryHandler();
    }

    // ── Template ─────────────────────────────────────────────────────────────

    _renderTemplate() {
        const tpl = window.morse_template;
        if (!tpl) { console.error('[Morse] template not loaded'); return; }
        const el = document.querySelector('.extension-content[data-extension="morse"]');
        if (el) {
            el.innerHTML = tpl;
            // DOM was rebuilt — allow handlers to be re-attached
            this._handlersSet = false;
        }
    }

    _waitForDOM(cb, attempts = 0) {
        if (document.getElementById('morse-start-btn')) {
            cb();
        } else if (attempts < 20) {
            setTimeout(() => this._waitForDOM(cb, attempts + 1), 100);
        } else {
            console.error('[Morse] DOM elements not found after 2 s');
        }
    }

    // ── Event handlers ────────────────────────────────────────────────────────

    _setupHandlers() {
        // Guard: only attach listeners once per DOM instance
        if (this._handlersSet) return;
        this._handlersSet = true;

        const startBtn = document.getElementById('morse-start-btn');
        const clearBtn = document.getElementById('morse-clear-btn');
        const copyBtn  = document.getElementById('morse-copy-btn');

        if (startBtn) startBtn.addEventListener('click', () => this._toggleDecoder());
        if (clearBtn) clearBtn.addEventListener('click', () => this._clearOutput());
        if (copyBtn)  copyBtn.addEventListener('click',  () => this._copyOutput());
    }

    // ── Decoder control ───────────────────────────────────────────────────────

    _toggleDecoder() {
        if (this.running) {
            this._stopDecoder();
        } else {
            this._startDecoder();
        }
    }

    _startDecoder() {
        const ws = this._getWS();
        if (!ws) { this._setStatus('Error: WebSocket not connected', 'error'); return; }

        this._installBinaryHandler();

        ws.send(JSON.stringify({
            type: 'audio_extension_attach',
            extension_name: 'morse',
            params: {}
        }));

        this.running = true;
        this._setStatus('Connecting…');

        const btn = document.getElementById('morse-start-btn');
        if (btn) { btn.textContent = 'Stop'; btn.classList.add('running'); }
    }

    _stopDecoder() {
        const ws = this._getWS();
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'audio_extension_detach' }));
        }

        this._restoreBinaryHandler();
        this.running = false;
        this._setStatus('Stopped');
        this._clearStats();

        const btn = document.getElementById('morse-start-btn');
        if (btn) { btn.textContent = 'Start'; btn.classList.remove('running'); }
    }

    // ── WebSocket binary interception ─────────────────────────────────────────

    _getWS() {
        const c = window.dxClusterClient;
        if (!c || !c.ws || c.ws.readyState !== WebSocket.OPEN) return null;
        return c.ws;
    }

    _installBinaryHandler() {
        const c = window.dxClusterClient;
        if (!c || !c.ws) return;

        // Only save the original handler once — don't overwrite with our own
        if (!this._origHandler) {
            this._origHandler = c.ws.onmessage;
        }

        this._ourHandler = (event) => {
            if (event.data instanceof ArrayBuffer) {
                this._handleBinary(event.data);
            } else if (event.data instanceof Blob) {
                event.data.arrayBuffer().then(buf => this._handleBinary(buf));
            } else {
                // Text (JSON) message — check for audio extension messages we care about,
                // then pass everything else to the original handler.
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'audio_extension_attached') {
                        this._setStatus('Running — listening for CW…', 'ok');
                        return; // consumed
                    }
                    if (msg.type === 'audio_extension_error') {
                        this._handleServerError(msg.error || 'Unknown server error');
                        return; // consumed
                    }
                } catch (_) { /* not JSON — fall through */ }

                if (this._origHandler) this._origHandler.call(c.ws, event);
            }
        };

        c.ws.onmessage = this._ourHandler;
    }

    _restoreBinaryHandler() {
        const c = window.dxClusterClient;
        if (c && c.ws && this._origHandler) {
            c.ws.onmessage = this._origHandler;
        }
        this._origHandler = null;
        this._ourHandler  = null;
    }

    // ── Binary message parsing ────────────────────────────────────────────────

    _handleBinary(buf) {
        const view = new DataView(buf);
        if (buf.byteLength < 1) return;
        const type = view.getUint8(0);

        switch (type) {
            case 0x10: this._handleDecode(view, buf); break;
            case 0x11: this._handleStats(view);       break;
            case 0x12: this._handleBinaryError(view, buf); break;
            default:
                console.warn('[Morse] unknown binary message type:', type);
        }
    }

    // 0x10 decode event
    // [type:1][confidence:1][cost:4 f32 BE][pitch:4 f32 BE][speed:4 f32 BE][text_len:4][text]
    _handleDecode(view, buf) {
        if (buf.byteLength < 18) return;
        const confByte = view.getUint8(1);
        const cost     = view.getFloat32(2,  false);
        const pitch    = view.getFloat32(6,  false);
        const speed    = view.getFloat32(10, false);
        const textLen  = view.getUint32(14,  false);
        if (buf.byteLength < 18 + textLen) return;
        const text     = new TextDecoder().decode(new Uint8Array(buf, 18, textLen));

        const confName = ['high', 'medium', 'low', 'poor'][confByte] ?? 'poor';

        this._appendText(text, confName);
        this._updateStats(pitch, speed, confName, cost);
    }

    // 0x11 stats event
    // [type:1][pitch:4 f32 BE][speed:4 f32 BE]
    _handleStats(view) {
        if (view.byteLength < 9) return;
        const pitch = view.getFloat32(1, false);
        const speed = view.getFloat32(5, false);
        this._updateStats(pitch, speed, null, null);
    }

    // 0x12 binary error event (subprocess crash / binary not found)
    // [type:1][msg_len:4][msg]
    _handleBinaryError(view, buf) {
        if (buf.byteLength < 5) return;
        const msgLen = view.getUint32(1, false);
        if (buf.byteLength < 5 + msgLen) return;
        const msg = new TextDecoder().decode(new Uint8Array(buf, 5, msgLen));
        this._handleServerError(msg);
    }

    // Common error handler (binary 0x12 or JSON audio_extension_error)
    _handleServerError(msg) {
        console.error('[Morse] backend error:', msg);
        this._setStatus('Error: ' + msg, 'error');

        // Subprocess is gone — clean up the WS handler and reset button
        this._restoreBinaryHandler();
        this.running = false;
        this._clearStats();
        const btn = document.getElementById('morse-start-btn');
        if (btn) { btn.textContent = 'Start'; btn.classList.remove('running'); }
    }

    // ── UI helpers ────────────────────────────────────────────────────────────

    _appendText(text, conf) {
        const el = document.getElementById('morse-output-text');
        if (!el) return;

        this.textBuffer += text;

        const span = document.createElement('span');
        span.className = 'conf-' + conf;
        span.textContent = text;
        el.appendChild(span);

        // Auto-scroll to bottom
        const area = document.getElementById('morse-output-area');
        if (area) area.scrollTop = area.scrollHeight;
    }

    _updateStats(pitch, speed, conf, cost) {
        const pitchEl = document.getElementById('morse-pitch-value');
        const speedEl = document.getElementById('morse-speed-value');
        const confEl  = document.getElementById('morse-conf-value');

        if (pitchEl) pitchEl.textContent = pitch != null ? Math.round(pitch) : '---';
        if (speedEl) speedEl.textContent = speed != null ? speed.toFixed(1)  : '---';

        // Only update quality when a real confidence value is provided.
        // Stats-only events (0x11) pass conf=null and must not clear the last decode's quality.
        if (confEl && conf != null) {
            const labels = { high: 'High', medium: 'Medium', low: 'Low', poor: 'Poor' };
            confEl.textContent = labels[conf] ?? conf;
            confEl.dataset.conf = conf;
        }
    }

    // Reset all stats displays to '---' (called on stop/error)
    _clearStats() {
        const pitchEl = document.getElementById('morse-pitch-value');
        const speedEl = document.getElementById('morse-speed-value');
        const confEl  = document.getElementById('morse-conf-value');
        if (pitchEl) pitchEl.textContent = '---';
        if (speedEl) speedEl.textContent = '---';
        if (confEl)  { confEl.textContent = '---'; delete confEl.dataset.conf; }
    }

    _setStatus(text, cls) {
        const el = document.getElementById('morse-status-text');
        if (!el) return;
        el.textContent = text;
        el.className = 'morse-status-text' + (cls ? ' ' + cls : '');
    }

    _clearOutput() {
        this.textBuffer = '';
        const el = document.getElementById('morse-output-text');
        if (el) el.innerHTML = '';
    }

    _copyOutput() {
        if (!this.textBuffer) return;
        navigator.clipboard.writeText(this.textBuffer).then(() => {
            this._setStatus('Copied to clipboard', 'ok');
            setTimeout(() => {
                this._setStatus(this.running ? 'Running — listening for CW…' : 'Stopped');
            }, 2000);
        }).catch(err => {
            console.error('[Morse] copy failed:', err);
        });
    }

    // onProcessAudio is called by the framework with Web Audio data — not used here
    // (decoding happens entirely in the backend subprocess)
    onProcessAudio(_dataArray) {}
}

// Register
if (window.decoderManager) {
    window.decoderManager.register(new MorseExtension());
    console.log('✅ Morse (CW) Extension registered');
} else {
    console.error('[Morse] decoderManager not available');
}
