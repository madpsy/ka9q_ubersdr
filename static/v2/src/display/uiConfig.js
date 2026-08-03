// Operator display settings from /api/ui-config.
//
// The reply is kept verbatim under `config` so every key stays reachable
// without editing this file again. As of writing the server sends:
//
//   spectrum_bg_image, spectrum_bg_opacity   backdrop behind the spectrum
//   palette, contrast, smoothing, peak_hold  waterfall / trace appearance
//   line_graph, gpu_scroll, min_span         spectrum behaviour
//   band_color_intensity, bandwidth_indicator_color
//   theme {accent, accent_end, page_bg, panel_dark, panel_mid, text_light,
//          control_text}                     operator colour overrides
//   station_id_overlay, station_id_color     callsign watermark
//   controls_opacity                         v1 control-bar transparency
//   signal_meter_mode, smeter_mode, smeter_charts_visible, vu_meter_style
//   mobile_tuning_mode, default_buffer, allowed_postmessage_origins
//
// Only the backdrop and the station ID overlay are consumed so far. Values
// that drive rendering are also
// parsed and validated onto the top level, so the draw path never re-parses a
// string, but nothing is dropped.

export const UI_CONFIG_DEFAULTS = {
    loaded: false,
    config: {},
    bgImage: '',
    bgOpacity: 0.3,
    stationIdOverlay: true,     // absent key means show, as in v1
    stationIdColor: '#ffffff',
};

export function parseUiConfig(cfg) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ...UI_CONFIG_DEFAULTS };
    const o = parseFloat(cfg.spectrum_bg_opacity);
    const col = typeof cfg.station_id_color === 'string' ? cfg.station_id_color.trim() : '';
    return {
        loaded: true,
        config: cfg,
        bgImage: typeof cfg.spectrum_bg_image === 'string' ? cfg.spectrum_bg_image : '',
        bgOpacity: Number.isFinite(o)
            ? Math.max(0, Math.min(1, o))
            : UI_CONFIG_DEFAULTS.bgOpacity,
        stationIdOverlay: cfg.station_id_overlay !== false,
        stationIdColor: /^#[0-9a-fA-F]{6}$/.test(col) ? col : UI_CONFIG_DEFAULTS.stationIdColor,
    };
}
