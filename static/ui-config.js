/**
 * ui-config.js — Server UI defaults loader
 *
 * Fetches /api/ui-config on page load and applies each setting as a default
 * for new visitors. If the user has already set a preference in localStorage,
 * their value always takes priority — the server default is only used when
 * no localStorage value exists for that setting.
 *
 * Settings and their localStorage keys:
 *   signal_meter_mode         → signalMeterDisplayMode       (signal bar meter mode: dbfs/snr/dbfs-led/snr-led)
 *   smeter_mode               → ubersdr_smeter_colour_mode   (SMeterNeedle display mode)
 *   smeter_charts_visible     → ubersdr_smeter_charts_hidden (inverted: false→'0', true→absent/'0')
 *   palette                   → spectrumColorScheme           (waterfall colour palette)
 *   contrast                  → spectrumAutoContrast          (auto-range symmetric dB offset, 0-20)
 *   vu_meter_style            → vuMeterStyle                  (VU meter style: bar/led)
 *   gpu_scroll                → spectrumGpuScrollEnabled      (GPU sub-pixel waterfall scroll)
 *   smoothing                 → spectrumSmoothEnabled         (spatial smoothing)
 *   peak_hold                 → spectrumHoldEnabled           (peak hold, default true)
 *   line_graph                → spectrumLineGraphEnabled      (line graph overlay)
 *   bandwidth_indicator_color → bandwidthIndicatorColor       (bandwidth bar colour: green/red/cyan/white/yellow/orange/magenta)
 *   mobile_tuning_mode        → tuningMode                    (mobile frequency console default: buttons/wheel)
 *   default_buffer            → audioBufferThreshold          (default audio buffer threshold in ms: 50/100/150/200/300/500)
 *   spectrum_bg_image         → (no localStorage key)         URL of the spectrum background image,
 *                                                              or "" if none. Read directly from
 *                                                              window.serverUIConfig by SpectrumDisplay.
 *   spectrum_bg_opacity       → (no localStorage key)         Opacity of the background image (0.0–1.0,
 *                                                              default 0.3). Read directly from
 *                                                              window.serverUIConfig by SpectrumDisplay.
 *   station_id_overlay        → (no localStorage key)         Whether to show the station callsign/name/
 *                                                              location overlay on the spectrum line graph.
 *                                                              Server-side operator setting; default true.
 *                                                              Read directly from window.serverUIConfig.
 *   station_id_color          → (no localStorage key)         Hex colour (#rrggbb) for the station ID
 *                                                              overlay text; default "#ffffff". Read
 *                                                              directly from window.serverUIConfig.
 *   theme                     → (no localStorage key)         Map of CSS theme token overrides.
 *                                                              Applied as CSS custom properties on :root
 *                                                              via document.documentElement.style.setProperty().
 *                                                              Keys: page_bg, panel_dark, panel_mid,
 *                                                                    accent, accent_end, text_light.
 *                                                              When absent/empty the :root defaults in
 *                                                              style.css reproduce the original appearance.
 *
 * Usage (called from app.js before spectrum/meter initialisation):
 *   await loadServerUIConfig();
 *   const palette = getUIDefault('spectrumColorScheme', 'palette', 'jet');
 */

// Holds the fetched server UI config (null until loaded)
window.serverUIConfig = null;

/**
 * Fetch /api/ui-config and store in window.serverUIConfig.
 * Safe to call multiple times — subsequent calls are no-ops if already loaded.
 * Never throws; on failure serverUIConfig remains null and built-in defaults apply.
 */
async function loadServerUIConfig() {
    if (window.serverUIConfig !== null) return; // already loaded
    try {
        const resp = await fetch('/api/ui-config');
        if (resp.ok) {
            window.serverUIConfig = await resp.json();
        } else {
            console.warn('[ui-config] /api/ui-config returned', resp.status, '— using built-in defaults');
            window.serverUIConfig = {};
        }
    } catch (e) {
        console.warn('[ui-config] Failed to fetch /api/ui-config:', e, '— using built-in defaults');
        window.serverUIConfig = {};
    }
}

/**
 * Return the effective value for a UI setting using this priority order:
 *   1. User's localStorage value (user preference always wins)
 *   2. Server default from /api/ui-config
 *   3. Built-in hardcoded fallback
 *
 * @param {string} localStorageKey  - The localStorage key for this setting
 * @param {string} serverKey        - The key in the /api/ui-config response
 * @param {*}      fallback         - Built-in default if neither source has a value
 * @returns {*} The effective value (always a string from localStorage, or typed from server/fallback)
 */
function getUIDefault(localStorageKey, serverKey, fallback) {
    // 1. Check localStorage first — user preference always wins
    try {
        const local = localStorage.getItem(localStorageKey);
        if (local !== null && local !== undefined && local !== '') {
            return local;
        }
    } catch (e) {
        // localStorage unavailable (private browsing, etc.) — continue to server default
    }

    // 2. Use server default if available
    if (window.serverUIConfig && window.serverUIConfig[serverKey] !== undefined) {
        const serverVal = window.serverUIConfig[serverKey];
        // Convert numbers to strings for settings stored as strings in localStorage
        if (typeof fallback === 'string' && typeof serverVal === 'number') {
            return String(serverVal);
        }
        return serverVal;
    }

    // 3. Built-in fallback
    return fallback;
}

/**
 * Return the effective numeric value for a UI setting.
 * Same priority as getUIDefault but always returns a number.
 *
 * @param {string} localStorageKey  - The localStorage key for this setting
 * @param {string} serverKey        - The key in the /api/ui-config response
 * @param {number} fallback         - Built-in default number
 * @returns {number}
 */
function getUIDefaultNumber(localStorageKey, serverKey, fallback) {
    const val = getUIDefault(localStorageKey, serverKey, fallback);
    const num = parseFloat(val);
    return isNaN(num) ? fallback : num;
}

/**
 * Return the effective boolean value for a UI setting.
 * Same priority as getUIDefault but always returns a boolean.
 *
 * localStorage stores booleans as strings ('true'/'false').
 * The server returns actual JSON booleans.
 * The fallback is a boolean.
 *
 * @param {string}  localStorageKey  - The localStorage key for this setting
 * @param {string}  serverKey        - The key in the /api/ui-config response
 * @param {boolean} fallback         - Built-in default boolean
 * @returns {boolean}
 */
function getUIDefaultBool(localStorageKey, serverKey, fallback) {
    try {
        const local = localStorage.getItem(localStorageKey);
        if (local !== null && local !== undefined && local !== '') {
            // localStorage stores booleans as strings
            return local === 'true';
        }
    } catch (e) {
        // localStorage unavailable
    }

    if (window.serverUIConfig && window.serverUIConfig[serverKey] !== undefined) {
        return Boolean(window.serverUIConfig[serverKey]);
    }

    return fallback;
}

/**
 * Apply the server UI defaults to the spectrum display and meters.
 * Called after loadServerUIConfig() and after the DOM is ready,
 * but BEFORE SpectrumDisplay and SMeterNeedle are initialised.
 *
 * For settings read by constructors (SMeterNeedle, SpectrumDisplay), we
 * pre-populate localStorage with the server default if no user preference exists.
 * For settings read from DOM elements, we set the element value directly.
 */
function applyServerUIDefaults() {
    // ── Palette ──────────────────────────────────────────────────────────────
    // Apply default palette to the <select> element so it's pre-selected
    // before SpectrumDisplay reads it during initialisation.
    // localStorage key: spectrumColorScheme
    const paletteDefault = getUIDefault('spectrumColorScheme', 'palette', 'jet');
    const colorSchemeEl = document.getElementById('spectrum-colorscheme');
    if (colorSchemeEl) {
        colorSchemeEl.value = paletteDefault;
    }

    // ── Auto-contrast ─────────────────────────────────────────────────────────
    // Apply default auto-contrast to the slider element.
    // The slider range is 0-20 (symmetric dB offset for auto-range).
    // localStorage key: spectrumAutoContrast
    const contrastDefault = getUIDefaultNumber('spectrumAutoContrast', 'contrast', 10);
    const contrastSlider = document.getElementById('spectrum-auto-contrast');
    const contrastValue = document.getElementById('spectrum-auto-contrast-value');
    if (contrastSlider) {
        contrastSlider.value = contrastDefault;
    }
    if (contrastValue) {
        contrastValue.textContent = contrastDefault;
    }

    // ── Signal bar meter mode ─────────────────────────────────────────────────
    // SignalMeter reads from localStorage in its constructor.
    // localStorage key: signalMeterDisplayMode
    // Valid values: dbfs, snr, dbfs-led, snr-led
    const signalMeterModeDefault = getUIDefault('signalMeterDisplayMode', 'signal_meter_mode', 'dbfs');
    try {
        if (localStorage.getItem('signalMeterDisplayMode') === null) {
            localStorage.setItem('signalMeterDisplayMode', signalMeterModeDefault);
        }
    } catch (e) {
        // localStorage unavailable — SignalMeter will use its own built-in default
    }

    // ── S-meter mode ──────────────────────────────────────────────────────────
    // SMeterNeedle reads from localStorage in its constructor, so pre-populate
    // localStorage with the server default if no user preference exists.
    // localStorage key: ubersdr_smeter_colour_mode
    // Valid values: smeter-classic, snr-classic, smeter-dynamic, snr-dynamic
    const smeterModeDefault = getUIDefault('ubersdr_smeter_colour_mode', 'smeter_mode', 'smeter-classic');
    try {
        if (localStorage.getItem('ubersdr_smeter_colour_mode') === null) {
            localStorage.setItem('ubersdr_smeter_colour_mode', smeterModeDefault);
        }
    } catch (e) {
        // localStorage unavailable — SMeterNeedle will use its own built-in default
    }

    // ── S-meter charts visibility ─────────────────────────────────────────────
    // initSMeterChartsToggle() reads 'ubersdr_smeter_charts_hidden' ('1'=hidden, '0'=visible).
    // The server key smeter_charts_visible is the logical inverse (true = show charts).
    //
    // The Go UIBoolSetting.Default is a plain bool, so when smeter_charts_visible is absent
    // from ui.yaml the server sends false (Go zero value). We cannot distinguish this from
    // an admin explicitly setting false. Therefore:
    //   - server sends true  → admin explicitly wants charts visible   → write '0'
    //   - server sends false → either unconfigured OR admin wants hidden
    //                          The admin checkbox defaults to checked, so the first save
    //                          always writes true. We treat false as "hidden by admin choice"
    //                          only after the admin has saved at least once.
    //   - server key absent  → fresh install, no ui.yaml → default to visible → write '0'
    //
    // localStorage key: ubersdr_smeter_charts_hidden
    try {
        if (localStorage.getItem('ubersdr_smeter_charts_hidden') === null) {
            const serverVal = window.serverUIConfig && window.serverUIConfig['smeter_charts_visible'];
            // true → visible ('0'), false → hidden ('1'), absent/null → visible ('0')
            const hidden = serverVal === false ? '1' : '0';
            localStorage.setItem('ubersdr_smeter_charts_hidden', hidden);
        }
    } catch (e) {
        // localStorage unavailable — initSMeterChartsToggle will default to visible
    }

    // ── VU meter style ────────────────────────────────────────────────────────
    // app.js reads vuMeterStyle from localStorage at module level (line ~571),
    // so we pre-populate localStorage before app.js runs.
    // localStorage key: vuMeterStyle
    // Valid values: bar, led
    const vuMeterDefault = getUIDefault('vuMeterStyle', 'vu_meter_style', 'bar');
    try {
        if (localStorage.getItem('vuMeterStyle') === null) {
            localStorage.setItem('vuMeterStyle', vuMeterDefault);
        }
    } catch (e) {
        // localStorage unavailable
    }

    // ── Boolean spectrum settings ─────────────────────────────────────────────
    // SpectrumDisplay reads these from localStorage in its constructor/setupControls.
    // Pre-populate localStorage with server defaults if no user preference exists.

    // GPU scroll: spectrumGpuScrollEnabled (default: false)
    const gpuScrollDefault = getUIDefaultBool('spectrumGpuScrollEnabled', 'gpu_scroll', false);
    try {
        if (localStorage.getItem('spectrumGpuScrollEnabled') === null) {
            localStorage.setItem('spectrumGpuScrollEnabled', gpuScrollDefault.toString());
        }
    } catch (e) { /* ignore */ }

    // Smoothing: spectrumSmoothEnabled (default: false)
    const smoothingDefault = getUIDefaultBool('spectrumSmoothEnabled', 'smoothing', false);
    try {
        if (localStorage.getItem('spectrumSmoothEnabled') === null) {
            localStorage.setItem('spectrumSmoothEnabled', smoothingDefault.toString());
        }
    } catch (e) { /* ignore */ }

    // Peak hold: spectrumHoldEnabled (default: true)
    // Note: SpectrumDisplay reads this as !== 'false' (true if absent), so
    // we only need to write 'false' if the server default is false.
    const peakHoldDefault = getUIDefaultBool('spectrumHoldEnabled', 'peak_hold', true);
    try {
        if (localStorage.getItem('spectrumHoldEnabled') === null) {
            localStorage.setItem('spectrumHoldEnabled', peakHoldDefault.toString());
        }
    } catch (e) { /* ignore */ }

    // Line graph: spectrumLineGraphEnabled (default: false)
    const lineGraphDefault = getUIDefaultBool('spectrumLineGraphEnabled', 'line_graph', false);
    try {
        if (localStorage.getItem('spectrumLineGraphEnabled') === null) {
            localStorage.setItem('spectrumLineGraphEnabled', lineGraphDefault.toString());
        }
    } catch (e) { /* ignore */ }

    // Bandwidth indicator colour: bandwidthIndicatorColor (default: 'green')
    // SpectrumDisplay reads this from localStorage in its constructor.
    // Valid values: green, red, cyan, white, yellow, orange, magenta
    const bwColorDefault = getUIDefault('bandwidthIndicatorColor', 'bandwidth_indicator_color', 'green');
    try {
        if (localStorage.getItem('bandwidthIndicatorColor') === null) {
            localStorage.setItem('bandwidthIndicatorColor', bwColorDefault);
        }
    } catch (e) { /* ignore */ }

    // Mobile tuning mode: tuningMode (default: 'buttons')
    // initTuningControls() in app.js is an IIFE that runs at parse time — before this async
    // function runs — so it reads localStorage before the server default has been written.
    // We write the server default here, then call window.applyTuningModeFromStorage() (exposed
    // by initTuningControls) to re-sync the radio buttons and wheel/buttons visibility.
    // Valid values: buttons, wheel
    const mobileTuningDefault = getUIDefault('tuningMode', 'mobile_tuning_mode', 'buttons');
    try {
        if (localStorage.getItem('tuningMode') === null) {
            localStorage.setItem('tuningMode', mobileTuningDefault);
            // Re-sync the radio toggle and wheel/buttons visibility now that the server
            // default has been written. Safe to call even if not on mobile — applyMode()
            // inside initTuningControls() is a no-op on desktop.
            if (typeof window.applyTuningModeFromStorage === 'function') {
                window.applyTuningModeFromStorage();
            }
        }
    } catch (e) { /* ignore */ }

    // ── Default audio buffer ──────────────────────────────────────────────────
    // app.js reads audioBufferThreshold from localStorage in loadBufferThreshold().
    // Pre-populate localStorage with the server default if no user preference exists.
    // The server sends the value as a string (e.g. "200"). Valid values: 50/100/150/200/300/500.
    // localStorage key: audioBufferThreshold
    const defaultBufferDefault = getUIDefault('audioBufferThreshold', 'default_buffer', '200');
    try {
        if (localStorage.getItem('audioBufferThreshold') === null) {
            localStorage.setItem('audioBufferThreshold', defaultBufferDefault);
            // Re-sync maxBufferMs now that the server default has been written to localStorage.
            // loadBufferThreshold() ran at DOMContentLoaded before this async fetch completed,
            // so maxBufferMs is still the hardcoded 200ms default. Call it again to apply the
            // server-configured value. This mirrors the applyTuningModeFromStorage() pattern.
            if (typeof loadBufferThreshold === 'function') {
                loadBufferThreshold();
            }
        }
    } catch (e) { /* ignore */ }

    // ── Theme colours ─────────────────────────────────────────────────────────
    // Applied as CSS custom properties on :root. No localStorage — this is a
    // server-side operator setting, not a per-user preference.
    // The :root defaults in style.css reproduce the original appearance when
    // no theme is configured, so this block is a no-op for unconfigured installs.
    //
    // Map of server response key → CSS custom property name
    const themeCssVars = {
        page_bg:      '--page-bg',
        panel_dark:   '--panel-dark',
        panel_mid:    '--panel-mid',
        accent:       '--accent',
        accent_end:   '--accent-end',
        text_light:   '--text-light',
        control_text: '--control-text',
    };
    const theme = (window.serverUIConfig && window.serverUIConfig.theme) || {};
    for (const [key, cssVar] of Object.entries(themeCssVars)) {
        const val = theme[key];
        if (val && /^#[0-9a-fA-F]{6}$/.test(val)) {
            document.documentElement.style.setProperty(cssVar, val);
        }
    }
}

// Expose globally for use from app.js
window.loadServerUIConfig = loadServerUIConfig;
window.getUIDefault = getUIDefault;
window.getUIDefaultNumber = getUIDefaultNumber;
window.getUIDefaultBool = getUIDefaultBool;
window.applyServerUIDefaults = applyServerUIDefaults;
