/**
 * UberSDR Control Panel UI
 * Dual-purpose collapsible panel on the left edge of the main page.
 * Supports rotator control (azimuthal map + compass) and/or antenna switch.
 * Requires: rotator-display.js when rotator is enabled.
 */

class RotatorUI {
    /**
     * @param {object} opts
     * @param {boolean} [opts.rotatorEnabled=true]
     * @param {boolean} [opts.antSwitchEnabled=false]
     */
    constructor(opts = {}) {
        // Feature flags
        this.rotatorEnabled   = opts.rotatorEnabled   !== false; // default true for back-compat
        this.antSwitchEnabled = !!opts.antSwitchEnabled;

        // ── Rotator state ──────────────────────────────────────────────────
        this.isExpanded = false;
        this.rotatorDisplay = null;
        this.statusUpdateTimer = null;
        this.countriesData = [];
        this.savedPassword = localStorage.getItem('rotctl_password') || '';
        this.selectedCountry = null;

        // ── Ant switch state ───────────────────────────────────────────────
        this.antSwitchStatus    = null;   // last fetched status object
        this.antSwitchPassword  = localStorage.getItem('ant_switch_password') || '';
        this.antSwitchReadOnly  = false;  // set true after confirmed 401 with no server password
        this.antSwitchPollTimer = null;
        this.antSwitchPendingAnt = null;  // antenna number awaiting password entry
        this.antHistoryPage     = 0;      // current history page (0-based)
        this.antHistoryEntries  = [];     // cached history entries

        // ── Notification tracking ──────────────────────────────────────────
        this.lastMoving         = false;  // previous rotator moving state
        this.lastAntSelected    = null;   // JSON-serialised last selected array
        this.lastAntGrounded    = null;   // last grounded boolean (null = uninitialised)

        // ── Active inner tab: 'rotator' | 'antswitch' ─────────────────────
        this.activeTab = localStorage.getItem('control_panel_tab') ||
            (this.rotatorEnabled ? 'rotator' : 'antswitch');

        // Load saved expanded state
        const savedState = localStorage.getItem('ubersdr_rotator_expanded');
        this.isExpanded = savedState === 'true';

        this.createRotatorPanel();
        this.setupEventHandlers();

        // Start fetching status immediately for collapsed tab display
        this.startStatusUpdates();
    }
    
    /**
     * Start periodic status updates for the collapsed tab.
     * Rotator: 1 s (bearing display). Ant switch: handled by startAntSwitchPoll().
     */
    startStatusUpdates() {
        if (this.rotatorEnabled) {
            this.fetchRotatorStatus();
            this.statusUpdateTimer = setInterval(() => this.fetchRotatorStatus(), 1000);
        }
        if (this.antSwitchEnabled) {
            // 30 s when collapsed; will be sped up to 5 s when expanded on ant switch tab
            this.startAntSwitchPoll(30000);
        }
    }

    /**
     * Stop periodic status updates
     */
    stopStatusUpdates() {
        if (this.statusUpdateTimer) {
            clearInterval(this.statusUpdateTimer);
            this.statusUpdateTimer = null;
        }
        this.stopAntSwitchPoll();
    }
    
    /**
     * Create the panel HTML and inject into page.
     * Supports rotator-only, ant-switch-only, or both (dual-tab).
     */
    createRotatorPanel() {
        const hasBoth = this.rotatorEnabled && this.antSwitchEnabled;
        const collapsed = !this.isExpanded;

        // ── Inner tab bar (only when both features are enabled) ────────────
        const tabBar = hasBoth ? `
                <div id="cp-tab-bar" class="cp-tab-bar">
                    <button class="cp-tab-btn${this.activeTab === 'rotator'   ? ' active' : ''}"
                            onclick="rotatorUI.switchTab('rotator')">🧭 Rotator</button>
                    <button class="cp-tab-btn${this.activeTab === 'antswitch' ? ' active' : ''}"
                            onclick="rotatorUI.switchTab('antswitch')">📡 Antenna</button>
                </div>` : '';

        // ── Rotator pane ───────────────────────────────────────────────────
        const rotatorPane = this.rotatorEnabled ? `
                <div id="cp-rotator-pane" class="cp-pane"
                     style="display:${(!hasBoth || this.activeTab === 'rotator') ? 'flex' : 'none'};flex-direction:column;align-items:center;position:relative;width:100%;height:100%;">
                    <div id="rotator-display-container" class="rotator-display-container">
                        <div id="rotator-location-display" class="rotator-location-display">Loading...</div>
                        <div id="rotator-azimuth-display" class="rotator-azimuth-display">0°</div>
                        <div id="rotator-status-indicator" class="rotator-status-indicator disconnected"></div>
                        <button id="rotator-controls-button" class="rotator-controls-button" onclick="rotatorUI.openControls()">Controls</button>
                    </div>
                </div>` : '';

        // ── Ant switch pane ────────────────────────────────────────────────
        const antPane = this.antSwitchEnabled ? `
                <div id="cp-antswitch-pane" class="cp-pane"
                     style="display:${(!hasBoth || this.activeTab === 'antswitch') ? 'flex' : 'none'};flex-direction:column;width:100%;height:100%;overflow:hidden;">
                    <div class="cp-ant-inner">
                        <div id="cp-ant-banner" class="cp-ant-banner" style="display:none;"></div>
                        <div id="cp-ant-buttons" class="cp-ant-buttons"></div>
                        <div class="cp-ant-ground-row">
                            <button id="cp-ant-ground-btn" class="cp-ant-ground-btn"
                                    onclick="rotatorUI.onGroundClick()">⏚ Ground all</button>
                            <button class="cp-ant-controls-button" onclick="rotatorUI.openSwitchControls()">Controls</button>
                        </div>
                        <div id="cp-ant-password-row" class="cp-ant-password-row" style="display:none;">
                            <input id="cp-ant-password-input" type="password" placeholder="Password…"
                                   class="cp-ant-password-input"
                                   onkeydown="if(event.key==='Enter')rotatorUI.confirmAntPassword()"/>
                            <button class="cp-ant-password-confirm"
                                    onclick="rotatorUI.confirmAntPassword()">✓</button>
                            <span id="cp-ant-password-error" class="cp-ant-password-error"></span>
                        </div>
                        <div class="cp-ant-status-row">
                            <span id="cp-ant-status-text" class="cp-ant-status-text">Loading...</span>
                        </div>
                        <div class="cp-ant-history-section">
                            <div class="cp-ant-history-header">
                                <span class="cp-ant-history-title">📋 History</span>
                                <div class="cp-ant-history-nav">
                                    <button class="cp-ant-history-btn" id="cp-ant-hist-prev"
                                            onclick="rotatorUI.antHistoryPage--; rotatorUI.renderAntHistory()">‹</button>
                                    <span id="cp-ant-hist-page" class="cp-ant-hist-page">1/1</span>
                                    <button class="cp-ant-history-btn" id="cp-ant-hist-next"
                                            onclick="rotatorUI.antHistoryPage++; rotatorUI.renderAntHistory()">›</button>
                                </div>
                            </div>
                            <div id="cp-ant-history-list" class="cp-ant-history-list"></div>
                        </div>
                    </div>
                </div>` : '';

        // ── Collapsed tab strip content ────────────────────────────────────
        const rotTabContent = this.rotatorEnabled ? `
                        <span id="rotator-tab-bearing" class="rotator-tab-bearing">0°</span>
                        <span>🧭</span>
                        <span id="rotator-tab-status" class="rotator-tab-status disconnected"></span>` : '';

        const antTabContent = this.antSwitchEnabled ? `
                        <span id="cp-tab-ant-label" class="cp-tab-ant-label">📡</span>
                        <span id="cp-tab-ant-status" class="rotator-tab-status disconnected"></span>` : '';

        const rotatorHTML = `
            <div id="rotator-panel" class="rotator-panel ${this.isExpanded ? 'expanded' : 'collapsed'}">
                <!-- Left-edge tab strip (always visible) -->
                <div id="rotator-header" class="rotator-header" onclick="rotatorUI.togglePanel()">
                    <div id="cp-tab-collapsed"
                         style="display:${collapsed ? 'flex' : 'none'};flex-direction:column;align-items:center;gap:4px;">
                        ${rotTabContent}
                        ${antTabContent}
                    </div>
                    <span id="rotator-collapse-arrow" class="rotator-collapse-arrow"
                          style="display:${this.isExpanded ? 'block' : 'none'};">←</span>
                </div>

                <!-- Expandable content -->
                <div id="rotator-content" class="rotator-content" style="display:${this.isExpanded ? 'flex' : 'none'};">
                    ${tabBar}
                    <div class="cp-pane-wrapper">
                        ${rotatorPane}
                        ${antPane}
                    </div>
                </div>
            </div>
        `;

        // Inject CSS
        this.injectCSS();

        // Inject HTML before time display (bottom left)
        const timeDisplay = document.getElementById('time-display');
        if (timeDisplay && timeDisplay.parentNode) {
            timeDisplay.insertAdjacentHTML('beforebegin', rotatorHTML);
        } else {
            document.body.insertAdjacentHTML('beforeend', rotatorHTML);
        }

        // Lazy-init on load if already expanded
        if (this.isExpanded) {
            if (this.rotatorEnabled && this.activeTab === 'rotator') {
                this.initializeRotatorDisplay();
            }
            if (this.antSwitchEnabled) {
                this.startAntSwitchPoll(this.activeTab === 'antswitch' ? 5000 : 30000);
            }
        }
    }
    
    /**
     * Inject CSS styles for rotator panel
     */
    injectCSS() {
        const style = document.createElement('style');
        style.textContent = `
            .rotator-panel {
                position: fixed;
                bottom: 50px;
                left: 0;
                z-index: 900;
                font-family: Arial, sans-serif;
                font-size: 13px;
                display: flex;
                flex-direction: row;
                align-items: flex-end;
                transition: all 0.3s ease;
            }
            
            .rotator-panel.collapsed {
                width: 48px;
            }
            
            .rotator-panel.expanded {
                width: min(540px, 100vw);
                max-width: 100vw;
            }
            
            .rotator-header {
                width: 48px;
                min-height: 80px;
                padding: 8px 0;
                background: rgba(50, 50, 50, 0.92);
                color: #fff;
                cursor: pointer;
                user-select: none;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                gap: 4px;
                font-size: 20px;
                border: 1px solid rgba(100, 100, 100, 0.5);
                border-left: none;
                border-radius: 0 8px 8px 0;
                order: 1;
                flex-shrink: 0;
                position: relative;
                overflow: visible;
            }
            
            .rotator-tab-bearing {
                font-size: 11px;
                font-weight: 600;
                color: #fff;
                line-height: 1;
            }
            
            .rotator-tab-status {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                transition: background 0.3s, box-shadow 0.3s;
            }
            
            .rotator-tab-status.connected {
                background: #4CAF50;
                box-shadow: 0 0 6px #4CAF50;
            }
            
            .rotator-tab-status.disconnected {
                background: #f44336;
                box-shadow: 0 0 6px #f44336;
            }
            
            /* Flashing animation for moving state */
            @keyframes flash {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.3; }
            }

            .rotator-tab-status.moving,
            .rotator-status-indicator.moving {
                animation: flash 1s infinite;
            }

            .rotator-header:hover {
                background: rgba(70, 70, 70, 0.95);
            }
            
            .rotator-collapse-arrow {
                font-size: 20px;
                color: #fff;
                font-weight: bold;
                pointer-events: none;
            }

            /* Ant switch label on collapsed tab */
            .cp-tab-ant-label {
                font-size: 10px;
                font-weight: 600;
                color: #ccc;
                line-height: 1.2;
                max-width: 44px;
                white-space: normal;
                overflow-wrap: break-word;
                word-break: normal;
                text-align: center;
                overflow: hidden;
                display: block;
            }

            /* Inner tab bar — browser-style tabs */
            .cp-tab-bar {
                display: flex;
                flex-direction: row;
                align-items: flex-end;
                background: rgba(20,20,20,0.95);
                border-bottom: 2px solid rgba(80,80,80,0.6);
                flex-shrink: 0;
                padding: 0 4px;
                gap: 2px;
            }
            .cp-tab-btn {
                -webkit-appearance: none;
                appearance: none;
                padding: 7px 16px;
                background: rgba(35,35,35,0.9);
                color: #777;
                border: 1px solid rgba(80,80,80,0.5);
                border-bottom: none;
                border-radius: 6px 6px 0 0;
                cursor: pointer;
                font-size: 12px;
                font-family: inherit;
                font-weight: 600;
                outline: none;
                transition: color 0.15s, background 0.15s;
                position: relative;
                bottom: -2px;
            }
            .cp-tab-btn:hover:not(.active) {
                color: #bbb;
                background: rgba(50,50,50,0.9);
            }
            .cp-tab-btn.active {
                color: #fff;
                background: rgba(40,40,40,0.85);
                border-color: rgba(100,100,100,0.6);
                border-bottom: 2px solid rgba(40,40,40,0.85);
                z-index: 1;
            }

            /* Pane wrapper fills remaining height */
            .cp-pane-wrapper {
                flex: 1;
                overflow: hidden;
                position: relative;
            }
            .cp-pane {
                position: absolute;
                inset: 0;
            }

            .rotator-content {
                width: min(500px, calc(100vw - 48px));
                max-width: 100%;
                height: 500px;
                background: rgba(40, 40, 40, 0.92);
                border: 1px solid rgba(100, 100, 100, 0.6);
                border-left: none;
                border-radius: 0 8px 8px 0;
                order: 2;
                flex-shrink: 0;
                overflow: hidden;
                display: flex;
                flex-direction: column;
            }

            /* ── Ant switch pane ──────────────────────────────────────── */
            .cp-ant-inner {
                display: flex;
                flex-direction: column;
                gap: 10px;
                padding: 14px 12px;
                height: 100%;
                box-sizing: border-box;
                overflow-y: auto;
            }
            .cp-ant-banner {
                padding: 8px 12px;
                border-radius: 6px;
                font-size: 13px;
                font-weight: 600;
                text-align: center;
            }
            .cp-ant-banner.thunderstorm {
                background: rgba(255,152,0,0.2);
                border: 1px solid rgba(255,152,0,0.6);
                color: #ffb74d;
            }
            .cp-ant-banner.readonly {
                background: rgba(100,100,100,0.15);
                border: 1px solid rgba(150,150,150,0.4);
                color: #aaa;
            }
            .cp-ant-buttons {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
                gap: 8px;
            }
            .cp-ant-btn {
                -webkit-appearance: none;
                appearance: none;
                padding: 10px 6px;
                border-radius: 6px;
                border: 1px solid rgba(100,100,100,0.5);
                background: rgba(55,55,55,0.9);
                color: #bbb;
                font-size: 12px;
                font-family: inherit;
                font-weight: 600;
                cursor: pointer;
                text-align: center;
                outline: none;
                transition: background 0.15s, border-color 0.15s, color 0.15s;
                line-height: 1.3;
                word-break: break-word;
            }
            .cp-ant-btn:hover:not(:disabled) {
                background: rgba(70,70,70,0.9);
                border-color: rgba(150,150,150,0.6);
                color: #fff;
            }
            .cp-ant-btn.selected {
                background: #1b5e20;
                border: 2px solid #66bb6a;
                color: #a5d6a7;
                font-weight: 700;
                box-shadow: inset 0 0 6px rgba(102,187,106,0.3);
            }
            .cp-ant-btn.selected:hover:not(:disabled) {
                background: #2e7d32;
                border-color: #81c784;
                color: #c8e6c9;
            }
            .cp-ant-btn:disabled { opacity: 0.35; cursor: not-allowed; }
            .cp-ant-ground-row { display: flex; justify-content: flex-end; align-items: center; gap: 6px; }
            .cp-ant-ground-btn {
                -webkit-appearance: none;
                appearance: none;
                padding: 8px 20px;
                border-radius: 6px;
                border: 1px solid rgba(120,120,120,0.4);
                background: rgba(55,55,55,0.9);
                color: #aaa;
                font-size: 13px;
                font-family: inherit;
                font-weight: 600;
                cursor: pointer;
                outline: none;
                transition: background 0.15s, border-color 0.15s, color 0.15s;
            }
            .cp-ant-ground-btn:hover:not(:disabled) {
                background: rgba(70,70,70,0.9);
                border-color: rgba(150,150,150,0.6);
                color: #fff;
            }
            .cp-ant-ground-btn:disabled { opacity: 0.35; cursor: not-allowed; }
            .cp-ant-ground-btn.selected {
                background: #4a1010;
                border: 2px solid #ef5350;
                color: #ef9a9a;
                font-weight: 700;
                box-shadow: inset 0 0 6px rgba(239,83,80,0.3);
            }
            .cp-ant-ground-btn.selected:hover:not(:disabled) {
                background: #6d1a1a;
                border-color: #ef9a9a;
                color: #ffcdd2;
            }
            .cp-ant-password-row {
                display: flex;
                align-items: center;
                gap: 6px;
                flex-wrap: wrap;
            }
            .cp-ant-password-input {
                flex: 1;
                min-width: 80px;
                padding: 6px 8px;
                border-radius: 5px;
                border: 1px solid rgba(100,100,100,0.5);
                background: rgba(30,30,30,0.8);
                color: #fff;
                font-size: 12px;
            }
            .cp-ant-password-input:focus {
                outline: none;
                border-color: rgba(76,175,80,0.7);
            }
            .cp-ant-password-confirm {
                padding: 6px 10px;
                border-radius: 5px;
                border: 1px solid rgba(76,175,80,0.5);
                background: rgba(76,175,80,0.3);
                color: #fff;
                cursor: pointer;
                font-size: 13px;
                font-weight: 700;
            }
            .cp-ant-password-confirm:hover { background: rgba(76,175,80,0.6); }
            .cp-ant-password-error { font-size: 11px; color: #ef9a9a; width: 100%; }
            .cp-ant-status-row {
                padding-top: 6px;
                border-top: 1px solid rgba(100,100,100,0.3);
            }
            .cp-ant-status-text { font-size: 11px; color: #888; }

            /* ── Ant switch history ───────────────────────────────────── */
            .cp-ant-history-section {
                margin-top: 8px;
                border-top: 1px solid rgba(100,100,100,0.3);
                padding-top: 8px;
            }
            .cp-ant-history-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 6px;
            }
            .cp-ant-history-title {
                font-size: 11px;
                font-weight: 600;
                color: #aaa;
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }
            .cp-ant-history-nav {
                display: flex;
                align-items: center;
                gap: 4px;
            }
            .cp-ant-history-btn {
                -webkit-appearance: none;
                appearance: none;
                padding: 2px 7px;
                border-radius: 4px;
                border: 1px solid rgba(100,100,100,0.4);
                background: rgba(50,50,50,0.8);
                color: #ccc;
                font-size: 13px;
                cursor: pointer;
                line-height: 1;
            }
            .cp-ant-history-btn:disabled { opacity: 0.3; cursor: default; }
            .cp-ant-hist-page { font-size: 11px; color: #888; min-width: 28px; text-align: center; }
            .cp-ant-history-list { display: flex; flex-direction: column; gap: 3px; }
            .cp-ant-history-row {
                display: flex;
                align-items: baseline;
                gap: 6px;
                font-size: 11px;
                padding: 3px 4px;
                border-radius: 4px;
                background: rgba(255,255,255,0.03);
            }
            .cp-ant-history-row:nth-child(even) { background: rgba(255,255,255,0.06); }
            .cp-ant-hist-time { color: #666; white-space: nowrap; flex-shrink: 0; }
            .cp-ant-hist-label { color: #ccc; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .cp-ant-hist-src { font-size: 10px; flex-shrink: 0; }
            .cp-ant-hist-src.admin { color: #ffb74d; }
            .cp-ant-hist-src.public { color: #90caf9; }
            .cp-ant-hist-src.startup { color: #81c784; }
            .cp-ant-hist-src.scheduler { color: #ce93d8; }
            .cp-ant-history-empty { font-size: 11px; color: #555; text-align: center; padding: 8px 0; }
            
            .rotator-display-container {
                width: 100%;
                height: 100%;
                padding: 0;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                align-items: center;
                position: relative;
            }
            
            /* Position compass overlay on top-left of map */
            #rotator-display-container-compass {
                position: absolute !important;
                top: 20px !important;
                left: 20px !important;
                z-index: 100 !important;
                margin: 0 !important;
            }
            
            /* Location display in top-center */
            .rotator-location-display {
                position: absolute;
                top: 10px;
                left: 50%;
                transform: translateX(-50%);
                padding: 6px 12px;
                background: rgba(0, 0, 0, 0.6);
                color: white;
                border-radius: 6px;
                font-size: 12px;
                font-weight: 500;
                z-index: 100;
                box-shadow: 0 2px 6px rgba(0,0,0,0.3);
                text-align: center;
                line-height: 1.4;
                max-width: 80%;
            }
            
            /* Azimuth display in top-right */
            .rotator-azimuth-display {
                position: absolute;
                top: 20px;
                right: 20px;
                padding: 8px 12px;
                background: rgba(0, 0, 0, 0.6);
                color: white;
                border-radius: 6px;
                font-size: 16px;
                font-weight: 600;
                z-index: 100;
                box-shadow: 0 2px 6px rgba(0,0,0,0.3);
                min-width: 50px;
                text-align: center;
            }
            
            /* Status indicator in bottom-right */
            .rotator-status-indicator {
                position: absolute;
                bottom: 15px;
                right: 15px;
                width: 12px;
                height: 12px;
                border-radius: 50%;
                z-index: 100;
                transition: background 0.3s, box-shadow 0.3s;
            }
            
            .rotator-status-indicator.connected {
                background: #4CAF50;
                box-shadow: 0 0 10px #4CAF50;
            }
            
            .rotator-status-indicator.disconnected {
                background: #f44336;
                box-shadow: 0 0 10px #f44336;
            }
            
            /* Controls button in bottom-left */
            .rotator-controls-button {
                position: absolute;
                bottom: 10px;
                left: 10px;
                padding: 8px 16px;
                background: rgba(76, 175, 80, 0.9);
                color: white;
                border: none;
                border-radius: 6px;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                z-index: 100;
                transition: all 0.2s;
                box-shadow: 0 2px 6px rgba(0,0,0,0.3);
            }
            
            .rotator-controls-button:hover {
                background: rgba(76, 175, 80, 1);
                transform: translateY(-1px);
                box-shadow: 0 3px 8px rgba(0,0,0,0.4);
            }
            
            .rotator-controls-button:active {
                transform: translateY(0);
            }

            /* Controls button for ant-switch pane — sits left of Ground All */
            .cp-ant-controls-button {
                padding: 8px 16px;
                background: rgba(76, 175, 80, 0.9);
                color: white;
                border: none;
                border-radius: 6px;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
                box-shadow: 0 2px 6px rgba(0,0,0,0.3);
                white-space: nowrap;
                flex-shrink: 0;
            }

            .cp-ant-controls-button:hover {
                background: rgba(76, 175, 80, 1);
                transform: translateY(-1px);
                box-shadow: 0 3px 8px rgba(0,0,0,0.4);
            }

            .cp-ant-controls-button:active {
                transform: translateY(0);
            }
            
            /* Mobile responsive styles */
            @media (max-width: 768px) {
                .rotator-panel.expanded {
                    width: 100vw;
                    left: 0;
                }

                .rotator-content {
                    width: calc(100vw - 40px);
                    height: 400px;
                }
            }
            
            @media (max-width: 480px) {
                .rotator-content {
                    height: 350px;
                }
            }
        `;
        document.head.appendChild(style);
    }
    
    /**
     * Set up DOM event handlers
     */
    setupEventHandlers() {
        // Panel toggle is handled via onclick in HTML

        // Listen for bearing commands from the callsign lookup popup.
        // The popup sends {type:'rotator_set_bearing', bearing:<number>} when the
        // user clicks "Set" — we execute the API call here so the password never
        // leaves the main page.
        window.addEventListener('message', (event) => {
            if (event.origin !== window.location.origin) return;
            if (!event.data) return;

            if (event.data.type === 'rotator_set_bearing') {
                const bearing = parseFloat(event.data.bearing);
                if (isNaN(bearing) || !this.savedPassword) return;
                fetch('/api/rotctl/position', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: this.savedPassword, azimuth: bearing })
                }).then(async r => {
                    const d = await r.json().catch(() => ({}));
                    if (!r.ok || !d.success) {
                        console.error('[RotatorUI] lookup set-bearing failed:', d.error || r.status);
                        if (r.status === 401 || (d.error && d.error.toLowerCase().includes('password'))) {
                            this.savedPassword = '';
                            localStorage.removeItem('rotctl_password');
                        }
                    }
                }).catch(err => console.error('[RotatorUI] lookup set-bearing network error:', err));
                return;
            }

            if (event.data.type === 'ant_switch_select') {
                const antenna = parseInt(event.data.antenna, 10);
                if (isNaN(antenna) || !this.antSwitchPassword) return;
                this._sendAntCommand({ command: 'select', antenna });
                return;
            }

            // Popup requests an immediate push of the current ant switch status
            // (sent when the popup first receives a callsign_lookup message, to
            // avoid waiting up to 30 s for the next poll cycle).
            if (event.data.type === 'request_ant_switch_status') {
                if (this.antSwitchEnabled && this.antSwitchStatus) {
                    const lw = window._callsignLookupWindow;
                    if (lw && !lw.closed) {
                        try {
                            lw.postMessage({
                                type:           'ant_switch_status',
                                enabled:        !!this.antSwitchStatus.enabled,
                                num_antennas:   this.antSwitchStatus.num_antennas || 0,
                                antenna_labels: this.antSwitchStatus.antenna_labels || [],
                                selected:       this.antSwitchStatus.selected || [],
                                grounded:       !!this.antSwitchStatus.grounded,
                                thunderstorm:   !!this.antSwitchStatus.thunderstorm,
                                hasPassword:    !!this.antSwitchPassword
                            }, window.location.origin);
                        } catch (_) {}
                    }
                }
                return;
            }
        });
    }
    
    /**
     * Toggle panel expanded/collapsed
     */
    togglePanel() {
        this.isExpanded = !this.isExpanded;
        const panel   = document.getElementById('rotator-panel');
        const content = document.getElementById('rotator-content');
        const arrow   = document.getElementById('rotator-collapse-arrow');
        const tabCol  = document.getElementById('cp-tab-collapsed');

        if (this.isExpanded) {
            panel.classList.remove('collapsed');
            panel.classList.add('expanded');
            content.style.display = 'flex';
            if (arrow)  arrow.style.display  = 'block';
            if (tabCol) tabCol.style.display  = 'none';

            // Lazy-init rotator display when first expanded
            if (this.rotatorEnabled && this.activeTab === 'rotator') {
                if (!this.rotatorDisplay) {
                    this.initializeRotatorDisplay();
                } else {
                    this.fetchRotatorStatus();
                }
            }
            // Start ant switch polling at appropriate rate
            if (this.antSwitchEnabled) {
                this.startAntSwitchPoll(this.activeTab === 'antswitch' ? 5000 : 30000);
            }
        } else {
            panel.classList.remove('expanded');
            panel.classList.add('collapsed');
            content.style.display = 'none';
            if (arrow)  arrow.style.display  = 'none';
            if (tabCol) tabCol.style.display  = 'flex';

            // Slow down ant switch poll when collapsed
            if (this.antSwitchEnabled) {
                this.startAntSwitchPoll(30000);
            }
        }

        localStorage.setItem('ubersdr_rotator_expanded', this.isExpanded.toString());
    }

    /**
     * Switch the active inner tab ('rotator' | 'antswitch').
     * Only relevant when both features are enabled.
     */
    switchTab(tab) {
        this.activeTab = tab;
        localStorage.setItem('control_panel_tab', tab);

        // Update tab button styles
        document.querySelectorAll('.cp-tab-btn').forEach(btn => {
            btn.classList.toggle('active',
                (tab === 'rotator'   && btn.textContent.includes('Rotator')) ||
                (tab === 'antswitch' && btn.textContent.includes('Antenna'))
            );
        });

        // Show/hide panes
        const rotPane = document.getElementById('cp-rotator-pane');
        const antPane = document.getElementById('cp-antswitch-pane');
        if (rotPane) rotPane.style.display = tab === 'rotator'   ? 'flex' : 'none';
        if (antPane) antPane.style.display = tab === 'antswitch' ? 'flex' : 'none';

        // Lazy-init rotator display when switching to it
        if (tab === 'rotator' && this.rotatorEnabled && !this.rotatorDisplay) {
            this.initializeRotatorDisplay();
        }

        // Adjust ant switch poll rate based on visibility
        if (this.antSwitchEnabled) {
            this.startAntSwitchPoll(tab === 'antswitch' ? 5000 : 30000);
        }
    }
    
    /**
     * Initialize the rotator display component
     */
    initializeRotatorDisplay() {
        if (typeof RotatorDisplay === 'undefined') {
            console.error('[RotatorUI] RotatorDisplay class not found. Make sure rotator-display.js is loaded.');
            return;
        }
        
        // Create rotator display with map and compass, no controls
        // Set updateInterval to 0 to disable automatic fetching - we'll update manually
        this.rotatorDisplay = new RotatorDisplay({
            containerId: 'rotator-display-container',
            showMap: true,
            showCompass: true,
            showControls: false,
            showPassword: false,
            mapSize: 500,
            compassSize: 150,
            updateInterval: 0  // Disable automatic updates, we handle them in rotator-ui.js
        });
        
        // Fetch and display location
        this.fetchReceiverLocation();
        
        // Fetch countries for cone markers
        this.fetchCountries();

        // Listen for rotator status updates from RotatorDisplay
        document.addEventListener('rotator-status-update', (event) => {
            this.handleStatusUpdate(event.detail);
        });
        
        // Listen for map click events from RotatorDisplay
        document.addEventListener('rotator-map-click', (event) => {
            this.handleMapClick(event.detail);
        });

        // Do an initial status fetch
        this.fetchRotatorStatus();
    }
    
    /**
     * Fetch rotator status and update displays
     */
    async fetchRotatorStatus() {
        try {
            const response = await fetch('/api/rotctl/status');
            const data = await response.json();
            this.handleStatusUpdate(data);
        } catch (error) {
            this.handleStatusUpdate({ connected: false });
        }
    }
    
    /**
     * Handle status update from RotatorDisplay or direct fetch
     */
    handleStatusUpdate(data) {
        // Update azimuth in expanded view
        if (data.position && data.position.azimuth !== undefined) {
            const azimuthElement = document.getElementById('rotator-azimuth-display');
            if (azimuthElement) {
                azimuthElement.textContent = Math.round(data.position.azimuth) + '°';
            }
            
            // Update bearing on collapsed tab button
            const tabBearing = document.getElementById('rotator-tab-bearing');
            if (tabBearing) {
                tabBearing.textContent = Math.round(data.position.azimuth) + '°';
            }

            // Manually update the rotator display azimuth
            if (this.rotatorDisplay) {
                this.rotatorDisplay.updateAzimuthDisplay(data.position.azimuth);
            }

            // Update cone markers to show countries in current beam direction
            if (this.rotatorDisplay && this.countriesData.length > 0) {
                // If a country is selected, redraw with it excluded from cone markers
                if (this.selectedCountry) {
                    this.rotatorDisplay.showCountryMarker(
                        this.selectedCountry.name,
                        this.selectedCountry.bearing,
                        this.selectedCountry.distance_km,
                        this.countriesData,
                        data.position.azimuth
                    );
                } else {
                    // No country selected, just show cone markers
                    this.rotatorDisplay.updateConeMarkers(this.countriesData, data.position.azimuth);
                }
            }
        }
        
        // Update status indicator in expanded view
        const statusIndicator = document.getElementById('rotator-status-indicator');
        if (statusIndicator) {
            let className = 'rotator-status-indicator';
            if (data.connected) {
                className += ' connected';
                statusIndicator.title = 'Connected';
            } else {
                className += ' disconnected';
                statusIndicator.title = 'Disconnected';
            }
            // Add moving class if rotator is moving
            if (data.moving) {
                className += ' moving';
                statusIndicator.title += ' (Moving)';
            }
            statusIndicator.className = className;
        }
        
        // Update status indicator on collapsed tab button
        const tabStatus = document.getElementById('rotator-tab-status');
        if (tabStatus) {
            let className = 'rotator-tab-status';
            if (data.connected) {
                className += ' connected';
            } else {
                className += ' disconnected';
            }
            if (data.moving) {
                className += ' moving';
            }
            tabStatus.className = className;
        }

        // ── Rotator stopped-moving notification ───────────────────────────
        // Fire once when the rotator transitions from moving → stopped.
        // We only notify after the first real status update (lastMoving starts
        // false, so we guard against a spurious fire on page load by requiring
        // that we have seen at least one moving=true cycle first).
        if (this.lastMoving && !data.moving && data.connected) {
            const az = (data.position && data.position.azimuth !== undefined)
                ? Math.round(data.position.azimuth) + '°'
                : '';
            const msg = az ? `🧭 Rotator stopped at ${az}` : '🧭 Rotator stopped';
            if (typeof window.showNotification === 'function' && !window._isMobile) {
                window.showNotification(msg, 'success', 4000);
            }
        }
        this.lastMoving = !!data.moving;

        // Push rotator state to callsign lookup popup (if open)
        // The popup uses this to show current antenna bearing and the Set button.
        const lw = window._callsignLookupWindow;
        if (lw && !lw.closed) {
            try {
                lw.postMessage({
                    type:        'rotator_status',
                    enabled:     true,
                    connected:   !!data.connected,
                    azimuth:     (data.position && data.position.azimuth !== undefined)
                                     ? Math.round(data.position.azimuth)
                                     : null,
                    moving:      !!data.moving,
                    hasPassword: !!this.savedPassword
                }, window.location.origin);
            } catch (_) { /* popup closed between check and send — ignore */ }

            // Piggyback the current ant switch status on every rotator poll (1 s).
            // This ensures the popup sees the ant switch state immediately on open
            // without waiting up to 30 s for the dedicated ant switch poll cycle.
            if (this.antSwitchEnabled && this.antSwitchStatus) {
                try {
                    lw.postMessage({
                        type:           'ant_switch_status',
                        enabled:        !!this.antSwitchStatus.enabled,
                        num_antennas:   this.antSwitchStatus.num_antennas   || 0,
                        antenna_labels: this.antSwitchStatus.antenna_labels || [],
                        selected:       this.antSwitchStatus.selected       || [],
                        grounded:       !!this.antSwitchStatus.grounded,
                        thunderstorm:   !!this.antSwitchStatus.thunderstorm,
                        hasPassword:    !!this.antSwitchPassword
                    }, window.location.origin);
                } catch (_) {}
            }
        }
    }
    
    /**
     * Fetch receiver location and display it
     */
    async fetchReceiverLocation() {
        try {
            const response = await fetch('/api/description');
            const data = await response.json();
            
            const locationElement = document.getElementById('rotator-location-display');
            if (!locationElement) return;
            
            if (data.receiver && data.receiver.gps) {
                const lat = data.receiver.gps.lat.toFixed(4);
                const lon = data.receiver.gps.lon.toFixed(4);
                
                // Format: coordinates on top, location name below
                if (data.receiver.location) {
                    locationElement.innerHTML = `${lat}, ${lon}<br>${data.receiver.location}`;
                } else {
                    locationElement.textContent = `${lat}, ${lon}`;
                }
            } else {
                locationElement.textContent = 'Location N/A';
            }
        } catch (error) {
            console.error('[RotatorUI] Failed to fetch receiver location:', error);
            const locationElement = document.getElementById('rotator-location-display');
            if (locationElement) {
                locationElement.textContent = 'Location Error';
            }
        }
    }
    
    /**
     * Fetch countries data for cone markers
     */
    async fetchCountries() {
        try {
            const response = await fetch('/api/rotctl/countries');
            const data = await response.json();

            if (data.success && data.countries) {
                this.countriesData = data.countries;

                // Pass countries data to rotator display for tooltip
                if (this.rotatorDisplay) {
                    this.rotatorDisplay.setCountriesData(data.countries);
                }
            } else {
                console.error('[RotatorUI] Failed to fetch countries:', data.error);
            }
        } catch (error) {
            console.error('[RotatorUI] Failed to fetch countries:', error);
        }
    }

    /**
     * Handle map click event
     */
    async handleMapClick(detail) {
        const bearing = detail.bearing;
        const distance = detail.distance;

        // Check if password is available, recheck localStorage if not
        if (!this.savedPassword) {
            this.savedPassword = localStorage.getItem('rotctl_password') || '';
            if (!this.savedPassword) {
                console.log('[RotatorUI] No password available. Click "Controls" button to set password.');
                return;
            }
        }

        // Find the closest country by bearing and distance (same as rotator.html)
        if (this.countriesData.length > 0 && this.rotatorDisplay) {
            const closestCountry = this.rotatorDisplay.findClosestCountry(bearing, distance);
            if (closestCountry) {
                // Store selected country so it can be excluded from cone markers in status updates
                this.selectedCountry = closestCountry;

                // Get current azimuth for cone calculation
                try {
                    const statusResponse = await fetch('/api/rotctl/status');
                    const statusData = await statusResponse.json();
                    const currentAzimuth = statusData.position?.azimuth || 0;

                    // Show marker on map with cone markers
                    // Pass closestCountry.bearing to showCountryMarker so it can be excluded from cone markers
                    this.rotatorDisplay.showCountryMarker(
                        closestCountry.name,
                        closestCountry.bearing,
                        closestCountry.distance_km,
                        this.countriesData,
                        currentAzimuth
                    );
                } catch (error) {
                    console.error('[RotatorUI] Failed to get current azimuth for marker:', error);
                }
            }
        }

        // Send command to rotator with the exact cursor bearing (not country center)
        try {
            const response = await fetch('/api/rotctl/position', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    password: this.savedPassword,
                    azimuth: bearing
                })
            });

            const data = await response.json();

            if (data.success) {
                console.log(`[RotatorUI] Moving to ${bearing}°`);
            } else {
                console.error('[RotatorUI] Failed to set azimuth:', data.error);
                // If password is wrong, clear it
                if (data.error && data.error.toLowerCase().includes('password')) {
                    this.savedPassword = '';
                    localStorage.removeItem('rotctl_password');
                }
            }
        } catch (error) {
            console.error('[RotatorUI] Network error:', error);
        }
    }

    /**
     * Open rotator controls in a new tab
     */
    openControls() {
        window.open('/rotator.html', '_blank');
    }

    openSwitchControls() {
        window.open('/switch.html', '_blank');
    }

    /**
     * Destroy the rotator display
     */
    destroy() {
        if (this.rotatorDisplay) {
            this.rotatorDisplay.destroy();
            this.rotatorDisplay = null;
        }
        this.stopAntSwitchPoll();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Ant switch — polling
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Start (or restart) the ant switch poll at the given interval (ms).
     * Clears any existing timer first so the rate can be changed dynamically.
     */
    startAntSwitchPoll(intervalMs) {
        this.stopAntSwitchPoll();
        // Immediate fetch
        this.fetchAntSwitchStatus();
        this.antSwitchPollTimer = setInterval(() => this.fetchAntSwitchStatus(), intervalMs);
    }

    stopAntSwitchPoll() {
        if (this.antSwitchPollTimer) {
            clearInterval(this.antSwitchPollTimer);
            this.antSwitchPollTimer = null;
        }
    }

    async fetchAntSwitchStatus() {
        try {
            const resp = await fetch('/api/ant-switch/status');
            if (!resp.ok) return;
            const data = await resp.json();
            this.handleAntSwitchStatus(data);
        } catch { /* ignore — stale display stays */ }
        // Refresh history alongside every status poll
        this.fetchAntHistory();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Ant switch — status handling & UI rendering
    // ═══════════════════════════════════════════════════════════════════════

    handleAntSwitchStatus(data) {
        // ── Ant switch change notification ────────────────────────────────
        // Fire when selected antennas or grounded state changes.
        // lastAntSelected/lastAntGrounded start as null so the very first
        // status fetch (page load) is treated as initialisation only — no toast.
        const newSelected  = JSON.stringify((data.selected  || []).slice().sort((a,b)=>a-b));
        const newGrounded  = !!data.grounded;

        if (this.lastAntSelected !== null) {
            // We have a baseline — check for changes
            const selectedChanged = newSelected  !== this.lastAntSelected;
            const groundedChanged = newGrounded  !== this.lastAntGrounded;

            if ((selectedChanged || groundedChanged) && typeof window.showNotification === 'function' && !window._isMobile) {
                let msg;
                if (newGrounded) {
                    msg = '⏚ Antenna grounded';
                } else if (data.selected && data.selected.length > 0) {
                    const labels = data.selected.map(n => {
                        const idx = n - 1;
                        return (data.antenna_labels && data.antenna_labels[idx])
                            ? data.antenna_labels[idx]
                            : `Antenna ${n}`;
                    });
                    msg = '📡 Antenna: ' + labels.join(', ');
                } else {
                    msg = '📡 Antenna: none selected';
                }
                window.showNotification(msg, 'info', 4000);
            }
        }

        // Update baseline for next comparison
        this.lastAntSelected = newSelected;
        this.lastAntGrounded = newGrounded;

        // Keep window.activeAntennaLabel in sync so the spectrum overlay
        // (drawStationIdOverlay) reflects the current antenna immediately,
        // rather than waiting up to 30 s for the separate app.js poll.
        if (data.grounded) {
            window.activeAntennaLabel = 'Grounded';
        } else if (data.selected && data.selected.length > 0) {
            const labels = data.selected.map(n => {
                const idx = n - 1;
                return (data.antenna_labels && data.antenna_labels[idx])
                    ? data.antenna_labels[idx]
                    : `Antenna ${n}`;
            });
            window.activeAntennaLabel = labels.join(', ');
        } else {
            window.activeAntennaLabel = null;
        }

        this.antSwitchStatus = data;

        // ── Update collapsed tab label ─────────────────────────────────────
        const tabLabel = document.getElementById('cp-tab-ant-label');
        if (tabLabel) {
            let label = '📡';
            if (data.grounded) {
                label = '⏚';
            } else if (data.selected && data.selected.length > 0) {
                const idx = data.selected[0] - 1;
                const raw = (data.antenna_labels && data.antenna_labels[idx])
                    ? data.antenna_labels[idx]
                    : `Ant ${data.selected[0]}`;
                label = raw.length > 15 ? raw.slice(0, 14) + '…' : raw;
            }
            tabLabel.textContent = label;
        }

        // ── Update collapsed tab status dot ───────────────────────────────
        const tabDot = document.getElementById('cp-tab-ant-status');
        if (tabDot) {
            tabDot.className = 'rotator-tab-status ' + (data.enabled ? 'connected' : 'disconnected');
        }

        // ── Push ant switch state to callsign lookup popup (if open) ──────
        const lw = window._callsignLookupWindow;
        if (lw && !lw.closed) {
            try {
                lw.postMessage({
                    type:           'ant_switch_status',
                    enabled:        !!data.enabled,
                    num_antennas:   data.num_antennas || 0,
                    antenna_labels: data.antenna_labels || [],
                    selected:       data.selected || [],
                    grounded:       !!data.grounded,
                    thunderstorm:   !!data.thunderstorm,
                    hasPassword:    !!this.antSwitchPassword
                }, window.location.origin);
            } catch (_) { /* popup closed between check and send — ignore */ }
        }

        // ── Render the ant switch pane (only if it exists in DOM) ─────────
        const buttonsEl = document.getElementById('cp-ant-buttons');
        if (!buttonsEl) return; // pane not yet in DOM

        this.renderAntSwitchButtons(data);
        this.updateAntSwitchBanner(data);
        this.updateAntSwitchStatusText(data);
    }

    renderAntSwitchButtons(data) {
        const buttonsEl = document.getElementById('cp-ant-buttons');
        if (!buttonsEl) return;

        const numAntennas = data.num_antennas || 8;
        const labels      = data.antenna_labels || [];
        const selected    = data.selected || [];
        const disabled    = data.thunderstorm || this.antSwitchReadOnly;

        // Only rebuild DOM if antenna count changed (avoids flicker)
        if (buttonsEl.children.length !== numAntennas) {
            buttonsEl.innerHTML = '';
            for (let i = 1; i <= numAntennas; i++) {
                const label = (labels[i - 1] && labels[i - 1] !== '') ? labels[i - 1] : `Antenna ${i}`;
                const btn = document.createElement('button');
                btn.className = 'cp-ant-btn';
                btn.dataset.antenna = i;
                btn.textContent = label;
                btn.onclick = () => this.onAntButtonClick(i);
                buttonsEl.appendChild(btn);
            }
        }

        // Update label, selected state and disabled state on all buttons
        Array.from(buttonsEl.children).forEach(btn => {
            const n = parseInt(btn.dataset.antenna, 10);
            const lbl = (labels[n - 1] && labels[n - 1] !== '') ? labels[n - 1] : `Antenna ${n}`;
            // Only write textContent when it has changed to avoid unnecessary repaints
            if (btn.textContent !== lbl) btn.textContent = lbl;
            btn.classList.toggle('selected', selected.includes(n));
            btn.disabled = disabled;
        });

        // Ground button
        const groundBtn = document.getElementById('cp-ant-ground-btn');
        if (groundBtn) {
            groundBtn.disabled = disabled;
            groundBtn.classList.toggle('selected', !!data.grounded);
        }
    }

    updateAntSwitchBanner(data) {
        const banner = document.getElementById('cp-ant-banner');
        if (!banner) return;

        if (data.thunderstorm) {
            banner.style.display = 'block';
            banner.className = 'cp-ant-banner thunderstorm';
            banner.textContent = '⚡ Thunderstorm mode — switching disabled';
        } else if (this.antSwitchReadOnly) {
            banner.style.display = 'block';
            banner.className = 'cp-ant-banner readonly';
            banner.textContent = '👁 View only — no password configured';
        } else {
            banner.style.display = 'none';
        }
    }

    updateAntSwitchStatusText(data) {
        const el = document.getElementById('cp-ant-status-text');
        if (!el) return;

        if (data.grounded) {
            el.textContent = 'Status: Grounded';
        } else if (data.selected && data.selected.length > 0) {
            const labels = (data.selected || []).map(n => {
                const idx = n - 1;
                return (data.antenna_labels && data.antenna_labels[idx])
                    ? data.antenna_labels[idx]
                    : `Antenna ${n}`;
            });
            el.textContent = 'Active: ' + labels.join(', ');
        } else {
            el.textContent = 'Status: Unknown';
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Ant switch — control actions
    // ═══════════════════════════════════════════════════════════════════════

    onAntButtonClick(antennaNum) {
        if (!this.antSwitchPassword) {
            // Show inline password prompt, remember which antenna was clicked
            this.antSwitchPendingAnt = antennaNum;
            this._showAntPasswordRow('');
            return;
        }
        this._sendAntCommand({ command: 'select', antenna: antennaNum });
    }

    onGroundClick() {
        if (!this.antSwitchPassword) {
            this.antSwitchPendingAnt = 'ground';
            this._showAntPasswordRow('');
            return;
        }
        this._sendAntCommand({ command: 'ground' });
    }

    _showAntPasswordRow(errorMsg) {
        const row = document.getElementById('cp-ant-password-row');
        const err = document.getElementById('cp-ant-password-error');
        const inp = document.getElementById('cp-ant-password-input');
        if (row) row.style.display = 'flex';
        if (err) err.textContent = errorMsg;
        if (inp) { inp.value = ''; inp.focus(); }
    }

    _hideAntPasswordRow() {
        const row = document.getElementById('cp-ant-password-row');
        if (row) row.style.display = 'none';
        this.antSwitchPendingAnt = null;
    }

    confirmAntPassword() {
        const inp = document.getElementById('cp-ant-password-input');
        if (!inp) return;
        const pw = inp.value.trim();
        if (!pw) return;

        this.antSwitchPassword = pw;
        localStorage.setItem('ant_switch_password', pw);

        if (this.antSwitchPendingAnt === 'ground') {
            this._sendAntCommand({ command: 'ground' });
        } else if (this.antSwitchPendingAnt !== null) {
            this._sendAntCommand({ command: 'select', antenna: this.antSwitchPendingAnt });
        }
        this._hideAntPasswordRow();
    }

    async _sendAntCommand(cmdObj) {
        try {
            const resp = await fetch('/api/ant-switch/command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: this.antSwitchPassword, ...cmdObj })
            });

            if (resp.status === 401) {
                // Wrong or missing password — clear saved value and re-prompt
                this.antSwitchPassword = '';
                localStorage.removeItem('ant_switch_password');
                this._showAntPasswordRow('Incorrect password');
                return;
            }

            if (resp.status === 403) {
                // Thunderstorm — already shown in banner, nothing to do
                return;
            }

            // Success (200 or 202) — re-fetch status and history immediately
            const result = await resp.json().catch(() => ({}));
            if (result.selected !== undefined) {
                // Use the result directly to update UI without waiting for next poll
                this.handleAntSwitchStatus({
                    ...this.antSwitchStatus,
                    selected:  result.selected,
                    grounded:  result.grounded,
                    enabled:   true,
                });
            } else {
                this.fetchAntSwitchStatus();
            }
            this.fetchAntHistory();
        } catch (err) {
            console.error('[RotatorUI] Ant switch command failed:', err);
        }
    }
    // ═══════════════════════════════════════════════════════════════════════
    // Ant switch — change history
    // ═══════════════════════════════════════════════════════════════════════

    async fetchAntHistory() {
        try {
            const resp = await fetch('/api/ant-switch/history');
            if (!resp.ok) return;
            const data = await resp.json();
            if (Array.isArray(data.history)) {
                this.antHistoryEntries = data.history;
                this.renderAntHistory();
            }
        } catch { /* ignore */ }
    }

    renderAntHistory() {
        const list = document.getElementById('cp-ant-history-list');
        const pageEl = document.getElementById('cp-ant-hist-page');
        const prevBtn = document.getElementById('cp-ant-hist-prev');
        const nextBtn = document.getElementById('cp-ant-hist-next');
        if (!list) return;

        const entries = this.antHistoryEntries;
        const perPage = 10;
        const totalPages = Math.max(1, Math.ceil(entries.length / perPage));

        // Clamp page
        if (this.antHistoryPage < 0) this.antHistoryPage = 0;
        if (this.antHistoryPage >= totalPages) this.antHistoryPage = totalPages - 1;

        if (pageEl) pageEl.textContent = `${this.antHistoryPage + 1}/${totalPages}`;
        if (prevBtn) prevBtn.disabled = this.antHistoryPage === 0;
        if (nextBtn) nextBtn.disabled = this.antHistoryPage >= totalPages - 1;

        if (entries.length === 0) {
            list.innerHTML = '<div class="cp-ant-history-empty">No changes recorded yet</div>';
            return;
        }

        const start = this.antHistoryPage * perPage;
        const page  = entries.slice(start, start + perPage);

        const actionIcon = { select:'📡', ground:'⏚', add:'➕', remove:'➖', default:'⭐', thunderstorm_on:'⚡', thunderstorm_off:'✅' };

        list.innerHTML = page.map(e => {
            const t = new Date(e.time);
            const ts = t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const icon = actionIcon[e.action] || '•';
            const srcClass = e.source || 'public';
            return `<div class="cp-ant-history-row">
                <span class="cp-ant-hist-time">${ts}</span>
                <span class="cp-ant-hist-label">${icon} ${e.label || e.action}</span>
                <span class="cp-ant-hist-src ${srcClass}">${e.source}</span>
            </div>`;
        }).join('');
    }
}

// ─── Global instance ──────────────────────────────────────────────────────────
let rotatorUI = null;

/**
 * Initialize the control panel.
 * Pass rotatorEnabled and antSwitchEnabled from /api/description.
 * Not shown on mobile (overlaps docked controls).
 */
function initializeRotatorUI(opts = {}) {
    if (window.innerWidth <= 1024) return;
    if (!rotatorUI) {
        rotatorUI = new RotatorUI(opts);
        window.rotatorUI = rotatorUI;
    }
}
