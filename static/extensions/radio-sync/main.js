// Radio Sync Extension - Synchronize with external radios via Hamlib (WebAssembly)
// Displays frequency, mode, and TX/RX state with LED-style indicators
//
// Backed by Hamlib compiled to WebAssembly (see Hamlib/wasm/ in the Hamlib repo),
// served from /hamlib/ on this instance. Talks to real hardware over the Web
// Serial API via Hamlib's own rig backends instead of a hand-written per-radio
// protocol parser, so every serial-capable rig Hamlib supports works here.

const HAMLIB_BASE_URL = '/hamlib';

// Consecutive fully-failed poll cycles (freq+mode+PTT all erroring) before we
// treat the link as dead and disconnect, rather than retrying at 10Hz forever.
const MAX_POLL_FAILURES = 20;

// ubersdr's SDR-facing mode names (see static/extensions/README.md's Radio API)
// vs. Hamlib's canonical rig_strrmode()/rig_parse_mode() names (RIG_MODE_* in
// include/hamlib/rig.h). One table, shared by both sync directions - replaces
// the separate modeMap/reverseModeMap that used to live in each protocol file.
const SDR_TO_HAMLIB_MODE = {
    usb: 'USB', lsb: 'LSB', cwu: 'CW', cwl: 'CWR',
    am: 'AM', sam: 'SAM', fm: 'FM', nfm: 'FMN',
};
const HAMLIB_TO_SDR_MODE = Object.fromEntries(
    Object.entries(SDR_TO_HAMLIB_MODE).map(([sdr, hamlib]) => [hamlib, sdr])
);

class RadioSyncExtension extends DecoderExtension {
    constructor() {
        super('radio-sync', {
            displayName: 'Radio Sync',
            autoTune: false,
            requiresMode: null,
            preferredBandwidth: null
        });

        // Hamlib wasm module state
        this.hamlibModule = null;
        this.hamlibLoadPromise = null;
        this.rigHandle = 0;
        this.isConnected = false;
        this.isConnecting = false; // Guards against overlapping connectToRadio() calls (e.g. impatient repeat clicks)
        this.isDisconnecting = false;

        this.selectedRadio = null;
        this.selectedBaudRate = null; // Will be set when radio is selected
        this.syncMode = 'both'; // 'sdr-to-radio', 'radio-to-sdr', 'both'
        // Display style cycling (starting with modern digital)
        this.displayStyles = ['style-digital', 'style-led', 'style-amber', 'style-cyan', 'style-red', 'style-vfd'];
        this.currentStyleIndex = 0;

        // State tracking - these track the RADIO state, not SDR
        this.currentFrequency = 0;  // Radio frequency
        this.currentMode = 'USB';   // Radio mode
        this.txState = false;       // false = RX, true = TX
        this.muteOnTX = true; // Mute SDR when radio is transmitting
        this.wasMutedBeforeTX = false; // Track if SDR was already muted before TX

        // Track last values sent to radio to prevent feedback loops
        this.lastSentFrequency = 0;
        this.lastSentMode = '';

        // Flag to temporarily disable event handlers when we're updating SDR from radio
        this.updatingFromRadio = false;

        // Update intervals
        this.updateInterval = null;
        this.radioPollingInterval = null;
    }

    onInitialize() {
        console.log('Radio Sync Extension onInitialize called');
        this.radio.log('Radio Sync Extension initialized');

        // Load and render template
        this.renderUI();

        console.log('Radio Sync Extension initialization complete');
    }

    /**
     * Loads hamlib.wasm + the Web Serial bridge exactly once, cwraps the API,
     * and populates the radio dropdown from hamlib_list_rigs(). Safe to call
     * repeatedly (e.g. every onEnable()) - subsequent calls return the same
     * cached promise instead of reloading the 14MB module.
     */
    ensureHamlibLoaded() {
        if (this.hamlibLoadPromise) {
            return this.hamlibLoadPromise;
        }

        this.hamlibLoadPromise = (async () => {
            try {
                if (typeof window.HamlibSerialBridge === 'undefined') {
                    await new Promise((resolve, reject) => {
                        const script = document.createElement('script');
                        script.src = `${HAMLIB_BASE_URL}/hamlib-serial-bridge.js`;
                        script.onload = resolve;
                        script.onerror = () => reject(new Error('Failed to load hamlib-serial-bridge.js'));
                        document.head.appendChild(script);
                    });
                }

                const { default: createHamlibModule } = await import(`${HAMLIB_BASE_URL}/hamlib.js`);
                const bridge = new window.HamlibSerialBridge();
                const Module = await createHamlibModule({ hamlibSerial: bridge });

                this.hamlibModule = Module;
                this.hamlibBridge = bridge;

                // hamlib.wasm is built with plain -sASYNCIFY (see wasm/build.sh),
                // which supports only one in-flight async call into the module at
                // a time - calling a second cwrap({async:true}) function before the
                // first has unwound corrupts Asyncify's call stack and Hamlib's
                // shared cmd/response buffers (e.g. newcat's priv->cmd_str /
                // ret_data). Both the radio-polling interval and the SDR->radio
                // polling interval below fire independently every 100ms, so
                // without serialization their calls can overlap on a slow serial
                // link, producing exactly this kind of corruption (e.g. PTT
                // reads flipping on/off spuriously). Route every call through one
                // queue so the module only ever sees one call at a time.
                this._hamlibQueue = Promise.resolve();
                const serialize = (fn) => (...args) => {
                    const result = this._hamlibQueue.then(() => fn(...args));
                    this._hamlibQueue = result.then(() => {}, () => {});
                    return result;
                };

                this.hamlibOpen = serialize(Module.cwrap('hamlib_open', 'number',
                    ['number', 'number', 'number', 'number', 'number', 'number'], { async: true }));
                this.hamlibClose = serialize(Module.cwrap('hamlib_close', 'number', ['number'], { async: true }));
                this.hamlibGetFreq = serialize(Module.cwrap('hamlib_get_freq', 'number', ['number'], { async: true }));
                this.hamlibSetFreq = serialize(Module.cwrap('hamlib_set_freq', 'number', ['number', 'number'], { async: true }));
                this.hamlibGetMode = serialize(Module.cwrap('hamlib_get_mode', 'string', ['number'], { async: true }));
                this.hamlibSetMode = serialize(Module.cwrap('hamlib_set_mode', 'number', ['number', 'string'], { async: true }));
                this.hamlibGetPtt = serialize(Module.cwrap('hamlib_get_ptt', 'number', ['number'], { async: true }));

                const listRigs = Module.cwrap('hamlib_list_rigs', 'string', []); // no I/O - plain sync call
                const rigs = JSON.parse(listRigs());
                this.populateRadioDropdown(rigs);

                this.addMessage(`Hamlib loaded: ${rigs.length} radios available`, 'success');
            } catch (error) {
                console.error('Failed to load Hamlib wasm module:', error);
                this.showHamlibLoadError(error);
                throw error;
            }
        })();

        // Never cache a rejection: the 14MB wasm fetch can fail transiently, and
        // holding on to the rejected promise would make every later Connect bail
        // out on it, leaving the extension dead until a page reload. Dropping it
        // lets the next call retry from scratch. (This handler also keeps a
        // failure from surfacing as an unhandled rejection for callers that
        // fire-and-forget, e.g. onEnable().)
        this.hamlibLoadPromise.catch(() => {
            this.hamlibLoadPromise = null;
        });

        return this.hamlibLoadPromise;
    }

    /**
     * Replaces the static placeholder options in #radio-sync-model with one
     * <optgroup> per manufacturer, generated from hamlib_list_rigs(). Each
     * <option>'s dataset carries the serial settings hamlib_open() needs -
     * this is the per-radio config source now (replaces the old hardcoded
     * this.radioProtocols map).
     */
    populateRadioDropdown(rigs) {
        const modelSelect = document.getElementById('radio-sync-model');
        if (!modelSelect) return;

        const byMfg = new Map();
        for (const rig of rigs) {
            if (!byMfg.has(rig.mfg)) byMfg.set(rig.mfg, []);
            byMfg.get(rig.mfg).push(rig);
        }

        const mfgs = Array.from(byMfg.keys()).sort((a, b) => a.localeCompare(b));

        modelSelect.innerHTML = '<option value="">Select Radio...</option>';
        for (const mfg of mfgs) {
            const optgroup = document.createElement('optgroup');
            optgroup.label = mfg;

            const rigsForMfg = byMfg.get(mfg).sort((a, b) => a.name.localeCompare(b.name));
            for (const rig of rigsForMfg) {
                const option = document.createElement('option');
                option.value = String(rig.model);
                option.textContent = rig.name;
                option.dataset.name = `${rig.mfg} ${rig.name}`;
                option.dataset.baud = rig.baudMax;
                option.dataset.dataBits = rig.dataBits;
                option.dataset.stopBits = rig.stopBits;
                option.dataset.parity = rig.parity;
                option.dataset.handshake = rig.handshake;
                optgroup.appendChild(option);
            }
            modelSelect.appendChild(optgroup);
        }

        this.populateModelComboboxList(mfgs, byMfg);

        const modelInput = document.getElementById('radio-sync-model-input');
        if (modelInput) {
            modelInput.disabled = false;
            modelInput.placeholder = 'Type to search radios...';
        }
    }

    /**
     * Builds the visible search dropdown (#radio-sync-model-listbox) that sits
     * on top of the real (hidden) #radio-sync-model <select>. Each option div's
     * data-value matches the hidden select's <option value>, so selecting one
     * just re-uses the existing hidden select + 'change' event machinery -
     * connectToRadio() etc. don't need to know the combobox exists.
     */
    populateModelComboboxList(mfgs, byMfg) {
        const listbox = document.getElementById('radio-sync-model-listbox');
        if (!listbox) return;

        listbox.innerHTML = '';
        for (const mfg of mfgs) {
            const groupLabel = document.createElement('div');
            groupLabel.className = 'radio-sync-combobox-group-label';
            groupLabel.textContent = mfg;
            listbox.appendChild(groupLabel);

            const rigsForMfg = byMfg.get(mfg).sort((a, b) => a.name.localeCompare(b.name));
            for (const rig of rigsForMfg) {
                const item = document.createElement('div');
                item.className = 'radio-sync-combobox-option';
                item.setAttribute('role', 'option');
                item.dataset.value = String(rig.model);
                item.dataset.searchText = `${rig.mfg} ${rig.name}`.toLowerCase();
                item.textContent = rig.name;
                listbox.appendChild(item);
            }
        }
    }

    showHamlibLoadError(error) {
        const errorDiv = document.getElementById('radio-sync-api-error');
        if (errorDiv) {
            errorDiv.style.display = 'block';
            errorDiv.querySelector('strong').textContent = '⚠️ Hamlib module failed to load';
            errorDiv.querySelector('p').textContent =
                `Could not load ${HAMLIB_BASE_URL}/hamlib.js (${error.message}). Radio control is unavailable.`;
        }
        this.addMessage(`Hamlib load error: ${error.message}`, 'error');
    }

    showSerialAPIError() {
        const errorDiv = document.getElementById('radio-sync-api-error');
        if (errorDiv) {
            errorDiv.style.display = 'block';
        }
        this.addMessage('Web Serial API not available in this browser', 'error');
    }

    renderUI() {
        const template = window.radio_sync_template;

        if (!template) {
            console.error('Radio Sync extension template not loaded');
            return;
        }

        const container = this.getContentElement();
        if (!container) return;

        container.innerHTML = template;
    }

    setupEventListeners() {
        // Radio model selection
        const modelSelect = document.getElementById('radio-sync-model');
        const connectBtn = document.getElementById('radio-sync-connect');

        if (modelSelect) {
            modelSelect.addEventListener('change', (e) => {
                this.selectedRadio = e.target.value;

                // Update baud rate dropdown to default for selected radio
                const baudRateSelect = document.getElementById('radio-sync-baud-rate');
                const option = modelSelect.selectedOptions[0];
                if (baudRateSelect && this.selectedRadio && option) {
                    baudRateSelect.value = option.dataset.baud;
                    this.selectedBaudRate = parseInt(option.dataset.baud, 10);
                }

                // Update connect button based on selection
                if (connectBtn) {
                    if (this.selectedRadio) {
                        connectBtn.disabled = false;
                        connectBtn.textContent = 'Connect to Radio';
                        this.addMessage(`Selected: ${option?.dataset.name || 'Unknown'}`, 'info');
                    } else {
                        connectBtn.disabled = true;
                        connectBtn.textContent = 'Select Radio First';
                    }
                }
            });
        } else {
            console.error('Radio Sync: model select not found');
        }

        this.setupModelCombobox();

        // Baud rate selection
        const baudRateSelect = document.getElementById('radio-sync-baud-rate');
        if (baudRateSelect) {
            baudRateSelect.addEventListener('change', (e) => {
                this.selectedBaudRate = parseInt(e.target.value, 10);
                this.addMessage(`Baud rate: ${this.selectedBaudRate}`, 'info');
            });
        }

        // Sync direction buttons
        const sdrToRadioBtn = document.getElementById('radio-sync-sdr-to-radio');
        const radioToSdrBtn = document.getElementById('radio-sync-radio-to-sdr');
        const bothBtn = document.getElementById('radio-sync-both');

        if (sdrToRadioBtn) {
            sdrToRadioBtn.addEventListener('click', () => this.setSyncMode('sdr-to-radio'));
        }
        if (radioToSdrBtn) {
            radioToSdrBtn.addEventListener('click', () => this.setSyncMode('radio-to-sdr'));
        }
        if (bothBtn) {
            bothBtn.addEventListener('click', () => this.setSyncMode('both'));
        }

        // Connect/Disconnect buttons
        const disconnectBtn = document.getElementById('radio-sync-disconnect');

        if (connectBtn) {
            console.log('Radio Sync: Connect button found, adding listener');
            // Set initial state
            connectBtn.disabled = true;
            connectBtn.textContent = 'Select Radio First';

            connectBtn.addEventListener('click', () => {
                console.log('Radio Sync: Connect button clicked');
                this.connectToRadio();
            });
        } else {
            console.error('Radio Sync: Connect button not found');
        }

        if (disconnectBtn) {
            disconnectBtn.addEventListener('click', () => this.disconnectFromRadio());
        } else {
            console.error('Radio Sync: Disconnect button not found');
        }

        // Mute on TX checkbox
        const muteOnTXCheckbox = document.getElementById('radio-sync-mute-on-tx');
        if (muteOnTXCheckbox) {
            muteOnTXCheckbox.addEventListener('change', (e) => {
                this.muteOnTX = e.target.checked;
                this.addMessage(`Mute on TX: ${this.muteOnTX ? 'enabled' : 'disabled'}`, 'info');
            });
        }

        // Display style cycling
        const displayElement = document.getElementById('radio-sync-display');
        if (displayElement) {
            displayElement.addEventListener('click', () => this.cycleDisplayStyle());
        }
    }

    /**
     * Wires the search input + dropdown listbox that sit on top of the real
     * (hidden) #radio-sync-model <select>. The hamlib rig list has hundreds
     * of entries across dozens of manufacturers, so a plain <select> is
     * painful to scroll through - this adds type-to-filter on top of it
     * while leaving the hidden select as the single source of truth that
     * the rest of the extension (change listener, connectToRadio()) reads.
     */
    setupModelCombobox() {
        const input = document.getElementById('radio-sync-model-input');
        const clearBtn = document.getElementById('radio-sync-model-clear');
        const listbox = document.getElementById('radio-sync-model-listbox');
        const modelSelect = document.getElementById('radio-sync-model');
        const combobox = document.getElementById('radio-sync-model-combobox');
        if (!input || !clearBtn || !listbox || !modelSelect || !combobox) {
            console.error('Radio Sync: model combobox elements not found');
            return;
        }

        const getVisibleOptions = () =>
            Array.from(listbox.querySelectorAll('.radio-sync-combobox-option'))
                .filter((el) => el.style.display !== 'none');

        const setActive = (el) => {
            listbox.querySelectorAll('.radio-sync-combobox-option.is-active')
                .forEach((el2) => el2.classList.remove('is-active'));
            if (el) {
                el.classList.add('is-active');
                el.scrollIntoView({ block: 'nearest' });
            }
        };

        const openList = () => {
            listbox.style.display = 'block';
            input.setAttribute('aria-expanded', 'true');
        };

        const closeList = () => {
            listbox.style.display = 'none';
            input.setAttribute('aria-expanded', 'false');
            setActive(null);
        };

        const applyFilter = () => {
            const query = input.value.trim().toLowerCase();
            let anyVisible = false;

            listbox.querySelectorAll('.radio-sync-combobox-group-label').forEach((label) => {
                let node = label.nextElementSibling;
                let groupHasMatch = false;
                while (node && !node.classList.contains('radio-sync-combobox-group-label')) {
                    const match = !query || node.dataset.searchText.includes(query);
                    node.style.display = match ? '' : 'none';
                    if (match) { groupHasMatch = true; anyVisible = true; }
                    node = node.nextElementSibling;
                }
                label.style.display = groupHasMatch ? '' : 'none';
            });

            let emptyMsg = listbox.querySelector('.radio-sync-combobox-empty');
            if (!anyVisible) {
                if (!emptyMsg) {
                    emptyMsg = document.createElement('div');
                    emptyMsg.className = 'radio-sync-combobox-empty';
                    emptyMsg.textContent = 'No matching radios';
                    listbox.appendChild(emptyMsg);
                }
            } else if (emptyMsg) {
                emptyMsg.remove();
            }

            setActive(null);
        };

        const selectOption = (optionEl) => {
            const value = optionEl.dataset.value;
            modelSelect.value = value;
            modelSelect.dispatchEvent(new Event('change'));

            const selected = modelSelect.selectedOptions[0];
            input.value = selected ? selected.dataset.name : '';
            clearBtn.style.display = value ? 'inline-block' : 'none';
            closeList();
        };

        input.addEventListener('focus', () => {
            input.select();
            openList();
        });

        input.addEventListener('input', () => {
            openList();
            applyFilter();
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                openList();
                const visible = getVisibleOptions();
                if (!visible.length) return;
                const current = listbox.querySelector('.radio-sync-combobox-option.is-active');
                let idx = current ? visible.indexOf(current) : -1;
                idx = e.key === 'ArrowDown'
                    ? Math.min(idx + 1, visible.length - 1)
                    : Math.max(idx - 1, 0);
                setActive(visible[idx]);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const active = listbox.querySelector('.radio-sync-combobox-option.is-active');
                const visible = getVisibleOptions();
                const target = active || (visible.length === 1 ? visible[0] : null);
                if (target) selectOption(target);
            } else if (e.key === 'Escape') {
                const selected = modelSelect.selectedOptions[0];
                input.value = modelSelect.value && selected ? selected.dataset.name : '';
                closeList();
            }
        });

        listbox.addEventListener('mousedown', (e) => {
            const optionEl = e.target.closest('.radio-sync-combobox-option');
            if (!optionEl) return;
            e.preventDefault(); // keep focus in input, avoid a blur/close race
            selectOption(optionEl);
        });

        clearBtn.addEventListener('click', () => {
            modelSelect.value = '';
            modelSelect.dispatchEvent(new Event('change'));
            input.value = '';
            clearBtn.style.display = 'none';
            input.focus();
            applyFilter();
            openList();
        });

        document.addEventListener('click', (e) => {
            if (!combobox.contains(e.target)) closeList();
        });
    }

    cycleDisplayStyle() {
        const displayElement = document.getElementById('radio-sync-display');
        if (!displayElement) return;

        // Remove current style
        displayElement.classList.remove(this.displayStyles[this.currentStyleIndex]);

        // Move to next style
        this.currentStyleIndex = (this.currentStyleIndex + 1) % this.displayStyles.length;

        // Add new style
        displayElement.classList.add(this.displayStyles[this.currentStyleIndex]);

        // Get style name for message
        const styleName = this.displayStyles[this.currentStyleIndex]
            .replace('style-', '')
            .replace('-', ' ')
            .toUpperCase();

        this.addMessage(`Display style: ${styleName}`, 'info');
    }

    setSyncMode(mode) {
        this.syncMode = mode;

        // Update button states
        const buttons = {
            'sdr-to-radio': document.getElementById('radio-sync-sdr-to-radio'),
            'radio-to-sdr': document.getElementById('radio-sync-radio-to-sdr'),
            'both': document.getElementById('radio-sync-both')
        };

        Object.keys(buttons).forEach(key => {
            if (buttons[key]) {
                if (key === mode) {
                    buttons[key].classList.add('radio-sync-btn-active');
                    // Force inline styles to override any CSS
                    buttons[key].style.background = '#3498db';
                    buttons[key].style.borderColor = '#5dade2';
                    buttons[key].style.boxShadow = '0 0 15px rgba(52, 152, 219, 0.6)';
                    buttons[key].style.color = '#ffffff';
                    buttons[key].style.fontWeight = '700';
                } else {
                    buttons[key].classList.remove('radio-sync-btn-active');
                    // Remove inline styles
                    buttons[key].style.background = '';
                    buttons[key].style.borderColor = '';
                    buttons[key].style.boxShadow = '';
                    buttons[key].style.color = '';
                    buttons[key].style.fontWeight = '';
                }
            } else {
                console.error('Button not found:', key);
            }
        });

        this.addMessage(`Sync mode: ${mode.replace(/-/g, ' ').toUpperCase()}`, 'info');
    }

    updateFromSDR() {
        // Initialize display with SDR state until we get radio state
        const sdrFreq = this.radio.getFrequency();
        const sdrMode = this.radio.getMode();

        // Update displays (will be overwritten by radio responses)
        this.updateFrequencyDisplay(sdrFreq);
        this.updateModeDisplay(sdrMode);
    }

    updateFrequencyDisplay(freq) {
        const formatted = this.formatFrequencyLED(freq);
        this.updateElementById('radio-sync-freq-display', (el) => {
            el.textContent = formatted;
        });
    }

    formatFrequencyLED(hz) {
        // Show dashes if frequency is 0 (not connected)
        if (hz === 0) {
            return '--.---.---';
        }
        // Format for LED display: 14.074.000
        const mhz = (hz / 1000000).toFixed(6);
        // Add dots every 3 digits from the right (after decimal point)
        const parts = mhz.split('.');
        if (parts.length === 2) {
            const intPart = parts[0];
            const decPart = parts[1];
            // Group decimal part in threes
            const grouped = decPart.match(/.{1,3}/g).join('.');
            return `${intPart}.${grouped}`;
        }
        return mhz;
    }

    updateModeDisplay(mode) {
        this.updateElementById('radio-sync-mode-display', (el) => {
            // Show dashes if mode is empty or '---'
            if (!mode || mode === '---') {
                el.textContent = '---';
            } else {
                el.textContent = mode.toUpperCase();
            }
        });
    }

    updateTXRXState(isTX, isConnected = true) {
        const wasTransmitting = this.txState;
        this.txState = isTX;

        const stateDisplay = document.getElementById('radio-sync-state-display');

        if (stateDisplay) {
            if (!isConnected) {
                // Show dashes when not connected
                stateDisplay.textContent = '--';
                stateDisplay.classList.remove('led-state-tx', 'led-state-rx');
            } else if (isTX) {
                stateDisplay.textContent = 'TX';
                stateDisplay.classList.remove('led-state-rx');
                stateDisplay.classList.add('led-state-tx');
            } else {
                stateDisplay.textContent = 'RX';
                stateDisplay.classList.remove('led-state-tx');
                stateDisplay.classList.add('led-state-rx');
            }
        }

        // Handle mute on TX (only when connected)
        if (isConnected && this.muteOnTX) {
            if (isTX && !wasTransmitting) {
                // Just started transmitting - mute SDR
                this.muteSDR();
            } else if (!isTX && wasTransmitting) {
                // Just stopped transmitting - unmute SDR
                this.unmuteSDR();
            }
        }
    }

    muteSDR() {
        try {
            // Store whether SDR was already muted before we mute it
            this.wasMutedBeforeTX = this.radio.getMuted();

            // Only mute if not already muted
            if (!this.wasMutedBeforeTX) {
                const result = this.radio.setMuted(true);

                if (result) {
                    this.addMessage('🔇 SDR muted (radio TX)', 'info');
                } else {
                    this.addMessage('Failed to mute SDR', 'warning');
                }
            }
        } catch (error) {
            console.error('Error in muteSDR:', error);
            this.addMessage(`Mute error: ${error.message}`, 'error');
        }
    }

    unmuteSDR() {
        try {
            // Only unmute if we muted it (don't unmute if it was already muted)
            if (!this.wasMutedBeforeTX) {
                const result = this.radio.setMuted(false);

                if (result) {
                    this.addMessage('🔊 SDR unmuted (radio RX)', 'info');
                } else {
                    this.addMessage('Failed to unmute SDR', 'warning');
                }
            }
        } catch (error) {
            console.error('Error in unmuteSDR:', error);
            this.addMessage(`Unmute error: ${error.message}`, 'error');
        }
    }

    async connectToRadio() {
        // Guard against overlapping attempts: repeat clicks while a connect is
        // already in flight (e.g. the device picker is still open) would each
        // call hamlibOpen() again, popping another picker and - if more than
        // one happened to succeed - leaking the earlier attempt's still-open
        // serial port since only the last rigHandle survives on `this`.
        if (this.isConnecting || this.isConnected) {
            return;
        }

        if (!this.selectedRadio) {
            this.addMessage('Please select a radio model first', 'warning');
            return;
        }

        if (!('serial' in navigator)) {
            this.addMessage('Web Serial API not available', 'error');
            return;
        }

        try {
            await this.ensureHamlibLoaded();
        } catch (error) {
            return; // ensureHamlibLoaded() already reported this
        }

        const modelSelect = document.getElementById('radio-sync-model');
        const option = modelSelect?.selectedOptions[0];
        if (!option) {
            this.addMessage('Please select a radio model first', 'warning');
            return;
        }

        const model = Number(this.selectedRadio);
        const baud = this.selectedBaudRate || Number(option.dataset.baud);
        const dataBits = Number(option.dataset.dataBits);
        const stopBits = Number(option.dataset.stopBits);
        const parity = Number(option.dataset.parity);
        const handshake = Number(option.dataset.handshake);

        this.isConnecting = true;
        const connectBtn = document.getElementById('radio-sync-connect');
        if (connectBtn) connectBtn.disabled = true;

        try {
            this.addMessage(`Connecting to ${option.dataset.name}...`, 'info');

            // This triggers the browser's Web Serial device picker.
            this.rigHandle = await this.hamlibOpen(model, baud, dataBits, stopBits, parity, handshake);

            if (this.rigHandle <= 0) {
                throw new Error('hamlib_open failed - check the message log / browser console for the Hamlib debug trace');
            }

            this.isConnected = true;
            this.addMessage(`Connected to ${option.dataset.name} at ${baud} baud`, 'success');

            // Update UI
            this.updateConnectionUI(true);

            // Start polling radio state (freq/mode/TX for display, and for radio-to-sdr sync)
            this.startRadioPolling();

            // Get current SDR state before syncing to radio
            this.currentFrequency = this.radio.getFrequency();
            this.currentMode = this.radio.getMode();

            // Send initial state to radio (for sdr-to-radio sync)
            if (this.syncMode === 'sdr-to-radio' || this.syncMode === 'both') {
                await this.sendFrequencyToRadio(this.currentFrequency);
                await this.sendModeToRadio(this.currentMode);
            }

        } catch (error) {
            this.addMessage(`Connection failed: ${error.message}`, 'error');
            this.isConnected = false;
            this.rigHandle = 0;
        } finally {
            this.isConnecting = false;
            if (connectBtn) connectBtn.disabled = !this.selectedRadio || this.isConnected;
        }
    }

    async disconnectFromRadio() {
        if (!this.rigHandle || this.isDisconnecting) return;

        this.isDisconnecting = true;

        try {
            this.stopRadioPolling();

            await this.hamlibClose(this.rigHandle);
            this.rigHandle = 0;
            this.isConnected = false;

            this.addMessage('Disconnected from radio', 'info');
            this.updateConnectionUI(false);

        } catch (error) {
            this.addMessage(`Disconnect error: ${error.message}`, 'error');
        } finally {
            this.isDisconnecting = false;
            // Reset display to dashes when disconnected
            this.updateFrequencyDisplay(0);
            this.updateModeDisplay('---');
            this.updateTXRXState(false, false);
        }
    }

    startRadioPolling() {
        // Stop any existing polling
        this.stopRadioPolling();

        // Poll radio every 100ms for freq/mode/TX state (always, for display and mute-on-TX).
        // Guarded by _pollingBusy so a round trip that runs long (real serial
        // hardware, not guaranteed to fit in 100ms) skips ticks instead of
        // piling up an ever-growing backlog of queued calls (see the
        // _hamlibQueue serialization in ensureHamlibLoaded()).
        this._pollingBusy = false;
        this._pollFailures = 0;
        this.radioPollingInterval = setInterval(async () => {
            if (!this.isConnected || !this.rigHandle || this._pollingBusy) return;

            this._pollingBusy = true;
            try {
                const freq = await this.hamlibGetFreq(this.rigHandle);
                if (freq >= 0) this.handleRadioFrequency(freq);

                const hamlibMode = await this.hamlibGetMode(this.rigHandle);
                if (hamlibMode) this.handleRadioMode(hamlibMode);

                const ptt = await this.hamlibGetPtt(this.rigHandle);
                if (ptt >= 0) this.updateTXRXState(ptt !== 0);

                // hamlib reports failure as a negative rc rather than throwing,
                // so a dead port would otherwise poll (and log) forever at 10Hz.
                if (freq < 0 && !hamlibMode && ptt < 0) {
                    this._pollFailures++;
                } else {
                    this._pollFailures = 0;
                }
            } catch (error) {
                console.error('Radio polling error:', error);
                this._pollFailures++;
            } finally {
                this._pollingBusy = false;
            }

            if (this._pollFailures >= MAX_POLL_FAILURES) {
                this.addMessage(
                    `Lost communication with radio (${this._pollFailures} failed polls) - disconnecting`,
                    'error');
                this.disconnectFromRadio();
            }
        }, 100); // Poll every 100ms (10 Hz) for responsive sync

        this.addMessage('Started polling radio state (freq/mode/TX) at 10 Hz', 'info');
    }

    stopRadioPolling() {
        if (this.radioPollingInterval) {
            clearInterval(this.radioPollingInterval);
            this.radioPollingInterval = null;
            this.addMessage('Stopped polling radio state', 'info');
        }
    }

    handleRadioFrequency(freq) {
        this.currentFrequency = freq;
        this.updateFrequencyDisplay(freq);

        if (this.syncMode === 'radio-to-sdr' || this.syncMode === 'both') {
            const currentSDRFreq = this.radio.getFrequency();
            if (freq !== currentSDRFreq) {
                // Set flag to prevent our event handlers from reacting
                this.updatingFromRadio = true;
                // Track this as the last sent frequency to prevent feedback
                this.lastSentFrequency = freq;
                this.radio.setFrequency(freq);
                // Clear flag immediately after event loop processes the event
                setTimeout(() => { this.updatingFromRadio = false; }, 0);
            }
        }
    }

    handleRadioMode(hamlibMode) {
        const sdrMode = HAMLIB_TO_SDR_MODE[hamlibMode] || hamlibMode.toLowerCase();
        this.currentMode = sdrMode;
        this.updateModeDisplay(sdrMode);

        // The rig can legitimately sit in modes the SDR has no equivalent for -
        // PKTUSB/PKTLSB/RTTY/..., i.e. any data-mode operating such as FT8.
        // radio.setMode() rejects those outright, so pushing one at the SDR just
        // fails silently; worse, recording it in lastSentMode makes the next
        // pollSDRState() tick see a mismatch and "correct" the radio back to the
        // SDR's mode, dragging the rig out of data mode. Show it on the display
        // but leave both ends alone, and keep lastSentMode tracking what the SDR
        // is actually on so nothing gets pushed back.
        if (!(sdrMode in SDR_TO_HAMLIB_MODE)) {
            this.lastSentMode = this.radio.getMode();
            return;
        }

        if (this.syncMode === 'radio-to-sdr' || this.syncMode === 'both') {
            const currentSDRMode = this.radio.getMode();
            if (sdrMode !== currentSDRMode) {
                // Set flag to prevent our event handlers from reacting
                this.updatingFromRadio = true;
                // Track this as the last sent mode to prevent feedback
                this.lastSentMode = sdrMode;
                this.radio.setMode(sdrMode);
                // Clear flag immediately after event loop processes the event
                setTimeout(() => { this.updatingFromRadio = false; }, 0);
            }
        }
    }

    updateConnectionUI(connected) {
        const connectBtn = document.getElementById('radio-sync-connect');
        const disconnectBtn = document.getElementById('radio-sync-disconnect');
        const baudRateSelect = document.getElementById('radio-sync-baud-rate');

        if (connectBtn && disconnectBtn) {
            if (connected) {
                connectBtn.style.display = 'none';
                disconnectBtn.style.display = 'inline-block';
                // Disable baud rate selection when connected
                if (baudRateSelect) {
                    baudRateSelect.disabled = true;
                }
            } else {
                connectBtn.style.display = 'inline-block';
                connectBtn.disabled = !this.selectedRadio;
                disconnectBtn.style.display = 'none';
                // Enable baud rate selection when disconnected
                if (baudRateSelect) {
                    baudRateSelect.disabled = false;
                }
            }
        }
    }

    async sendFrequencyToRadio(freq) {
        if (!this.isConnected || !this.rigHandle) return;

        try {
            await this.hamlibSetFreq(this.rigHandle, freq);
            this.addMessage(`Set radio frequency: ${this.radio.formatFrequency(freq)}`, 'success');
        } catch (error) {
            this.addMessage(`Failed to set frequency: ${error.message}`, 'error');
        }
    }

    async sendModeToRadio(mode) {
        if (!this.isConnected || !this.rigHandle) return;

        try {
            const hamlibMode = SDR_TO_HAMLIB_MODE[mode] || mode.toUpperCase();
            await this.hamlibSetMode(this.rigHandle, hamlibMode);
            this.addMessage(`Set radio mode: ${mode.toUpperCase()}`, 'success');
        } catch (error) {
            this.addMessage(`Failed to set mode: ${error.message}`, 'error');
        }
    }

    addMessage(message, type = 'info') {
        const messagesDiv = document.getElementById('radio-sync-messages');
        if (!messagesDiv) return;

        const timestamp = new Date().toLocaleTimeString();
        const messageDiv = document.createElement('div');
        messageDiv.className = `radio-sync-message radio-sync-message-${type}`;
        messageDiv.textContent = `[${timestamp}] ${message}`;

        messagesDiv.appendChild(messageDiv);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;

        // Keep only last 1000 messages
        while (messagesDiv.children.length > 1000) {
            messagesDiv.removeChild(messagesDiv.firstChild);
        }
    }

    getContentElement() {
        const panel = document.querySelector('.decoder-extension-panel');
        if (panel) {
            return panel.querySelector('.decoder-extension-content');
        }
        return null;
    }

    onEnable() {
        console.log('Radio Sync Extension onEnable called');

        // Set up event listeners now that template is definitely in DOM
        this.setupEventListeners();

        // Load the Hamlib wasm module and populate the radio dropdown from it.
        // Fire-and-forget: showHamlibLoadError() already reports failure in the
        // UI, and connectToRadio() retries the load if the user tries anyway.
        this.ensureHamlibLoaded().catch(() => {});

        // Subscribe to radio events for SDR changes
        this.subscribeToRadioEvents();

        // Set initial sync mode button state
        this.setSyncMode(this.syncMode);

        // Check for Web Serial API support and show error if not available
        if (!('serial' in navigator)) {
            this.showSerialAPIError();
        }

        this.addMessage('Radio Sync extension enabled', 'success');

        // Start periodic updates to poll SDR state
        this.updateInterval = setInterval(() => {
            this.pollSDRState();
        }, 100); // Update every 100ms (10 Hz) for responsive sync

        // Initial update
        this.updateFromSDR();
    }

    onDisable() {
        this.addMessage('Radio Sync extension disabled', 'info');

        // Stop periodic updates
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }

        // Disconnect if connected
        if (this.isConnected) {
            this.disconnectFromRadio();
        }
    }

    pollSDRState() {
        // If not connected, ensure display shows dashes
        if (!this.isConnected) {
            this.updateFrequencyDisplay(0);
            this.updateModeDisplay('---');
            return;
        }

        // Poll SDR state and send changes to radio if in sdr-to-radio or both mode
        if (this.syncMode !== 'sdr-to-radio' && this.syncMode !== 'both') {
            return;
        }

        const sdrFreq = this.radio.getFrequency();
        const sdrMode = this.radio.getMode();

        // Check if SDR frequency changed and send to radio
        if (sdrFreq !== this.lastSentFrequency) {
            this.lastSentFrequency = sdrFreq;
            this.sendFrequencyToRadio(sdrFreq);
        }

        // Check if SDR mode changed and send to radio
        if (sdrMode !== this.lastSentMode) {
            this.lastSentMode = sdrMode;
            this.sendModeToRadio(sdrMode);
        }
    }

    onProcessAudio(dataArray) {
        // Not used for this extension
    }

    onFrequencyChanged(frequency) {
        // Ignore if we're currently updating from radio (prevents feedback loop)
        if (this.updatingFromRadio) return;

        // Only send if frequency actually changed from what we last sent
        if (frequency === this.lastSentFrequency) return;

        // Send to radio if in sdr-to-radio or both mode
        if (this.isConnected && (this.syncMode === 'sdr-to-radio' || this.syncMode === 'both')) {
            this.lastSentFrequency = frequency;
            this.sendFrequencyToRadio(frequency);
        }
    }

    onModeChanged(mode) {
        // Ignore if we're currently updating from radio (prevents feedback loop)
        if (this.updatingFromRadio) return;

        // Only send if mode actually changed from what we last sent
        if (mode === this.lastSentMode) return;

        // Send to radio if in sdr-to-radio or both mode
        if (this.isConnected && (this.syncMode === 'sdr-to-radio' || this.syncMode === 'both')) {
            this.lastSentMode = mode;
            this.sendModeToRadio(mode);
        }
    }
}

// Register the extension
if (window.decoderManager) {
    window.decoderManager.register(new RadioSyncExtension());
    console.log('✅ Radio Sync Extension registered');
}
