// Paging & Signalling extension — multimon-ng integration.
// Backend messages: 0x50 JSON decode/event, 0x51 JSON error.

class SignallingExtension extends DecoderExtension {
    constructor() {
        super('signalling', {
            displayName: 'Paging & Signalling',
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: null
        });
        this.running = false;
        this.decodeCount = 0;
        this.originalHandler = null;
        this.handlersReady = false;
    }

    onInitialize() {
        const container = document.querySelector('.extension-content[data-extension="signalling"]');
        if (container && window.signalling_template) container.innerHTML = window.signalling_template;
        this._bind();
    }

    onActivate() {
        this.handlersReady = false;
        this._bind();
    }

    onDeactivate() {
        if (this.running) this._stop();
    }

    onDisable() {
        if (this.running) this._stop();
        this._restoreWebSocket();
    }

    onProcessAudio(_samples) {}

    _bind() {
        if (this.handlersReady) return;
        const start = document.getElementById('sig-start');
        if (!start) {
            setTimeout(() => this._bind(), 100);
            return;
        }
        this.handlersReady = true;
        start.addEventListener('click', () => this.running ? this._stop() : this._start());
        document.getElementById('sig-clear')?.addEventListener('click', () => this._clear());
    }

    async _start() {
        const ws = this._webSocket();
        if (!ws) {
            this._setStatus('Audio connection is not ready', 'error');
            return;
        }
        const profile = document.getElementById('sig-profile')?.value || 'paging';
        const bandwidth = profile === 'dtmf' || profile === 'twotone' ? 12000 : 15000;
        if ((this.radio.getMode() || '').toLowerCase() !== 'nfm') this.radio.setMode('nfm');
        this.radio.setBandwidth(-Math.floor(bandwidth / 2), Math.floor(bandwidth / 2));
        await new Promise(resolve => setTimeout(resolve, 350));

        this._installWebSocket();
        ws.send(JSON.stringify({
            type: 'audio_extension_attach',
            extension_name: 'signalling',
            params: { profile }
        }));
        this.running = true;
        this._setButton(true);
        this._setStatus('Starting…', 'running');
    }

    _stop() {
        const ws = this._webSocket();
        if (ws) ws.send(JSON.stringify({ type: 'audio_extension_detach' }));
        this.running = false;
        this._setButton(false);
        this._setStatus('Stopped', '');
        this._restoreWebSocket();
    }

    _webSocket() {
        const ws = window.dxClusterClient?.ws;
        return ws && ws.readyState === WebSocket.OPEN ? ws : null;
    }

    _installWebSocket() {
        const client = window.dxClusterClient;
        if (!client?.ws) return;
        if (!this.originalHandler) this.originalHandler = client.ws.onmessage;
        client.ws.binaryType = 'arraybuffer';
        client.ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                this._handleBinary(event.data);
                return;
            }
            if (event.data instanceof Blob) {
                event.data.arrayBuffer().then(data => this._handleBinary(data));
                return;
            }
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'audio_extension_attached' &&
                    message.extension_name === 'signalling') {
                    this._setStatus('Running — waiting for a signal…', 'running');
                    return;
                }
                if (message.type === 'audio_extension_error') {
                    this._handleError(message.error || 'Decoder error');
                    return;
                }
            } catch (_) {
                // Forward non-JSON text below.
            }
            if (this.originalHandler) this.originalHandler.call(client.ws, event);
        };
    }

    _restoreWebSocket() {
        const client = window.dxClusterClient;
        if (client?.ws && this.originalHandler) {
            client.ws.onmessage = this.originalHandler;
            client.ws.binaryType = 'blob';
        }
        this.originalHandler = null;
    }

    _handleBinary(data) {
        if (!data || data.byteLength < 2) return;
        const type = new DataView(data).getUint8(0);
        if (type !== 0x50 && type !== 0x51) return;
        try {
            const payload = new TextDecoder().decode(new Uint8Array(data, 1));
            const message = JSON.parse(payload);
            if (type === 0x51) this._handleError(message.error || 'multimon-ng stopped');
            else if (message.type === 'signalling_started') {
                this._setStatus('Running — waiting for a signal…', 'running');
            } else {
                this._addDecode(message);
            }
        } catch (error) {
            console.warn('[Signalling] invalid decoder payload', error);
        }
    }

    _addDecode(message) {
        this.decodeCount += 1;
        const count = document.getElementById('sig-count');
        if (count) count.textContent = `${this.decodeCount} decode${this.decodeCount === 1 ? '' : 's'}`;
        const list = document.getElementById('sig-results');
        if (!list) return;
        list.querySelector('.sig-empty')?.remove();
        const row = document.createElement('div');
        row.className = 'sig-result';
        const stamp = document.createElement('span');
        stamp.className = 'sig-time';
        stamp.textContent = new Date(message.timestamp || Date.now()).toLocaleTimeString();
        const text = document.createElement('span');
        text.textContent = message.raw || '';
        row.append(stamp, text);
        list.prepend(row);
        while (list.children.length > 300) list.lastElementChild.remove();
    }

    _handleError(message) {
        this.running = false;
        this._setButton(false);
        this._setStatus(message, 'error');
        this._restoreWebSocket();
    }

    _setButton(running) {
        const button = document.getElementById('sig-start');
        if (!button) return;
        button.textContent = running ? 'Stop decoder' : 'Start decoder';
        button.classList.toggle('running', running);
    }

    _setStatus(text, className) {
        const status = document.getElementById('sig-status');
        if (!status) return;
        status.textContent = text;
        status.className = className || '';
    }

    _clear() {
        this.decodeCount = 0;
        const count = document.getElementById('sig-count');
        if (count) count.textContent = '0 decodes';
        const list = document.getElementById('sig-results');
        if (list) list.innerHTML = '<div class="sig-empty">Waiting for decoder output.</div>';
    }
}

if (window.decoderManager) {
    window.decoderManager.register(new SignallingExtension());
    console.log('Paging & Signalling extension registered');
} else {
    console.error('[Signalling] decoderManager not available');
}
