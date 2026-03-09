/**
 * rmnoise.js — RMNoise AI denoising for UberSDR web client
 *
 * Protocol (reverse-engineered from audio-mixer-processor2.js):
 *   - Audio sent/received at 8 kHz int16 PCM
 *   - Each frame: 20-byte header + int16 PCM samples
 *   - Header: frameNumber (uint64 LE) + timestamp (uint64 LE) + audioScale (uint32 LE)
 *   - audioScale = floor(32767 / max_abs_value)  [normalisation factor]
 *   - Frame size: 384 samples @ 8 kHz = 64 ms
 *
 * Mirrors clients/python/rmnoise_denoise.py + rmnoise_window.py
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────────
const RM_RATE   = 8000;   // RMNoise wire protocol sample rate
const RM_FRAME  = 384;    // 64 ms at 8 kHz
const RM_SERVER = 'wss://s2.rmnoise.com:8766';
// RM_BASE (https://rmnoise.com) is no longer used for fetch() calls — the Go
// server-side CORS proxy handles those.  RM_SERVER is still used for WebSocket.

// ── State ──────────────────────────────────────────────────────────────────────
const rmNoise = {
    enabled:          false,
    bypass:           false,   // "Original" button — keep bridge fed, discard output
    ready:            false,
    connecting:       false,

    // WebRTC / WebSocket
    pc:               null,    // RTCPeerConnection
    dc:               null,    // RTCDataChannel
    ws:               null,    // WebSocket (signalling)

    // Protocol
    frameNum:         BigInt(0),
    inputRate:        12000,   // current server sample rate (updated per packet)
    filterNumber:     1,
    availableFilters: [],

    // Jitter buffer (stores Float32Array frames at 8 kHz)
    jitterBuf:        [],
    jitterMax:        256,

    // Accumulators
    accumIn:          new Float32Array(0),   // input samples at inputRate
    accumOut:         new Float32Array(0),   // denoised 8 kHz samples

    // Latency tracking
    sendTimes:        new Map(),             // BigInt frameNum → performance.now()
    lastLatencyMs:    0,
    lastStatsUpdate:  0,

    // Stats poll interval
    statsInterval:    null,
};

// Expose globally so app.js can call rmNoise_process()
window.rmNoiseBridge = rmNoise;

// ── Wire-protocol helpers ──────────────────────────────────────────────────────

/**
 * Pack a 20-byte header + int16 PCM frame.
 * Mirrors pack_frame() in rmnoise_denoise.py
 */
function rmNoise_packFrame(frameNum, tsMs, pcm8k_i16, scale) {
    const headerBytes = 20;
    const pcmBytes    = pcm8k_i16.length * 2;
    const buf         = new ArrayBuffer(headerBytes + pcmBytes);
    const view        = new DataView(buf);

    view.setBigUint64(0,  BigInt(frameNum), true);   // uint64 LE
    view.setBigUint64(8,  BigInt(tsMs),     true);   // uint64 LE
    view.setUint32(16,    scale,            true);   // uint32 LE

    const pcmView = new Int16Array(buf, headerBytes);
    pcmView.set(pcm8k_i16);
    return buf;
}

/**
 * Unpack a server frame.
 * Mirrors unpack_frame() in rmnoise_denoise.py
 * Returns { frameNum (BigInt), tsMs (BigInt), scale (number), pcm (Int16Array) }
 */
function rmNoise_unpackFrame(data) {
    const view    = new DataView(data);
    const frameNum = view.getBigUint64(0,  true);
    const tsMs     = view.getBigUint64(8,  true);
    const scale    = view.getUint32(16,    true);
    const pcm      = new Int16Array(data, 20);
    return { frameNum, tsMs, scale, pcm };
}

// ── Resampling ─────────────────────────────────────────────────────────────────

/**
 * Resample a Float32Array from fromRate to toRate using OfflineAudioContext.
 * High-quality browser-native resampling (async).
 */
async function rmNoise_resample(float32, fromRate, toRate) {
    if (fromRate === toRate) return float32.slice();
    const outLen = Math.max(1, Math.ceil(float32.length * toRate / fromRate));
    try {
        const ctx = new OfflineAudioContext(1, outLen, toRate);
        const buf = ctx.createBuffer(1, float32.length, fromRate);
        buf.getChannelData(0).set(float32);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
        const rendered = await ctx.startRendering();
        return rendered.getChannelData(0);
    } catch (e) {
        // Fallback: nearest-neighbour (no async context available)
        const out = new Float32Array(outLen);
        const ratio = float32.length / outLen;
        for (let i = 0; i < outLen; i++) {
            out[i] = float32[Math.min(Math.round(i * ratio), float32.length - 1)];
        }
        return out;
    }
}

// ── Audio processing ───────────────────────────────────────────────────────────

/**
 * Process a mono Float32Array through the RMNoise bridge.
 * Mirrors RMNoiseBridge.process() in rmnoise_window.py
 *
 * @param {Float32Array} audioFloat  mono samples at inputRate
 * @param {number}       sampleRate  current server sample rate
 * @returns {Float32Array|null}  denoised samples at sampleRate, or null if not ready
 */
async function rmNoise_process(audioFloat, sampleRate) {
    if (!rmNoise.ready || !rmNoise.dc || rmNoise.dc.readyState !== 'open') {
        return null;
    }

    // Update rate if changed
    if (rmNoise.inputRate !== sampleRate) {
        rmNoise.inputRate = sampleRate;
        rmNoise.accumIn   = new Float32Array(0);
        rmNoise.accumOut  = new Float32Array(0);
    }

    const nIn        = audioFloat.length;
    const accumTarget = Math.round(RM_FRAME * sampleRate / RM_RATE);

    // ── Send path: accumulate → downsample → pack → send ──────────────────────
    const newAccumIn = new Float32Array(rmNoise.accumIn.length + nIn);
    newAccumIn.set(rmNoise.accumIn);
    newAccumIn.set(audioFloat, rmNoise.accumIn.length);
    rmNoise.accumIn = newAccumIn;

    while (rmNoise.accumIn.length >= accumTarget) {
        const chunk = rmNoise.accumIn.slice(0, accumTarget);
        rmNoise.accumIn = rmNoise.accumIn.slice(accumTarget);

        try {
            // Downsample to 8 kHz
            const pcm8k_f32 = await rmNoise_resample(chunk, sampleRate, RM_RATE);

            // Trim/pad to exactly RM_FRAME samples
            let frame8k = pcm8k_f32;
            if (frame8k.length > RM_FRAME) {
                frame8k = frame8k.slice(0, RM_FRAME);
            } else if (frame8k.length < RM_FRAME) {
                const padded = new Float32Array(RM_FRAME);
                padded.set(frame8k);
                frame8k = padded;
            }

            // Compute audioScale and convert to int16
            let maxAbs = 0;
            for (let i = 0; i < frame8k.length; i++) {
                const a = Math.abs(frame8k[i]);
                if (a > maxAbs) maxAbs = a;
            }
            const scale = maxAbs > 1e-9 ? Math.min(Math.floor(32767.0 / maxAbs), 4294967295) : 1;

            const pcm8k_i16 = new Int16Array(RM_FRAME);
            for (let i = 0; i < RM_FRAME; i++) {
                pcm8k_i16[i] = Math.max(-32768, Math.min(32767, Math.round(frame8k[i] * scale)));
            }

            const tsMs    = BigInt(Date.now());
            const frameNum = rmNoise.frameNum;
            const packed  = rmNoise_packFrame(frameNum, tsMs, pcm8k_i16, scale);

            rmNoise.sendTimes.set(frameNum, performance.now());
            if (rmNoise.sendTimes.size > 300) {
                // Evict oldest
                const oldest = rmNoise.sendTimes.keys().next().value;
                rmNoise.sendTimes.delete(oldest);
            }

            if (rmNoise.dc && rmNoise.dc.readyState === 'open') {
                rmNoise.dc.send(packed);
            }

            rmNoise.frameNum = frameNum + BigInt(1);
        } catch (e) {
            console.error('[RMNoise] Send error:', e);
        }
    }

    // ── Receive path: drain jitter buffer → upsample ──────────────────────────
    // Drain all available 8 kHz frames into accumOut
    while (rmNoise.jitterBuf.length > 0) {
        const frame = rmNoise.jitterBuf.shift();
        const merged = new Float32Array(rmNoise.accumOut.length + frame.length);
        merged.set(rmNoise.accumOut);
        merged.set(frame, rmNoise.accumOut.length);
        rmNoise.accumOut = merged;
    }

    // How many 8 kHz samples do we need to cover nIn input samples?
    const n8kNeeded = Math.ceil(nIn * RM_RATE / sampleRate);

    if (rmNoise.accumOut.length >= n8kNeeded) {
        const chunk8k = rmNoise.accumOut.slice(0, n8kNeeded);
        rmNoise.accumOut = rmNoise.accumOut.slice(n8kNeeded);

        // Upsample from 8 kHz → sampleRate
        const upsampled = await rmNoise_resample(chunk8k, RM_RATE, sampleRate);

        // Trim or zero-pad to exactly nIn samples
        if (upsampled.length >= nIn) {
            return upsampled.slice(0, nIn);
        } else {
            const result = new Float32Array(nIn);
            result.set(upsampled);
            return result;
        }
    }

    // Not enough denoised data yet — return null (caller uses original audio)
    return null;
}

// ── Connection ─────────────────────────────────────────────────────────────────

async function rmNoise_connect(username, password, filterNumber) {
    if (rmNoise.connecting || rmNoise.ready) return;
    rmNoise.connecting = true;
    rmNoise.filterNumber = filterNumber || 1;

    rmNoise_setStatus('Connecting…', 'orange');
    rmNoise_log(`Connecting to RMNoise as '${username}' (filter ${rmNoise.filterNumber})…`);
    rmNoise_updateButton();

    try {
        // ── Step 1: Login (via Go CORS proxy) ─────────────────────────────────
        const loginResp = await fetch('/api/rmnoise/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        const loginText = await loginResp.text();
        let loginData;
        try { loginData = JSON.parse(loginText); } catch {
            throw new Error(`Login proxy error (HTTP ${loginResp.status}): ${loginText.slice(0, 120)}`);
        }
        if (!loginData.ok) throw new Error(loginData.error || 'Login failed');
        const proxyToken = loginData.token;
        rmNoise_log('Login successful');

        // ── Step 2: Get JWT (via Go CORS proxy) ───────────────────────────────
        const jwtResp = await fetch('/api/rmnoise/webrtc_token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: proxyToken }),
        });
        const jwtData = await jwtResp.json();
        if (!jwtData.success || !jwtData.token) throw new Error('Failed to get JWT token');
        const token = jwtData.token;
        rmNoise_log('JWT token received');

        // ── Step 3: Get TURN credentials (via Go CORS proxy) ──────────────────
        const turnResp = await fetch('/api/rmnoise/turn_creds', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: proxyToken }),
        });
        const turnData = await turnResp.json();
        if (!turnData.success) throw new Error('Failed to get TURN credentials');
        rmNoise_log('TURN credentials received');

        const iceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            {
                urls:       turnData.uris || [],
                username:   turnData.username,
                credential: turnData.password,
            },
        ];

        // ── Step 4: WebSocket signalling ───────────────────────────────────────
        await rmNoise_connectWS(token, iceServers);

    } catch (e) {
        console.error('[RMNoise] Connection error:', e);
        rmNoise_log(`Connection failed: ${e.message}`);
        rmNoise_setStatus('Failed', 'red');
        rmNoise.connecting = false;
        rmNoise.enabled    = false;
        rmNoise_updateButton();
        rmNoise_syncCheckbox();
    }
}

async function rmNoise_connectWS(token, iceServers) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(RM_SERVER);
        rmNoise.ws = ws;

        ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'auth', token }));
        };

        ws.onmessage = async (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }

            switch (msg.type) {
                case 'auth_ok':
                    rmNoise_log('WebSocket authenticated');
                    ws.send(JSON.stringify({
                        type: 'ai_filter_selection',
                        filterNumber: rmNoise.filterNumber,
                    }));
                    // Set up WebRTC
                    try {
                        await rmNoise_setupWebRTC(ws, iceServers);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                    break;

                case 'answer':
                    if (rmNoise.pc) {
                        const ad = msg.answer || msg;
                        await rmNoise.pc.setRemoteDescription(
                            new RTCSessionDescription({ type: 'answer', sdp: ad.sdp })
                        );
                        rmNoise_log('WebRTC answer received');
                    }
                    break;

                case 'ice-candidate':
                    if (rmNoise.pc && msg.candidate && msg.candidate.candidate) {
                        try {
                            await rmNoise.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                        } catch (e) {
                            console.warn('[RMNoise] ICE candidate error:', e);
                        }
                    }
                    break;

                case 'ai_filters_list':
                    rmNoise.availableFilters = msg.filters || [];
                    rmNoise_log(`Available AI filters: ${rmNoise.availableFilters.length}`);
                    rmNoise_populateFilterList();
                    break;

                case 'entered_standby':
                    rmNoise_log(`Server standby: ${msg.reason || ''}`);
                    break;

                case 'left_standby':
                    rmNoise_log('Server left standby');
                    break;

                default:
                    break;
            }
        };

        ws.onerror = (e) => {
            reject(new Error('WebSocket error'));
        };

        ws.onclose = () => {
            if (rmNoise.ready) {
                rmNoise_log('WebSocket closed');
                rmNoise_handleDisconnect();
            }
        };
    });
}

async function rmNoise_setupWebRTC(ws, iceServers) {
    rmNoise_log('Setting up WebRTC…');

    const pc = new RTCPeerConnection({ iceServers });
    rmNoise.pc = pc;

    const dc = pc.createDataChannel('audio', { ordered: false, maxRetransmits: 0 });
    rmNoise.dc = dc;

    dc.onopen = () => {
        rmNoise_log('Data channel opened – denoising active');
        rmNoise.ready      = true;
        rmNoise.connecting = false;
        rmNoise_setStatus('Connected ✓', 'green');
        rmNoise_updateButton();
        rmNoise_syncCheckbox();
        rmNoise_startStatsInterval();
    };

    dc.onclose = () => {
        if (rmNoise.ready) {
            rmNoise_log('Data channel closed');
            rmNoise_handleDisconnect();
        }
    };

    dc.onerror = (e) => {
        console.error('[RMNoise] DataChannel error:', e);
    };

    dc.onmessage = (ev) => {
        try {
            const { frameNum, scale, pcm } = rmNoise_unpackFrame(ev.data);

            // Undo audioScale normalisation → float32 in [-1, 1]
            const s = scale > 0 ? scale : 32767;
            const pcm8k_f32 = new Float32Array(pcm.length);
            for (let i = 0; i < pcm.length; i++) {
                pcm8k_f32[i] = pcm[i] / s;
            }

            // Measure latency
            if (rmNoise.sendTimes.has(frameNum)) {
                const lat = performance.now() - rmNoise.sendTimes.get(frameNum);
                rmNoise.sendTimes.delete(frameNum);
                rmNoise.lastLatencyMs = lat;
            }

            // Push to jitter buffer (drop oldest if full)
            if (rmNoise.jitterBuf.length >= rmNoise.jitterMax) {
                rmNoise.jitterBuf.shift();
            }
            rmNoise.jitterBuf.push(pcm8k_f32);

        } catch (e) {
            console.error('[RMNoise] Server audio error:', e);
        }
    };

    pc.onicecandidate = (ev) => {
        if (ev.candidate) {
            ws.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: {
                    candidate:     ev.candidate.candidate,
                    sdpMid:        ev.candidate.sdpMid,
                    sdpMLineIndex: ev.candidate.sdpMLineIndex,
                },
            }));
        }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({
        type:  'offer',
        offer: { type: 'offer', sdp: pc.localDescription.sdp },
    }));
    rmNoise_log('WebRTC offer sent');
}

function rmNoise_handleDisconnect() {
    rmNoise.ready      = false;
    rmNoise.connecting = false;
    if (rmNoise.enabled) {
        rmNoise_setStatus('Disconnected', 'grey');
    }
    rmNoise_updateButton();
    rmNoise_syncCheckbox();
    rmNoise_stopStatsInterval();
}

async function rmNoise_disconnect() {
    rmNoise_log('Stopping RMNoise bridge…');
    rmNoise_stopStatsInterval();

    if (rmNoise.dc) {
        try { rmNoise.dc.close(); } catch {}
        rmNoise.dc = null;
    }
    if (rmNoise.pc) {
        try { rmNoise.pc.close(); } catch {}
        rmNoise.pc = null;
    }
    if (rmNoise.ws) {
        try { rmNoise.ws.close(); } catch {}
        rmNoise.ws = null;
    }

    rmNoise.ready      = false;
    rmNoise.connecting = false;
    rmNoise.accumIn    = new Float32Array(0);
    rmNoise.accumOut   = new Float32Array(0);
    rmNoise.jitterBuf  = [];
    rmNoise.sendTimes.clear();
    rmNoise.frameNum   = BigInt(0);
}

// ── Toggle functions ───────────────────────────────────────────────────────────

async function toggleRMNoise() {
    if (rmNoise.enabled) {
        // Disable
        rmNoise.enabled = false;
        rmNoise.bypass  = false;
        await rmNoise_disconnect();
        rmNoise_setStatus('Disconnected', 'grey');
        rmNoise_updateButton();
        rmNoise_syncCheckbox();
        rmNoise_log('RMNoise denoising disabled');
    } else {
        // Enable
        const username = localStorage.getItem('rmnoise_username') || '';
        const password = localStorage.getItem('rmnoise_password') || '';
        if (!username || !password) {
            openRMNoiseModal();
            return;
        }
        rmNoise.enabled = true;
        rmNoise_syncCheckbox();
        await rmNoise_connect(username, password, rmNoise.filterNumber);
    }
}

function toggleRMNoiseQuick() {
    const hasCreds = localStorage.getItem('rmnoise_username') &&
                     localStorage.getItem('rmnoise_password');
    if (!hasCreds) {
        openRMNoiseModal();
        return;
    }
    toggleRMNoise();
}

function toggleRMNoiseBypass() {
    rmNoise.bypass = !rmNoise.bypass;
    const btn = document.getElementById('rmnoise-original-btn');
    if (btn) {
        btn.textContent  = rmNoise.bypass ? '● Original' : 'Original';
        btn.style.color  = rmNoise.bypass ? '#ff6b6b' : '';
    }
}

// ── Stats ──────────────────────────────────────────────────────────────────────

function rmNoise_startStatsInterval() {
    rmNoise_stopStatsInterval();
    rmNoise.statsInterval = setInterval(rmNoise_updateStats, 500);
}

function rmNoise_stopStatsInterval() {
    if (rmNoise.statsInterval) {
        clearInterval(rmNoise.statsInterval);
        rmNoise.statsInterval = null;
    }
}

function rmNoise_updateStats() {
    if (!rmNoise.ready) return;

    const jitter  = rmNoise.jitterBuf.length;
    const latency = rmNoise.lastLatencyMs;

    // Update modal stats
    const jEl = document.getElementById('rmnoise-jitter');
    const lEl = document.getElementById('rmnoise-latency');
    if (jEl) jEl.textContent = `${jitter} frames`;
    if (lEl) lEl.textContent = `${latency.toFixed(0)} ms`;

    // Jitter bar (max 20 frames = full)
    const ratio    = Math.min(jitter / 20, 1.0);
    const fillEl   = document.getElementById('rmnoise-jitter-fill');
    if (fillEl) {
        fillEl.style.width = `${Math.round(ratio * 100)}%`;
        fillEl.style.backgroundColor =
            jitter <= 6  ? '#28a745' :
            jitter <= 12 ? '#ffc107' : '#dc3545';
    }

    // Update main-window status label
    const statusLabel = document.getElementById('rmnoise-status-label');
    if (statusLabel && rmNoise.ready) {
        statusLabel.textContent = `● Connected  ${latency.toFixed(0)} ms  ${jitter}fr`;
        statusLabel.style.color = '#28a745';
    }
}

// ── Filter list ────────────────────────────────────────────────────────────────

function rmNoise_populateFilterList() {
    const sel = document.getElementById('rmnoise-filter-select');
    if (!sel || rmNoise.availableFilters.length === 0) return;

    sel.innerHTML = '';
    const savedFilter = rmNoise.filterNumber;

    for (const f of rmNoise.availableFilters) {
        const opt = document.createElement('option');
        opt.value       = f.filterNumber;
        opt.textContent = f.filterDesc || `Filter ${f.filterNumber}`;
        if (f.filterNumber === savedFilter) opt.selected = true;
        sel.appendChild(opt);
    }
}

function rmNoise_onFilterChanged() {
    const sel = document.getElementById('rmnoise-filter-select');
    if (!sel) return;
    const newFilter = parseInt(sel.value, 10);
    if (isNaN(newFilter)) return;

    rmNoise.filterNumber = newFilter;
    localStorage.setItem('rmnoise_filter', newFilter);

    // Send to server if connected
    if (rmNoise.ws && rmNoise.ws.readyState === WebSocket.OPEN) {
        rmNoise.ws.send(JSON.stringify({
            type:         'ai_filter_selection',
            filterNumber: newFilter,
        }));
        rmNoise_log(`Filter changed to: ${sel.options[sel.selectedIndex]?.textContent}`);
    }
}

// ── Credentials ────────────────────────────────────────────────────────────────

function rmNoise_saveCredentials() {
    const username = (document.getElementById('rmnoise-username')?.value || '').trim();
    const password = (document.getElementById('rmnoise-password')?.value || '').trim();

    if (!username || !password) {
        alert('Username and password are required');
        return;
    }

    localStorage.setItem('rmnoise_username', username);
    localStorage.setItem('rmnoise_password', password);
    localStorage.setItem('rmnoise_filter',   rmNoise.filterNumber);
    rmNoise_log('Credentials saved');
}

function rmNoise_loadCredentials() {
    const username = localStorage.getItem('rmnoise_username') || '';
    const password = localStorage.getItem('rmnoise_password') || '';
    const filter   = parseInt(localStorage.getItem('rmnoise_filter') || '1', 10);

    const uEl = document.getElementById('rmnoise-username');
    const pEl = document.getElementById('rmnoise-password');
    if (uEl) uEl.value = username;
    if (pEl) pEl.value = password;

    rmNoise.filterNumber = isNaN(filter) ? 1 : filter;

    const sel = document.getElementById('rmnoise-filter-select');
    if (sel) sel.value = rmNoise.filterNumber;
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function rmNoise_setStatus(text, colour) {
    const el = document.getElementById('rmnoise-status-text');
    if (!el) return;
    el.textContent  = text;
    el.style.color  =
        colour === 'green'  ? '#28a745' :
        colour === 'orange' ? '#fd7e14' :
        colour === 'red'    ? '#dc3545' : '#888';
}

function rmNoise_updateButton() {
    const btn = document.getElementById('rmn-quick-toggle');
    if (!btn) return;

    if (rmNoise.connecting) {
        btn.style.backgroundColor = '#fd7e14';  // orange
    } else if (rmNoise.ready && rmNoise.enabled) {
        btn.style.backgroundColor = '#28a745';  // green
    } else if (!rmNoise.enabled) {
        btn.style.backgroundColor = '#6f42c1';  // purple (idle)
    } else {
        btn.style.backgroundColor = '#dc3545';  // red (failed)
    }

    // Original button
    const origBtn = document.getElementById('rmnoise-original-btn');
    if (origBtn) {
        origBtn.disabled = !(rmNoise.ready && rmNoise.enabled);
    }
}

function rmNoise_syncCheckbox() {
    const cb = document.getElementById('rmnoise-enable-checkbox');
    if (cb) cb.checked = rmNoise.enabled;
}

function rmNoise_log(message) {
    const ts  = new Date().toTimeString().slice(0, 8);
    const div = document.getElementById('rmnoise-log');
    if (!div) return;
    const line = document.createElement('div');
    line.textContent = `[${ts}] ${message}`;
    div.appendChild(line);
    div.scrollTop = div.scrollHeight;
}

// ── Modal ──────────────────────────────────────────────────────────────────────

function openRMNoiseModal() {
    const modal = document.getElementById('rmnoise-modal');
    if (!modal) return;
    rmNoise_loadCredentials();
    modal.style.display = 'flex';
}

function closeRMNoiseModal() {
    const modal = document.getElementById('rmnoise-modal');
    if (modal) modal.style.display = 'none';
}

// Close on backdrop click
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('rmnoise-modal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeRMNoiseModal();
        });
    }

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeRMNoiseModal();
    });

    // RMN button: left-click toggles (or opens modal if no creds)
    const rmnBtn = document.getElementById('rmn-quick-toggle');
    if (rmnBtn) {
        rmnBtn.addEventListener('click', (e) => {
            const hasCreds = localStorage.getItem('rmnoise_username') &&
                             localStorage.getItem('rmnoise_password');
            if (!hasCreds) {
                openRMNoiseModal();
            } else {
                toggleRMNoise();
            }
        });

        // Right-click always opens config modal
        rmnBtn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            openRMNoiseModal();
        });
    }

    // Load saved credentials into modal fields
    rmNoise_loadCredentials();

    // Initialise button state
    rmNoise_updateButton();
});

// ── Expose globals for app.js ──────────────────────────────────────────────────
window.toggleRMNoise        = toggleRMNoise;
window.toggleRMNoiseQuick   = toggleRMNoiseQuick;
window.toggleRMNoiseBypass  = toggleRMNoiseBypass;
window.openRMNoiseModal     = openRMNoiseModal;
window.closeRMNoiseModal    = closeRMNoiseModal;
window.rmNoise_saveCredentials  = rmNoise_saveCredentials;
window.rmNoise_onFilterChanged  = rmNoise_onFilterChanged;
window.rmNoise_process          = rmNoise_process;