// ============================================================
// shared_session.js — Session sharing for UberSDR Multi-Monitor
//
// Owner model: a single "owner key" (UUID v4) is generated once
// per browser and stored in localStorage as mm_share_owner_key.
// All sessions created by this browser use that key.
// The key is sent as X-Owner-Key header on POST/PUT/DELETE.
//
// Follower model: ?share=SHARE_ID in URL → follower mode.
// SSE stream with 5s polling fallback.
// ============================================================

'use strict';

// --------------- State variables ---------------
let sharedSessionId      = null;   // share_id (owner or follower)
let isOwnerMode          = false;  // true when we own the current session
let isFollowerMode       = false;  // true when ?share= present and not owner
let sharedSessionVersion = 0;      // last known version (SSE dedup)
let sharedSessionSSE     = null;   // EventSource instance
let sharedSessionPollTimer = null; // fallback polling timer
let _shareUpdateTimer    = null;   // debounce timer for owner updates
let _sseFails            = 0;      // consecutive SSE connection failures
let _relayUpstream       = null;   // RelayUpstream instance (owner only)
let _followerRelay       = null;   // FollowerRelay instance (follower only)

// --------------- Owner key ---------------
const LS_OWNER_KEY = 'mm_share_owner_key';

function _getOrCreateOwnerKey() {
    let key = localStorage.getItem(LS_OWNER_KEY);
    if (!key) {
        key = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
        localStorage.setItem(LS_OWNER_KEY, key);
    }
    return key;
}

function _ownerKey() {
    return localStorage.getItem(LS_OWNER_KEY);
}

// --------------- Name validation ---------------
const SHARE_NAME_RE = /^[a-zA-Z0-9 .:_-]{1,50}$/;

function _defaultShareName() {
    const mhz = currentFreqHz / 1e6;
    // Format as e.g. "14.100" — trim trailing zeros after decimal but keep at least 3dp
    const freqStr = mhz.toFixed(3).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    const modeStr = (modeOverride || currentMode || 'USB').toUpperCase();
    const now = new Date();
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    return `${freqStr} MHz ${modeStr} ${hh}:${mm} UTC`;
}

function validateShareName() {
    const input = document.getElementById('shareNameInput');
    const hint  = document.getElementById('shareNameHint');
    const btn   = document.getElementById('shareCreateBtn');
    if (!input) return;
    const val = input.value.trim();
    const valid = SHARE_NAME_RE.test(val);
    input.classList.toggle('invalid', !valid);
    if (hint) {
        hint.textContent = valid
            ? 'Letters, numbers, spaces, periods, hyphens, colons and underscores (max 50)'
            : '⚠ Only letters, numbers, spaces, periods, hyphens, colons and underscores allowed (max 50)';
        hint.classList.toggle('error', !valid);
    }
    if (btn) btn.disabled = !valid;
}

// --------------- Modal open/close ---------------
function openShareModal() {
    const overlay = document.getElementById('shareModalOverlay');
    if (!overlay) return;
    if (sharedSessionId) {
        _showShareState2();
    } else {
        _showShareState1();
        _loadMyShares();
    }
    overlay.classList.add('open');
}

function closeShareModal() {
    const overlay = document.getElementById('shareModalOverlay');
    if (overlay) overlay.classList.remove('open');
}

function shareModalOverlayClick(e) {
    if (e.target === document.getElementById('shareModalOverlay')) closeShareModal();
}

function _showShareState1() {
    document.getElementById('shareState1').style.display = '';
    document.getElementById('shareState2').style.display = 'none';
    document.getElementById('shareModalTitle').textContent = '🔗 Share This Session';
    const input = document.getElementById('shareNameInput');
    if (input) {
        input.value = _defaultShareName();
        validateShareName();
    }
}

function _showShareState2() {
    document.getElementById('shareState1').style.display = 'none';
    document.getElementById('shareState2').style.display = '';
    document.getElementById('shareModalTitle').textContent = '🔗 Sharing Active';
    const urlInput = document.getElementById('shareUrlInput');
    if (urlInput && sharedSessionId) {
        urlInput.value = `${location.origin}${location.pathname}?share=${sharedSessionId}`;
    }
    document.querySelectorAll('.share-session-btn').forEach(btn => {
        btn.classList.add('active');
        btn.innerHTML = '🔗 Sharing <span class="share-live-dot"></span>';
    });
}

// --------------- My Shares list ---------------
async function _loadMyShares() {
    const ownerKey  = _ownerKey();
    const container = document.getElementById('mySharesList');
    const section   = document.getElementById('mySharesSection');
    if (!container || !section) return;
    if (!ownerKey) { section.style.display = 'none'; return; }

    container.innerHTML = '<div style="font-size:0.8em;opacity:0.5;padding:4px 0;">Loading…</div>';
    section.style.display = '';

    try {
        const resp = await fetch(`/api/shared-sessions?owner_key=${encodeURIComponent(ownerKey)}`);
        if (!resp.ok) { section.style.display = 'none'; return; }
        const sessions = await resp.json();
        if (!Array.isArray(sessions) || sessions.length === 0) {
            section.style.display = 'none';
            return;
        }
        section.style.display = '';
        container.innerHTML = sessions.map(s => `
            <div class="my-share-item" id="my-share-${s.share_id}">
                <div class="my-share-info">
                    <span class="my-share-name">${escHtml(s.name || s.share_id)}</span>
                    <span class="my-share-freq">${(s.freq_hz / 1e6).toFixed(3)} MHz · ${(s.mode || '').toUpperCase()}</span>
                </div>
                <div class="my-share-actions">
                    <button class="btn btn-secondary" style="font-size:0.78em;padding:4px 10px;"
                            onclick="resumeSharedSession('${s.share_id}')">Resume</button>
                    <button class="btn btn-danger" style="font-size:0.78em;padding:4px 8px;"
                            onclick="deleteOwnedSession('${s.share_id}')">🗑</button>
                </div>
            </div>
        `).join('');
    } catch (e) {
        section.style.display = 'none';
    }
}

function resumeSharedSession(shareId) {
    sharedSessionId      = shareId;
    sharedSessionVersion = 0;
    isOwnerMode          = true;
    // Start relay upstream if not already running
    if (!_relayUpstream) {
        const ownerKey = _getOrCreateOwnerKey();
        _relayUpstream = new RelayUpstream(shareId, ownerKey);
        _relayUpstream.connect();
        // Attach callbacks to any already-running radios
        if (typeof attachRelayCallbacksToActiveRadios === 'function') {
            attachRelayCallbacksToActiveRadios(_relayUpstream);
        }
    }
    // Re-sync the stored session with this browser's current state (freq, mode,
    // Smart Listen open) — the stored values may be stale from a previous session.
    scheduleSharedSessionUpdate();
    closeShareModal();
    openShareModal();
}

async function deleteOwnedSession(shareId) {
    const ownerKey = _ownerKey();
    if (!ownerKey) return;
    closeShareModal();
    showConfirmOverlay({
        icon:        '🗑️',
        title:       'Delete shared session?',
        desc:        'Followers will be disconnected.',
        confirmText: '🗑️ Delete',
        confirmCls:  'btn-danger',
        cancelText:  'Cancel',
        onConfirm:   () => _doDeleteOwnedSession(shareId, ownerKey),
        onCancel:    () => openShareModal(),
    });
}

async function _doDeleteOwnedSession(shareId, ownerKey) {
    if (sharedSessionId === shareId) {
        _clearShareState();
    }

    try {
        await fetch(`/api/shared-sessions/${shareId}`, {
            method: 'DELETE',
            headers: { 'X-Owner-Key': ownerKey },
        });
    } catch (e) { /* ignore */ }

    const el = document.getElementById(`my-share-${shareId}`);
    if (el) el.remove();

    const container = document.getElementById('mySharesList');
    if (container && container.children.length === 0) {
        const section = document.getElementById('mySharesSection');
        if (section) section.style.display = 'none';
    }
}

// --------------- Copy link ---------------
function copyShareLink() {
    const urlInput = document.getElementById('shareUrlInput');
    if (!urlInput) return;
    navigator.clipboard.writeText(urlInput.value).then(() => {
        const btn = document.getElementById('shareCopyBtn');
        if (btn) {
            const orig = btn.textContent;
            btn.textContent = '✓ Copied!';
            setTimeout(() => { btn.textContent = orig; }, 1800);
        }
    }).catch(() => {
        urlInput.select();
        document.execCommand('copy');
    });
}

// --------------- Copy follower share link ---------------
function copyFollowerShareLink() {
    if (!sharedSessionId) return;
    const url = `${location.origin}${location.pathname}?share=${encodeURIComponent(sharedSessionId)}`;
    navigator.clipboard.writeText(url).then(() => {
        const btn = document.querySelector('.follower-copy-btn');
        if (btn) {
            const orig = btn.textContent;
            btn.textContent = '✓ Copied!';
            setTimeout(() => { btn.textContent = orig; }, 1800);
        }
    }).catch(() => {
        // Fallback for browsers without clipboard API
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    });
}

// --------------- Create shared session (owner) ---------------
async function createSharedSession() {
    const nameInput = document.getElementById('shareNameInput');
    const name = nameInput ? nameInput.value.trim() : _defaultShareName();
    if (!SHARE_NAME_RE.test(name)) { validateShareName(); return; }

    const ownerKey = _getOrCreateOwnerKey();
    const btn = document.getElementById('shareCreateBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }

    try {
        const body = {
            name,
            freq_hz:       currentFreqHz,
            mode:          modeOverride || currentMode || 'usb',
            modality:      modality || 'phone',
            mode_override: modeOverride || null,
            instance_ids:  [...selectedIds],
            smart_listen_open: document.getElementById('snrModalOverlay')?.classList.contains('open') || false,
        };
        const resp = await fetch('/api/shared-sessions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Owner-Key': ownerKey,
            },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            alert(`Failed to create share: ${err.error || resp.statusText}`);
            return;
        }
        const data = await resp.json();
        sharedSessionId      = data.share_id;
        sharedSessionVersion = 1;
        isOwnerMode          = true;
        _setOwnerUnloadGuard(true);

        // Start relay upstream so followers can receive audio
        _relayUpstream = new RelayUpstream(data.share_id, ownerKey);
        _relayUpstream.connect();

        // Attach onAudioFrame callbacks to all already-running radios.
        // New radios created by connectInstance() will also get the callback
        // (see multi_monitor.js connectInstance() — it checks _relayUpstream).
        if (typeof attachRelayCallbacksToActiveRadios === 'function') {
            attachRelayCallbacksToActiveRadios(_relayUpstream);
        }

        closeShareModal();
        openShareModal(); // re-opens in State 2
    } catch (e) {
        alert(`Network error: ${e.message}`);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔗 Create Share Link'; }
    }
}

// --------------- Update shared session (owner, debounced) ---------------
function scheduleSharedSessionUpdate() {
    if (_shareUpdateTimer) clearTimeout(_shareUpdateTimer);
    _shareUpdateTimer = setTimeout(_doSharedSessionUpdate, 500);
}

async function _doSharedSessionUpdate() {
    if (!sharedSessionId || !isOwnerMode) return;
    const ownerKey = _ownerKey();
    if (!ownerKey) return;
    // Determine smart listen modal state
    const smartOpen = document.getElementById('snrModalOverlay')?.classList.contains('open') || false;
    // Determine channel assignments
    // "both" mode: leftChannelId is set, rightChannelId is null, pan=0
    // We encode "both" as left_channel_id = right_channel_id = id so followers can detect it
    let leftId  = (typeof leftChannelId  !== 'undefined') ? leftChannelId  : null;
    let rightId = (typeof rightChannelId !== 'undefined') ? rightChannelId : null;
    if (leftId !== null && rightId === null) {
        // Check if it's "both" mode (pan=0) vs just "left" mode (pan=-1)
        const pan = (typeof getActiveRadioPanValue === 'function') ? getActiveRadioPanValue(leftId) : null;
        if (pan === 0.0) {
            // "both" mode — encode as same ID in both slots
            rightId = leftId;
        }
    }
    try {
        await fetch(`/api/shared-sessions/${sharedSessionId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Owner-Key': ownerKey,
            },
            body: JSON.stringify({
                freq_hz:          currentFreqHz,
                mode:             modeOverride || currentMode || 'usb',
                modality:         modality || 'phone',
                mode_override:    modeOverride || null,
                smart_listen_open: smartOpen,
                left_channel_id:  leftId,
                right_channel_id: rightId,
            }),
        });
    } catch (e) { /* silently ignore — will retry on next change */ }
}

// --------------- Stop sharing (owner) ---------------

/** Arm/disarm the beforeunload warning shown when the owner tries to close/refresh the tab. */
function _setOwnerUnloadGuard(active) {
    if (active) {
        if (!window._ownerUnloadHandler) {
            window._ownerUnloadHandler = e => {
                if (typeof isOwnerMode !== 'undefined' && isOwnerMode) {
                    e.preventDefault();
                    e.returnValue = '';   // required for Chrome
                }
            };
            window.addEventListener('beforeunload', window._ownerUnloadHandler);
        }
    } else {
        if (window._ownerUnloadHandler) {
            window.removeEventListener('beforeunload', window._ownerUnloadHandler);
            window._ownerUnloadHandler = null;
        }
    }
}

/** Core stop-sharing logic — no confirm dialog. */
async function _stopSharingCore() {
    if (!sharedSessionId) { closeShareModal(); return; }
    const idToDelete = sharedSessionId;
    const ownerKey = _ownerKey();
    _clearShareState();
    _setOwnerUnloadGuard(false);
    closeShareModal();
    if (ownerKey) {
        try {
            await fetch(`/api/shared-sessions/${idToDelete}`, {
                method: 'DELETE',
                headers: { 'X-Owner-Key': ownerKey },
            });
        } catch (e) { /* ignore — session will expire naturally */ }
    }
}

async function stopSharing() {
    if (!sharedSessionId) { closeShareModal(); return; }
    closeShareModal();
    showConfirmOverlay({
        icon:        '🔗',
        title:       'Stop sharing?',
        desc:        'All followers will be disconnected.',
        confirmText: '🛑 Stop Sharing',
        confirmCls:  'btn-danger',
        cancelText:  'Keep Sharing',
        onConfirm:   () => _stopSharingCore(),
        onCancel:    () => openShareModal(),
    });
}

function _clearShareState() {
    sharedSessionId      = null;
    sharedSessionVersion = 0;
    isOwnerMode          = false;
    if (_relayUpstream) {
        _relayUpstream.disconnect();
        _relayUpstream = null;
        // Remove onAudioFrame callbacks from all active radios
        if (typeof attachRelayCallbacksToActiveRadios === 'function') {
            attachRelayCallbacksToActiveRadios(null);
        }
    }
    _hideRelayListenerBadge();
    document.querySelectorAll('.share-session-btn').forEach(btn => {
        btn.classList.remove('active');
        btn.innerHTML = '🔗 Share';
    });
}

// --------------- Follower mode ---------------
function _initFollowerMode() {
    const params  = new URLSearchParams(location.search);
    const shareId = params.get('share');
    if (!shareId) return;

    const ownerKey = _ownerKey();
    if (ownerKey) {
        // Check if this session belongs to us
        fetch(`/api/shared-sessions?owner_key=${encodeURIComponent(ownerKey)}`)
            .then(r => r.ok ? r.json() : [])
            .then(sessions => {
                const isOwner = Array.isArray(sessions) && sessions.some(s => s.share_id === shareId);
                if (isOwner) {
                    sharedSessionId = shareId;
                    isOwnerMode     = true;
                    document.querySelectorAll('.share-session-btn').forEach(btn => {
                        btn.classList.add('active');
                        btn.innerHTML = '🔗 Sharing <span class="share-live-dot"></span>';
                    });
                    // Start relay upstream for this resumed owner session
                    if (!_relayUpstream) {
                        _relayUpstream = new RelayUpstream(shareId, ownerKey);
                        _relayUpstream.connect();
                        // Attach callbacks to any already-running radios
                        if (typeof attachRelayCallbacksToActiveRadios === 'function') {
                            attachRelayCallbacksToActiveRadios(_relayUpstream);
                        }
                    }
                    // Re-sync the stored session with this browser's current state
                    // (freq, mode, Smart Listen open) — stored values may be stale.
                    scheduleSharedSessionUpdate();
                } else {
                    _enterFollowerMode(shareId);
                }
            })
            .catch(() => _enterFollowerMode(shareId));
        return;
    }

    _enterFollowerMode(shareId);
}

// Pending session data — stored while waiting for user gesture on join splash
let _pendingFollowerData = null;

function _enterFollowerMode(shareId) {
    isFollowerMode  = true;
    sharedSessionId = shareId;
    document.body.classList.add('follower-locked');

    fetch(`/api/shared-sessions/${shareId}`)
        .then(r => {
            if (!r.ok) throw new Error('Session not found');
            return r.json();
        })
        .then(data => {
            _pendingFollowerData = data;
            _showJoinSplash(data);
        })
        .catch(err => {
            console.warn('[Share] Failed to load session:', err);
            _showShareEnded();
        });
}

function _showJoinSplash(data) {
    const overlay = document.getElementById('followerJoinOverlay');
    if (!overlay) {
        // Fallback: no splash element, start immediately
        _startFollowerSession(_pendingFollowerData);
        return;
    }
    const nameEl  = document.getElementById('followerJoinName');
    const freqEl  = document.getElementById('followerJoinFreq');
    const modeEl  = document.getElementById('followerJoinMode');
    const countEl = document.getElementById('followerJoinCount');
    if (nameEl)  nameEl.textContent  = data.name || data.share_id;
    if (freqEl)  freqEl.textContent  = `${(data.freq_hz / 1e6).toFixed(3)} MHz`;
    if (modeEl)  modeEl.textContent  = (data.mode || '').toUpperCase();
    if (countEl) countEl.textContent = Array.isArray(data.instance_ids) ? `${data.instance_ids.length}` : '—';
    overlay.classList.add('open');
}

// Called when user clicks "▶ Start Listening" — provides the user gesture for AudioContext
function followerJoinStart() {
    const overlay = document.getElementById('followerJoinOverlay');
    if (overlay) overlay.classList.remove('open');
    if (_pendingFollowerData) {
        _startFollowerSession(_pendingFollowerData);
        _pendingFollowerData = null;
    }
}

// Called when user clicks "Cancel"
function followerJoinCancel() {
    const overlay = document.getElementById('followerJoinOverlay');
    if (overlay) overlay.classList.remove('open');
    exitFollowerMode();
}

function _startFollowerSession(data) {
    const monitoringStarted = _applySharedState(data, true) || Promise.resolve();
    _showFollowerBanner(data);
    // Check relay capacity before connecting
    if (data.max_followers > 0 && data.follower_count >= data.max_followers) {
        if (typeof showToast === 'function') {
            showToast(`⚠️ This session is full — the maximum number of listeners (${data.max_followers}) has been reached.`, 'warn', 10000);
        }
        return;
    }
    if (_followerRelay) {
        _followerRelay.disconnect();
    }
    // Connect the relay only once the monitor grid is ready: the server sends a
    // fresh session_state on connect, and applying it (including auto-opening
    // Smart Listen) needs the tiles and snrHistory buffers to exist.
    monitoringStarted.catch(() => {}).then(() => {
        _followerRelay = new FollowerRelay(sharedSessionId);
        _followerRelay.connect();
    });
}

function _showFollowerBanner(data) {
    const banner = document.getElementById('followerBanner');
    if (!banner) return;
    const nameEl = document.getElementById('followerBannerName');
    const freqEl = document.getElementById('followerBannerFreq');
    if (nameEl) nameEl.textContent = data.name || data.share_id;
    if (freqEl) freqEl.textContent = `· ${(data.freq_hz / 1e6).toFixed(3)} MHz · ${(data.mode || '').toUpperCase()}`;
    banner.classList.add('visible');
}

function _updateFollowerBanner(data) {
    const freqEl = document.getElementById('followerBannerFreq');
    if (freqEl) freqEl.textContent = `· ${(data.freq_hz / 1e6).toFixed(3)} MHz · ${(data.mode || '').toUpperCase()}`;
}

function exitFollowerMode() {
    isFollowerMode = false;
    document.body.classList.remove('follower-locked');
    const banner = document.getElementById('followerBanner');
    if (banner) banner.classList.remove('visible');
    const ended = document.getElementById('shareEndedOverlay');
    if (ended) ended.classList.remove('open');
    _disconnectSSE();
    if (_followerRelay) {
        _followerRelay.disconnect();
        _followerRelay = null;
    }
    _hideRelayListenerBadge();
    const params = new URLSearchParams(location.search);
    params.delete('share');
    const qs = params.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
    // Return to selection phase if currently in monitor view
    const monitorPhase = document.getElementById('phase-monitor');
    if (monitorPhase && monitorPhase.style.display !== 'none' &&
        typeof stopMonitoring === 'function') {
        stopMonitoring();
    }
}

function _showShareEnded() {
    const overlay = document.getElementById('shareEndedOverlay');
    if (overlay) overlay.classList.add('open');
}

// --------------- Apply shared state (follower) ---------------
function _applySharedState(data, initial = false) {
    if (!data) return null;
    if (data.version !== undefined && data.version <= sharedSessionVersion && !initial) return null;
    // Don't record the version on the initial (page-load GET) apply: that snapshot
    // may be stale by the time the user clicks "Start Listening". Leaving the
    // version at 0 guarantees the fresh session_state the relay sends on connect
    // (version >= 1) is always applied, including the Smart Listen state.
    if (!initial) sharedSessionVersion = data.version || 0;

    // Apply modality first (so resolveMode uses the right modality)
    if (data.modality && data.modality !== modality) {
        setModality(data.modality);
    }

    // Detect if mode_override changed
    const prevModeOverride = modeOverride;
    if (data.mode_override !== undefined) {
        modeOverride = data.mode_override || null;
        if (typeof syncNRUI === 'function') syncNRUI();
    }
    const modeChanged = modeOverride !== prevModeOverride;

    // Apply frequency — use the freq input + dispatch 'input' event to trigger
    // the existing applyFreq() machinery (updates display, mode indicator, retunes radios)
    // Also trigger if only mode changed (same freq) so the mode indicator and radios update
    if (data.freq_hz && (data.freq_hz !== currentFreqHz || modeChanged)) {
        const mhz = data.freq_hz / 1e6;
        const slider = document.getElementById('freqSlider');
        const input  = document.getElementById('freqInput');
        if (slider) slider.value = mhz.toFixed(6);  // slider is in MHz
        if (input) {
            input.value = mhz.toFixed(6);
            // Dispatch input event to trigger applyFreq() in setupFrequencyControls()
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    // Sync Smart Listen modal open/close with the host. Skipped on the initial
    // (page-load GET) apply — monitoring hasn't started yet and the snapshot may
    // be stale. The relay sends a fresh session_state right after connecting,
    // once the monitor grid is ready (see _startFollowerSession), and that
    // message performs the initial open here.
    if (!initial && data.smart_listen_open !== undefined) {
        const isOpen = document.getElementById('snrModalOverlay')?.classList.contains('open') || false;
        if (data.smart_listen_open && !isOpen && typeof openSnrHistoryModal === 'function') {
            openSnrHistoryModal();
        } else if (!data.smart_listen_open && isOpen && typeof closeSnrHistoryModal === 'function') {
            closeSnrHistoryModal();
        }
    }

    // Apply channel assignments (only if not initial — on initial, follower chooses their own)
    if (!initial) {
        _applyChannelAssignments(data.left_channel_id || null, data.right_channel_id || null);
    }

    // On initial load: select instances and start monitoring
    let monitoringStarted = null;
    if (initial && Array.isArray(data.instance_ids) && data.instance_ids.length > 0) {
        selectedIds = new Set(data.instance_ids);
        // Followers use relay-based monitoring (no direct SDR connections)
        if (isFollowerMode && typeof startMonitoringFollower === 'function') {
            monitoringStarted = startMonitoringFollower();
        } else if (typeof startMonitoring === 'function') {
            startMonitoring();
        }
    }

    _updateFollowerBanner(data);
    return monitoringStarted;
}

function _applyChannelAssignments(newLeftId, newRightId) {
    if (typeof assignChannel !== 'function' || typeof removeFromChannel !== 'function') return;

    const curLeft  = (typeof leftChannelId  !== 'undefined') ? leftChannelId  : null;
    const curRight = (typeof rightChannelId !== 'undefined') ? rightChannelId : null;

    // In follower mode activeRadios is empty so getActiveRadioPanValue() always returns null.
    // Use followerPanMap (maintained by assignChannel in follower mode) for pan checks instead.
    const isFollower = typeof isFollowerMode !== 'undefined' && isFollowerMode;
    function _getPan(id) {
        if (isFollower) {
            return (typeof followerPanMap !== 'undefined') ? (followerPanMap.get(id) ?? null) : null;
        }
        return (typeof getActiveRadioPanValue === 'function') ? getActiveRadioPanValue(id) : null;
    }

    // "both" mode is encoded as newLeftId === newRightId (same non-null value)
    if (newLeftId && newRightId && newLeftId === newRightId) {
        // Only call assignChannel if not already in both mode
        const alreadyBoth = curLeft === newLeftId && curRight === null && _getPan(newLeftId) === 0;
        if (!alreadyBoth) assignChannel(newLeftId, 'both');
        return;
    }

    // Mute instances that were playing but are no longer in either slot
    [curLeft, curRight].forEach(id => {
        if (id && id !== newLeftId && id !== newRightId) {
            removeFromChannel(id);
        }
    });

    // Apply new assignments — but ONLY if the instance isn't already correctly assigned
    // (assignChannel has toggle behaviour: calling it again removes the assignment)
    if (newLeftId) {
        const alreadyLeft = curLeft === newLeftId && _getPan(newLeftId) === -1;
        if (!alreadyLeft) assignChannel(newLeftId, 'left');
    }
    if (newRightId) {
        const alreadyRight = curRight === newRightId && _getPan(newRightId) === 1;
        if (!alreadyRight) assignChannel(newRightId, 'right');
    }
}

// --------------- SSE connection ---------------
function _connectSSE(shareId) {
    _disconnectSSE();
    _sseFails = 0;
    _openSSE(shareId);
}

function _openSSE(shareId) {
    const sse = new EventSource(`/api/shared-sessions/${shareId}/events`);
    sharedSessionSSE = sse;

    sse.onmessage = (e) => {
        _sseFails = 0;
        try {
            const data = JSON.parse(e.data);
            _applySharedState(data);
        } catch (err) { /* ignore parse errors */ }
    };

    sse.addEventListener('deleted', () => {
        _disconnectSSE();
        _showShareEnded();
    });

    sse.onerror = () => {
        _sseFails++;
        sse.close();
        sharedSessionSSE = null;
        if (_sseFails >= 3) {
            console.warn('[Share] SSE failed 3 times, falling back to polling');
            _startPolling(shareId);
        } else {
            setTimeout(() => _openSSE(shareId), 3000);
        }
    };
}

function _disconnectSSE() {
    if (sharedSessionSSE) {
        sharedSessionSSE.close();
        sharedSessionSSE = null;
    }
    _stopPolling();
}

// --------------- Fallback polling ---------------
function _startPolling(shareId) {
    _stopPolling();
    sharedSessionPollTimer = setInterval(async () => {
        try {
            const resp = await fetch(`/api/shared-sessions/${shareId}`);
            if (!resp.ok) { _showShareEnded(); _stopPolling(); return; }
            const data = await resp.json();
            _applySharedState(data);
        } catch (e) { /* ignore */ }
    }, 5000);
}

function _stopPolling() {
    if (sharedSessionPollTimer) {
        clearInterval(sharedSessionPollTimer);
        sharedSessionPollTimer = null;
    }
}

// --------------- Init on page load ---------------
document.addEventListener('DOMContentLoaded', () => {
    _initFollowerMode();
});

// ============================================================
// RelayUpstream — owner-side WebSocket relay connection
// Sends binary audio frames to the collector relay hub so
// followers can receive them without connecting to SDR instances.
// ============================================================

class RelayUpstream {
    constructor(shareId, ownerKey) {
        this.shareId    = shareId;
        this.ownerKey   = ownerKey;
        this.ws         = null;
        this.streamIndex = new Map(); // instanceId → uint8 stream index
        this._reconnectTimer = null;
        this._closed    = false;
    }

    connect() {
        if (this._closed) return;
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${proto}//${location.host}/api/shared-sessions/${this.shareId}/relay?role=owner&owner_key=${encodeURIComponent(this.ownerKey)}`;
        let opened = false;
        try {
            this.ws = new WebSocket(url);
            this.ws.binaryType = 'arraybuffer';
        } catch (e) {
            this._scheduleReconnect();
            return;
        }

        this.ws.onopen = () => {
            opened = true;
            console.log('[Relay] Owner connected');
        };

        this.ws.onmessage = (e) => {
            if (typeof e.data !== 'string') return;
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'ping') {
                    // Respond to server keepalive ping with pong
                    try { this.ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {}
                } else if (msg.type === 'relay_state') {
                    // Server sends stream index mapping — use these exact indices
                    // so our binary frames match what followers expect
                    this.streamIndex.clear();
                    const streams = msg.streams || [];
                    for (const s of streams) {
                        this.streamIndex.set(s.instance_id, s.index);
                    }
                    console.log('[Relay] Owner received stream map:', Object.fromEntries(this.streamIndex));
                } else if (msg.type === 'follower_count') {
                    _updateRelayListenerBadge(msg.count);
                }
            } catch (_) {}
        };

        this.ws.onclose = (event) => {
            this.ws = null;
            if (!opened && !this._closed) {
                // Connection was rejected before opening (e.g. 403 from proxy)
                // Don't reconnect — the relay endpoint is unavailable
                console.warn(`[Relay] Owner connection rejected (code ${event.code}) — relay unavailable, stopping`);
                this._closed = true;
                // Stop sharing and close the modal so the UI doesn't show an active share
                if (typeof _stopSharingCore === 'function') {
                    _stopSharingCore();
                } else if (typeof _clearShareState === 'function') {
                    _clearShareState();
                    if (typeof closeShareModal === 'function') closeShareModal();
                }
                // Notify the user
                if (typeof showToast === 'function') {
                    showToast('⚠️ Relay unavailable — sharing could not be started. Please try again later.', 'error', 8000);
                }
                return;
            }
            if (!this._closed) this._scheduleReconnect();
        };

        this.ws.onerror = () => {
            // onclose will fire after onerror — reconnect handled there
        };
    }

    disconnect() {
        this._closed = true;
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (this.ws) { this.ws.close(); this.ws = null; }
    }

    _scheduleReconnect() {
        if (this._closed) return;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.connect();
        }, 3000);
    }

    // Called by multi_monitor.js onAudioFrame callback for each MinimalRadio.
    // Builds the 14-byte relay header and sends the frame to the server.
    sendAudio(instanceId, sampleRate, channels, basebandPower, noiseDensity, opusBytes) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        // Wait for relay_state from server before sending — drop frames until
        // we have the server-assigned stream index map
        if (!this.streamIndex.has(instanceId)) return;
        const idx = this.streamIndex.get(instanceId);

        // Build 14-byte header + opus payload
        const buf = new ArrayBuffer(14 + opusBytes.byteLength);
        const view = new DataView(buf);
        view.setUint8(0, idx);
        view.setUint32(1, sampleRate, true);       // 4 bytes LE
        view.setUint8(5, channels);                // 1 byte
        view.setFloat32(6, basebandPower, true);   // 4 bytes LE
        view.setFloat32(10, noiseDensity, true);   // 4 bytes LE
        new Uint8Array(buf, 14).set(opusBytes);

        try {
            this.ws.send(buf);
        } catch (_) {}
    }
}

// ============================================================
// Relay listener badge helpers
// ============================================================

function _updateRelayListenerBadge(count) {
    const badge   = document.getElementById('relayListenerBadge');
    const countEl = document.getElementById('relayListenerCount');
    if (!badge || !countEl) return;
    countEl.textContent = count;
    badge.style.display = 'flex';
}

function _hideRelayListenerBadge() {
    const badge = document.getElementById('relayListenerBadge');
    if (badge) badge.style.display = 'none';
}

// ============================================================
// FollowerRelay — follower-side WebSocket relay connection
// Receives binary audio frames + JSON control messages from
// the collector relay hub. Replaces SSE for followers.
// ============================================================

class FollowerRelay {
    constructor(shareId) {
        this.shareId    = shareId;
        this.ws         = null;
        this.players    = new Map();   // instanceId → FollowerAudioPlayer
        this.streamMap  = new Map();   // stream_index (uint8) → instanceId string
        this._reconnectTimer = null;
        this._closed    = false;
        this._audioCtx  = null;
    }

    connect() {
        if (this._closed) return;
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const relayPath = `/api/shared-sessions/${this.shareId}/relay?role=follower`;
        const url = `${proto}//${location.host}${relayPath}`;
        let opened = false;
        try {
            this.ws = new WebSocket(url);
            this.ws.binaryType = 'arraybuffer';
        } catch (e) {
            this._scheduleReconnect();
            return;
        }

        this.ws.onopen = () => {
            opened = true;
            console.log('[Relay] Follower connected');
        };

        this.ws.onmessage = (e) => this._handleMessage(e);

        this.ws.onclose = (event) => {
            this.ws = null;
            if (!opened && !this._closed) {
                // Connection rejected before opening (e.g. 403 from proxy or relay disabled)
                console.warn(`[Relay] Follower connection rejected (code ${event.code}) — relay unavailable`);
                this._closed = true;
                if (typeof updateRelayTileOwnerState === 'function') {
                    const ids = Array.from(typeof selectedIds !== 'undefined' ? selectedIds : []);
                    updateRelayTileOwnerState(false, ids);
                }
                if (typeof showToast === 'function') {
                    showToast('⚠️ Relay unavailable — signal and audio relay could not connect.', 'warn', 8000);
                }
                return;
            }
            if (!this._closed) this._scheduleReconnect();
        };

        this.ws.onerror = () => {};
    }

    disconnect() {
        this._closed = true;
        if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
        if (this.ws) { this.ws.close(); this.ws = null; }
        this.players.forEach(p => p.stop());
        this.players.clear();
        _hideRelayListenerBadge();
    }

    _scheduleReconnect() {
        if (this._closed) return;
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this.connect();
        }, 3000);
    }

    _handleMessage(event) {
        if (typeof event.data === 'string') {
            let msg;
            try { msg = JSON.parse(event.data); } catch (_) { return; }
            switch (msg.type) {
                case 'ping':
                    // Respond to server keepalive ping with pong
                    try { if (this.ws) this.ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {}
                    break;
                case 'relay_state':
                    this._handleRelayState(msg);
                    break;
                case 'session_state':
                    // Replaces SSE: freq/mode/channel sync from owner updates
                    _applySharedState(msg);
                    break;
                case 'session_deleted':
                    // Replaces SSE 'deleted' event
                    _showShareEnded();
                    break;
                case 'follower_count':
                    _updateRelayListenerBadge(msg.count);
                    break;
            }
        } else {
            this._handleBinaryFrame(event.data);
        }
    }

    _handleRelayState(msg) {
        // Rebuild stream index map
        this.streamMap.clear();
        const streams = msg.streams || [];
        for (const s of streams) {
            this.streamMap.set(s.index, s.instance_id);
        }

        // Update tile states based on owner_connected
        if (typeof updateRelayTileOwnerState === 'function') {
            updateRelayTileOwnerState(msg.owner_connected, streams.map(s => s.instance_id));
        }
    }

    _handleBinaryFrame(data) {
        // Parse 14-byte relay header:
        // [1: stream_index][4: sampleRate LE][1: channels][4: bp LE][4: nd LE][N: opus]
        if (data.byteLength < 14) return;
        const view = new DataView(data);
        const streamIndex    = view.getUint8(0);
        const sampleRate     = view.getUint32(1, true);
        const channels       = view.getUint8(5);
        const basebandPower  = view.getFloat32(6, true);
        const noiseDensity   = view.getFloat32(10, true);
        const opusBytes      = new Uint8Array(data, 14);

        const instanceId = this.streamMap.get(streamIndex);
        if (!instanceId) return;

        // Compute SNR and update signal bar + SNR history chart
        const snr = (basebandPower > -900 && noiseDensity > -900)
            ? basebandPower - noiseDensity
            : null;
        if (typeof updateMeterTileSignal === 'function') {
            updateMeterTileSignal(instanceId, basebandPower, noiseDensity, snr);
        }

        // Route audio to the player for this instance
        let player = this.players.get(instanceId);
        if (!player) {
            if (!this._audioCtx) {
                try { this._audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' }); } catch (_) { return; }
            }
            player = new FollowerAudioPlayer(instanceId, this._audioCtx);
            this.players.set(instanceId, player);
        }
        player.feedFrame(sampleRate, channels, opusBytes);
    }

    // Called by multi_monitor.js when channel assignment changes for a follower tile
    setInstancePan(instanceId, pan) {
        const player = this.players.get(instanceId);
        if (player) player.setPan(pan);
    }

    setVolume(volume) {
        this.players.forEach(p => p.setVolume(volume));
    }
}

// ============================================================
// FollowerAudioPlayer — stripped-down audio player for relay
// Receives pre-parsed Opus frames and plays them via Web Audio.
// ============================================================

class FollowerAudioPlayer {
    constructor(instanceId, audioContext) {
        this.instanceId   = instanceId;
        this.audioContext = audioContext;
        this.opusDecoder  = null;
        this._decoderSampleRate = null;
        this._decoderChannels   = null;
        this.nextPlayTime = 0;
        this._gainNode    = null;
        this._panNode     = null;
        this._stopped     = false;
        this._initAudioGraph();
    }

    _initAudioGraph() {
        try {
            this._gainNode = this.audioContext.createGain();
            this._gainNode.gain.value = 1.0;
            this._panNode  = this.audioContext.createStereoPanner();
            this._panNode.pan.value = 0;
            this._gainNode.connect(this._panNode);
            this._panNode.connect(this.audioContext.destination);
        } catch (e) {
            console.error('[FollowerAudio] Failed to init audio graph:', e);
        }
    }

    async feedFrame(sampleRate, channels, opusBytes) {
        if (this._stopped) return;
        try {
            // (Re)initialize decoder if sample rate or channels changed
            if (!this.opusDecoder ||
                this._decoderSampleRate !== sampleRate ||
                this._decoderChannels   !== channels) {
                await this._initDecoder(sampleRate, channels);
            }
            if (!this.opusDecoder) return;

            const decoded = await this.opusDecoder.decodeFrame(opusBytes);
            if (!decoded || !decoded.channelData || decoded.channelData[0].length === 0) return;

            const numCh = Math.max(2, decoded.channelData.length);
            const buf = this.audioContext.createBuffer(numCh, decoded.channelData[0].length, sampleRate);
            if (decoded.channelData.length === 1) {
                buf.getChannelData(0).set(decoded.channelData[0]);
                buf.getChannelData(1).set(decoded.channelData[0]);
            } else {
                for (let ch = 0; ch < Math.min(decoded.channelData.length, 2); ch++) {
                    buf.getChannelData(ch).set(decoded.channelData[ch]);
                }
            }

            const src = this.audioContext.createBufferSource();
            src.buffer = buf;
            src.connect(this._gainNode);

            const now = this.audioContext.currentTime;
            // Reset if behind real-time OR if queue has grown more than 0.5s ahead
            // (prevents slow playback after burst of frames on reconnect)
            if (this.nextPlayTime < now || this.nextPlayTime > now + 0.5) {
                this.nextPlayTime = now + 0.05;
            }
            src.start(this.nextPlayTime);
            this.nextPlayTime += buf.duration;
        } catch (e) {
            console.error('[FollowerAudio] feedFrame error:', e);
        }
    }

    async _initDecoder(sampleRate, channels) {
        try {
            // Use the same OpusDecoder lookup as MinimalRadio.initOpusDecoder()
            let OpusDecoderClass = null;
            if (typeof OpusDecoder !== 'undefined') {
                OpusDecoderClass = OpusDecoder;
            } else if (window['opus-decoder'] && window['opus-decoder'].OpusDecoder) {
                OpusDecoderClass = window['opus-decoder'].OpusDecoder;
            } else if (window.OpusDecoder) {
                OpusDecoderClass = window.OpusDecoder;
            }
            if (!OpusDecoderClass) { console.error('[FollowerAudio] OpusDecoder not available', sampleRate); return; }
            if (this.opusDecoder) {
                try { await this.opusDecoder.free(); } catch (_) {}
            }
            this.opusDecoder = new OpusDecoderClass({ sampleRate, channels });
            await this.opusDecoder.ready;
            this._decoderSampleRate = sampleRate;
            this._decoderChannels   = channels;
        } catch (e) {
            console.error('[FollowerAudio] Decoder init error:', e);
            this.opusDecoder = null;
        }
    }

    setPan(value) {
        // value: -1 = left, 0 = both, 1 = right
        if (this._panNode) this._panNode.pan.value = value;
    }

    setVolume(v) {
        if (this._gainNode) this._gainNode.gain.value = Math.max(0, Math.min(1, v));
    }

    stop() {
        this._stopped = true;
        if (this.opusDecoder) {
            try { this.opusDecoder.free(); } catch (_) {}
            this.opusDecoder = null;
        }
        try {
            if (this._gainNode) this._gainNode.disconnect();
            if (this._panNode)  this._panNode.disconnect();
        } catch (_) {}
    }
}
