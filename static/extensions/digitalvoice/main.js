// Digital Voice extension — receive-only DSD-FME integration.
//
// Binary protocol (backend -> browser):
//   0x40 [UTF-8 JSON] decoder event/metadata
//   0x41 [timestamp:8 BE][sample rate:4 BE][channels:1][PCM16 LE...]
//   0x42 [UTF-8 JSON] decoder error

class DigitalVoiceExtension extends DecoderExtension {
    constructor() {
        super('digitalvoice', {
            displayName: 'Digital Voice',
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: null
        });
        this.running = false;
        this.eventCount = 0;
        this.originalHandler = null;
        this.binaryHandler = null;
        this.nextPlayTime = 0;
        this.gainNode = null;
        this.handlersReady = false;
    }

    onInitialize() {
        this._render();
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

    _render() {
        const container = document.querySelector('.extension-content[data-extension="digitalvoice"]');
        if (container && window.digitalvoice_template) {
            container.innerHTML = window.digitalvoice_template;
        }
    }

    _bind() {
        if (this.handlersReady) return;
        const start = document.getElementById('dv-start');
        if (!start) {
            setTimeout(() => this._bind(), 100);
            return;
        }
        this.handlersReady = true;
        start.addEventListener('click', () => this.running ? this._stop() : this._start());
        document.getElementById('dv-clear')?.addEventListener('click', () => this._clear());
        document.getElementById('dv-protocol')?.addEventListener('change', () => this._updateInversion());
        document.getElementById('dv-volume')?.addEventListener('input', (event) => {
            if (this.gainNode) this.gainNode.gain.value = Number(event.target.value);
        });
        this._updateInversion();
    }

    _updateInversion() {
        const protocol = document.getElementById('dv-protocol')?.value || 'dmr';
        const checkbox = document.getElementById('dv-inverted');
        if (!checkbox) return;
        checkbox.disabled = !['dmr', 'nxdn48', 'nxdn96', 'dpmr', 'm17'].includes(protocol);
        if (checkbox.disabled) checkbox.checked = false;
    }

    async _start() {
        const ws = this._webSocket();
        if (!ws) {
            this._setStatus('Audio connection is not ready', 'error');
            return;
        }

        const protocol = document.getElementById('dv-protocol')?.value || 'dmr';
        const bandwidths = {
            nxdn48: 7000, dpmr: 7000,
            provoice: 24000, edacs: 24000
        };
        const width = bandwidths[protocol] || 12000;

        // The server-side decoder consumes the mono NFM audio tap. Allow the
        // mode update to reach the receiver before attaching the extension.
        if ((this.radio.getMode() || '').toLowerCase() !== 'nfm') {
            this.radio.setMode('nfm');
        }
        this.radio.setBandwidth(-Math.floor(width / 2), Math.floor(width / 2));
        await new Promise(resolve => setTimeout(resolve, 350));

        this._installWebSocket();
        ws.send(JSON.stringify({
            type: 'audio_extension_attach',
            extension_name: 'digitalvoice',
            params: {
                protocol,
                inverted: !!document.getElementById('dv-inverted')?.checked
            }
        }));

        this.running = true;
        this.nextPlayTime = 0;
        this._setButton(true);
        this._setStatus('Starting…', 'running');
    }

    _stop() {
        const ws = this._webSocket();
        if (ws) ws.send(JSON.stringify({ type: 'audio_extension_detach' }));
        this.running = false;
        this.nextPlayTime = 0;
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
        this.binaryHandler = (event) => {
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
                    message.extension_name === 'digitalvoice') {
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
        client.ws.onmessage = this.binaryHandler;
    }

    _restoreWebSocket() {
        const client = window.dxClusterClient;
        if (client?.ws && this.originalHandler) {
            client.ws.onmessage = this.originalHandler;
            client.ws.binaryType = 'blob';
        }
        this.originalHandler = null;
        this.binaryHandler = null;
    }

    _handleBinary(data) {
        if (!data || data.byteLength < 1) return;
        const type = new DataView(data).getUint8(0);
        if (type === 0x40 || type === 0x42) {
            const payload = new TextDecoder().decode(new Uint8Array(data, 1));
            try {
                const message = JSON.parse(payload);
                if (type === 0x42) this._handleError(message.error || 'DSD-FME stopped');
                else this._addEvent(message);
            } catch (error) {
                console.warn('[DigitalVoice] invalid event payload', error);
            }
            return;
        }
        if (type === 0x41) this._playPCM(data);
    }

    _playPCM(data) {
        if (!this.running || data.byteLength < 16) return;
        const view = new DataView(data);
        const sampleRate = view.getUint32(9, false);
        const channels = view.getUint8(13);
        const byteLength = data.byteLength - 14;
        const frames = Math.floor(byteLength / (2 * channels));
        if (!sampleRate || !channels || !frames) return;

        const context = this.radio.getAudioContext();
        if (!context) return;
        if (!this.gainNode) {
            this.gainNode = context.createGain();
            this.gainNode.gain.value = Number(document.getElementById('dv-volume')?.value || 1);
            this.gainNode.connect(context.destination);
        }

        const buffer = context.createBuffer(channels, frames, sampleRate);
        for (let channel = 0; channel < channels; channel++) {
            const output = buffer.getChannelData(channel);
            for (let frame = 0; frame < frames; frame++) {
                const offset = 14 + ((frame * channels + channel) * 2);
                output[frame] = view.getInt16(offset, true) / 32768;
            }
        }

        const now = context.currentTime;
        if (this.nextPlayTime < now || this.nextPlayTime > now + 1) {
            this.nextPlayTime = now + 0.06;
        }
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(this.gainNode);
        source.start(this.nextPlayTime);
        this.nextPlayTime += frames / sampleRate;
        this._setStatus('Decoding clear audio', 'running');
    }

    _addEvent(event) {
        if (event.type === 'digital_voice_started') {
            this._setStatus('Running — waiting for a signal…', 'running');
            return;
        }
        this.eventCount += 1;
        const count = document.getElementById('dv-count');
        if (count) count.textContent = `${this.eventCount} event${this.eventCount === 1 ? '' : 's'}`;

        const list = document.getElementById('dv-events');
        if (!list) return;
        list.querySelector('.dv-empty')?.remove();
        const row = document.createElement('div');
        row.className = `dv-event${event.encrypted ? ' encrypted' : ''}`;

        const header = document.createElement('div');
        header.className = 'dv-event-head';
        const details = [String(event.protocol || 'signal').toUpperCase()];
        if (event.slot) details.push(`slot ${event.slot}`);
        if (event.color_code !== undefined && event.color_code !== 0) details.push(`CC ${event.color_code}`);
        if (event.source_id) details.push(`source ${event.source_id}`);
        if (event.target_id) details.push(`target ${event.target_id}`);
        if (event.nac) details.push(`NAC ${event.nac}`);
        if (event.encrypted) details.push('ENCRYPTED — AUDIO SUPPRESSED');
        header.textContent = details.join(' · ');

        const body = document.createElement('div');
        body.textContent = event.raw || '';
        row.append(header, body);
        list.prepend(row);
        while (list.children.length > 200) list.lastElementChild.remove();
    }

    _handleError(message) {
        this.running = false;
        this._setButton(false);
        this._setStatus(message, 'error');
        this._restoreWebSocket();
    }

    _setButton(running) {
        const button = document.getElementById('dv-start');
        if (!button) return;
        button.textContent = running ? 'Stop decoder' : 'Start decoder';
        button.classList.toggle('running', running);
    }

    _setStatus(text, className) {
        const status = document.getElementById('dv-status');
        if (!status) return;
        status.textContent = text;
        status.className = `dv-status${className ? ` ${className}` : ''}`;
    }

    _clear() {
        this.eventCount = 0;
        const count = document.getElementById('dv-count');
        if (count) count.textContent = '0 events';
        const list = document.getElementById('dv-events');
        if (list) list.innerHTML = '<div class="dv-empty">Waiting for decoder events.</div>';
    }
}

if (window.decoderManager) {
    window.decoderManager.register(new DigitalVoiceExtension());
    console.log('Digital Voice extension registered');
} else {
    console.error('[DigitalVoice] decoderManager not available');
}
