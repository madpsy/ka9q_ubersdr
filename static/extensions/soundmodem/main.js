// Sound Modem Extension — powered by QtSoundModem (nogui mode)
// Decodes AX.25 packet radio frames via KISS TNC and displays them.
//
// Binary wire protocol (backend → frontend):
//
//   0x20  AX.25 packet frame
//         [type:1=0x20][kiss_port:1][frame_len:4 uint32 BE][ax25_frame: N bytes]
//
//   0x21  Error event (subprocess crash or binary not found)
//         [type:1=0x21][msg_len:4 uint32 BE][msg: UTF-8]
//
// Frontend params sent on attach:
//   {
//     channels: [
//       { enabled: bool, modem: int, freq: float, rcvr_pairs: int, fx25: int, il2p: int },
//       ...  (up to 4)
//     ],
//     dcd_threshold: int
//   }

class SoundModemExtension extends DecoderExtension {
    constructor() {
        super('soundmodem', {
            displayName: 'Sound Modem',
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: 3000
        });

        this.running       = false;
        this.frameCount    = 0;
        this.filter        = 'all';   // frame type filter: all | aprs | ui
        this.channelFilter = 'all';   // channel filter: all | 0 | 1 | 2 | 3
        this.copyBuffer    = [];
        this.configOpen    = false;

        this._origHandler = null;
        this._ourHandler  = null;
        this._handlersSet = false;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    onInitialize() {
        this._renderTemplate();
        this._waitForDOM(() => this._setupHandlers());
    }

    onActivate() {
        this._handlersSet = false;
        this._waitForDOM(() => this._setupHandlers());
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
        const tpl = window.soundmodem_template;
        if (!tpl) { console.error('[SoundModem] template not loaded'); return; }
        const el = document.querySelector('.extension-content[data-extension="soundmodem"]');
        if (el) {
            el.innerHTML = tpl;
            this._handlersSet = false;
        }
    }

    _waitForDOM(cb, attempts = 0) {
        if (document.getElementById('sm-start-btn')) {
            cb();
        } else if (attempts < 20) {
            setTimeout(() => this._waitForDOM(cb, attempts + 1), 100);
        } else {
            console.error('[SoundModem] DOM elements not found after 2 s');
        }
    }

    // ── Event handlers ────────────────────────────────────────────────────────

    _setupHandlers() {
        if (this._handlersSet) return;
        this._handlersSet = true;

        const startBtn   = document.getElementById('sm-start-btn');
        const clearBtn   = document.getElementById('sm-clear-btn');
        const copyBtn    = document.getElementById('sm-copy-btn');
        const configBtn  = document.getElementById('sm-config-btn');
        const filterSel  = document.getElementById('sm-filter-select');

        if (startBtn)  startBtn.addEventListener('click',  () => this._toggleDecoder());
        if (clearBtn)  clearBtn.addEventListener('click',  () => this._clearOutput());
        if (copyBtn)   copyBtn.addEventListener('click',   () => this._copyOutput());
        if (configBtn) configBtn.addEventListener('click',  () => this._toggleConfig());
        if (filterSel) filterSel.addEventListener('change', (e) => { this.filter = e.target.value; });

        const channelFilterSel = document.getElementById('sm-channel-filter');
        if (channelFilterSel) channelFilterSel.addEventListener('change', (e) => {
            this.channelFilter = e.target.value;
        });

        // Wire up channel enable checkboxes to enable/disable their param rows
        for (let i = 0; i < 4; i++) {
            const cb = document.getElementById(`sm-ch${i}-enabled`);
            if (cb) {
                cb.addEventListener('change', () => this._updateChannelState(i));
            }
        }

        // Restore DOM state after re-activation
        if (filterSel) filterSel.value = this.filter;
        const channelFilterSel2 = document.getElementById('sm-channel-filter');
        if (channelFilterSel2) channelFilterSel2.value = this.channelFilter;
        if (startBtn && this.running) {
            startBtn.textContent = 'Stop';
            startBtn.classList.add('running');
        }

        // Restore config panel visibility
        const panel = document.getElementById('sm-config-panel');
        if (panel) panel.style.display = this.configOpen ? 'block' : 'none';

        this._updateCountDisplay();
    }

    _updateChannelState(idx) {
        const cb     = document.getElementById(`sm-ch${idx}-enabled`);
        const params = document.getElementById(`sm-ch${idx}-params`);
        if (!cb || !params) return;

        const enabled = cb.checked;
        params.classList.toggle('sm-channel-params-disabled', !enabled);

        // Enable/disable all inputs within the params div
        params.querySelectorAll('input, select').forEach(el => {
            el.disabled = !enabled;
        });
    }

    _toggleConfig() {
        this.configOpen = !this.configOpen;
        const panel = document.getElementById('sm-config-panel');
        if (panel) panel.style.display = this.configOpen ? 'block' : 'none';
        const btn = document.getElementById('sm-config-btn');
        if (btn) btn.classList.toggle('active', this.configOpen);
    }

    // ── Collect params from UI ────────────────────────────────────────────────

    _collectParams() {
        const channels = [];
        for (let i = 0; i < 4; i++) {
            const enabled   = document.getElementById(`sm-ch${i}-enabled`)?.checked ?? false;
            const modem     = parseInt(document.getElementById(`sm-ch${i}-modem`)?.value  ?? '1', 10);
            const freq      = parseFloat(document.getElementById(`sm-ch${i}-freq`)?.value  ?? '1700');
            const rcvrPairs = parseInt(document.getElementById(`sm-ch${i}-rcvr`)?.value   ?? '0', 10);
            const fx25      = parseInt(document.getElementById(`sm-ch${i}-fx25`)?.value   ?? '1', 10);
            const il2p      = parseInt(document.getElementById(`sm-ch${i}-il2p`)?.value   ?? '0', 10);

            channels.push({
                enabled,
                modem:      isNaN(modem)     ? 1    : modem,
                freq:       isNaN(freq)      ? 1700 : freq,
                rcvr_pairs: isNaN(rcvrPairs) ? 0    : rcvrPairs,
                fx25:       isNaN(fx25)      ? 1    : fx25,
                il2p:       isNaN(il2p)      ? 0    : il2p,
            });
        }

        const dcdRaw = parseInt(document.getElementById('sm-dcd-threshold')?.value ?? '20', 10);
        const dcdThreshold = isNaN(dcdRaw) ? 20 : Math.max(1, Math.min(100, dcdRaw));

        return { channels, dcd_threshold: dcdThreshold };
    }

    // ── Decoder control ───────────────────────────────────────────────────────

    _toggleDecoder() {
        if (this.running) this._stopDecoder();
        else              this._startDecoder();
    }

    _startDecoder() {
        const ws = this._getWS();
        if (!ws) { this._setStatus('Error: WebSocket not connected', 'error'); return; }

        const params = this._collectParams();

        // Validate: at least one channel enabled
        const anyEnabled = params.channels.some(ch => ch.enabled);
        if (!anyEnabled) {
            this._setStatus('Error: enable at least one channel', 'error');
            return;
        }

        this._installBinaryHandler();

        ws.send(JSON.stringify({
            type: 'audio_extension_attach',
            extension_name: 'soundmodem',
            params: { output_mode: 'ax25', ...params }
        }));

        this.running = true;
        this._setStatus('Connecting…');

        const btn = document.getElementById('sm-start-btn');
        if (btn) { btn.textContent = 'Stop'; btn.classList.add('running'); }

        // Disable config while running
        const configBtn = document.getElementById('sm-config-btn');
        if (configBtn) configBtn.disabled = true;
    }

    _stopDecoder() {
        const ws = this._getWS();
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'audio_extension_detach' }));
        }

        this._restoreBinaryHandler();
        this.running = false;
        this._setStatus('Stopped');

        const btn = document.getElementById('sm-start-btn');
        if (btn) { btn.textContent = 'Start'; btn.classList.remove('running'); }

        const configBtn = document.getElementById('sm-config-btn');
        if (configBtn) configBtn.disabled = false;
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

        if (!this._origHandler) {
            this._origHandler = c.ws.onmessage;
        }

        this._ourHandler = (event) => {
            if (event.data instanceof ArrayBuffer) {
                this._handleBinary(event.data);
            } else if (event.data instanceof Blob) {
                event.data.arrayBuffer().then(buf => this._handleBinary(buf));
            } else {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'audio_extension_attached') {
                        this._setStatus('Running — listening for packets…', 'ok');
                        return;
                    }
                    if (msg.type === 'audio_extension_error') {
                        this._handleServerError(msg.error || 'Unknown server error');
                        return;
                    }
                } catch (_) { /* not JSON */ }

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
            case 0x20: this._handlePacket(view, buf); break;
            case 0x21: this._handleBinaryError(view, buf); break;
            default:
                console.warn('[SoundModem] unknown binary message type:', type.toString(16));
        }
    }

    // 0x20 AX.25 packet frame
    _handlePacket(view, buf) {
        if (buf.byteLength < 6) return;
        const kissPort = view.getUint8(1);
        const frameLen = view.getUint32(2, false);
        if (buf.byteLength < 6 + frameLen) return;

        const ax25 = new Uint8Array(buf, 6, frameLen);
        const parsed = this._parseAX25(ax25);
        if (!parsed) return;

        parsed.kissPort = kissPort;
        this._displayFrame(parsed);
    }

    // 0x21 error event
    _handleBinaryError(view, buf) {
        if (buf.byteLength < 5) return;
        const msgLen = view.getUint32(1, false);
        if (buf.byteLength < 5 + msgLen) return;
        const msg = new TextDecoder().decode(new Uint8Array(buf, 5, msgLen));
        this._handleServerError(msg);
    }

    _handleServerError(msg) {
        console.error('[SoundModem] backend error:', msg);
        this._setStatus('Error: ' + msg, 'error');
        this._restoreBinaryHandler();
        this.running = false;
        const btn = document.getElementById('sm-start-btn');
        if (btn) { btn.textContent = 'Start'; btn.classList.remove('running'); }
        const configBtn = document.getElementById('sm-config-btn');
        if (configBtn) configBtn.disabled = false;
    }

    // ── AX.25 frame parser ────────────────────────────────────────────────────

    _parseAX25(bytes) {
        if (bytes.length < 15) return null;

        try {
            const dest = this._decodeAddress(bytes, 0);
            const src  = this._decodeAddress(bytes, 7);

            let offset = 14;
            const digi = [];

            if ((bytes[13] & 0x01) === 0) {
                while (offset + 7 <= bytes.length) {
                    const d = this._decodeAddress(bytes, offset);
                    digi.push(d);
                    offset += 7;
                    if (bytes[offset - 1] & 0x01) break;
                }
            }

            if (offset >= bytes.length) return null;

            const ctrl = bytes[offset++];

            let frameType = 'other';
            let pid = null;
            let info = '';

            const isUI    = (ctrl & 0xEF) === 0x03;
            const isSABM  = (ctrl & 0xEF) === 0x2F;
            const isUA    = (ctrl & 0xEF) === 0x63;
            const isDISC  = (ctrl & 0xEF) === 0x43;
            const isDM    = (ctrl & 0xEF) === 0x0F;
            const isIFrame = (ctrl & 0x01) === 0;

            if (isUI) {
                frameType = 'ui';
                if (offset < bytes.length) {
                    pid = bytes[offset++];
                    info = this._decodeInfo(bytes, offset);
                }
            } else if (isIFrame) {
                frameType = 'connected';
                if (offset < bytes.length) {
                    pid = bytes[offset++];
                    info = this._decodeInfo(bytes, offset);
                }
            } else if (isSABM) {
                frameType = 'connected'; info = '[SABM]';
            } else if (isUA) {
                frameType = 'connected'; info = '[UA]';
            } else if (isDISC) {
                frameType = 'connected'; info = '[DISC]';
            } else if (isDM) {
                frameType = 'connected'; info = '[DM]';
            } else {
                info = '[ctrl=0x' + ctrl.toString(16).padStart(2, '0') + ']';
            }

            const isAPRS = isUI && pid === 0xF0;
            if (isAPRS) frameType = 'aprs';

            return { from: src, to: dest, digipeaters: digi, ctrl, pid, info, frameType, isAPRS };

        } catch (e) {
            console.warn('[SoundModem] AX.25 parse error:', e);
            return null;
        }
    }

    _decodeAddress(bytes, offset) {
        let call = '';
        for (let i = 0; i < 6; i++) {
            const ch = bytes[offset + i] >> 1;
            if (ch !== 0x20 && ch !== 0x00) call += String.fromCharCode(ch);
        }
        call = call.trim();
        const ssidByte = bytes[offset + 6];
        const ssid = (ssidByte >> 1) & 0x0F;
        const hasBeenRepeated = (ssidByte & 0x80) !== 0;
        return ssid > 0 ? `${call}-${ssid}${hasBeenRepeated ? '*' : ''}` : `${call}${hasBeenRepeated ? '*' : ''}`;
    }

    _decodeInfo(bytes, offset) {
        if (offset >= bytes.length) return '';
        const slice = bytes.slice(offset);
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(slice);
        } catch (_) {
            return new TextDecoder('latin1').decode(slice);
        }
    }

    // ── Display ───────────────────────────────────────────────────────────────

    _displayFrame(parsed) {
        // Apply frame type filter
        if (this.filter === 'aprs' && !parsed.isAPRS) return;
        if (this.filter === 'ui'   && parsed.frameType !== 'ui' && !parsed.isAPRS) return;

        // Apply channel filter
        if (this.channelFilter !== 'all' && String(parsed.kissPort) !== this.channelFilter) return;

        this.frameCount++;
        this._updateCountDisplay();

        const lastEl = document.getElementById('sm-last-callsign');
        if (lastEl) lastEl.textContent = parsed.from;

        const digiStr = parsed.digipeaters.length > 0
            ? ' via ' + parsed.digipeaters.join(',')
            : '';
        const pathStr = `${parsed.from} → ${parsed.to}${digiStr}`;

        const now = new Date();
        const timeStr = now.toTimeString().slice(0, 8);
        this.copyBuffer.push(`[${timeStr}] ${pathStr}: ${parsed.info}`);

        const row = document.createElement('div');
        row.className = `sm-frame sm-frame-${parsed.frameType}`;

        const meta = document.createElement('div');
        meta.className = 'sm-frame-meta';

        const timeEl = document.createElement('div');
        timeEl.className = 'sm-frame-time';
        // Time + channel badge
        const chLabel = ['A', 'B', 'C', 'D'][parsed.kissPort] ?? String(parsed.kissPort);
        const badge = document.createElement('span');
        badge.className = `sm-channel-badge sm-channel-badge-${parsed.kissPort}`;
        badge.textContent = chLabel;
        timeEl.appendChild(document.createTextNode(timeStr + ' '));
        timeEl.appendChild(badge);

        const fromEl = document.createElement('div');
        fromEl.className = 'sm-frame-from';
        fromEl.textContent = parsed.from;

        const toEl = document.createElement('div');
        toEl.className = 'sm-frame-to';
        toEl.textContent = parsed.to;

        meta.appendChild(timeEl);
        meta.appendChild(fromEl);
        meta.appendChild(toEl);

        const body = document.createElement('div');
        body.className = 'sm-frame-body';

        const pathEl = document.createElement('div');
        pathEl.className = 'sm-frame-path';
        pathEl.textContent = pathStr + (parsed.pid != null ? ` [PID:0x${parsed.pid.toString(16).padStart(2,'0')}]` : '');

        const payloadEl = document.createElement('div');
        payloadEl.className = 'sm-frame-payload';
        payloadEl.textContent = parsed.info;

        body.appendChild(pathEl);
        body.appendChild(payloadEl);

        row.appendChild(meta);
        row.appendChild(body);

        const list = document.getElementById('sm-frame-list');
        if (list) {
            list.appendChild(row);
            while (list.children.length > 500) {
                list.removeChild(list.firstChild);
            }
        }

        const area = document.getElementById('sm-output-area');
        if (area) area.scrollTop = area.scrollHeight;
    }

    _updateCountDisplay() {
        const el = document.getElementById('sm-frame-count');
        if (el) el.textContent = this.frameCount;
    }

    // ── UI helpers ────────────────────────────────────────────────────────────

    _setStatus(text, cls) {
        const el = document.getElementById('sm-status-text');
        if (!el) return;
        el.textContent = text;
        el.className = 'sm-status-text' + (cls ? ' ' + cls : '');
    }

    _clearOutput() {
        this.frameCount = 0;
        this.copyBuffer = [];
        this._updateCountDisplay();
        const list = document.getElementById('sm-frame-list');
        if (list) list.innerHTML = '';
        const lastEl = document.getElementById('sm-last-callsign');
        if (lastEl) lastEl.textContent = '---';
    }

    _copyOutput() {
        if (!this.copyBuffer.length) return;
        const text = this.copyBuffer.join('\n');
        navigator.clipboard.writeText(text).then(() => {
            this._setStatus('Copied to clipboard', 'ok');
            setTimeout(() => {
                this._setStatus(this.running ? 'Running — listening for packets…' : 'Stopped');
            }, 2000);
        }).catch(err => {
            console.error('[SoundModem] copy failed:', err);
        });
    }

    onProcessAudio(_dataArray) {}
}

// Register
if (window.decoderManager) {
    window.decoderManager.register(new SoundModemExtension());
    console.log('✅ Sound Modem Extension registered');
} else {
    console.error('[SoundModem] decoderManager not available');
}
