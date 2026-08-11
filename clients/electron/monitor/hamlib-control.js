// Rig Control — synchronise frequency and mode between multi-monitor and a real
// radio over CAT, using Hamlib compiled to WebAssembly on top of the Web Serial
// API.  No protocol code lives here: hamlib.wasm's own rig backends do the
// talking, so every serial-capable rig Hamlib supports works.
//
// The bundle (hamlib.js + hamlib.wasm + hamlib-serial-bridge.js, ~14 MB, fetched
// into static/hamlib/ by download-hamlib.sh) is requested only when the user
// opens the Rig modal — never on page load.  See ensureHamlibLoaded().
//
// Loaded after multi_monitor.js, so it shares that file's global lexical scope:
// currentFreqHz / currentMode / modality / modeOverride and the retune helpers
// are read and written directly, the same way shared_session.js does.

(function () {
    'use strict';

    const HAMLIB_BASE_URL = 'hamlib';

    // How often the rig is polled for freq / mode / PTT.  Each tick is three
    // serialised CAT round trips, so on a slow link the pollBusy guard below is
    // what actually paces this — the interval only sets the floor.
    const POLL_INTERVAL_MS = 150;

    // Consecutive fully-failed poll cycles (freq + mode + PTT all erroring)
    // before the link is treated as dead.  Hamlib reports failure as a negative
    // return code rather than throwing, so without this a yanked USB cable
    // would poll and log forever.
    const MAX_POLL_FAILURES = 20;

    // multi-monitor's SDR modes vs. Hamlib's canonical rig_strrmode() names.
    // Only these four exist here: resolveMode() and bandwidthForMode() in
    // multi_monitor.js have no notion of AM/FM/data modes, so a rig sitting in
    // one of those is displayed but never pushed at the SDR.
    const SDR_TO_HAMLIB_MODE = { usb: 'USB', lsb: 'LSB', cwu: 'CW', cwl: 'CWR' };
    const HAMLIB_TO_SDR_MODE = { USB: 'usb', LSB: 'lsb', CW: 'cwu', CWR: 'cwl' };

    // Offered for every rig, with the rig's own Hamlib default preselected.
    const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];

    const LS_RIG_KEY = 'mm_rig_prefs';

    // ── State ────────────────────────────────────────────────────────────────

    let hamlibModule    = null;
    let api             = null;    // cwrapped Hamlib entry points, set by ensureHamlibLoaded()
    let loadPromise     = null;
    let rigs            = [];      // hamlib_list_rigs() output
    let rigHandle       = 0;
    let isConnected     = false;
    let isConnecting    = false;   // guards overlapping connect() calls (impatient repeat clicks)

    let selectedModel = null;      // Hamlib rig model number, as a string
    let selectedBaud  = null;
    let direction     = 'rig-to-sdr';  // 'rig-to-sdr' | 'sdr-to-rig'
    let muteOnTx      = true;

    let pollTimer    = null;
    let pollBusy     = false;
    let pollFailures = 0;

    let txState          = false;
    let lastOutOfRangeHz = 0;      // throttles the out-of-band warning

    // Last values pushed to the rig in sdr-to-rig mode, so an unchanged SDR
    // doesn't re-issue set_freq / set_mode on every tick.
    let lastSentFreq = 0;
    let lastSentMode = '';

    // ── Loading ──────────────────────────────────────────────────────────────

    /**
     * Fetch and instantiate the Hamlib bundle exactly once, cwrap its API and
     * populate the rig list.  Safe to call repeatedly; a failed load is not
     * cached so the next attempt starts from scratch.
     */
    function ensureHamlibLoaded() {
        if (loadPromise) return loadPromise;

        loadPromise = (async () => {
            setStatus('Loading Hamlib (~14 MB, one-time)…', 'info');

            if (typeof window.HamlibSerialBridge === 'undefined') {
                await new Promise((resolve, reject) => {
                    const script = document.createElement('script');
                    script.src = `${HAMLIB_BASE_URL}/hamlib-serial-bridge.js`;
                    script.onload = resolve;
                    script.onerror = () => reject(new Error('failed to load hamlib-serial-bridge.js'));
                    document.head.appendChild(script);
                });
            }

            const { default: createHamlibModule } = await import(`./${HAMLIB_BASE_URL}/hamlib.js`);
            const bridge = new window.HamlibSerialBridge();
            const Module = await createHamlibModule({
                hamlibSerial: bridge,
                // Hamlib's own debug trace — the only useful diagnostic when a
                // rig refuses to open, so route it into the message log too.
                print:    (text) => addMessage(text, 'info'),
                printErr: (text) => addMessage(text, 'warning'),
            });

            hamlibModule = Module;

            // hamlib.wasm is built with plain -sASYNCIFY, which allows only one
            // in-flight async call into the module at a time: a second one
            // entered before the first unwinds corrupts Asyncify's stack and
            // Hamlib's shared command/response buffers.  Route every call
            // through one queue so the module only ever sees one at a time.
            let queue = Promise.resolve();
            const serialize = (fn) => (...args) => {
                const result = queue.then(() => fn(...args));
                queue = result.then(() => {}, () => {});
                return result;
            };

            api = {
                open:    serialize(Module.cwrap('hamlib_open', 'number',
                    ['number', 'number', 'number', 'number', 'number', 'number'], { async: true })),
                close:   serialize(Module.cwrap('hamlib_close',    'number', ['number'], { async: true })),
                getFreq: serialize(Module.cwrap('hamlib_get_freq', 'number', ['number'], { async: true })),
                setFreq: serialize(Module.cwrap('hamlib_set_freq', 'number', ['number', 'number'], { async: true })),
                getMode: serialize(Module.cwrap('hamlib_get_mode', 'string', ['number'], { async: true })),
                setMode: serialize(Module.cwrap('hamlib_set_mode', 'number', ['number', 'string'], { async: true })),
                getPtt:  serialize(Module.cwrap('hamlib_get_ptt',  'number', ['number'], { async: true })),
            };

            // No I/O, so this one stays a plain synchronous call.
            rigs = JSON.parse(Module.cwrap('hamlib_list_rigs', 'string', [])());
            populateRigList();
            applyPrefsToUI();

            setStatus(`Hamlib ready — ${rigs.length} radios available`, 'ok');
            addMessage(`Hamlib loaded: ${rigs.length} radios available`, 'success');
        })();

        // Never cache a rejection: the 14 MB fetch can fail transiently, and a
        // held rejected promise would make every later attempt bail out on it
        // until the page is reloaded.
        loadPromise.catch((err) => {
            loadPromise = null;
            hamlibModule = null;
            console.error('Rig Control: failed to load Hamlib', err);
            setStatus(`Hamlib failed to load: ${err.message}`, 'error');
            addMessage(`Hamlib load error: ${err.message}`, 'error');
        });

        return loadPromise;
    }

    // ── Rig list + baud dropdowns ────────────────────────────────────────────

    /**
     * Build both halves of the radio picker from hamlib_list_rigs():
     *
     *  - the hidden <select>, which stays the single source of truth — each
     *    <option>'s dataset carries the serial settings hamlib_open() needs, so
     *    connectRig() never has to know the combobox exists;
     *  - the visible listbox the user filters and clicks, whose entries carry
     *    the matching option value.
     *
     * 270-odd rigs across dozens of manufacturers is miserable to scroll, hence
     * type-to-filter — the same arrangement UberSDR's radio-sync extension uses.
     */
    function populateRigList() {
        const select  = document.getElementById('rigModelSelect');
        const listbox = document.getElementById('rigModelListbox');
        if (!select || !listbox) return;

        const byMfg = new Map();
        for (const rig of rigs) {
            if (!byMfg.has(rig.mfg)) byMfg.set(rig.mfg, []);
            byMfg.get(rig.mfg).push(rig);
        }

        select.innerHTML = '<option value=""></option>';
        listbox.innerHTML = '';

        for (const mfg of [...byMfg.keys()].sort((a, b) => a.localeCompare(b))) {
            const group = document.createElement('optgroup');
            group.label = mfg;

            const label = document.createElement('div');
            label.className = 'rig-combobox-group';
            label.textContent = mfg;
            listbox.appendChild(label);

            for (const rig of byMfg.get(mfg).sort((a, b) => a.name.localeCompare(b.name))) {
                const option = document.createElement('option');
                option.value = String(rig.model);
                option.textContent = rig.name;
                option.dataset.name      = `${rig.mfg} ${rig.name}`;
                option.dataset.baud      = rig.baudMax;
                option.dataset.dataBits  = rig.dataBits;
                option.dataset.stopBits  = rig.stopBits;
                option.dataset.parity    = rig.parity;
                option.dataset.handshake = rig.handshake;
                group.appendChild(option);

                const item = document.createElement('div');
                item.className = 'rig-combobox-option';
                item.setAttribute('role', 'option');
                item.dataset.value = String(rig.model);
                item.dataset.searchText = `${rig.mfg} ${rig.name}`.toLowerCase();
                item.textContent = rig.name;
                listbox.appendChild(item);
            }
            select.appendChild(group);
        }

        const input = document.getElementById('rigModelInput');
        if (input) {
            input.disabled = false;
            input.placeholder = 'Type to search radios…';
        }
        const count = document.getElementById('rigFilterCount');
        if (count) count.textContent = `${rigs.length} radios`;

        syncConnectButton();
    }

    /**
     * Wire the search input and listbox. Selecting an entry just drives the
     * hidden <select> and fires its 'change', so onModelChanged() and everything
     * downstream stay unaware of the combobox.
     */
    function setupCombobox() {
        const input    = document.getElementById('rigModelInput');
        const clearBtn = document.getElementById('rigModelClear');
        const listbox  = document.getElementById('rigModelListbox');
        const select   = document.getElementById('rigModelSelect');
        const combobox = document.getElementById('rigCombobox');
        if (!input || !clearBtn || !listbox || !select || !combobox) return;

        const visibleOptions = () =>
            [...listbox.querySelectorAll('.rig-combobox-option')]
                .filter((el) => el.style.display !== 'none');

        const setActive = (el) => {
            listbox.querySelectorAll('.rig-combobox-option.is-active')
                .forEach((other) => other.classList.remove('is-active'));
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
            let shown = 0;

            // Hide a manufacturer's heading when none of its rigs match.
            listbox.querySelectorAll('.rig-combobox-group').forEach((label) => {
                let node = label.nextElementSibling;
                let groupHasMatch = false;
                while (node && !node.classList.contains('rig-combobox-group')) {
                    const match = !query || node.dataset.searchText.includes(query);
                    node.style.display = match ? '' : 'none';
                    if (match) { groupHasMatch = true; shown++; }
                    node = node.nextElementSibling;
                }
                label.style.display = groupHasMatch ? '' : 'none';
            });

            let empty = listbox.querySelector('.rig-combobox-empty');
            if (!shown && !empty) {
                empty = document.createElement('div');
                empty.className = 'rig-combobox-empty';
                empty.textContent = 'No matching radios';
                listbox.appendChild(empty);
            } else if (shown && empty) {
                empty.remove();
            }

            const count = document.getElementById('rigFilterCount');
            if (count) {
                count.textContent = query ? `${shown} of ${rigs.length}` : `${rigs.length} radios`;
            }

            setActive(null);
        };

        const selectOption = (optionEl) => {
            select.value = optionEl.dataset.value;
            select.dispatchEvent(new Event('change'));
            setInputToSelection();
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
                const visible = visibleOptions();
                if (!visible.length) return;
                const current = listbox.querySelector('.rig-combobox-option.is-active');
                let idx = current ? visible.indexOf(current) : -1;
                idx = e.key === 'ArrowDown'
                    ? Math.min(idx + 1, visible.length - 1)
                    : Math.max(idx - 1, 0);
                setActive(visible[idx]);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const active = listbox.querySelector('.rig-combobox-option.is-active');
                const visible = visibleOptions();
                // A single remaining match is unambiguous — take it without
                // making the user arrow down to it first.
                const target = active || (visible.length === 1 ? visible[0] : null);
                if (target) selectOption(target);
            } else if (e.key === 'Escape') {
                setInputToSelection();
                closeList();
            }
        });

        listbox.addEventListener('mousedown', (e) => {
            const optionEl = e.target.closest('.rig-combobox-option');
            if (!optionEl) return;
            e.preventDefault();   // keep focus in the input, avoid a blur/close race
            selectOption(optionEl);
        });

        clearBtn.addEventListener('click', () => {
            select.value = '';
            select.dispatchEvent(new Event('change'));
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

    /** Show the hidden select's current pick as the input's text. */
    function setInputToSelection() {
        const select   = document.getElementById('rigModelSelect');
        const input    = document.getElementById('rigModelInput');
        const clearBtn = document.getElementById('rigModelClear');
        if (!select || !input) return;

        const option = select.selectedOptions[0];
        input.value = select.value && option ? option.dataset.name : '';
        if (clearBtn) clearBtn.style.display = select.value ? 'inline-block' : 'none';
    }

    function populateBaudList(defaultBaud) {
        const select = document.getElementById('rigBaudSelect');
        if (!select) return;

        // A rig's Hamlib default may not be one of the common rates (some sit at
        // 4800 or 1200), and neither may a previously saved pick — fold both in
        // rather than losing them.
        const rates = [...new Set([...BAUD_RATES, defaultBaud, selectedBaud].filter(Boolean))]
            .sort((a, b) => a - b);

        select.innerHTML = '';
        for (const rate of rates) {
            const option = document.createElement('option');
            option.value = String(rate);
            option.textContent = String(rate);
            select.appendChild(option);
        }
        select.value = String(selectedBaud || defaultBaud);
        selectedBaud = parseInt(select.value, 10) || defaultBaud;
    }

    // ── Preferences ──────────────────────────────────────────────────────────

    function savePrefs() {
        try {
            localStorage.setItem(LS_RIG_KEY, JSON.stringify({
                model:     selectedModel,
                baud:      selectedBaud,
                direction: direction,
                muteOnTx:  muteOnTx,
            }));
        } catch (e) { /* localStorage unavailable (private browsing, quota) */ }
    }

    /**
     * Pull saved settings into module state at load time. Read this early —
     * before anything can call savePrefs() — or the first save of the session
     * would overwrite the stored rig with the not-yet-restored defaults.
     */
    function loadPrefs() {
        let prefs = null;
        try {
            prefs = JSON.parse(localStorage.getItem(LS_RIG_KEY) || 'null');
        } catch (e) { /* corrupt entry — ignore */ }
        if (!prefs) return;

        if (prefs.model) selectedModel = String(prefs.model);
        if (prefs.baud)  selectedBaud  = prefs.baud;
        if (prefs.direction === 'sdr-to-rig' || prefs.direction === 'rig-to-sdr') {
            direction = prefs.direction;
        }
        if (typeof prefs.muteOnTx === 'boolean') muteOnTx = prefs.muteOnTx;
    }

    /** Reflect the loaded settings in the UI, once the rig list is populated. */
    function applyPrefsToUI() {
        const box = document.getElementById('rigMuteOnTx');
        if (box) box.checked = muteOnTx;

        const select = document.getElementById('rigModelSelect');
        // The rig may have vanished from a newer Hamlib build.
        if (selectedModel && select?.querySelector(`option[value="${selectedModel}"]`)) {
            select.value = selectedModel;
            onModelChanged();
            setInputToSelection();
        }
        setDirection(direction);
    }

    // ── Modal ────────────────────────────────────────────────────────────────

    function openRigModal() {
        const overlay = document.getElementById('rigModalOverlay');
        if (!overlay) return;
        overlay.classList.add('open');

        // Followers can drive their rig from the shared session but can't tune
        // the session, so lock the direction to sdr-to-rig for them.
        const follower = typeof isFollowerMode !== 'undefined' && isFollowerMode;
        const rigToSdrBtn = document.getElementById('rigDirRigToSdr');
        if (rigToSdrBtn) {
            rigToSdrBtn.disabled = follower;
            rigToSdrBtn.title = follower
                ? 'Unavailable while following a shared session — the host controls the frequency'
                : 'The radio tunes the SDRs';
        }
        // Don't persist a direction the user didn't choose — they may open the
        // same page later as the host.
        setDirection(follower ? 'sdr-to-rig' : direction, false);

        if (!('serial' in navigator)) {
            // The red box states the requirement outright, so drop the advisory
            // note rather than saying it twice.
            const err  = document.getElementById('rigSerialError');
            const note = document.getElementById('rigBrowserNote');
            if (err)  err.style.display  = 'block';
            if (note) note.style.display = 'none';
            setStatus('Web Serial API not available in this browser', 'error');
            return;
        }

        // Clicking "Rig Sync" is the opt-in: this is the only thing that ever pulls
        // hamlib.js / hamlib.wasm / hamlib-serial-bridge.js down.  Failure is
        // already reported in the modal, so swallow it here rather than leaving
        // an unhandled rejection behind.
        ensureHamlibLoaded().catch(() => {});
    }

    function closeRigModal() {
        document.getElementById('rigModalOverlay')?.classList.remove('open');
    }

    function rigModalOverlayClick(e) {
        if (e.target === document.getElementById('rigModalOverlay')) closeRigModal();
    }

    // ── Connect / disconnect ─────────────────────────────────────────────────

    function onModelChanged() {
        const select = document.getElementById('rigModelSelect');
        const option = select?.selectedOptions[0];
        selectedModel = select?.value || null;

        if (selectedModel && option) {
            populateBaudList(parseInt(option.dataset.baud, 10));
            addMessage(`Selected: ${option.dataset.name}`, 'info');
        }
        syncConnectButton();
        savePrefs();
    }

    function onBaudChanged() {
        selectedBaud = parseInt(document.getElementById('rigBaudSelect').value, 10);
        addMessage(`Baud rate: ${selectedBaud}`, 'info');
        savePrefs();
    }

    function onMuteOnTxChanged(checked) {
        muteOnTx = checked;
        // Leaving TX-mute on while switching it off would strand the SDRs muted.
        if (!muteOnTx && txState) setSdrMuted(false);
        savePrefs();
    }

    function setDirection(dir, persist = true) {
        direction = dir;
        for (const [key, id] of [['sdr-to-rig', 'rigDirSdrToRig'], ['rig-to-sdr', 'rigDirRigToSdr']]) {
            document.getElementById(id)?.classList.toggle('active', key === dir);
        }
        // Whichever side is now the master starts from a clean slate: drop the
        // change-detection baselines so the next tick pushes current state.
        lastSentFreq = 0;
        lastSentMode = '';
        lastOutOfRangeHz = 0;
        if (persist) savePrefs();
    }

    function syncConnectButton() {
        const connectBtn = document.getElementById('rigConnectBtn');
        if (!connectBtn) return;
        connectBtn.disabled = !selectedModel || isConnecting || isConnected;
        connectBtn.textContent = selectedModel ? '🔌 Connect' : 'Select a radio first';
    }

    async function connectRig() {
        // Repeat clicks while the device picker is open would each call
        // hamlib_open(), popping another picker and leaking the earlier port.
        if (isConnecting || isConnected) return;

        if (!selectedModel) {
            setStatus('Select a radio model first', 'error');
            return;
        }
        if (!('serial' in navigator)) {
            setStatus('Web Serial API not available in this browser', 'error');
            return;
        }

        // A first Connect on a slow link can land here before the bundle has
        // finished loading, so wait for it.  Failure is reported by
        // ensureHamlibLoaded() itself — just don't proceed.
        try {
            await ensureHamlibLoaded();
        } catch (err) {
            return;
        }
        if (!api) return;

        const option = document.getElementById('rigModelSelect')?.selectedOptions[0];
        if (!option) return;

        isConnecting = true;
        syncConnectButton();

        try {
            setStatus(`Connecting to ${option.dataset.name}…`, 'info');
            addMessage(`Connecting to ${option.dataset.name} at ${selectedBaud} baud…`, 'info');

            // Pops the browser's serial device picker.
            rigHandle = await api.open(
                Number(selectedModel),
                selectedBaud,
                Number(option.dataset.dataBits),
                Number(option.dataset.stopBits),
                Number(option.dataset.parity),
                Number(option.dataset.handshake));

            if (rigHandle <= 0) {
                throw new Error('hamlib_open failed — see the message log for Hamlib\'s trace');
            }

            isConnected = true;
            setStatus(`Connected to ${option.dataset.name}`, 'ok');
            addMessage(`Connected to ${option.dataset.name}`, 'success');
            syncConnectionUI(true);
            startPolling();

            if (direction === 'sdr-to-rig') await pushSdrStateToRig(true);
        } catch (err) {
            isConnected = false;
            rigHandle = 0;
            setStatus(`Connection failed: ${err.message}`, 'error');
            addMessage(`Connection failed: ${err.message}`, 'error');
        } finally {
            isConnecting = false;
            syncConnectButton();
        }
    }

    /**
     * Disconnect is deliberately not awaited on hamlib_close().
     *
     * Every call into the module — close included — is serialised behind the
     * single Asyncify queue, so close() can only start once any in-flight poll
     * cycle has finished, and on a rig that has stopped answering that cycle is
     * grinding through hamlib's own per-command retries first. Waiting for it
     * before touching the UI makes this button look broken precisely when the
     * link is, which is when people reach for it. So tear down state and UI
     * synchronously — nothing can interleave, since zeroing rigHandle happens
     * with no await in between — and let the port close in the background.
     */
    function disconnectRig() {
        if (!rigHandle) return;

        const handle = rigHandle;
        rigHandle   = 0;
        isConnected = false;
        stopPolling();
        if (txState) setSdrMuted(false);
        txState = false;
        updateRigDisplay(0, '', false);
        syncConnectionUI(false);
        syncConnectButton();
        setStatus('Disconnecting…', 'info');
        addMessage('Disconnecting…', 'info');

        api.close(handle).then(() => {
            addMessage('Disconnected from radio', 'info');
            setStatus('Disconnected', 'idle');
        }).catch((err) => {
            // The rig is already released as far as this page is concerned; say
            // so plainly, because the OS-level port may still be held.
            addMessage(`Disconnect error: ${err.message}`, 'error');
            setStatus('Disconnected — the serial port may not have closed cleanly', 'error');
        });
    }

    function syncConnectionUI(connected) {
        const connectBtn    = document.getElementById('rigConnectBtn');
        const disconnectBtn = document.getElementById('rigDisconnectBtn');
        const modelInput    = document.getElementById('rigModelInput');
        const modelClear    = document.getElementById('rigModelClear');
        const baudSelect    = document.getElementById('rigBaudSelect');
        const toolbarBtn    = document.getElementById('rigControlBtn');

        if (connectBtn)    connectBtn.style.display    = connected ? 'none' : 'inline-block';
        if (disconnectBtn) disconnectBtn.style.display = connected ? 'inline-block' : 'none';
        // Changing the rig or baud rate mid-session would silently not apply —
        // Hamlib is already open on the old settings.
        if (modelInput)    modelInput.disabled = connected;
        if (modelClear)    modelClear.style.visibility = connected ? 'hidden' : '';
        if (baudSelect)    baudSelect.disabled = connected;
        if (toolbarBtn)    toolbarBtn.classList.toggle('active', connected);
    }

    // ── Polling ──────────────────────────────────────────────────────────────

    function startPolling() {
        stopPolling();
        pollBusy = false;
        pollFailures = 0;

        pollTimer = setInterval(async () => {
            if (!isConnected || !rigHandle || pollBusy) return;

            // Pin the handle for this cycle: disconnectRig() can zero rigHandle
            // between our awaits, and passing 0 into the next call would just
            // earn an error that looks like a rig fault.
            const handle = rigHandle;

            pollBusy = true;
            try {
                const freq = await api.getFreq(handle);
                const mode = await api.getMode(handle);
                const ptt  = await api.getPtt(handle);

                // Disconnected while we were waiting — these readings are stale
                // and there is nothing left to apply them to.
                if (rigHandle !== handle) return;

                if (freq < 0 && !mode && ptt < 0) {
                    pollFailures++;
                } else {
                    pollFailures = 0;
                    updateRigDisplay(freq > 0 ? freq : 0, mode || '', ptt > 0);
                    if (ptt >= 0) handlePtt(ptt !== 0);
                    if (direction === 'rig-to-sdr') {
                        applyRigStateToSdr(freq > 0 ? freq : 0, mode || '');
                    } else {
                        await pushSdrStateToRig(false);
                    }
                }
            } catch (err) {
                console.error('Rig Control: poll error', err);
                pollFailures++;
            } finally {
                pollBusy = false;
            }

            // Same again for the failure path: don't announce a dead link the
            // user has already walked away from.
            if (rigHandle === handle && pollFailures >= MAX_POLL_FAILURES) {
                addMessage(`Lost communication with radio (${pollFailures} failed polls) — disconnecting`, 'error');
                setStatus('Lost communication with radio', 'error');
                disconnectRig();
            }
        }, POLL_INTERVAL_MS);
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    // ── Rig → SDR ────────────────────────────────────────────────────────────

    /**
     * Tune every monitored SDR to the rig's frequency and mode.
     *
     * Mirrors shared_session.js's _applySharedState(): write modality /
     * modeOverride directly, then poke the frequency input so the existing
     * applyFreq() machinery does one retune with the new mode and bandwidth,
     * and keeps the display, band filter, Smart Listen modal and URL in sync.
     */
    function applyRigStateToSdr(freqHz, hamlibMode) {
        // Followers never tune: the shared session's host owns frequency and
        // mode.  openRigModal() locks the direction for them, this is the belt.
        if (typeof isFollowerMode !== 'undefined' && isFollowerMode) return;

        const sdrMode = HAMLIB_TO_SDR_MODE[hamlibMode] || null;

        // The rig can legitimately sit in a mode the SDR has no equivalent for
        // (PKTUSB/RTTY/AM/FM…).  Show it, but leave the SDR's mode alone rather
        // than dragging the operator out of it.
        const modeChanged = sdrMode !== null
            && (sdrMode !== currentMode || modeOverride !== sdrMode);

        const mhz = freqHz / 1e6;
        let freqChanged = freqHz > 0 && freqHz !== currentFreqHz;
        if (freqChanged && (mhz < 0.1 || mhz > 30)) {
            // 2 m / 70 cm and the rig's transverter ranges are simply not
            // tunable here — warn once per frequency instead of every 150 ms.
            if (freqHz !== lastOutOfRangeHz) {
                lastOutOfRangeHz = freqHz;
                addMessage(`Radio on ${mhz.toFixed(6)} MHz — outside the SDR range (0.1–30 MHz), not following`, 'warning');
            }
            freqChanged = false;
        }

        if (!modeChanged && !freqChanged) return;

        if (modeChanged) {
            modality     = (sdrMode === 'cwu' || sdrMode === 'cwl') ? 'cw' : 'phone';
            modeOverride = sdrMode;
            if (typeof syncModalityUI === 'function') syncModalityUI();
        }

        // Dispatch even when only the mode changed: applyFreq() is what rebuilds
        // the bandwidth and retunes, and it reads the frequency from state.
        const targetMhz = (freqChanged ? freqHz : currentFreqHz) / 1e6;
        const slider = document.getElementById('freqSlider');
        const input  = document.getElementById('freqInput');
        if (slider) slider.value = targetMhz.toFixed(6);
        if (input) {
            input.value = targetMhz.toFixed(6);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    // ── SDR → Rig ────────────────────────────────────────────────────────────

    /** Send the SDR's frequency and mode to the rig when either has changed. */
    async function pushSdrStateToRig(force) {
        if (!isConnected || !rigHandle) return;

        if (force || currentFreqHz !== lastSentFreq) {
            lastSentFreq = currentFreqHz;
            try {
                await api.setFreq(rigHandle, currentFreqHz);
                addMessage(`Radio → ${(currentFreqHz / 1e6).toFixed(6)} MHz`, 'success');
            } catch (err) {
                addMessage(`Failed to set radio frequency: ${err.message}`, 'error');
            }
        }

        if (force || currentMode !== lastSentMode) {
            lastSentMode = currentMode;
            const hamlibMode = SDR_TO_HAMLIB_MODE[currentMode];
            if (hamlibMode) {
                try {
                    await api.setMode(rigHandle, hamlibMode);
                    addMessage(`Radio → ${hamlibMode}`, 'success');
                } catch (err) {
                    addMessage(`Failed to set radio mode: ${err.message}`, 'error');
                }
            }
        }
    }

    // ── PTT ──────────────────────────────────────────────────────────────────

    function handlePtt(isTx) {
        if (isTx === txState) return;
        txState = isTx;
        if (!muteOnTx) return;

        if (isTx) {
            setSdrMuted(true);
            addMessage('🔇 SDR audio muted (radio TX)', 'info');
        } else {
            setSdrMuted(false);
            addMessage('🔊 SDR audio unmuted (radio RX)', 'info');
        }
    }

    /**
     * Mute/unmute via the radioAPI shim, which saves and restores per-radio
     * volumes so channel assignments and play-best survive the PTT cycle.
     * This covers directly-connected instances; relayed audio in follower mode
     * is not affected.
     */
    function setSdrMuted(muted) {
        if (window.radioAPI && typeof window.radioAPI.setMuted === 'function') {
            window.radioAPI.setMuted(muted);
        }
    }

    // ── Display + log ────────────────────────────────────────────────────────

    function updateRigDisplay(freqHz, hamlibMode, isTx) {
        const freqEl = document.getElementById('rigFreqDisplay');
        if (freqEl) {
            freqEl.textContent = freqHz > 0
                ? (freqHz / 1e6).toFixed(6)
                : '--.------';
        }

        const modeEl = document.getElementById('rigModeDisplay');
        if (modeEl) modeEl.textContent = hamlibMode || '---';

        const stateEl = document.getElementById('rigStateDisplay');
        if (stateEl) {
            const connected = isConnected;
            stateEl.textContent = connected ? (isTx ? 'TX' : 'RX') : '--';
            stateEl.classList.toggle('tx', connected && isTx);
            stateEl.classList.toggle('rx', connected && !isTx);
        }
    }

    function setStatus(text, kind) {
        const el = document.getElementById('rigStatus');
        if (!el) return;
        el.textContent = text;
        el.className = `rig-status rig-status-${kind || 'idle'}`;
    }

    function addMessage(text, type) {
        const log = document.getElementById('rigLog');
        if (!log) return;

        const line = document.createElement('div');
        line.className = `rig-log-${type || 'info'}`;
        line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;

        while (log.children.length > 500) log.removeChild(log.firstChild);
    }

    // ── Wiring ───────────────────────────────────────────────────────────────

    // Release the serial port when the tab goes away so other CAT software
    // (WSJT-X, a logger) isn't locked out until the browser gets round to it.
    window.addEventListener('pagehide', () => {
        if (rigHandle && api) api.close(rigHandle);
    });

    // This file is loaded at end-of-body, so the modal markup already exists.
    setupCombobox();
    loadPrefs();

    window.openRigModal         = openRigModal;
    window.closeRigModal        = closeRigModal;
    window.rigModalOverlayClick = rigModalOverlayClick;
    window.rigConnect           = connectRig;
    window.rigDisconnect        = disconnectRig;
    window.rigSetDirection      = setDirection;
    window.rigModelChanged      = onModelChanged;
    window.rigBaudChanged       = onBaudChanged;
    window.rigMuteOnTxChanged   = onMuteOnTxChanged;
})();
