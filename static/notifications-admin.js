'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — filter field definitions per event type
// ═══════════════════════════════════════════════════════════════════════════════

const FILTER_FIELDS = {
    cw_spot: [
        { name: 'callsigns',         type: 'string_list', label: 'Callsigns',         hint: 'Exact match, e.g. G3XYZ, M0ABC' },
        { name: 'callsign_prefixes', type: 'string_list', label: 'Callsign Prefixes', hint: 'e.g. 3Y, JD1, VK0' },
        { name: 'countries',         type: 'string_list', label: 'Countries',          hint: 'CTY country name, e.g. Japan' },
        { name: 'country_codes',     type: 'string_list', label: 'Country Codes',      hint: 'ISO alpha-2, e.g. JP, AU' },
        { name: 'continents',        type: 'enum_list',   label: 'Continents',         values: ['NA','SA','EU','AF','AS','OC','AN'] },
        { name: 'cq_zones',          type: 'int_list',    label: 'CQ Zones',           hint: 'e.g. 3, 14, 28' },
        { name: 'itu_zones',         type: 'int_list',    label: 'ITU Zones',          hint: 'e.g. 6, 7' },
        { name: 'bands',             type: 'string_list', label: 'Bands',              hint: 'e.g. 40m, 20m' },
        { name: 'modes',             type: 'enum_list',   label: 'Modes',              values: ['CW','RTTY'] },
        { name: 'min_snr',           type: 'int',         label: 'Min SNR (dB)',       hint: 'Minimum SNR inclusive' },
        { name: 'max_snr',           type: 'int',         label: 'Max SNR (dB)',       hint: 'Maximum SNR inclusive' },
        { name: 'min_wpm',           type: 'int',         label: 'Min WPM',            hint: 'Minimum speed in WPM' },
        { name: 'min_distance_km',   type: 'float',       label: 'Min Distance (km)',  hint: 'Requires locator data' },
        { name: 'max_distance_km',   type: 'float',       label: 'Max Distance (km)',  hint: '' },
    ],
    dx_spot: [
        { name: 'callsigns',         type: 'string_list', label: 'Callsigns',          hint: 'Exact match' },
        { name: 'callsign_prefixes', type: 'string_list', label: 'Callsign Prefixes',  hint: 'e.g. 3Y, JD1' },
        { name: 'countries',         type: 'string_list', label: 'Countries',           hint: 'CTY country name' },
        { name: 'country_codes',     type: 'string_list', label: 'Country Codes',       hint: 'ISO alpha-2' },
        { name: 'continents',        type: 'enum_list',   label: 'Continents',          values: ['NA','SA','EU','AF','AS','OC','AN'] },
        { name: 'cq_zones',          type: 'int_list',    label: 'CQ Zones',            hint: '' },
        { name: 'itu_zones',         type: 'int_list',    label: 'ITU Zones',           hint: '' },
        { name: 'bands',             type: 'string_list', label: 'Bands',               hint: 'e.g. 20m' },
        { name: 'comment_contains',  type: 'string_list', label: 'Comment Contains',    hint: 'Case-insensitive substrings' },
        { name: 'spotters',          type: 'string_list', label: 'Spotters',            hint: 'Spotter callsign exact match' },
    ],
    digital_decode: [
        { name: 'callsigns',         type: 'string_list', label: 'Callsigns',          hint: 'Exact match' },
        { name: 'callsign_prefixes', type: 'string_list', label: 'Callsign Prefixes',  hint: '' },
        { name: 'countries',         type: 'string_list', label: 'Countries',           hint: '' },
        { name: 'country_codes',     type: 'string_list', label: 'Country Codes',       hint: 'ISO alpha-2' },
        { name: 'continents',        type: 'enum_list',   label: 'Continents',          values: ['NA','SA','EU','AF','AS','OC','AN'] },
        { name: 'cq_zones',          type: 'int_list',    label: 'CQ Zones',            hint: '' },
        { name: 'itu_zones',         type: 'int_list',    label: 'ITU Zones',           hint: '' },
        { name: 'bands',             type: 'string_list', label: 'Bands',               hint: 'e.g. 20m, 40m' },
        { name: 'digital_modes',     type: 'enum_list',   label: 'Digital Modes',       values: ['FT8','FT4','WSPR','JS8'] },
        { name: 'min_snr',           type: 'int',         label: 'Min SNR (dB)',        hint: '' },
        { name: 'max_snr',           type: 'int',         label: 'Max SNR (dB)',        hint: '' },
        { name: 'message_contains',  type: 'string_list', label: 'Message Contains',    hint: 'Decoded message substrings' },
        { name: 'min_distance_km',   type: 'float',       label: 'Min Distance (km)',   hint: '' },
        { name: 'max_distance_km',   type: 'float',       label: 'Max Distance (km)',   hint: '' },
    ],
    space_weather: [
        { name: 'k_min',   type: 'int',   label: 'K-index Min',  hint: 'Fire when K-index >= this' },
        { name: 'k_max',   type: 'int',   label: 'K-index Max',  hint: 'Fire when K-index <= this' },
        { name: 'a_min',   type: 'int',   label: 'A-index Min',  hint: 'Fire when A-index >= this' },
        { name: 'sfi_min', type: 'float', label: 'SFI Min',      hint: 'Fire when SFI >= this' },
        { name: 'sfi_max', type: 'float', label: 'SFI Max',      hint: 'Fire when SFI <= this' },
    ],
    antenna_switch: [
        { name: 'ant_actions', type: 'enum_list', label: 'Actions',      values: ['select','ground','add','remove','default'] },
        { name: 'ant_numbers', type: 'int_list',  label: 'Ant Numbers',  hint: 'Specific antenna port numbers' },
        { name: 'ant_sources', type: 'enum_list', label: 'Sources',      values: ['public','admin','startup','sync','scheduler','hardware'] },
    ],
    rotator: [
        { name: 'rotator_moving', type: 'bool_optional', label: 'Moving State', hint: 'true=only when starts moving; false=only when stops; blank=any change' },
    ],
    system_monitor: [
        { name: 'components',   type: 'enum_list', label: 'Components',    values: ['noise_floor','space_weather','decoder','cw_skimmer','mqtt','rotator','ant_switch','frequency_reference','instance_reporter','sdr_frontend','gpsdo','system_load','cpu_temperature','dsp'] },
        { name: 'on_unhealthy', type: 'bool',      label: 'On Unhealthy',  hint: 'Fire only on healthy to unhealthy transition' },
        { name: 'on_recovery',  type: 'bool',      label: 'On Recovery',   hint: 'Fire only on unhealthy to healthy transition' },
        { name: 'flap_detection',      type: 'toggle_on', label: 'Flap Detection', hint: 'Suppress repeated alerts when a component oscillates (e.g. system load). Sends one "flap detected" alert, then resumes once stable. Default: on' },
        { name: 'flap_threshold',      type: 'int', default: 6,  min: 2, max: 1000,  label: 'Flap: changes',        hint: 'Health changes needed to trigger flap detection (default 6, min 2)' },
        { name: 'flap_window_minutes', type: 'int', default: 10, min: 1, max: 10080, label: 'Flap: within minutes', hint: 'Rolling window for counting changes (default 10)' },
        { name: 'flap_clear_minutes',  type: 'int', default: 15, min: 1, max: 10080, label: 'Flap: resume after',   hint: 'Stable minutes before alerts resume — stops it suppressing forever (default 15)' },
    ],
    user_session: [
        { name: 'session_actions',       type: 'enum_list',   label: 'Actions',             values: ['connected','disconnected'] },
        { name: 'session_country_codes', type: 'string_list', label: 'Country Codes',       hint: 'ISO alpha-2, e.g. US, CA' },
        { name: 'session_continents',    type: 'enum_list',   label: 'Continents',          values: ['NA','SA','EU','AF','AS','OC','AN'] },
        { name: 'user_agent_contains',   type: 'string_list', label: 'User-Agent Contains', hint: 'e.g. bot, curl' },
        { name: 'client_ips',            type: 'string_list', label: 'Client IPs',          hint: 'Specific IP addresses' },
        { name: 'exclude_bypassed',      type: 'toggle_on',   label: 'Exclude Bypassed',    hint: 'When enabled, bypassed users (bypass password or IP allowlist) do not trigger notifications. Default: on' },
    ],
    voice_activity: [
        { name: 'voice_bands',          type: 'string_list', label: 'Bands',           hint: 'e.g. 20m, 40m; empty = all' },
        { name: 'voice_country_codes',  type: 'string_list', label: 'Country Codes',   hint: 'DX cluster enriched, ISO alpha-2' },
        { name: 'voice_continents',     type: 'enum_list',   label: 'Continents',      values: ['NA','SA','EU','AF','AS','OC','AN'] },
        { name: 'voice_callsigns',      type: 'string_list', label: 'Callsigns',       hint: 'DX cluster enriched, exact match' },
        { name: 'voice_min_snr',        type: 'float',       label: 'Min SNR (dB)',    hint: 'Minimum detected SNR' },
        { name: 'voice_min_confidence', type: 'float',       label: 'Min Confidence',  hint: '0.0 to 1.0' },
    ],
    server_startup: [],
};

const EVENT_TYPES = Object.keys(FILTER_FIELDS);

const EVENT_TYPE_LABELS = {
    cw_spot:        'CW Spot',
    dx_spot:        'DX Spot',
    digital_decode: 'Digital Decode',
    space_weather:  'Space Weather',
    antenna_switch: 'Antenna Switch',
    rotator:        'Rotator',
    system_monitor: 'System Monitor',
    user_session:   'User Session',
    voice_activity: 'Voice Activity',
    server_startup: 'Server Startup',
};

function eventLabel(et) {
    return EVENT_TYPE_LABELS[et] || et;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — deduplication keys per high-volume spot event
// ═══════════════════════════════════════════════════════════════════════════════
//
// cw_spot / dx_spot / digital_decode fire hundreds of times per minute. A rule
// for one of these MUST either set a selective filter or "notify once per" one
// or more of these keys, which collapses the firehose into one alert per new
// value (e.g. once the first time each country is decoded). Keys must mirror
// dedupKeysForEvent() in notification_config.go.
const DEDUP_FIELDS = {
    cw_spot: [
        { name: 'callsign',     label: 'Callsign' },
        { name: 'country',      label: 'Country' },
        { name: 'country_code', label: 'Country Code' },
        { name: 'continent',    label: 'Continent' },
        { name: 'cq_zone',      label: 'CQ Zone' },
        { name: 'itu_zone',     label: 'ITU Zone' },
        { name: 'band',         label: 'Band' },
        { name: 'mode',         label: 'Mode' },
    ],
    dx_spot: [
        { name: 'callsign',     label: 'Callsign' },
        { name: 'country',      label: 'Country' },
        { name: 'country_code', label: 'Country Code' },
        { name: 'continent',    label: 'Continent' },
        { name: 'band',         label: 'Band' },
    ],
    digital_decode: [
        { name: 'callsign',     label: 'Callsign' },
        { name: 'country',      label: 'Country' },
        { name: 'country_code', label: 'Country Code' },
        { name: 'continent',    label: 'Continent' },
        { name: 'cq_zone',      label: 'CQ Zone' },
        { name: 'itu_zone',     label: 'ITU Zone' },
        { name: 'band',         label: 'Band' },
        { name: 'mode',         label: 'Mode' },
    ],
};

// Events for which a selective filter or dedup is mandatory.
const HIGH_VOLUME_EVENTS = Object.keys(DEDUP_FIELDS);

function isHighVolumeEvent(et) {
    return HIGH_VOLUME_EVENTS.indexOf(et) >= 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS — template field definitions per event type
// ═══════════════════════════════════════════════════════════════════════════════

const TEMPLATE_FIELDS = {
    cw_spot: [
        { name: '.DXCall',      goType: 'string',   desc: 'Spotted callsign.' },
        { name: '.Spotter',     goType: 'string',   desc: 'Spotter callsign.' },
        { name: '.Frequency',   goType: 'float64',  desc: 'Frequency in Hz. Use <code>{{khz .Frequency}}</code> for display.' },
        { name: '.Band',        goType: 'string',   desc: 'Band name, e.g. "40m".' },
        { name: '.SNR',         goType: 'int',      desc: 'Signal-to-noise ratio in dB.' },
        { name: '.WPM',         goType: 'int',      desc: 'Speed in words per minute.' },
        { name: '.Mode',        goType: 'string',   desc: 'Mode string: "CW" or "RTTY".' },
        { name: '.Comment',     goType: 'string',   desc: 'Spot comment (may be empty).' },
        { name: '.Country',     goType: 'string',   desc: 'CTY country name.' },
        { name: '.CountryCode', goType: 'string',   desc: 'ISO alpha-2 code. Use <code>{{flag .CountryCode}}</code> for emoji.' },
        { name: '.CQZone',      goType: 'int',      desc: 'CQ zone.' },
        { name: '.ITUZone',     goType: 'int',      desc: 'ITU zone.' },
        { name: '.Continent',   goType: 'string',   desc: 'Continent code.' },
        { name: '.DistanceKm',  goType: '*float64', desc: 'Distance in km (nil if unknown). Guard with <code>{{if .DistanceKm}}</code>.' },
        { name: '.BearingDeg',  goType: '*float64', desc: 'Bearing in degrees (nil if unknown). Use <code>{{bearing .BearingDeg}}</code>.' },
        { name: '.Latitude',    goType: 'float64',  desc: 'Station latitude in decimal degrees (0 if unknown).' },
        { name: '.Longitude',   goType: 'float64',  desc: 'Station longitude in decimal degrees (0 if unknown).' },
        { name: '.Name',        goType: 'string',   desc: 'Operator name (may be empty).' },
        { name: '.Grid',        goType: 'string',   desc: 'Maidenhead locator (may be empty).' },
        { name: '.Time',        goType: 'time.Time',desc: 'Spot timestamp.' },
    ],
    dx_spot: [
        { name: '.DXCall',      goType: 'string',   desc: 'Spotted callsign.' },
        { name: '.Spotter',     goType: 'string',   desc: 'Spotter callsign.' },
        { name: '.Frequency',   goType: 'float64',  desc: 'Frequency in Hz. Use <code>{{khz .Frequency}}</code> for display.' },
        { name: '.Band',        goType: 'string',   desc: 'Band name.' },
        { name: '.Comment',     goType: 'string',   desc: 'Spot comment (may be empty).' },
        { name: '.Country',     goType: 'string',   desc: 'CTY country name.' },
        { name: '.CountryCode', goType: 'string',   desc: 'ISO alpha-2 code. Use <code>{{flag .CountryCode}}</code> for emoji.' },
        { name: '.Continent',   goType: 'string',   desc: 'Continent code.' },
        { name: '.TimeOffset',  goType: 'float64',  desc: 'Time offset in minutes from spot time.' },
        { name: '.Time',        goType: 'time.Time',desc: 'Spot timestamp.' },
    ],
    digital_decode: [
        { name: '.Callsign',      goType: 'string',   desc: 'Decoded callsign.' },
        { name: '.Locator',       goType: 'string',   desc: 'Maidenhead locator (may be empty).' },
        { name: '.Country',       goType: 'string',   desc: 'CTY country name.' },
        { name: '.CountryCode',   goType: 'string',   desc: 'ISO alpha-2 code. Use <code>{{flag .CountryCode}}</code> for emoji.' },
        { name: '.CQZone',        goType: 'int',      desc: 'CQ zone.' },
        { name: '.ITUZone',       goType: 'int',      desc: 'ITU zone.' },
        { name: '.Continent',     goType: 'string',   desc: 'Continent code.' },
        { name: '.SNR',           goType: 'int',      desc: 'SNR in dB.' },
        { name: '.Frequency',     goType: 'uint64',   desc: 'Signal frequency in Hz. Use <code>{{mhz .Frequency}}</code> for display.' },
        { name: '.DialFrequency', goType: 'uint64',   desc: 'Dial frequency in Hz. Use <code>{{mhz .DialFrequency}}</code> for display.' },
        { name: '.Mode',          goType: 'string',   desc: 'Decode mode: FT8, FT4, WSPR, JS8.' },
        { name: '.Message',       goType: 'string',   desc: 'Full decoded message text.' },
        { name: '.Band',          goType: 'string',   desc: 'Band name.' },
        { name: '.DistanceKm',    goType: '*float64', desc: 'Distance in km (nil if unknown). Guard with <code>{{if .DistanceKm}}</code>.' },
        { name: '.BearingDeg',    goType: '*float64', desc: 'Bearing in degrees (nil if unknown). Use <code>{{bearing .BearingDeg}}</code>.' },
        { name: '.DBm',           goType: 'int',      desc: 'Transmit power in dBm (WSPR only).' },
        { name: '.TxFrequency',   goType: 'uint64',   desc: 'Transmit frequency in Hz (WSPR only). Use <code>{{mhz .TxFrequency}}</code>.' },
        { name: '.Timestamp',     goType: 'time.Time',desc: 'Decode timestamp.' },
    ],
    space_weather: [
        { name: '.SFI',                goType: 'float64', desc: 'Solar Flux Index.' },
        { name: '.KIndex',             goType: 'int',     desc: 'Current K-index (0–9).' },
        { name: '.KIndexStatus',       goType: 'string',  desc: 'K-index status description.' },
        { name: '.AIndex',             goType: 'int',     desc: 'Current A-index.' },
        { name: '.SolarWindBz',        goType: 'float64', desc: 'Solar wind Bz component in nT.' },
        { name: '.PropagationQuality', goType: 'string',  desc: 'Human-readable propagation quality string.' },
        { name: '.PreviousKIndex',     goType: 'int',     desc: 'K-index from previous update (for trend arrows).' },
        { name: '.PreviousSFI',        goType: 'float64', desc: 'SFI from previous update.' },
    ],
    antenna_switch: [
        { name: '.Action',   goType: 'string',   desc: 'Action: select, ground, add, remove, default.' },
        { name: '.Antenna',  goType: 'int',      desc: 'Antenna port number (0 for ground/default).' },
        { name: '.Label',    goType: 'string',   desc: 'Human-readable antenna name.' },
        { name: '.Selected', goType: '[]int',    desc: 'Resulting selected antenna ports. Use <code>{{range .Selected}}</code> or <code>{{join ", " .Selected}}</code>.' },
        { name: '.Grounded', goType: 'bool',     desc: 'True when all antennas are grounded.' },
        { name: '.Source',   goType: 'string',   desc: 'Command source: public, admin, startup, sync, scheduler, hardware.' },
        { name: '.Time',     goType: 'time.Time',desc: 'Event timestamp.' },
    ],
    rotator: [
        { name: '.Azimuth',         goType: 'float64',  desc: 'Current azimuth in degrees.' },
        { name: '.Elevation',       goType: 'float64',  desc: 'Current elevation in degrees.' },
        { name: '.Moving',          goType: 'bool',     desc: 'True while the rotator is moving.' },
        { name: '.TargetAzimuth',   goType: 'float64',  desc: 'Target azimuth in degrees.' },
        { name: '.TargetElevation', goType: 'float64',  desc: 'Target elevation in degrees.' },
        { name: '.Time',            goType: 'time.Time',desc: 'Event timestamp.' },
    ],
    system_monitor: [
        { name: '.Component',         goType: 'string',   desc: 'Subsystem name.' },
        { name: '.Healthy',           goType: 'bool',     desc: 'Current health state.' },
        { name: '.PreviouslyHealthy', goType: 'bool',     desc: 'Health state before this event.' },
        { name: '.Issues',            goType: '[]string', desc: 'List of issue descriptions. Use <code>{{join ", " .Issues}}</code>.' },
        { name: '.Status',            goType: 'string',   desc: 'Status string: degraded, recovered, flapping, stabilized, or unknown.' },
        { name: '.Flapping',          goType: 'bool',     desc: 'True on a "flap detection activated" alert (component oscillating).' },
        { name: '.Time',              goType: 'time.Time',desc: 'Event timestamp.' },
    ],
    user_session: [
        { name: '.Action',        goType: 'string',   desc: '"connected" or "disconnected".' },
        { name: '.ClientIP',      goType: 'string',   desc: 'Client IP address.' },
        { name: '.Country',       goType: 'string',   desc: 'CTY/GeoIP country name.' },
        { name: '.CountryCode',   goType: 'string',   desc: 'ISO alpha-2 code. Use <code>{{flag .CountryCode}}</code> for emoji.' },
        { name: '.Continent',     goType: 'string',   desc: 'Continent code.' },
        { name: '.UserAgent',     goType: 'string',   desc: 'HTTP User-Agent string.' },
        { name: '.UserSessionID', goType: 'string',   desc: 'Internal session UUID.' },
        { name: '.Frequency',     goType: 'uint64',   desc: 'Tuned frequency in Hz at connect time.' },
        { name: '.Mode',          goType: 'string',   desc: 'Mode at connect time.' },
        { name: '.Time',          goType: 'time.Time',desc: 'Event timestamp.' },
    ],
    server_startup: [
        { name: '.Version',   goType: 'string',   desc: 'UberSDR version string.' },
        { name: '.Callsign',  goType: 'string',   desc: 'Configured station callsign.' },
        { name: '.Name',      goType: 'string',   desc: 'Configured station name.' },
        { name: '.StartTime', goType: 'time.Time',desc: 'Server start timestamp.' },
    ],
    voice_activity: [
        { name: '.Band',              goType: 'string',   desc: 'Band name.' },
        { name: '.CenterFreq',        goType: 'uint64',   desc: 'Signal centre frequency in Hz. Use <code>{{mhz .CenterFreq}}</code>.' },
        { name: '.EstimatedDialFreq', goType: 'uint64',   desc: 'Estimated dial frequency in Hz. Use <code>{{mhz .EstimatedDialFreq}}</code>.' },
        { name: '.StartFreq',         goType: 'uint64',   desc: 'Signal start frequency in Hz.' },
        { name: '.EndFreq',           goType: 'uint64',   desc: 'Signal end frequency in Hz.' },
        { name: '.Bandwidth',         goType: 'uint64',   desc: 'Signal bandwidth in Hz.' },
        { name: '.Mode',              goType: 'string',   desc: 'Estimated mode (USB, LSB, AM, etc.).' },
        { name: '.SNR',               goType: 'float32',  desc: 'Detected SNR in dB. Wrap with <code>f32</code> before printf/mulf.' },
        { name: '.Confidence',        goType: 'float32',  desc: 'Detection confidence 0.0–1.0. Wrap with <code>f32</code> before printf/mulf.' },
        { name: '.DXCallsign',        goType: 'string',   desc: 'DX cluster enriched callsign (may be empty).' },
        { name: '.DXCountry',         goType: 'string',   desc: 'DX cluster enriched country name (may be empty).' },
        { name: '.DXCountryCode',     goType: 'string',   desc: 'DX cluster enriched ISO alpha-2 code (may be empty).' },
        { name: '.DXContinent',       goType: 'string',   desc: 'DX cluster enriched continent code (may be empty).' },
        { name: '.Time',              goType: 'time.Time',desc: 'Detection timestamp.' },
    ],
};

const TEMPLATE_FUNCS = [
    { name: 'flag',    sig: 'flag code',      desc: 'ISO alpha-2 → flag emoji. e.g. "JP" → 🇯🇵',                                    example: '{{flag .CountryCode}}' },
    { name: 'bearing', sig: 'bearing deg',    desc: 'Compass direction string (N, NE, ENE…). Handles nil *float64 → "?".',           example: '{{bearing .BearingDeg}}' },
    { name: 'deref',   sig: 'deref ptr',      desc: 'Nil-safe dereference of *float64. Returns 0.0 for nil.',                        example: '{{printf "%.0f" (deref .DistanceKm)}}' },
    { name: 'divf',    sig: 'divf a b',       desc: 'Float division. Returns 0 if b is 0.',                                          example: '{{printf "%.3f" (divf .Frequency 1000000.0)}}' },
    { name: 'mulf',    sig: 'mulf a b',       desc: 'Float multiplication. Use with f32 for float32 fields.',                        example: '{{printf "%.0f" (mulf (f32 .Confidence) 100)}}' },
    { name: 'f32',     sig: 'f32 v',          desc: 'Converts float32 to float64 for use with printf, mulf, divf.',                  example: '{{printf "%.1f" (f32 .SNR)}}' },
    { name: 'mhz',     sig: 'mhz hz',         desc: 'uint64 Hz → MHz string with 3 decimal places. For digital_decode / voice_activity frequencies.', example: '{{mhz .EstimatedDialFreq}}' },
    { name: 'khz',     sig: 'khz hz',         desc: 'float64 Hz → kHz string with 1 decimal place. For cw_spot / dx_spot .Frequency only.',           example: '{{khz .Frequency}}' },
    { name: 'join',    sig: 'join sep items', desc: 'Joins a string slice with a separator.',                                        example: '{{join ", " .Issues}}' },
    { name: 'upper',   sig: 'upper s',        desc: 'Converts string to upper case.',                                                example: '{{upper .Mode}}' },
    { name: 'lower',   sig: 'lower s',        desc: 'Converts string to lower case.',                                                example: '{{lower .Band}}' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

let localConfig = {
    enabled: false,
    channels: {},
    rules: [],
};

let lastStats = {};

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

async function apiFetch(url, options) {
    options = options || {};
    const resp = await fetch(url, options);
    if (resp.status === 401) {
        const returnUrl = encodeURIComponent(window.location.pathname);
        window.location.href = '/admin.html?return=' + returnUrl;
        throw new Error('Redirecting to login');
    }
    return resp;
}

function showAlert(container, type, message, autoDismiss) {
    if (autoDismiss === undefined) autoDismiss = true;
    const div = document.createElement('div');
    div.className = 'alert alert-' + type;
    div.innerHTML = '<span>' + escHtml(message) + '</span><span class="alert-dismiss" title="Dismiss">&#x2715;</span>';
    div.querySelector('.alert-dismiss').addEventListener('click', function() { div.remove(); });
    container.prepend(div);
    if (autoDismiss) {
        setTimeout(function() { if (div.parentNode) div.remove(); }, 4000);
    }
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function parseCSV(str) {
    return str.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
}

function parseIntCSV(str) {
    return str.split(',').map(function(s) { return parseInt(s.trim(), 10); }).filter(function(n) { return !isNaN(n); });
}

function fmtDate(str) {
    if (!str || str === '0001-01-01T00:00:00Z') return '\u2014';
    try { return new Date(str).toLocaleString(); } catch(e) { return str; }
}

function el(id) { return document.getElementById(id); }

function fmtCount(n) {
    n = Number(n) || 0;
    var abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

function initTabs() {
    document.querySelectorAll('.tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
            document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
            tab.classList.add('active');
            el('tab-' + tab.dataset.tab).classList.add('active');
            // Refresh data on every tab click (same as pressing Refresh)
            loadHealth().catch(function() {});
            loadConfig().catch(function() {});
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 1 — OVERVIEW / HEALTH
// ═══════════════════════════════════════════════════════════════════════════════

async function loadHealth() {
    const loading = el('healthLoading');
    const content = el('healthContent');
    loading.style.display = 'flex';
    content.style.display = 'none';

    try {
        const resp = await apiFetch('/admin/notifications/health');
        const data = await resp.json();

        el('masterEnable').checked = !!data.enabled;

        const stats = data.stats || {};
        lastStats = stats;
        const statsGrid = el('statsGrid');
        const statItems = [
            { label: 'Published',    value: stats.total_published    != null ? stats.total_published    : 0 },
            { label: 'Sent',         value: stats.total_sent         != null ? stats.total_sent         : 0 },
            { label: 'Errors',       value: stats.total_errors       != null ? stats.total_errors       : 0 },
            { label: 'Rate-Limited', value: stats.total_rate_limited != null ? stats.total_rate_limited : 0 },
        ];
        statsGrid.innerHTML = statItems.map(function(s) {
            return '<div class="stat-card"><div class="stat-value">' + fmtCount(s.value) + '</div><div class="stat-label">' + s.label + '</div></div>';
        }).join('');

        const dotClass = data.enabled ? 'green' : 'grey';
        const lastSent  = fmtDate(stats.last_sent_at);
        const lastError = fmtDate(stats.last_error_at);
        el('statusDetails').innerHTML =
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">' +
                '<span class="status-dot ' + dotClass + '"></span>' +
                '<strong>' + (data.enabled ? 'Enabled' : 'Disabled') + '</strong>' +
            '</div>' +
            '<div style="font-size:0.875rem;color:#555;display:grid;grid-template-columns:auto 1fr;gap:4px 16px">' +
                '<span style="color:#888">Last sent:</span><span>' + lastSent + '</span>' +
                '<span style="color:#888">Last error:</span><span>' + lastError + '</span>' +
            '</div>';

        const issues = data.issues || [];
        const issuesSection = el('issuesSection');
        const issuesList    = el('issuesList');
        if (issues.length > 0) {
            issuesList.innerHTML = issues.map(function(i) { return '<li>' + escHtml(i) + '</li>'; }).join('');
            issuesSection.style.display = 'block';
        } else {
            issuesSection.style.display = 'none';
        }

        loading.style.display = 'none';
        content.style.display = 'block';
    } catch (err) {
        if (err.message === 'Redirecting to login') return;
        loading.style.display = 'none';
        content.style.display = 'block';
        showAlert(el('overviewAlerts'), 'error', 'Failed to load health: ' + err.message, false);
    }
}

async function loadConfig() {
    try {
        const resp = await apiFetch('/admin/notifications/config');
        if (!resp.ok) return;
        const data = await resp.json();

        localConfig.enabled = !!data.enabled;

        const serverChannels = data.channels || {};
        const merged = {};
        for (const name in serverChannels) {
            const ch = serverChannels[name];
            const existing = localConfig.channels[name];
            merged[name] = {
                type:               ch.type              || 'telegram',
                bot_token:          (existing && existing.bot_token && existing.bot_token !== '********')
                                        ? existing.bot_token
                                        : (ch.bot_token_set ? '********' : ''),
                chat_id:            ch.chat_id            || '',
                parse_mode:         ch.parse_mode         || 'HTML',
                rate_limit_minutes: ch.rate_limit_minutes != null ? ch.rate_limit_minutes : 10,
                // Email (SMTP) — password redacted like the bot token.
                smtp_host:          ch.smtp_host          || '',
                smtp_port:          ch.smtp_port          || 587,
                smtp_security:      ch.smtp_security       || 'starttls',
                smtp_username:      ch.smtp_username       || '',
                smtp_password:      (existing && existing.smtp_password && existing.smtp_password !== '********')
                                        ? existing.smtp_password
                                        : (ch.smtp_password_set ? '********' : ''),
                email_from:         ch.email_from          || '',
                email_to:           Array.isArray(ch.email_to) ? ch.email_to : [],
                subject_prefix:     ch.subject_prefix      || '[UberSDR]',
                // Webhook — secret is never returned by the server; only webhook_secret_set is.
                webhook_url:                ch.webhook_url                || '',
                webhook_method:             ch.webhook_method             || 'POST',
                webhook_format:             ch.webhook_format             || 'text',
                webhook_secret:             (existing && existing.webhook_secret && existing.webhook_secret !== '********')
                                                ? existing.webhook_secret
                                                : (ch.webhook_secret_set ? '********' : ''),
                webhook_headers:            ch.webhook_headers            || {},
                webhook_timeout_seconds:    ch.webhook_timeout_seconds    || 10,
                webhook_insecure_skip_verify: !!ch.webhook_insecure_skip_verify,
                webhook_body_template:      ch.webhook_body_template      || '',
            };
        }
        localConfig.channels = merged;

        const serverRules = data.rules || [];
        localConfig.rules = serverRules.map(function(sr) {
            return {
                name:                 sr.name,
                enabled:              sr.enabled,
                event:                sr.event,
                channels:             sr.channels || [],
                filters:              sr.filters  || {},
                dedup_by:             sr.dedup_by || [],
                dedup_window_minutes: sr.dedup_window_minutes || 0,
                template:             sr.template || '',
                templates:            sr.templates || {},
            };
        });

        el('masterEnable').checked = localConfig.enabled;
        renderChannels();
        renderRules();
    } catch (err) {
        if (err.message === 'Redirecting to login') return;
        console.error('loadConfig error:', err);
    }
}

function downloadConfig() {
    const date = new Date();
    const pad = function(n) { return String(n).padStart(2, '0'); };
    const stamp = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    const filename = 'notifications-config-' + stamp + '.json';

    const json = JSON.stringify(localConfig, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function uploadConfig(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        let parsed;
        try {
            parsed = JSON.parse(e.target.result);
        } catch (err) {
            showAlert(el('overviewAlerts'), 'error', 'Invalid JSON file: ' + err.message, false);
            return;
        }

        // Basic shape validation
        if (typeof parsed !== 'object' || parsed === null ||
            !('enabled' in parsed) || !('channels' in parsed) || !('rules' in parsed)) {
            showAlert(el('overviewAlerts'), 'error', 'File does not look like a notifications config (missing enabled/channels/rules keys).', false);
            return;
        }
        if (typeof parsed.channels !== 'object' || Array.isArray(parsed.channels)) {
            showAlert(el('overviewAlerts'), 'error', 'Invalid config: "channels" must be an object.', false);
            return;
        }
        if (!Array.isArray(parsed.rules)) {
            showAlert(el('overviewAlerts'), 'error', 'Invalid config: "rules" must be an array.', false);
            return;
        }

        localConfig.enabled  = !!parsed.enabled;
        localConfig.channels = parsed.channels;
        localConfig.rules    = parsed.rules;

        // Sync master toggle to loaded value
        el('masterEnable').checked = localConfig.enabled;

        // Re-render channels and rules tabs
        renderChannels();
        renderRules();

        showAlert(el('overviewAlerts'), 'success',
            'Config loaded from "' + escHtml(file.name) + '" (' +
            Object.keys(localConfig.channels).length + ' channel(s), ' +
            localConfig.rules.length + ' rule(s)). ' +
            'Click "Save All Changes" on the Channels or Rules tab to persist to the server.',
            false);
    };
    reader.readAsText(file);
}

function initOverview() {
    el('btnRefreshHealth').addEventListener('click', loadHealth);

    el('masterEnable').addEventListener('change', async function() {
        localConfig.enabled = this.checked;
        const ok = await saveConfig(el('overviewAlerts'));
        if (ok) await loadHealth();
    });

    el('btnDownloadConfig').addEventListener('click', downloadConfig);

    el('btnUploadConfig').addEventListener('click', function() {
        el('configUploadInput').value = '';   // reset so same file can be re-uploaded
        el('configUploadInput').click();
    });

    el('configUploadInput').addEventListener('change', function() {
        if (this.files && this.files[0]) {
            uploadConfig(this.files[0]);
        }
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAVE CONFIG (shared)
// ═══════════════════════════════════════════════════════════════════════════════

async function saveConfig(alertContainer) {
    const payload = {
        enabled:  localConfig.enabled,
        channels: {},
        rules:    [],
    };

    for (const name in localConfig.channels) {
        const ch = localConfig.channels[name];
        if (ch.type === 'email') {
            payload.channels[name] = {
                type:               'email',
                smtp_host:          ch.smtp_host || '',
                smtp_port:          Number(ch.smtp_port) || 587,
                smtp_security:      ch.smtp_security || 'starttls',
                smtp_username:      ch.smtp_username || '',
                // Empty password = unauthenticated relay (legitimate); only the
                // masked placeholder means "keep existing".
                smtp_password:      ch.smtp_password || '',
                email_from:         ch.email_from || '',
                email_to:           Array.isArray(ch.email_to) ? ch.email_to : parseCSV(String(ch.email_to || '')),
                subject_prefix:     ch.subject_prefix || '[UberSDR]',
                rate_limit_minutes: Number(ch.rate_limit_minutes) || 10,
            };
        } else if (ch.type === 'webhook') {
            payload.channels[name] = {
                type:                       'webhook',
                webhook_url:                ch.webhook_url || '',
                webhook_method:             ch.webhook_method || 'POST',
                webhook_format:             ch.webhook_format || 'text',
                // Empty secret = no signing; masked placeholder means "keep existing".
                webhook_secret:             ch.webhook_secret || '',
                webhook_headers:            ch.webhook_headers || {},
                webhook_timeout_seconds:    Number(ch.webhook_timeout_seconds) || 10,
                webhook_insecure_skip_verify: !!ch.webhook_insecure_skip_verify,
                webhook_body_template:      ch.webhook_body_template || '',
                rate_limit_minutes:         Number(ch.rate_limit_minutes) || 10,
            };
        } else {
            payload.channels[name] = {
                type:               ch.type,
                bot_token:          ch.bot_token || '********',
                chat_id:            ch.chat_id,
                parse_mode:         ch.parse_mode || 'HTML',
                rate_limit_minutes: Number(ch.rate_limit_minutes) || 10,
            };
        }
    }

    localConfig.rules.forEach(function(rule) {
        const r = {
            name:     rule.name,
            enabled:  rule.enabled,
            event:    rule.event,
            channels: rule.channels,
            filters:  buildFiltersPayload(rule.event, rule.filters),
        };
        if (Array.isArray(rule.dedup_by) && rule.dedup_by.length > 0) {
            r.dedup_by = rule.dedup_by;
            r.dedup_window_minutes = Number(rule.dedup_window_minutes) || 0;
        }
        if (rule.template) r.template = rule.template;
        if (rule.templates && Object.keys(rule.templates).length > 0) {
            // Only keep overrides for channels the rule actually targets.
            const t = {};
            (rule.channels || []).forEach(function(c) {
                if (rule.templates[c]) t[c] = rule.templates[c];
            });
            if (Object.keys(t).length > 0) r.templates = t;
        }
        payload.rules.push(r);
    });

    try {
        const resp = await apiFetch('/admin/notifications/config', {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        });
        const data = await resp.json();

        if (resp.ok && data.ok) {
            showAlert(alertContainer, 'success', data.message || 'Configuration saved.');
            return true;
        } else {
            const issues = data.issues ? '\n' + data.issues.join('\n') : '';
            showAlert(alertContainer, 'error', (data.error || 'Save failed.') + issues, false);
            return false;
        }
    } catch (err) {
        if (err.message === 'Redirecting to login') return false;
        showAlert(alertContainer, 'error', 'Save error: ' + err.message, false);
        return false;
    }
}

function buildFiltersPayload(eventType, filters) {
    if (!filters) return {};
    const fields = FILTER_FIELDS[eventType] || [];
    const out = {};
    fields.forEach(function(fd) {
        const val = filters[fd.name];
        if (val === undefined || val === null || val === '') return;
        if (fd.type === 'string_list' || fd.type === 'enum_list') {
            const arr = Array.isArray(val) ? val : parseCSV(String(val));
            if (arr.length > 0) out[fd.name] = arr;
        } else if (fd.type === 'int_list') {
            const arr = Array.isArray(val) ? val : parseIntCSV(String(val));
            if (arr.length > 0) out[fd.name] = arr;
        } else if (fd.type === 'int') {
            const n = parseInt(val, 10);
            if (!isNaN(n)) out[fd.name] = n;
        } else if (fd.type === 'float') {
            const n = parseFloat(val);
            if (!isNaN(n)) out[fd.name] = n;
        } else if (fd.type === 'bool') {
            if (val !== '' && val !== undefined) out[fd.name] = (val === true || val === 'true');
        } else if (fd.type === 'bool_optional' || fd.type === 'toggle_on') {
            if (val !== '' && val !== undefined && val !== null) {
                out[fd.name] = (val === true || val === 'true');
            }
        }
    });
    return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 2 — CHANNELS
// ═══════════════════════════════════════════════════════════════════════════════

// EMAIL_PRESETS prefill host/port/security when a provider is chosen from the
// dropdown. They are pure UI convenience — only the resolved SMTP values are
// stored, never the provider name. "custom" leaves the fields editable.
const EMAIL_PRESETS = {
    gmail:    { label: 'Gmail',                   host: 'smtp.gmail.com',         port: 587, security: 'starttls' },
    outlook:  { label: 'Outlook / Microsoft 365', host: 'smtp-mail.outlook.com',  port: 587, security: 'starttls' },
    fastmail: { label: 'Fastmail',                host: 'smtp.fastmail.com',      port: 465, security: 'tls' },
    yahoo:    { label: 'Yahoo',                   host: 'smtp.mail.yahoo.com',    port: 465, security: 'tls' },
    icloud:   { label: 'iCloud',                  host: 'smtp.mail.me.com',       port: 587, security: 'starttls' },
    sendgrid: { label: 'SendGrid',                host: 'smtp.sendgrid.net',      port: 587, security: 'starttls' },
    mailgun:  { label: 'Mailgun',                 host: 'smtp.mailgun.org',       port: 587, security: 'starttls' },
    ses:      { label: 'Amazon SES',              host: '',                       port: 587, security: 'starttls' },
    custom:   { label: 'Custom',                  host: '',                       port: 587, security: 'starttls' },
};

// detectEmailProvider returns the preset key whose host matches, else 'custom'.
function detectEmailProvider(host) {
    host = (host || '').toLowerCase().trim();
    for (const key in EMAIL_PRESETS) {
        if (key === 'custom') continue;
        if (EMAIL_PRESETS[key].host && EMAIL_PRESETS[key].host.toLowerCase() === host) return key;
    }
    return 'custom';
}

// WEBHOOK_PRESETS prefill the URL template, method, and format when a service
// is chosen from the dropdown. Only the resolved values are stored, never the
// preset key. "custom" leaves all fields editable.
const WEBHOOK_PRESETS = {
    ntfy:       {
        label: 'ntfy',
        urlTemplate: 'https://ntfy.sh/YOUR_TOPIC',
        method: 'POST', format: 'text',
        hint: 'Replace YOUR_TOPIC with your topic name. For private topics add an Authorization header: <code>Bearer &lt;token&gt;</code>.',
    },
    slack:      {
        label: 'Slack',
        urlTemplate: 'https://hooks.slack.com/services/T.../B.../...',
        method: 'POST', format: 'slack',
        hint: 'Paste the Incoming Webhook URL from your Slack app settings. The URL is the secret — no extra auth needed.',
    },
    discord:    {
        label: 'Discord',
        urlTemplate: 'https://discord.com/api/webhooks/ID/TOKEN',
        method: 'POST', format: 'discord',
        hint: 'Paste the Webhook URL from your Discord channel settings. The URL is the secret — no extra auth needed.',
    },
    zapier:     {
        label: 'Zapier',
        urlTemplate: 'https://hooks.zapier.com/hooks/catch/USER/HOOK/',
        method: 'POST', format: 'json',
        hint: 'Paste the Catch Hook URL from your Zap. Fields in the JSON body are available as variables in Zapier.',
    },
    homeassist: {
        label: 'Home Assistant',
        urlTemplate: 'http://homeassistant.local:8123/api/webhook/YOUR_ID',
        method: 'POST', format: 'json',
        hint: 'Create a Webhook trigger automation in HA and paste its ID here. For remote access use https:// and add an <code>Authorization: Bearer &lt;token&gt;</code> header.',
    },
    n8n:        {
        label: 'n8n',
        urlTemplate: 'https://YOUR_N8N/webhook/YOUR_PATH',
        method: 'POST', format: 'json',
        hint: 'Use the Webhook node URL from your n8n workflow. Add header auth in n8n and mirror it in the Extra Headers below.',
    },
    custom:     {
        label: 'Custom',
        urlTemplate: '',
        method: 'POST', format: 'text',
        hint: '',
    },
};

// detectWebhookPreset returns the preset key that best matches a URL, else 'custom'.
function detectWebhookPreset(url) {
    url = (url || '').toLowerCase();
    if (url.indexOf('ntfy.sh') >= 0)                   return 'ntfy';
    if (url.indexOf('hooks.slack.com') >= 0)           return 'slack';
    if (url.indexOf('discord.com/api/webhooks') >= 0)  return 'discord';
    if (url.indexOf('hooks.zapier.com') >= 0)          return 'zapier';
    if (url.indexOf('n8n') >= 0)                       return 'n8n';
    if (url.indexOf('/api/webhook') >= 0)              return 'homeassist';
    return 'custom';
}

function renderChannels() {
    const list = el('channelList');
    const channels = localConfig.channels;
    const names = Object.keys(channels);

    if (names.length === 0) {
        list.innerHTML =
            '<div class="empty-state">' +
                '<div class="empty-state-icon">&#x1F4E1;</div>' +
                '<p>No channels configured yet.</p>' +
                '<p style="font-size:0.85rem;margin-top:4px">Click &ldquo;Add Channel&rdquo; to create one.</p>' +
            '</div>';
        return;
    }

    const byCh     = lastStats.by_channel          || {};
    const byChErr  = lastStats.by_channel_errors    || {};
    const byChRL   = lastStats.by_channel_rate_limited || {};

    list.innerHTML = names.map(function(name) {
        const ch = channels[name];
        // Type-specific meta badges (secret status + key destination fields).
        let metaBadges;
        if (ch.type === 'email') {
            let pwBadge;
            if (ch.smtp_password && ch.smtp_password !== '********') {
                pwBadge = '<span class="badge badge-green">Password entered</span>';
            } else if (ch.smtp_password === '********') {
                pwBadge = '<span class="badge badge-yellow">Password set (hidden)</span>';
            } else {
                pwBadge = '<span class="badge badge-grey">No auth</span>';
            }
            const toList = Array.isArray(ch.email_to) ? ch.email_to.join(', ') : (ch.email_to || '');
            metaBadges = pwBadge +
                (ch.smtp_host ? '<span class="badge badge-grey">' + escHtml(ch.smtp_host) + ':' + (ch.smtp_port || 587) + '</span>' : '<span class="badge badge-red">No host</span>') +
                '<span class="badge badge-grey">' + escHtml(ch.smtp_security || 'starttls') + '</span>' +
                (toList ? '<span class="badge badge-grey">to: ' + escHtml(toList) + '</span>' : '');
        } else if (ch.type === 'webhook') {
            let secretBadge;
            if (ch.webhook_secret && ch.webhook_secret !== '********') {
                secretBadge = '<span class="badge badge-green">Secret entered</span>';
            } else if (ch.webhook_secret === '********') {
                secretBadge = '<span class="badge badge-yellow">Secret set (hidden)</span>';
            } else {
                secretBadge = '<span class="badge badge-grey">No secret</span>';
            }
            // Show a truncated URL (strip scheme, cap at 45 chars).
            const urlDisplay = ch.webhook_url
                ? ch.webhook_url.replace(/^https?:\/\//, '').substring(0, 45) +
                  (ch.webhook_url.replace(/^https?:\/\//, '').length > 45 ? '…' : '')
                : '';
            metaBadges = secretBadge +
                (urlDisplay ? '<span class="badge badge-grey" title="' + escHtml(ch.webhook_url) + '">' + escHtml(urlDisplay) + '</span>' : '<span class="badge badge-red">No URL</span>') +
                '<span class="badge badge-grey">' + escHtml(ch.webhook_method || 'POST') + '</span>' +
                '<span class="badge badge-grey">' + escHtml(ch.webhook_format || 'text') + '</span>';
        } else {
            let tokenBadge;
            if (ch.bot_token && ch.bot_token !== '********') {
                tokenBadge = '<span class="badge badge-green">Token entered</span>';
            } else if (ch.bot_token === '********') {
                tokenBadge = '<span class="badge badge-yellow">Token set (hidden)</span>';
            } else {
                tokenBadge = '<span class="badge badge-red">No token</span>';
            }
            metaBadges = tokenBadge +
                (ch.chat_id ? '<span class="badge badge-grey">chat: ' + escHtml(ch.chat_id) + '</span>' : '') +
                '<span class="badge badge-grey">' + escHtml(ch.parse_mode || 'HTML') + '</span>';
        }
        const sent      = byCh[name]    || 0;
        const errors    = byChErr[name]  || 0;
        const rateLim   = byChRL[name]   || 0;
        const statsBadges =
            '<span class="badge badge-green" title="Messages sent">&#x2709; ' + sent + ' sent</span>' +
            (errors  > 0 ? '<span class="badge badge-red"   title="Send errors">&#x26A0; '    + errors  + ' err</span>'   : '') +
            (rateLim > 0 ? '<span class="badge badge-yellow" title="Rate-limited">&#x23F1; ' + rateLim + ' RL</span>'    : '');
        const manageBtn = (ch.type === 'telegram')
            ? '<button class="btn btn-sm btn-secondary btn-manage-channel" data-name="' + escHtml(name) + '">&#x1F916; Manage</button>'
            : '';
        return '<div class="item-card" data-channel="' + escHtml(name) + '">' +
            '<div class="item-card-header">' +
                '<div>' +
                    '<div class="item-card-title">&#x1F4E1; ' + escHtml(name) + '</div>' +
                    '<div class="item-card-meta">' +
                        '<span class="badge badge-blue">' + escHtml(ch.type) + '</span>' +
                        metaBadges +
                        '<span class="badge badge-grey">rate: ' + (ch.rate_limit_minutes != null ? ch.rate_limit_minutes : 10) + ' min</span>' +
                        statsBadges +
                    '</div>' +
                '</div>' +
                '<div class="item-card-actions">' +
                    '<button class="btn btn-sm btn-secondary btn-test-channel" data-name="' + escHtml(name) + '">&#x1F9EA; Test</button>' +
                    manageBtn +
                    '<button class="btn btn-sm btn-edit-channel" data-name="' + escHtml(name) + '">&#x270F;&#xFE0F; Edit</button>' +
                    '<button class="btn btn-sm btn-danger btn-delete-channel" data-name="' + escHtml(name) + '">&#x1F5D1;&#xFE0F; Delete</button>' +
                '</div>' +
            '</div>' +
            '<div class="tg-manage-panel" id="tgManage-' + escHtml(name) + '" style="display:none"></div>' +
        '</div>';
    }).join('');

    list.querySelectorAll('.btn-test-channel').forEach(function(btn) {
        btn.addEventListener('click', function() { testChannel(btn.dataset.name); });
    });
    list.querySelectorAll('.btn-manage-channel').forEach(function(btn) {
        btn.addEventListener('click', function() { toggleTelegramManagePanel(btn.dataset.name); });
    });
    list.querySelectorAll('.btn-edit-channel').forEach(function(btn) {
        btn.addEventListener('click', function() { showChannelForm(btn.dataset.name); });
    });
    list.querySelectorAll('.btn-delete-channel').forEach(function(btn) {
        btn.addEventListener('click', function() { deleteChannel(btn.dataset.name); });
    });
}

// ── Telegram Bot Management Panel ────────────────────────────────────────────

function toggleTelegramManagePanel(name) {
    var panel = el('tgManage-' + name);
    if (!panel) return;
    if (panel.style.display !== 'none') {
        panel.style.display = 'none';
        panel.innerHTML = '';
        return;
    }
    panel.style.display = 'block';
    renderTelegramManagePanel(name, panel);
}

async function tgManageCall(name, action, extra) {
    var ch = localConfig.channels[name];
    if (!ch) return null;
    // If the token is masked (never sent back from server), we pass an empty
    // string and let the backend use the saved channel by name instead.
    // The backend endpoint accepts bot_token="" as "use saved channel config".
    var token = (ch.bot_token && ch.bot_token !== '********') ? ch.bot_token : '';
    var body = Object.assign({ bot_token: token, chat_id: ch.chat_id || '', action: action, channel: name }, extra || {});
    try {
        var resp = await apiFetch('/admin/notifications/telegram-manage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return await resp.json();
    } catch (err) {
        if (err.message === 'Redirecting to login') return null;
        return { ok: false, error: err.message };
    }
}

function tgMgrAlert(name, type, msg) {
    var container = el('tgMgr-alert-' + name);
    if (!container) return;
    var div = document.createElement('div');
    div.className = 'alert alert-' + type;
    div.style.marginTop = '6px';
    div.innerHTML = '<span>' + escHtml(msg) + '</span><span class="alert-dismiss" title="Dismiss">&#x2715;</span>';
    div.querySelector('.alert-dismiss').addEventListener('click', function() { div.remove(); });
    container.innerHTML = '';
    container.appendChild(div);
    setTimeout(function() { if (div.parentNode) div.remove(); }, 5000);
}

function addTgCmdRow(name, cmd, desc) {
    var container = el('tgMgr-cmdRows-' + name);
    if (!container) return;
    var row = document.createElement('div');
    row.className = 'webhook-header-row';
    row.style.cssText = 'display:flex;gap:8px;margin-bottom:6px;align-items:center';
    row.innerHTML =
        '<input type="text" class="tg-cmd-name" placeholder="/command" value="' + escHtml(cmd) + '" style="flex:1;min-width:0" maxlength="32">' +
        '<input type="text" class="tg-cmd-desc" placeholder="Description shown in menu" value="' + escHtml(desc) + '" style="flex:2;min-width:0" maxlength="256">' +
        '<button type="button" class="btn btn-sm btn-danger tg-cmd-remove" title="Remove">&#x2715;</button>';
    row.querySelector('.tg-cmd-remove').addEventListener('click', function() { row.remove(); });
    container.appendChild(row);
}

function readTgCmdRows(name) {
    var container = el('tgMgr-cmdRows-' + name);
    if (!container) return [];
    var out = [];
    container.querySelectorAll('.webhook-header-row').forEach(function(row) {
        var cmd = row.querySelector('.tg-cmd-name').value.trim().replace(/^\//, '');
        var desc = row.querySelector('.tg-cmd-desc').value.trim();
        if (cmd && desc) out.push({ command: cmd, description: desc });
    });
    return out;
}

async function loadTelegramInfo(name) {
    var infoEl = el('tgMgr-info-' + name);
    var actionsEl = el('tgMgr-actions-' + name);
    if (!infoEl) return;

    infoEl.innerHTML = '<div class="loading-overlay" style="padding:8px 0"><div class="spinner"></div> Loading\u2026</div>';
    if (actionsEl) actionsEl.style.display = 'none';

    var res = await tgManageCall(name, 'get_info', {});
    if (!res || !res.ok) {
        infoEl.innerHTML = '<div class="alert alert-error" style="margin:0">' + escHtml((res && res.error) || 'Failed to load info.') + '</div>';
        return;
    }

    var bot = res.bot || {};
    var chat = res.chat || {};
    var memberCount = res.member_count || 0;

    var chatTypeBadge = chat.type ? '<span class="badge badge-blue">' + escHtml(chat.type) + '</span>' : '';
    var chatTitle = chat.title || chat.first_name || ('Chat ' + (chat.id || ''));
    var chatDesc = chat.description ? '<div style="font-size:0.8rem;color:#555;margin-top:3px">' + escHtml(chat.description) + '</div>' : '';
    var memberBadge = memberCount > 0 ? '<span class="badge badge-grey">&#x1F465; ' + memberCount + ' member' + (memberCount !== 1 ? 's' : '') + '</span>' : '';
    var inviteLink = chat.invite_link ? '<a href="' + escHtml(chat.invite_link) + '" target="_blank" rel="noopener" style="font-size:0.8rem">' + escHtml(chat.invite_link) + '</a>' : '';

    var botName = bot.first_name || bot.username || 'Unknown';
    var botUsername = bot.username ? '@' + bot.username : '';
    var botCanJoin = bot.can_join_groups ? '\u2705 Can join groups' : '\u274C Cannot join groups';
    var botCanRead = bot.can_read_all_group_messages ? '\u2705 Reads all messages' : '';
    var botInline = bot.supports_inline_queries ? '\u2705 Inline queries' : '';

    infoEl.innerHTML =
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:4px">' +
            '<div style="background:#fff;border:1px solid #e0e0e0;border-radius:6px;padding:10px 12px">' +
                '<div style="font-size:0.75rem;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Chat</div>' +
                '<div style="font-weight:600;font-size:0.95rem">' + escHtml(chatTitle) + ' ' + chatTypeBadge + ' ' + memberBadge + '</div>' +
                chatDesc +
                (inviteLink ? '<div style="margin-top:4px">' + inviteLink + '</div>' : '') +
                '<div style="font-size:0.8rem;color:#888;margin-top:4px">ID: ' + escHtml(String(chat.id || '')) + '</div>' +
            '</div>' +
            '<div style="background:#fff;border:1px solid #e0e0e0;border-radius:6px;padding:10px 12px">' +
                '<div style="font-size:0.75rem;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Bot</div>' +
                '<div style="font-weight:600;font-size:0.95rem">&#x1F916; ' + escHtml(botName) + ' <span style="font-weight:400;color:#888">' + escHtml(botUsername) + '</span></div>' +
                '<div style="font-size:0.8rem;color:#555;margin-top:4px">' + botCanJoin + '</div>' +
                (botCanRead ? '<div style="font-size:0.8rem;color:#555">' + botCanRead + '</div>' : '') +
                (botInline ? '<div style="font-size:0.8rem;color:#555">' + botInline + '</div>' : '') +
            '</div>' +
        '</div>';

    var titleInput = el('tgMgr-title-' + name);
    if (titleInput && chat.title) titleInput.value = chat.title;
    var descInput = el('tgMgr-desc-' + name);
    if (descInput && chat.description) descInput.value = chat.description;
    var botNameInput = el('tgMgr-botName-' + name);
    if (botNameInput && bot.first_name) botNameInput.value = bot.first_name;

    var cmdRes = await tgManageCall(name, 'get_commands', {});
    var cmdRows = el('tgMgr-cmdRows-' + name);
    if (cmdRows) {
        cmdRows.innerHTML = '';
        if (cmdRes && cmdRes.ok && Array.isArray(cmdRes.commands)) {
            cmdRes.commands.forEach(function(c) { addTgCmdRow(name, c.command, c.description); });
        }
    }

    if (actionsEl) actionsEl.style.display = 'block';
}

function renderTelegramManagePanel(name, panel) {
    panel.innerHTML =
        '<div style="border-top:1px solid #e0e0e0;padding:16px;background:#fafafa">' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">' +
                '<span style="font-size:1.2rem">&#x1F916;</span>' +
                '<strong style="color:#1565c0">Bot Management</strong>' +
                '<span style="flex:1"></span>' +
                '<button class="btn btn-sm btn-secondary" id="tgMgr-refresh-' + escHtml(name) + '">&#x1F504; Refresh</button>' +
            '</div>' +
            '<div id="tgMgr-info-' + escHtml(name) + '">' +
                '<div class="loading-overlay" style="padding:8px 0"><div class="spinner"></div> Loading bot &amp; chat info\u2026</div>' +
            '</div>' +
            '<div id="tgMgr-actions-' + escHtml(name) + '" style="display:none">' +
                '<div style="margin-top:14px">' +
                    '<div style="font-weight:600;font-size:0.85rem;color:#333;margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em">Chat Actions <span style="font-weight:400;color:#888;font-size:0.8rem">(bot must be admin)</span></div>' +
                    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:8px">' +
                        '<div style="flex:1;min-width:180px"><label style="font-size:0.8rem;color:#555;display:block;margin-bottom:3px">Rename chat</label>' +
                        '<input type="text" id="tgMgr-title-' + escHtml(name) + '" placeholder="New chat title" style="width:100%"></div>' +
                        '<button class="btn btn-sm" id="tgMgr-setTitle-' + escHtml(name) + '">Set Title</button>' +
                    '</div>' +
                    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:8px">' +
                        '<div style="flex:1;min-width:180px"><label style="font-size:0.8rem;color:#555;display:block;margin-bottom:3px">Chat description</label>' +
                        '<input type="text" id="tgMgr-desc-' + escHtml(name) + '" placeholder="New description (blank to clear)" style="width:100%"></div>' +
                        '<button class="btn btn-sm" id="tgMgr-setDesc-' + escHtml(name) + '">Set Description</button>' +
                    '</div>' +
                    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">' +
                        '<button class="btn btn-sm btn-secondary" id="tgMgr-inviteLink-' + escHtml(name) + '">&#x1F517; Generate Invite Link</button>' +
                        '<span id="tgMgr-inviteLinkResult-' + escHtml(name) + '" style="font-size:0.85rem;color:#1565c0;word-break:break-all"></span>' +
                    '</div>' +
                    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
                        '<button class="btn btn-sm btn-secondary" id="tgMgr-admins-' + escHtml(name) + '">&#x1F464; Show Admins</button>' +
                    '</div>' +
                    '<div id="tgMgr-adminsResult-' + escHtml(name) + '" style="margin-top:6px"></div>' +
                '</div>' +
                '<div style="margin-top:16px;border-top:1px solid #e8e8e8;padding-top:14px">' +
                    '<div style="font-weight:600;font-size:0.85rem;color:#333;margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em">Bot Identity <span style="font-weight:400;color:#888;font-size:0.8rem">(global \u2014 affects all chats)</span></div>' +
                    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:8px">' +
                        '<div style="flex:1;min-width:180px"><label style="font-size:0.8rem;color:#555;display:block;margin-bottom:3px">Bot display name</label>' +
                        '<input type="text" id="tgMgr-botName-' + escHtml(name) + '" placeholder="New bot name" style="width:100%"></div>' +
                        '<button class="btn btn-sm" id="tgMgr-setBotName-' + escHtml(name) + '">Rename Bot</button>' +
                    '</div>' +
                    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:8px">' +
                        '<div style="flex:1;min-width:180px"><label style="font-size:0.8rem;color:#555;display:block;margin-bottom:3px">Bot about text</label>' +
                        '<input type="text" id="tgMgr-botAbout-' + escHtml(name) + '" placeholder="Short description shown in bot profile" style="width:100%"></div>' +
                        '<button class="btn btn-sm" id="tgMgr-setBotAbout-' + escHtml(name) + '">Set About</button>' +
                    '</div>' +
                '</div>' +
                '<div style="margin-top:16px;border-top:1px solid #e8e8e8;padding-top:14px">' +
                    '<div style="font-weight:600;font-size:0.85rem;color:#333;margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em">Bot Commands Menu</div>' +
                    '<p style="font-size:0.8rem;color:#666;margin:0 0 8px">These appear in Telegram\'s <code>/</code> command picker. Each command must be lowercase letters/numbers/underscores, max 32 chars.</p>' +
                    '<div id="tgMgr-cmdRows-' + escHtml(name) + '"></div>' +
                    '<div style="display:flex;gap:8px;margin-top:6px">' +
                        '<button class="btn btn-sm btn-secondary" id="tgMgr-addCmd-' + escHtml(name) + '">+ Add Command</button>' +
                        '<button class="btn btn-sm" id="tgMgr-saveCmd-' + escHtml(name) + '">&#x1F4BE; Save Commands</button>' +
                        '<button class="btn btn-sm btn-secondary" id="tgMgr-clearCmd-' + escHtml(name) + '">&#x1F5D1; Clear All</button>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div id="tgMgr-alert-' + escHtml(name) + '" style="margin-top:10px"></div>' +
        '</div>';

    loadTelegramInfo(name);

    el('tgMgr-refresh-' + name).addEventListener('click', function() { loadTelegramInfo(name); });

    el('tgMgr-setTitle-' + name).addEventListener('click', async function() {
        var title = el('tgMgr-title-' + name).value.trim();
        if (!title) { tgMgrAlert(name, 'error', 'Enter a title first.'); return; }
        var res = await tgManageCall(name, 'set_title', { title: title });
        if (res && res.ok) { tgMgrAlert(name, 'success', res.message || 'Title updated.'); loadTelegramInfo(name); }
        else { tgMgrAlert(name, 'error', (res && res.error) || 'Failed.'); }
    });

    el('tgMgr-setDesc-' + name).addEventListener('click', async function() {
        var desc = el('tgMgr-desc-' + name).value;
        var res = await tgManageCall(name, 'set_description', { description: desc });
        if (res && res.ok) { tgMgrAlert(name, 'success', res.message || 'Description updated.'); loadTelegramInfo(name); }
        else { tgMgrAlert(name, 'error', (res && res.error) || 'Failed.'); }
    });

    el('tgMgr-inviteLink-' + name).addEventListener('click', async function() {
        var res = await tgManageCall(name, 'export_invite_link', {});
        if (res && res.ok) {
            var span = el('tgMgr-inviteLinkResult-' + name);
            var link = res.invite_link || '';
            var a = document.createElement('a');
            a.href = link;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = link;
            a.style.fontSize = '0.85rem';
            var copyBtn = document.createElement('button');
            copyBtn.className = 'btn btn-xs';
            copyBtn.style.marginLeft = '6px';
            copyBtn.textContent = 'Copy';
            copyBtn.addEventListener('click', function() {
                navigator.clipboard.writeText(link).then(function() {
                    copyBtn.textContent = 'Copied!';
                    setTimeout(function() { copyBtn.textContent = 'Copy'; }, 2000);
                });
            });
            span.innerHTML = '';
            span.appendChild(a);
            span.appendChild(copyBtn);
        } else {
            tgMgrAlert(name, 'error', (res && res.error) || 'Failed.');
        }
    });

    el('tgMgr-admins-' + name).addEventListener('click', async function() {
        var res = await tgManageCall(name, 'get_admins', {});
        var container = el('tgMgr-adminsResult-' + name);
        if (!res || !res.ok) {
            container.innerHTML = '<span style="color:#c62828;font-size:0.85rem">' + escHtml((res && res.error) || 'Failed.') + '</span>';
            return;
        }
        var admins = Array.isArray(res.admins) ? res.admins : [];
        if (admins.length === 0) {
            container.innerHTML = '<span style="font-size:0.85rem;color:#888">No admins found.</span>';
            return;
        }
        container.innerHTML = '<div style="font-size:0.85rem;display:flex;flex-wrap:wrap;gap:6px">' +
            admins.map(function(a) {
                var user = a.user || {};
                var label = user.username ? '@' + user.username : (user.first_name || String(user.id));
                var isBot = user.is_bot ? ' \uD83E\uDD16' : '';
                var status = a.status === 'creator' ? ' \uD83D\uDC51' : '';
                return '<span class="badge badge-grey">' + escHtml(label) + isBot + status + '</span>';
            }).join('') +
        '</div>';
    });

    el('tgMgr-setBotName-' + name).addEventListener('click', async function() {
        var n = el('tgMgr-botName-' + name).value.trim();
        if (!n) { tgMgrAlert(name, 'error', 'Enter a name first.'); return; }
        var res = await tgManageCall(name, 'set_bot_name', { name: n });
        if (res && res.ok) { tgMgrAlert(name, 'success', res.message || 'Bot name updated.'); loadTelegramInfo(name); }
        else { tgMgrAlert(name, 'error', (res && res.error) || 'Failed.'); }
    });

    el('tgMgr-setBotAbout-' + name).addEventListener('click', async function() {
        var desc = el('tgMgr-botAbout-' + name).value;
        var res = await tgManageCall(name, 'set_bot_description', { description: desc });
        if (res && res.ok) { tgMgrAlert(name, 'success', res.message || 'Bot about updated.'); loadTelegramInfo(name); }
        else { tgMgrAlert(name, 'error', (res && res.error) || 'Failed.'); }
    });

    el('tgMgr-addCmd-' + name).addEventListener('click', function() { addTgCmdRow(name, '', ''); });

    el('tgMgr-saveCmd-' + name).addEventListener('click', async function() {
        var commands = readTgCmdRows(name);
        var res = await tgManageCall(name, 'set_commands', { commands: commands });
        if (res && res.ok) { tgMgrAlert(name, 'success', res.message || 'Commands saved.'); }
        else { tgMgrAlert(name, 'error', (res && res.error) || 'Failed.'); }
    });

    el('tgMgr-clearCmd-' + name).addEventListener('click', async function() {
        if (!confirm('Clear all bot commands? This removes the /command menu from Telegram.')) return;
        var res = await tgManageCall(name, 'set_commands', { commands: [] });
        if (res && res.ok) {
            tgMgrAlert(name, 'success', 'Commands cleared.');
            el('tgMgr-cmdRows-' + name).innerHTML = '';
        } else {
            tgMgrAlert(name, 'error', (res && res.error) || 'Failed.');
        }
    });
}

async function deleteChannel(name) {
    if (!confirm('Delete channel "' + name + '"? It will also be removed from any rules that reference it.')) return;
    delete localConfig.channels[name];
    localConfig.rules.forEach(function(rule) {
        rule.channels = rule.channels.filter(function(c) { return c !== name; });
    });
    renderChannels();
    renderRules();
    await saveConfig(el('channelsAlerts'));
}

async function testChannel(name) {
    const alertEl = el('channelsAlerts');
    const ch = localConfig.channels[name];
    if (!ch) return;

    let body;
    if (ch.type === 'email') {
        if (ch.smtp_password === '********') {
            // Real password only lives on the server — test the saved channel.
            body = { channel: name };
        } else {
            body = {
                type:           'email',
                smtp_host:      ch.smtp_host,
                smtp_port:      Number(ch.smtp_port) || 587,
                smtp_security:  ch.smtp_security || 'starttls',
                smtp_username:  ch.smtp_username || '',
                smtp_password:  ch.smtp_password || '',
                email_from:     ch.email_from,
                email_to:       Array.isArray(ch.email_to) ? ch.email_to : parseCSV(String(ch.email_to || '')),
                subject_prefix: ch.subject_prefix || '[UberSDR]',
            };
        }
    } else if (ch.type === 'webhook') {
        if (ch.webhook_secret === '********') {
            // Real secret only lives on the server — test the saved channel.
            body = { channel: name };
        } else {
            body = {
                type:                       'webhook',
                webhook_url:                ch.webhook_url,
                webhook_method:             ch.webhook_method || 'POST',
                webhook_format:             ch.webhook_format || 'text',
                webhook_secret:             ch.webhook_secret || '',
                webhook_headers:            ch.webhook_headers || {},
                webhook_timeout_seconds:    Number(ch.webhook_timeout_seconds) || 10,
                webhook_insecure_skip_verify: !!ch.webhook_insecure_skip_verify,
                webhook_body_template:      ch.webhook_body_template || '',
            };
        }
    } else if (ch.bot_token && ch.bot_token !== '********') {
        body = { type: ch.type, bot_token: ch.bot_token, chat_id: ch.chat_id, parse_mode: ch.parse_mode || 'HTML' };
    } else {
        body = { channel: name };
    }

    showAlert(alertEl, 'info', 'Sending test to "' + name + '"...', true);
    try {
        const resp = await apiFetch('/admin/notifications/test', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(body),
        });
        const data = await resp.json();
        if (data.ok) {
            showAlert(alertEl, 'success', 'Test sent to "' + name + '" in ' + data.duration_ms + 'ms');
        } else {
            showAlert(alertEl, 'error', 'Test failed: ' + (data.error || 'unknown error'), false);
        }
    } catch (err) {
        if (err.message === 'Redirecting to login') return;
        showAlert(alertEl, 'error', 'Test error: ' + err.message, false);
    }
}

function renderChannelTypeInfo(type, provider) {
    const panel = el('chTypeInfo');
    if (!panel) return;
    if (type === 'telegram') {
        panel.innerHTML =
            '<div class="config-section" style="background:#e8f4fd;border:1px solid #90caf9;border-radius:6px;padding:14px 16px;margin-bottom:16px">' +
                '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">' +
                    '<span style="font-size:1.3rem">&#x1F916;</span>' +
                    '<strong style="color:#1565c0">Setting up a Telegram Bot</strong>' +
                '</div>' +
                '<ol style="margin:0;padding-left:20px;color:#1a237e;font-size:0.875rem;line-height:1.8">' +
                    '<li>Open Telegram and search for <strong>@BotFather</strong>.</li>' +
                    '<li>Send <code>/newbot</code> and follow the prompts to choose a name and username.</li>' +
                    '<li>BotFather will give you a <strong>Bot Token</strong> — paste it in the field below.</li>' +
                    '<li>Open a chat with your new bot (or add it to a group/channel) and <strong>send it at least one message</strong> so Telegram registers the chat.</li>' +
                    '<li>Click <strong>Discover Chats</strong> to find the Chat ID automatically, or paste it manually.</li>' +
                '</ol>' +
                '<p style="margin:10px 0 0;font-size:0.8rem;color:#555">&#x26A0;&#xFE0F; For group/channel notifications, add the bot as an <strong>administrator</strong> with permission to post messages.</p>' +
            '</div>';
    } else if (type === 'email') {
        // Providers that require an app password (basic-auth SMTP) rather than the
        // account password. Gmail/Yahoo/iCloud all need 2FA + an app password.
        const appPwProviders = { gmail: 'Google', yahoo: 'Yahoo', icloud: 'iCloud' };
        let appPwNote = '';
        if (appPwProviders[provider]) {
            appPwNote =
                '<p style="margin:10px 0 0;font-size:0.85rem;color:#7a4f01;background:#fff3cd;border:1px solid #ffe08a;border-radius:5px;padding:8px 10px">' +
                    '&#x1F511; <strong>' + escHtml(appPwProviders[provider]) + ' requires an App Password.</strong> ' +
                    'Turn on <strong>2-Step Verification</strong>, then generate a 16-character App Password and paste it in the ' +
                    '<strong>Password</strong> field — your normal account password will not work.' +
                    (provider === 'gmail' ? ' Create one at <code>myaccount.google.com → Security → App passwords</code>.' : '') +
                '</p>';
        }
        panel.innerHTML =
            '<div class="config-section" style="background:#e8f4fd;border:1px solid #90caf9;border-radius:6px;padding:14px 16px;margin-bottom:16px">' +
                '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
                    '<span style="font-size:1.3rem">&#x2709;&#xFE0F;</span>' +
                    '<strong style="color:#1565c0">Email (SMTP)</strong>' +
                '</div>' +
                '<p style="margin:0;font-size:0.875rem;color:#1a237e;line-height:1.6">' +
                    'Works with any provider. Pick one from <strong>Provider</strong> to prefill the server settings, ' +
                    'then enter your username and password. Choose <strong>Custom</strong> for a self-hosted server.' +
                '</p>' +
                appPwNote +
            '</div>';
    } else if (type === 'webhook') {
        var preset = WEBHOOK_PRESETS[provider] || WEBHOOK_PRESETS['custom'];
        var hintHtml = preset.hint
            ? '<p style="margin:8px 0 0;font-size:0.875rem;color:#1a237e;line-height:1.6">&#x1F4A1; ' + preset.hint + '</p>'
            : '';
        panel.innerHTML =
            '<div class="config-section" style="background:#e8f4fd;border:1px solid #90caf9;border-radius:6px;padding:14px 16px;margin-bottom:16px">' +
                '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
                    '<span style="font-size:1.3rem">&#x1F517;</span>' +
                    '<strong style="color:#1565c0">Webhook (HTTP POST)</strong>' +
                '</div>' +
                '<p style="margin:0;font-size:0.875rem;color:#1a237e;line-height:1.6">' +
                    'Sends an HTTP request to any URL when a notification fires. ' +
                    'Works with ntfy, Slack, Discord, Home Assistant, n8n, Zapier, and any custom endpoint.' +
                '</p>' +
                hintHtml +
                '<p style="margin:8px 0 0;font-size:0.8rem;color:#555">&#x1F512; Use <strong>https://</strong> and a <strong>Signing Secret</strong> so the receiver can verify requests came from UberSDR.</p>' +
            '</div>';
    } else {
        panel.innerHTML = '';
    }
}

// telegramFieldsHTML / emailFieldsHTML render the type-specific portion of the
// channel form into #chTypeFields.
function telegramFieldsHTML(ch, isEdit) {
    const parseModes = ['HTML','Markdown','MarkdownV2',''];
    const parseModeOptions = parseModes.map(function(m) {
        return '<option value="' + m + '"' + (ch.parse_mode === m ? ' selected' : '') + '>' + (m || 'plain') + '</option>';
    }).join('');
    const tokenPlaceholder = (isEdit && ch.bot_token === '********')
        ? 'Leave blank to keep existing token'
        : 'e.g. 7123456789:AAFxxxxxxxxxxxxxxxx';
    return '' +
        '<div class="form-group">' +
            '<label>Bot Token' + (isEdit && ch.bot_token === '********' ? ' (currently set)' : ' *') + '</label>' +
            '<div class="input-group">' +
                '<input type="password" id="chBotToken" value="" placeholder="' + tokenPlaceholder + '" autocomplete="new-password">' +
                '<button type="button" class="btn btn-secondary btn-sm" id="btnDiscoverChats">Discover Chats</button>' +
            '</div>' +
            '<div class="form-hint">From @BotFather. Leave blank to keep existing token when editing.</div>' +
        '</div>' +
        '<div id="chatDiscoveryResult"></div>' +
        '<div class="form-row">' +
            '<div class="form-group">' +
                '<label>Chat ID *</label>' +
                '<input type="text" id="chChatId" value="' + escHtml(ch.chat_id || '') + '" placeholder="e.g. -1001234567890">' +
                '<div class="form-hint">Negative for groups/channels, positive for personal chats.</div>' +
            '</div>' +
            '<div class="form-group">' +
                '<label>Parse Mode</label>' +
                '<select id="chParseMode">' + parseModeOptions + '</select>' +
            '</div>' +
        '</div>';
}

function emailFieldsHTML(ch, isEdit) {
    const provider = detectEmailProvider(ch.smtp_host);
    const providerOptions = Object.keys(EMAIL_PRESETS).map(function(k) {
        return '<option value="' + k + '"' + (provider === k ? ' selected' : '') + '>' + escHtml(EMAIL_PRESETS[k].label) + '</option>';
    }).join('');
    const securities = [['starttls','STARTTLS (587)'],['tls','TLS / SSL (465)'],['none','None (insecure)']];
    const sec = ch.smtp_security || 'starttls';
    const securityOptions = securities.map(function(s) {
        return '<option value="' + s[0] + '"' + (sec === s[0] ? ' selected' : '') + '>' + s[1] + '</option>';
    }).join('');
    const pwSet = isEdit && ch.smtp_password === '********';
    const pwPlaceholder = pwSet ? 'Leave blank to keep existing password' : 'App Password / SMTP password (blank = no auth)';
    const toVal = Array.isArray(ch.email_to) ? ch.email_to.join(', ') : (ch.email_to || '');
    return '' +
        '<div class="form-row">' +
            '<div class="form-group">' +
                '<label>Provider</label>' +
                '<select id="chEmailProvider">' + providerOptions + '</select>' +
                '<div class="form-hint">Prefills server settings. Pick Custom for anything else.</div>' +
            '</div>' +
            '<div class="form-group">' +
                '<label>Security</label>' +
                '<select id="chSmtpSecurity">' + securityOptions + '</select>' +
            '</div>' +
        '</div>' +
        '<div class="form-row">' +
            '<div class="form-group" style="flex:2">' +
                '<label>SMTP Host *</label>' +
                '<input type="text" id="chSmtpHost" value="' + escHtml(ch.smtp_host || '') + '" placeholder="e.g. smtp.gmail.com">' +
            '</div>' +
            '<div class="form-group" style="max-width:120px">' +
                '<label>Port</label>' +
                '<input type="number" id="chSmtpPort" value="' + (ch.smtp_port || 587) + '" min="1" max="65535">' +
            '</div>' +
        '</div>' +
        '<div class="form-row">' +
            '<div class="form-group">' +
                '<label>Username</label>' +
                '<input type="text" id="chSmtpUsername" value="' + escHtml(ch.smtp_username || '') + '" placeholder="usually your full email address" autocomplete="off">' +
            '</div>' +
            '<div class="form-group">' +
                '<label>Password' + (pwSet ? ' (currently set)' : '') + '</label>' +
                '<input type="password" id="chSmtpPassword" value="" placeholder="' + pwPlaceholder + '" autocomplete="new-password">' +
                '<div class="form-hint">Leave blank to keep existing (when editing) or for an unauthenticated relay.</div>' +
            '</div>' +
        '</div>' +
        '<div class="form-row">' +
            '<div class="form-group">' +
                '<label>From *</label>' +
                '<input type="text" id="chEmailFrom" value="' + escHtml(ch.email_from || '') + '" placeholder="UberSDR &lt;me@example.com&gt;">' +
            '</div>' +
            '<div class="form-group">' +
                '<label>To *</label>' +
                '<input type="text" id="chEmailTo" value="' + escHtml(toVal) + '" placeholder="you@example.com, other@example.com">' +
                '<div class="form-hint">Comma-separated for multiple recipients.</div>' +
            '</div>' +
        '</div>' +
        '<div class="form-group" style="max-width:320px">' +
            '<label>Subject Prefix</label>' +
            '<input type="text" id="chSubjectPrefix" value="' + escHtml(ch.subject_prefix || '[UberSDR]') + '" placeholder="[UberSDR]">' +
            '<div class="form-hint">Subject = prefix + first line of the message.</div>' +
        '</div>';
}

// ── Webhook channel form helpers ──────────────────────────────────────────────

function webhookHeaderRow(name, value) {
    return '<div class="webhook-header-row" style="display:flex;gap:8px;margin-bottom:6px;align-items:center">' +
        '<input type="text" class="wh-name" placeholder="Header name" value="' + escHtml(name) + '" style="flex:1;min-width:0" maxlength="256">' +
        '<input type="text" class="wh-value" placeholder="Value" value="' + escHtml(value) + '" style="flex:2;min-width:0" maxlength="1024">' +
        '<button type="button" class="btn btn-sm btn-danger wh-remove" title="Remove header">&#x2715;</button>' +
    '</div>';
}

function readWebhookHeaders() {
    var out = {};
    document.querySelectorAll('#chWebhookHeaders .webhook-header-row').forEach(function(row) {
        var k = row.querySelector('.wh-name').value.trim();
        var v = row.querySelector('.wh-value').value.trim();
        if (k) out[k] = v;
    });
    return out;
}

function attachRemoveHeader(btn) {
    btn.addEventListener('click', function() { btn.closest('.webhook-header-row').remove(); });
}

function webhookFieldsHTML(ch, isEdit) {
    var preset = detectWebhookPreset(ch.webhook_url || '');
    var presetOptions = Object.keys(WEBHOOK_PRESETS).map(function(k) {
        return '<option value="' + k + '"' + (preset === k ? ' selected' : '') + '>' +
               escHtml(WEBHOOK_PRESETS[k].label) + '</option>';
    }).join('');
    var methods = ['POST', 'PUT'];
    var methodOptions = methods.map(function(m) {
        return '<option value="' + m + '"' + ((ch.webhook_method || 'POST') === m ? ' selected' : '') + '>' + m + '</option>';
    }).join('');
    var formats = [
        ['text',    'text/plain — raw message (ntfy, custom)'],
        ['json',    'JSON envelope — {channel, message, timestamp}'],
        ['slack',   'Slack JSON — {"text":"…"}'],
        ['discord', 'Discord JSON — {"content":"…"}'],
    ];
    var formatOptions = formats.map(function(f) {
        return '<option value="' + f[0] + '"' + ((ch.webhook_format || 'text') === f[0] ? ' selected' : '') + '>' + escHtml(f[1]) + '</option>';
    }).join('');
    var secretSet = isEdit && ch.webhook_secret === '********';
    var secretPlaceholder = secretSet ? 'Leave blank to keep existing secret' : 'Optional HMAC-SHA256 signing secret';

    // Build existing header rows
    var headers = ch.webhook_headers || {};
    var headerRows = Object.keys(headers).map(function(k) {
        return webhookHeaderRow(k, headers[k]);
    }).join('');

    return '' +
        '<div class="form-row">' +
            '<div class="form-group">' +
                '<label>Service Preset</label>' +
                '<select id="chWebhookPreset">' + presetOptions + '</select>' +
                '<div class="form-hint">Prefills URL template and format. Pick Custom for anything else.</div>' +
            '</div>' +
            '<div class="form-group">' +
                '<label>Method</label>' +
                '<select id="chWebhookMethod">' + methodOptions + '</select>' +
            '</div>' +
        '</div>' +
        '<div class="form-group">' +
            '<label>Webhook URL *</label>' +
            '<input type="url" id="chWebhookURL" value="' + escHtml(ch.webhook_url || '') + '" placeholder="https://…" maxlength="2048">' +
            '<div class="form-hint">Use <strong>https://</strong> for any public endpoint.</div>' +
        '</div>' +
        '<div id="chWebhookPresetHint"></div>' +
        '<div class="form-row">' +
            '<div class="form-group">' +
                '<label>Payload Format</label>' +
                '<select id="chWebhookFormat">' + formatOptions + '</select>' +
            '</div>' +
            '<div class="form-group" style="max-width:130px">' +
                '<label>Timeout (s)</label>' +
                '<input type="number" id="chWebhookTimeout" value="' + (ch.webhook_timeout_seconds || 10) + '" min="1" max="60">' +
                '<div class="form-hint">1–60 seconds.</div>' +
            '</div>' +
        '</div>' +
        '<div class="form-group">' +
            '<label>Signing Secret' + (secretSet ? ' (currently set)' : '') + '</label>' +
            '<input type="password" id="chWebhookSecret" value="" placeholder="' + escHtml(secretPlaceholder) + '" autocomplete="new-password">' +
            '<div class="form-hint">When set, every request includes <code>X-Hub-Signature-256: sha256=&lt;hmac&gt;</code> so the receiver can verify authenticity. Leave blank to keep existing when editing.</div>' +
        '</div>' +
        '<div class="form-group">' +
            '<label>Extra Headers <span style="font-weight:400;font-size:0.8rem;color:#888">(optional)</span></label>' +
            '<div id="chWebhookHeaders">' + headerRows + '</div>' +
            '<button type="button" class="btn btn-sm btn-secondary" id="btnAddWebhookHeader" style="margin-top:6px">+ Add Header</button>' +
            '<div class="form-hint">e.g. <code>Authorization: Bearer &lt;token&gt;</code> or <code>X-Gotify-Key: &lt;token&gt;</code></div>' +
        '</div>' +
        '<div class="form-group">' +
            '<label class="checkbox-item">' +
                '<input type="checkbox" id="chWebhookInsecure"' + (ch.webhook_insecure_skip_verify ? ' checked' : '') + '> ' +
                'Skip TLS certificate verification' +
            '</label>' +
            '<div class="form-hint">&#x26A0;&#xFE0F; Only for self-signed certificates on private LANs. Never use on public endpoints.</div>' +
        '</div>' +
        '<div class="form-group">' +
            '<label>Body Template <span style="font-weight:400;font-size:0.8rem;color:#888">(optional — overrides Payload Format)</span></label>' +
            '<textarea id="chWebhookBodyTemplate" rows="4" placeholder=\'{"message":"{{jsonEscape .Message}}","title":"UberSDR","priority":5}\'>' + escHtml(ch.webhook_body_template || '') + '</textarea>' +
            '<div class="form-hint">When set, renders the full request body using Go <code>text/template</code> syntax. Overrides the Payload Format above. Leave blank to use the format instead.</div>' +
        '</div>' +
        '<details class="template-ref" style="margin-bottom:16px">' +
            '<summary class="template-ref-summary">Body template reference</summary>' +
            '<div class="template-ref-body">' +
                '<p style="margin:0 0 8px;font-size:0.85rem;color:#555">The template is rendered once per notification. Content-Type defaults to <code>application/json</code>; override via Extra Headers if needed.</p>' +
                '<table class="template-ref-table">' +
                    '<thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>' +
                    '<tbody>' +
                        '<tr><td><code>{{.Message}}</code></td><td><span class="template-ref-type">string</span></td><td>The fully-rendered notification text. May contain newlines.</td></tr>' +
                        '<tr><td><code>{{.Channel}}</code></td><td><span class="template-ref-type">string</span></td><td>The webhook channel name as configured.</td></tr>' +
                        '<tr><td><code>{{.Timestamp}}</code></td><td><span class="template-ref-type">string</span></td><td>Current UTC time in RFC3339 format, e.g. <code>2026-07-01T11:00:00Z</code>.</td></tr>' +
                    '</tbody>' +
                '</table>' +
                '<p style="margin:10px 0 4px;font-size:0.85rem;font-weight:600;color:#333">Examples</p>' +
                '<table class="template-ref-table">' +
                    '<thead><tr><th>Service</th><th>Template</th></tr></thead>' +
                    '<tbody>' +
                        '<tr><td>Gotify</td><td><code>{"message":"{{jsonEscape .Message}}","title":"UberSDR","priority":5}</code></td></tr>' +
                        '<tr><td>Slack (rich)</td><td><code>{"text":"{{jsonEscape .Message}}","username":"UberSDR"}</code></td></tr>' +
                        '<tr><td>Custom JSON</td><td><code>{"alert":"{{jsonEscape .Message}}","source":"{{.Channel}}","ts":"{{.Timestamp}}"}</code></td></tr>' +
                        '<tr><td>ntfy (JSON)</td><td><code>{"topic":"my-topic","message":"{{jsonEscape .Message}}","title":"UberSDR"}</code></td></tr>' +
                    '</tbody>' +
                '</table>' +
                '<p style="margin:10px 0 4px;font-size:0.85rem;font-weight:600;color:#333">Template functions</p>' +
                '<table class="template-ref-table">' +
                    '<thead><tr><th>Function</th><th>Example</th><th>Description</th></tr></thead>' +
                    '<tbody>' +
                        '<tr><td><code>jsonEscape s</code></td><td><code>{"msg":"{{jsonEscape .Message}}"}</code></td><td>JSON-escapes a string (backslashes, quotes, control chars). Use when embedding <code>.Message</code> inside a JSON template.</td></tr>' +
                        '<tr><td><code>upper s</code></td><td><code>{{upper .Channel}}</code></td><td>Converts string to upper case.</td></tr>' +
                        '<tr><td><code>lower s</code></td><td><code>{{lower .Channel}}</code></td><td>Converts string to lower case.</td></tr>' +
                    '</tbody>' +
                '</table>' +
                '<p style="margin:10px 0 0;font-size:0.8rem;color:#888">&#x26A0;&#xFE0F; Always use <code>{{jsonEscape .Message}}</code> (not <code>{{.Message}}</code>) when embedding the message inside a JSON template — otherwise a message containing <code>"</code> or <code>\\</code> will produce invalid JSON.</p>' +
            '</div>' +
        '</details>';
}

function renderWebhookPresetHint(presetKey) {
    var panel = el('chWebhookPresetHint');
    if (!panel) return;
    var preset = WEBHOOK_PRESETS[presetKey];
    if (!preset || !preset.hint) { panel.innerHTML = ''; return; }
    panel.innerHTML =
        '<div style="background:#e8f4fd;border:1px solid #90caf9;border-radius:6px;padding:10px 14px;margin-bottom:12px;font-size:0.875rem;color:#1a237e;line-height:1.6">' +
        '&#x1F4A1; ' + preset.hint +
        '</div>';
}

function showChannelForm(editName) {
    const container = el('channelFormContainer');
    const isEdit = editName !== null && editName !== undefined;
    const ch = isEdit ? Object.assign({}, localConfig.channels[editName]) : {
        type: 'telegram', bot_token: '', chat_id: '', parse_mode: 'HTML', rate_limit_minutes: 10,
    };

    const nameReadonly = isEdit ? 'readonly style="background:#f0f0f0"' : '';
    const types = [['telegram','Telegram'],['email','Email (SMTP)'],['webhook','Webhook (HTTP)']];
    const typeOptions = types.map(function(t) {
        return '<option value="' + t[0] + '"' + ((ch.type || 'telegram') === t[0] ? ' selected' : '') + '>' + t[1] + '</option>';
    }).join('');

    container.style.display = 'block';
    container.innerHTML =
        '<div class="inline-form">' +
            '<div class="inline-form-title">' + (isEdit ? 'Edit Channel: ' + escHtml(editName) : '+ New Channel') + '</div>' +
            '<div class="form-row">' +
                '<div class="form-group">' +
                    '<label>Channel Name *</label>' +
                    '<input type="text" id="chName" value="' + escHtml(isEdit ? editName : '') + '" placeholder="e.g. telegram_main" ' + nameReadonly + '>' +
                    '<div class="form-hint">Unique identifier used in rules. Letters, numbers, underscores.</div>' +
                '</div>' +
                '<div class="form-group">' +
                    '<label>Type *</label>' +
                    '<select id="chType"' + (isEdit ? ' disabled' : '') + '>' + typeOptions + '</select>' +
                    (isEdit ? '<div class="form-hint">Type cannot be changed after creation.</div>' : '') +
                '</div>' +
            '</div>' +
            '<div id="chTypeInfo"></div>' +
            '<div id="chTypeFields"></div>' +
            '<div class="form-group" style="max-width:200px">' +
                '<label>Rate Limit (minutes)</label>' +
                '<input type="number" id="chRateLimit" value="' + (ch.rate_limit_minutes != null ? ch.rate_limit_minutes : 10) + '" min="0" max="1440">' +
                '<div class="form-hint">Suppress duplicate alerts within this window. 0 = no limit.</div>' +
            '</div>' +
            '<div class="form-actions">' +
                '<button type="button" class="btn" id="btnSaveChannel">Save Channel</button>' +
                '<button type="button" class="btn btn-secondary" id="btnCancelChannel">Cancel</button>' +
            '</div>' +
        '</div>';

    // Render the fields for the currently-selected type, plus its info panel.
    function renderTypeFields() {
        const type = el('chType').value;
        if (type === 'email') {
            el('chTypeFields').innerHTML = emailFieldsHTML(ch, isEdit);
            renderChannelTypeInfo('email', detectEmailProvider(ch.smtp_host));
            // Provider preset prefills host/port/security and refreshes the hint.
            el('chEmailProvider').addEventListener('change', function() {
                const preset = EMAIL_PRESETS[this.value];
                if (preset) {
                    if (preset.host) el('chSmtpHost').value = preset.host;
                    el('chSmtpPort').value = preset.port;
                    el('chSmtpSecurity').value = preset.security;
                }
                renderChannelTypeInfo('email', this.value);
            });
            // Keep the app-password hint in sync if the host is typed manually.
            el('chSmtpHost').addEventListener('change', function() {
                const p = detectEmailProvider(this.value);
                el('chEmailProvider').value = p;
                renderChannelTypeInfo('email', p);
            });
        } else if (type === 'webhook') {
            const initialPreset = detectWebhookPreset(ch.webhook_url || '');
            el('chTypeFields').innerHTML = webhookFieldsHTML(ch, isEdit);
            renderChannelTypeInfo('webhook', initialPreset);
            renderWebhookPresetHint(initialPreset);
            // Preset selector prefills URL template, method, and format.
            el('chWebhookPreset').addEventListener('change', function() {
                const preset = WEBHOOK_PRESETS[this.value];
                if (preset) {
                    if (preset.urlTemplate) el('chWebhookURL').value = preset.urlTemplate;
                    el('chWebhookMethod').value = preset.method;
                    el('chWebhookFormat').value = preset.format;
                }
                renderChannelTypeInfo('webhook', this.value);
                renderWebhookPresetHint(this.value);
            });
            // Keep preset selector in sync when URL is typed manually.
            el('chWebhookURL').addEventListener('input', function() {
                const p = detectWebhookPreset(this.value);
                el('chWebhookPreset').value = p;
                renderChannelTypeInfo('webhook', p);
                renderWebhookPresetHint(p);
            });
            // Add/remove header rows.
            el('btnAddWebhookHeader').addEventListener('click', function() {
                el('chWebhookHeaders').insertAdjacentHTML('beforeend', webhookHeaderRow('', ''));
                el('chWebhookHeaders').querySelectorAll('.wh-remove').forEach(attachRemoveHeader);
            });
            el('chWebhookHeaders').querySelectorAll('.wh-remove').forEach(attachRemoveHeader);
        } else {
            el('chTypeFields').innerHTML = telegramFieldsHTML(ch, isEdit);
            renderChannelTypeInfo('telegram');
            el('btnDiscoverChats').addEventListener('click', function() { discoverChats(editName); });
        }
    }
    renderTypeFields();
    el('chType').addEventListener('change', renderTypeFields);

    el('btnCancelChannel').addEventListener('click', function() {
        container.style.display = 'none';
        container.innerHTML = '';
    });

    el('btnSaveChannel').addEventListener('click', async function() {
        const name = el('chName').value.trim();
        if (!name) { showAlert(el('channelsAlerts'), 'error', 'Channel name is required.', false); return; }
        if (!/^[a-zA-Z0-9_]+$/.test(name)) { showAlert(el('channelsAlerts'), 'error', 'Channel name must be letters, numbers, underscores only.', false); return; }

        const type = el('chType').value;
        const rate = parseInt(el('chRateLimit').value, 10) || 0;
        let channel;

        if (type === 'email') {
            const host = el('chSmtpHost').value.trim();
            if (!host) { showAlert(el('channelsAlerts'), 'error', 'SMTP host is required.', false); return; }
            const from = el('chEmailFrom').value.trim();
            if (!from) { showAlert(el('channelsAlerts'), 'error', 'From address is required.', false); return; }
            const to = parseCSV(el('chEmailTo').value);
            if (to.length === 0) { showAlert(el('channelsAlerts'), 'error', 'At least one recipient is required.', false); return; }

            const newPw = el('chSmtpPassword').value.trim();
            let finalPw;
            if (newPw) {
                finalPw = newPw;
            } else if (isEdit && ch.smtp_password === '********') {
                finalPw = '********';
            } else {
                finalPw = '';
            }

            channel = {
                type:               'email',
                smtp_host:          host,
                smtp_port:          parseInt(el('chSmtpPort').value, 10) || 587,
                smtp_security:      el('chSmtpSecurity').value,
                smtp_username:      el('chSmtpUsername').value.trim(),
                smtp_password:      finalPw,
                email_from:         from,
                email_to:           to,
                subject_prefix:     el('chSubjectPrefix').value.trim() || '[UberSDR]',
                rate_limit_minutes: rate,
            };
        } else if (type === 'webhook') {
            const url = el('chWebhookURL').value.trim();
            if (!url) { showAlert(el('channelsAlerts'), 'error', 'Webhook URL is required.', false); return; }
            if (!/^https?:\/\/.+/.test(url)) { showAlert(el('channelsAlerts'), 'error', 'Webhook URL must start with http:// or https://', false); return; }
            if (url.length > 2048) { showAlert(el('channelsAlerts'), 'error', 'Webhook URL must be 2048 characters or fewer.', false); return; }

            const timeout = parseInt(el('chWebhookTimeout').value, 10);
            if (isNaN(timeout) || timeout < 1 || timeout > 60) { showAlert(el('channelsAlerts'), 'error', 'Timeout must be between 1 and 60 seconds.', false); return; }

            // Validate header names and values before saving.
            const headers = readWebhookHeaders();
            const headerNameRe = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~]+$/;
            for (const k in headers) {
                if (!headerNameRe.test(k)) {
                    showAlert(el('channelsAlerts'), 'error', 'Header name "' + k + '" contains invalid characters.', false);
                    return;
                }
                if (/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(headers[k])) {
                    showAlert(el('channelsAlerts'), 'error', 'Header "' + k + '" value contains invalid characters (no CR, LF, or control characters).', false);
                    return;
                }
            }

            const newSecret = el('chWebhookSecret').value.trim();
            let finalSecret;
            if (newSecret) {
                finalSecret = newSecret;
            } else if (isEdit && ch.webhook_secret === '********') {
                finalSecret = '********';
            } else {
                finalSecret = '';
            }

            channel = {
                type:                       'webhook',
                webhook_url:                url,
                webhook_method:             el('chWebhookMethod').value,
                webhook_format:             el('chWebhookFormat').value,
                webhook_secret:             finalSecret,
                webhook_headers:            headers,
                webhook_timeout_seconds:    timeout,
                webhook_insecure_skip_verify: el('chWebhookInsecure').checked,
                webhook_body_template:      el('chWebhookBodyTemplate').value.trim(),
                rate_limit_minutes:         rate,
            };
        } else {
            const newToken = el('chBotToken').value.trim();
            let finalToken;
            if (newToken) {
                finalToken = newToken;
            } else if (isEdit && ch.bot_token === '********') {
                finalToken = '********';
            } else {
                finalToken = '';
            }

            const chatId = el('chChatId').value.trim();
            if (!chatId) { showAlert(el('channelsAlerts'), 'error', 'Chat ID is required.', false); return; }

            channel = {
                type:               'telegram',
                bot_token:          finalToken,
                chat_id:            chatId,
                parse_mode:         el('chParseMode').value,
                rate_limit_minutes: rate,
            };
        }

        localConfig.channels[name] = channel;

        container.style.display = 'none';
        container.innerHTML = '';
        renderChannels();
        await saveConfig(el('channelsAlerts'));
    });
}

async function discoverChats(editName) {
    const token = el('chBotToken').value.trim();
    const resultEl = el('chatDiscoveryResult');

    if (!token) {
        resultEl.innerHTML = '<div class="alert alert-warning" style="margin-top:8px">Enter a bot token first.</div>';
        return;
    }

    resultEl.innerHTML = '<div class="loading-overlay" style="padding:8px 0"><div class="spinner"></div> Querying Telegram...</div>';

    try {
        const resp = await apiFetch('/admin/notifications/telegram-updates', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ bot_token: token }),
        });
        const data = await resp.json();

        if (!data.ok) {
            resultEl.innerHTML = '<div class="alert alert-error" style="margin-top:8px">Error: ' + escHtml(data.error || 'Unknown error') + '</div>';
            return;
        }

        let html = '<div class="config-section" style="margin-top:12px">' +
            '<div class="config-section-title">Bot: @' + escHtml(data.bot_username || '?') + '</div>';

        if (!data.chats || data.chats.length === 0) {
            html += '<p style="font-size:0.875rem;color:#888">' + escHtml(data.hint || 'No chats found. Send a message to your bot then try again.') + '</p>';
        } else {
            html += '<ul class="chat-list">';
            data.chats.forEach(function(chat) {
                const displayName = chat.title || (chat.first_name ? chat.first_name + (chat.last_name ? ' ' + chat.last_name : '') : '') || String(chat.id);
                html += '<li class="chat-item">' +
                    '<div class="chat-item-info">' +
                        '<span class="chat-item-name">' + escHtml(displayName) + '</span>' +
                        '<span class="chat-item-id">ID: ' + chat.id + ' &bull; ' + escHtml(chat.type) + '</span>' +
                    '</div>' +
                    '<button type="button" class="btn btn-xs" data-chatid="' + chat.id + '">Use this</button>' +
                '</li>';
            });
            html += '</ul>';
        }
        html += '</div>';
        resultEl.innerHTML = html;

        resultEl.querySelectorAll('[data-chatid]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                el('chChatId').value = btn.dataset.chatid;
                resultEl.innerHTML = '<div class="alert alert-success" style="margin-top:8px">Chat ID set to ' + escHtml(btn.dataset.chatid) + '</div>';
            });
        });
    } catch (err) {
        if (err.message === 'Redirecting to login') return;
        resultEl.innerHTML = '<div class="alert alert-error" style="margin-top:8px">Error: ' + escHtml(err.message) + '</div>';
    }
}

function initChannels() {
    el('btnAddChannel').addEventListener('click', function() { showChannelForm(null); });
}

// =============================================================================
// TAB 3 — RULES
// =============================================================================

function renderRules() {
    const list = el('ruleList');
    const rules = localConfig.rules;

    if (rules.length === 0) {
        list.innerHTML =
            '<div class="empty-state">' +
                '<div class="empty-state-icon">&#x1F4CB;</div>' +
                '<p>No rules configured yet.</p>' +
                '<p style="font-size:0.85rem;margin-top:4px">Click &ldquo;Add Rule&rdquo; to create one.</p>' +
            '</div>';
        return;
    }

    const byRule    = lastStats.by_rule             || {};
    const byRuleErr = lastStats.by_rule_errors       || {};
    const byRuleRL  = lastStats.by_rule_rate_limited || {};

    list.innerHTML = rules.map(function(rule, idx) {
        const enabledBadge = rule.enabled
            ? '<span class="badge badge-green">Enabled</span>'
            : '<span class="badge badge-grey">Disabled</span>';
        const channelBadges = (rule.channels || []).map(function(c) {
            return '<span class="badge badge-blue">' + escHtml(c) + '</span>';
        }).join('');
        const filterCount = rule.filters ? Object.keys(rule.filters).length : 0;
        const filterBadge = filterCount > 0
            ? '<span class="badge badge-purple">' + filterCount + ' filter' + (filterCount !== 1 ? 's' : '') + '</span>'
            : '';
        const templateBadge = rule.template
            ? '<span class="badge badge-yellow">custom template</span>'
            : '';
        const overrideCount = rule.templates ? Object.keys(rule.templates).length : 0;
        const overrideBadge = overrideCount > 0
            ? '<span class="badge badge-yellow" title="Per-channel template overrides">' + overrideCount + ' channel template' + (overrideCount !== 1 ? 's' : '') + '</span>'
            : '';
        const dedupBadge = (Array.isArray(rule.dedup_by) && rule.dedup_by.length > 0)
            ? '<span class="badge badge-purple" title="Notify once per ' + escHtml(rule.dedup_by.join(', ')) +
                (rule.dedup_window_minutes ? ' every ' + rule.dedup_window_minutes + ' min' : ' (until restart)') + '">' +
                '&#x1F501; once per ' + escHtml(rule.dedup_by.join('+')) + '</span>'
            : '';
        const rKey    = rule.name;
        const sent    = byRule[rKey]    || 0;
        const errors  = byRuleErr[rKey]  || 0;
        const rateLim = byRuleRL[rKey]   || 0;
        const statsBadges =
            '<span class="badge badge-green" title="Messages sent">&#x2709; ' + sent + ' sent</span>' +
            (errors  > 0 ? '<span class="badge badge-red"    title="Send errors">&#x26A0; '   + errors  + ' err</span>'  : '') +
            (rateLim > 0 ? '<span class="badge badge-yellow" title="Rate-limited">&#x23F1; ' + rateLim + ' RL</span>'   : '');

        return '<div class="item-card" data-rule-idx="' + idx + '">' +
            '<div class="item-card-header">' +
                '<div>' +
                    '<div class="item-card-title">&#x1F4CB; ' + escHtml(rule.name) + '</div>' +
                    '<div class="item-card-meta">' +
                        enabledBadge +
                        '<span class="badge badge-grey">' + escHtml(eventLabel(rule.event)) + '</span>' +
                        channelBadges +
                        filterBadge +
                        dedupBadge +
                        templateBadge +
                        overrideBadge +
                        statsBadges +
                    '</div>' +
                '</div>' +
                '<div class="item-card-actions">' +
                    '<label class="toggle-switch" title="' + (rule.enabled ? 'Disable' : 'Enable') + '">' +
                        '<input type="checkbox" class="rule-toggle" data-idx="' + idx + '"' + (rule.enabled ? ' checked' : '') + '>' +
                        '<span class="toggle-slider"></span>' +
                    '</label>' +
                    '<button class="btn btn-sm btn-edit-rule" data-idx="' + idx + '">&#x270F;&#xFE0F; Edit</button>' +
                    '<button class="btn btn-sm btn-danger btn-delete-rule" data-idx="' + idx + '">&#x1F5D1;&#xFE0F; Delete</button>' +
                '</div>' +
            '</div>' +
        '</div>';
    }).join('');

    list.querySelectorAll('.rule-toggle').forEach(function(chk) {
        chk.addEventListener('change', async function() {
            const idx = parseInt(chk.dataset.idx, 10);
            localConfig.rules[idx].enabled = chk.checked;
            renderRules();
            await saveConfig(el('rulesAlerts'));
        });
    });
    list.querySelectorAll('.btn-edit-rule').forEach(function(btn) {
        btn.addEventListener('click', function() { showRuleForm(parseInt(btn.dataset.idx, 10)); });
    });
    list.querySelectorAll('.btn-delete-rule').forEach(function(btn) {
        btn.addEventListener('click', function() { deleteRule(parseInt(btn.dataset.idx, 10)); });
    });
}

async function deleteRule(idx) {
    const rule = localConfig.rules[idx];
    if (!rule) return;
    if (!confirm('Delete rule "' + rule.name + '"?')) return;
    localConfig.rules.splice(idx, 1);
    renderRules();
    await saveConfig(el('rulesAlerts'));
}

function showRuleForm(editIdx) {
    const container = el('ruleFormContainer');
    const isEdit = editIdx !== null && editIdx !== undefined && editIdx >= 0;
    const rule = isEdit ? Object.assign({}, localConfig.rules[editIdx], { filters: Object.assign({}, localConfig.rules[editIdx].filters) }) : {
        name: '', enabled: true, event: 'dx_spot', channels: [], filters: {}, template: '',
        dedup_by: [], dedup_window_minutes: 0, templates: {},
    };
    // Working copy of per-channel template overrides, preserved across re-renders.
    const workingTemplates = Object.assign({}, rule.templates || {});

    const eventOptions = EVENT_TYPES.map(function(et) {
        return '<option value="' + et + '"' + (rule.event === et ? ' selected' : '') + '>' + eventLabel(et) + '</option>';
    }).join('');

    const channelCheckboxes = Object.keys(localConfig.channels).map(function(name) {
        const checked = (rule.channels || []).indexOf(name) >= 0 ? ' checked' : '';
        return '<label class="checkbox-item"><input type="checkbox" class="rule-channel-cb" value="' + escHtml(name) + '"' + checked + '> ' + escHtml(name) + '</label>';
    }).join('');

    container.style.display = 'block';
    container.innerHTML =
        '<div class="inline-form">' +
            '<div class="inline-form-title">' + (isEdit ? 'Edit Rule: ' + escHtml(rule.name) : '+ New Rule') + '</div>' +
            '<div class="form-row">' +
                '<div class="form-group">' +
                    '<label>Rule Name *</label>' +
                    '<input type="text" id="ruleName" value="' + escHtml(rule.name) + '" placeholder="e.g. DX Alerts">' +
                '</div>' +
                '<div class="form-group">' +
                    '<label>Event Type *</label>' +
                    '<select id="ruleEvent">' + eventOptions + '</select>' +
                '</div>' +
            '</div>' +
            '<div class="toggle-row" style="margin-bottom:16px">' +
                '<label class="toggle-switch">' +
                    '<input type="checkbox" id="ruleEnabled"' + (rule.enabled ? ' checked' : '') + '>' +
                    '<span class="toggle-slider"></span>' +
                '</label>' +
                '<span class="toggle-label">Rule Enabled</span>' +
            '</div>' +
            '<div class="config-section">' +
                '<div class="config-section-title">Channels</div>' +
                (Object.keys(localConfig.channels).length === 0
                    ? '<p style="font-size:0.875rem;color:#888">No channels configured. Add a channel first.</p>'
                    : '<div class="checkbox-group" id="ruleChannels">' + channelCheckboxes + '</div>') +
            '</div>' +
            '<div class="config-section" id="filterSection">' +
                '<div class="config-section-title">Filters <span style="font-weight:400;font-size:0.8rem;color:#888">(all optional — leave blank to match everything)</span></div>' +
                '<div class="filter-fields-container" id="filterFields"></div>' +
            '</div>' +
            '<div class="config-section" id="dedupSection" style="display:none">' +
                '<div class="config-section-title">Deduplication <span style="font-weight:400;font-size:0.8rem;color:#888">(notify once per new value)</span></div>' +
                '<div id="dedupFields"></div>' +
            '</div>' +
            '<div class="config-section">' +
                '<div class="config-section-title">Default Template <span style="font-weight:400;font-size:0.8rem;color:#888">(optional — leave blank to use built-in default)</span></div>' +
                '<div class="form-group">' +
                    '<textarea id="ruleTemplate" rows="4" placeholder="Go template, e.g. DX: {{.DXCall}} on {{khz .Frequency}} kHz">' + escHtml(rule.template || '') + '</textarea>' +
                    '<div class="form-hint">Used for any selected channel without its own override below. Uses Go <code>text/template</code> syntax — see fields below.</div>' +
                '</div>' +
                '<div id="channelTemplateOverrides"></div>' +
                '<div id="templateFieldsRef"></div>' +
            '</div>' +
            '<div class="form-actions">' +
                '<button type="button" class="btn" id="btnSaveRule">Save Rule</button>' +
                '<button type="button" class="btn btn-secondary" id="btnCancelRule">Cancel</button>' +
            '</div>' +
        '</div>';

    // Render filter fields, dedup fields and template reference for current event
    renderFilterFields(rule.event, rule.filters);
    renderDedupFields(rule.event, rule.dedup_by, rule.dedup_window_minutes);
    renderTemplateFields(rule.event);
    renderChannelTemplateOverrides(workingTemplates);

    // Re-render filters, dedup and template reference when event type changes
    el('ruleEvent').addEventListener('change', function() {
        renderFilterFields(el('ruleEvent').value, {});
        renderDedupFields(el('ruleEvent').value, [], 0);
        renderTemplateFields(el('ruleEvent').value);
    });

    // When the selected channels change, refresh the per-channel override boxes,
    // preserving anything already typed.
    container.querySelectorAll('.rule-channel-cb').forEach(function(cb) {
        cb.addEventListener('change', function() {
            captureChannelTemplateOverrides(workingTemplates);
            renderChannelTemplateOverrides(workingTemplates);
        });
    });

    el('btnCancelRule').addEventListener('click', function() {
        container.style.display = 'none';
        container.innerHTML = '';
    });

    el('btnSaveRule').addEventListener('click', async function() {
        const name = el('ruleName').value.trim();
        if (!name) { showAlert(el('rulesAlerts'), 'error', 'Rule name is required.', false); return; }

        const selectedChannels = [];
        container.querySelectorAll('.rule-channel-cb:checked').forEach(function(cb) {
            selectedChannels.push(cb.value);
        });

        const eventType = el('ruleEvent').value;
        const filters = readFilterFields(eventType);
        const dedup = readDedupFields(eventType);
        const template = el('ruleTemplate').value.trim();

        // Collect per-channel overrides for the channels still selected.
        captureChannelTemplateOverrides(workingTemplates);
        const templates = {};
        selectedChannels.forEach(function(c) {
            if (workingTemplates[c]) templates[c] = workingTemplates[c];
        });

        const newRule = {
            name:                 name,
            enabled:              el('ruleEnabled').checked,
            event:                eventType,
            channels:             selectedChannels,
            filters:              filters,
            dedup_by:             dedup.dedup_by,
            dedup_window_minutes: dedup.dedup_window_minutes,
            template:             template,
            templates:            templates,
        };

        if (isEdit) {
            localConfig.rules[editIdx] = newRule;
        } else {
            localConfig.rules.push(newRule);
        }

        container.style.display = 'none';
        container.innerHTML = '';
        renderRules();
        await saveConfig(el('rulesAlerts'));
    });
}

// captureChannelTemplateOverrides reads the currently-rendered override
// textareas into the working map so their content survives a re-render.
function captureChannelTemplateOverrides(workingTemplates) {
    document.querySelectorAll('.ch-tmpl-override').forEach(function(ta) {
        const name = ta.dataset.channel;
        const val = ta.value.trim();
        if (val) {
            workingTemplates[name] = val;
        } else {
            delete workingTemplates[name];
        }
    });
}

// renderChannelTemplateOverrides draws one collapsible override box per
// currently-selected channel. Empty boxes mean "use the default template".
function renderChannelTemplateOverrides(workingTemplates) {
    const container = el('channelTemplateOverrides');
    if (!container) return;

    const selected = [];
    document.querySelectorAll('.rule-channel-cb:checked').forEach(function(cb) { selected.push(cb.value); });

    if (selected.length === 0) {
        container.innerHTML = '';
        return;
    }

    let html = '<div class="config-section-title" style="margin-top:14px">Per-channel Templates ' +
        '<span style="font-weight:400;font-size:0.8rem;color:#888">(optional — overrides the default above for that channel)</span></div>';
    selected.forEach(function(name) {
        const val = workingTemplates[name] || '';
        const open = val ? ' open' : '';
        html += '<details class="template-ref"' + open + ' style="margin-bottom:8px">' +
            '<summary class="template-ref-summary">' + escHtml(name) +
                (val ? ' <span class="badge badge-yellow">override</span>' : '') + '</summary>' +
            '<div class="form-group" style="margin-top:8px">' +
                '<textarea class="ch-tmpl-override" data-channel="' + escHtml(name) + '" rows="3" ' +
                    'placeholder="Leave blank to use the default template above">' + escHtml(val) + '</textarea>' +
            '</div>' +
        '</details>';
    });
    container.innerHTML = html;
}

function renderFilterFields(eventType, currentFilters) {
    const container = el('filterFields');
    const fields = FILTER_FIELDS[eventType] || [];

    if (fields.length === 0) {
        container.innerHTML = '<p style="font-size:0.875rem;color:#888">No filters available for this event type.</p>';
        return;
    }

    container.innerHTML = fields.map(function(fd) {
        const val = currentFilters && currentFilters[fd.name] !== undefined ? currentFilters[fd.name] : '';
        let inputHtml = '';

        if (fd.type === 'enum_list') {
            const selectedVals = Array.isArray(val) ? val : (val ? parseCSV(String(val)) : []);
            inputHtml = '<div class="checkbox-group">' +
                fd.values.map(function(v) {
                    const checked = selectedVals.indexOf(v) >= 0 ? ' checked' : '';
                    return '<label class="checkbox-item"><input type="checkbox" class="filter-enum" data-field="' + fd.name + '" value="' + escHtml(v) + '"' + checked + '> ' + escHtml(v) + '</label>';
                }).join('') +
            '</div>';
        } else if (fd.type === 'bool') {
            const boolVal = val === true || val === 'true' ? 'true' : (val === false || val === 'false' ? 'false' : '');
            inputHtml = '<select class="filter-input" data-field="' + fd.name + '" data-type="' + fd.type + '">' +
                '<option value=""' + (boolVal === '' ? ' selected' : '') + '>-- not set --</option>' +
                '<option value="true"' + (boolVal === 'true' ? ' selected' : '') + '>true</option>' +
                '<option value="false"' + (boolVal === 'false' ? ' selected' : '') + '>false</option>' +
            '</select>';
        } else if (fd.type === 'bool_optional') {
            const boolVal = val === true || val === 'true' ? 'true' : (val === false || val === 'false' ? 'false' : '');
            inputHtml = '<select class="filter-input" data-field="' + fd.name + '" data-type="' + fd.type + '">' +
                '<option value=""' + (boolVal === '' ? ' selected' : '') + '>-- any --</option>' +
                '<option value="true"' + (boolVal === 'true' ? ' selected' : '') + '>true (moving)</option>' +
                '<option value="false"' + (boolVal === 'false' ? ' selected' : '') + '>false (stopped)</option>' +
            '</select>';
        } else if (fd.type === 'toggle_on') {
            // Single checkbox, ON by default — unchecked only when explicitly false.
            const checked = (val === false || val === 'false') ? '' : ' checked';
            inputHtml = '<label class="checkbox-item"><input type="checkbox" class="filter-toggle" data-field="' + fd.name + '"' + checked + '> Enabled</label>';
        } else {
            // text / int / float. Pre-fill a configured default when unset.
            let effVal = val;
            if ((effVal === '' || effVal === null || effVal === undefined) && fd.default !== undefined) {
                effVal = fd.default;
            }
            const displayVal = Array.isArray(effVal) ? effVal.join(', ') : (effVal !== null && effVal !== undefined ? String(effVal) : '');
            const placeholder = fd.hint || '';
            if (fd.type === 'int' || fd.type === 'float') {
                // Numeric input with browser-enforced bounds.
                const minAttr  = fd.min !== undefined ? ' min="' + fd.min + '"' : '';
                const maxAttr  = fd.max !== undefined ? ' max="' + fd.max + '"' : '';
                const stepAttr = fd.type === 'int' ? ' step="1"' : ' step="any"';
                inputHtml = '<input type="number" class="filter-input" data-field="' + fd.name + '" data-type="' + fd.type + '"' + minAttr + maxAttr + stepAttr + ' value="' + escHtml(displayVal) + '" placeholder="' + escHtml(placeholder) + '">';
            } else {
                inputHtml = '<input type="text" class="filter-input" data-field="' + fd.name + '" data-type="' + fd.type + '" value="' + escHtml(displayVal) + '" placeholder="' + escHtml(placeholder) + '">';
            }
        }

        return '<div class="filter-field-row">' +
            '<div>' +
                '<div class="filter-field-label">' + escHtml(fd.label) + '</div>' +
                (fd.hint ? '<div class="filter-field-hint">' + escHtml(fd.hint) + '</div>' : '') +
            '</div>' +
            '<div>' + inputHtml + '</div>' +
        '</div>';
    }).join('');
}

function renderDedupFields(eventType, currentDedupBy, currentWindow) {
    const section = document.getElementById('dedupSection');
    const container = document.getElementById('dedupFields');
    if (!section || !container) return;

    const fields = DEDUP_FIELDS[eventType] || [];
    if (!isHighVolumeEvent(eventType) || fields.length === 0) {
        // Dedup only applies to high-volume spot events.
        section.style.display = 'none';
        container.innerHTML = '';
        return;
    }
    section.style.display = 'block';

    const selected = Array.isArray(currentDedupBy) ? currentDedupBy : [];
    const windowVal = (currentWindow === null || currentWindow === undefined) ? '' : currentWindow;

    const checkboxes = fields.map(function(fd) {
        const checked = selected.indexOf(fd.name) >= 0 ? ' checked' : '';
        return '<label class="checkbox-item"><input type="checkbox" class="dedup-key" data-key="' + fd.name + '" value="' + fd.name + '"' + checked + '> ' + escHtml(fd.label) + '</label>';
    }).join('');

    container.innerHTML =
        '<div class="form-hint" style="margin-bottom:10px">' +
            'These events fire <strong>hundreds of times per minute</strong>. ' +
            'Pick one or more keys below to notify <strong>only the first time each distinct value is seen</strong> ' +
            '(e.g. tick <em>Country</em> to be alerted once per new country, not on every spot). ' +
            'Leave all unticked only if you have set a selective filter above — otherwise the rule will be rejected.' +
        '</div>' +
        '<div class="filter-field-label">Notify once per</div>' +
        '<div class="checkbox-group" style="margin-bottom:12px">' + checkboxes + '</div>' +
        '<div class="filter-field-row">' +
            '<div>' +
                '<div class="filter-field-label">Re-arm after (minutes)</div>' +
                '<div class="filter-field-hint">How long before the same value can alert again. ' +
                    '<strong>0 = once until the server restarts.</strong> ' +
                    'e.g. 1440 = at most once per day per value.</div>' +
            '</div>' +
            '<div><input type="number" id="dedupWindow" min="0" max="525600" value="' + escHtml(String(windowVal === '' ? 0 : windowVal)) + '"></div>' +
        '</div>';
}

function readDedupFields(eventType) {
    const out = { dedup_by: [], dedup_window_minutes: 0 };
    if (!isHighVolumeEvent(eventType)) return out;
    const container = document.getElementById('dedupFields');
    if (!container) return out;
    container.querySelectorAll('.dedup-key:checked').forEach(function(cb) {
        out.dedup_by.push(cb.value);
    });
    const win = container.querySelector('#dedupWindow');
    if (win) {
        const n = parseInt(win.value, 10);
        if (!isNaN(n) && n > 0) out.dedup_window_minutes = n;
    }
    return out;
}

function renderTemplateFields(eventType) {
    const container = document.getElementById('templateFieldsRef');
    if (!container) return;

    const fields = TEMPLATE_FIELDS[eventType] || [];

    let html = '<details class="template-ref" open>' +
        '<summary class="template-ref-summary">Available fields for <strong>' + escHtml(eventLabel(eventType)) + '</strong></summary>' +
        '<div class="template-ref-body">';

    if (fields.length === 0) {
        html += '<p style="font-size:0.8rem;color:#888;margin:0">No template fields defined for this event type.</p>';
    } else {
        html += '<table class="template-ref-table">' +
            '<thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead>' +
            '<tbody>';
        fields.forEach(function(f) {
            html += '<tr>' +
                '<td><code>' + escHtml(f.name) + '</code></td>' +
                '<td><span class="template-ref-type">' + escHtml(f.goType) + '</span></td>' +
                '<td>' + f.desc + '</td>' +
            '</tr>';
        });
        html += '</tbody></table>';
    }

    html += '<details class="template-ref-funcs">' +
        '<summary>Template functions</summary>' +
        '<table class="template-ref-table">' +
        '<thead><tr><th>Function</th><th>Example</th><th>Description</th></tr></thead>' +
        '<tbody>';
    TEMPLATE_FUNCS.forEach(function(fn) {
        html += '<tr>' +
            '<td><code>' + escHtml(fn.sig) + '</code></td>' +
            '<td><code>' + escHtml(fn.example) + '</code></td>' +
            '<td>' + escHtml(fn.desc) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table></details>';

    html += '</div></details>';
    container.innerHTML = html;
}

function readFilterFields(eventType) {
    const fields = FILTER_FIELDS[eventType] || [];
    const out = {};
    const container = el('filterFields');
    if (!container) return out;

    fields.forEach(function(fd) {
        if (fd.type === 'enum_list') {
            const checked = [];
            container.querySelectorAll('.filter-enum[data-field="' + fd.name + '"]:checked').forEach(function(cb) {
                checked.push(cb.value);
            });
            if (checked.length > 0) out[fd.name] = checked;
        } else if (fd.type === 'toggle_on') {
            const cb = container.querySelector('.filter-toggle[data-field="' + fd.name + '"]');
            if (cb) out[fd.name] = cb.checked; // always explicit boolean
        } else {
            const input = container.querySelector('.filter-input[data-field="' + fd.name + '"]');
            if (!input) return;
            const raw = input.value.trim();
            if (!raw) {
                // Empty numeric field with a configured default → emit the default
                // so an enabled feature (e.g. flap detection) always has a value.
                if ((fd.type === 'int' || fd.type === 'float') && fd.default !== undefined) {
                    out[fd.name] = fd.default;
                }
                return;
            }
            if (fd.type === 'string_list') {
                const arr = parseCSV(raw);
                if (arr.length > 0) out[fd.name] = arr;
            } else if (fd.type === 'int_list') {
                const arr = parseIntCSV(raw);
                if (arr.length > 0) out[fd.name] = arr;
            } else if (fd.type === 'int') {
                let n = parseInt(raw, 10);
                if (isNaN(n)) { if (fd.default !== undefined) out[fd.name] = fd.default; return; }
                if (fd.min !== undefined && n < fd.min) n = fd.min;
                if (fd.max !== undefined && n > fd.max) n = fd.max;
                out[fd.name] = n;
            } else if (fd.type === 'float') {
                let n = parseFloat(raw);
                if (isNaN(n)) { if (fd.default !== undefined) out[fd.name] = fd.default; return; }
                if (fd.min !== undefined && n < fd.min) n = fd.min;
                if (fd.max !== undefined && n > fd.max) n = fd.max;
                out[fd.name] = n;
            } else if (fd.type === 'bool' || fd.type === 'bool_optional') {
                if (raw === 'true') out[fd.name] = true;
                else if (raw === 'false') out[fd.name] = false;
            }
        }
    });
    return out;
}

function initRules() {
    el('btnAddRule').addEventListener('click', function() { showRuleForm(null); });
}

// =============================================================================
// INIT
// =============================================================================

async function init() {
    initTabs();
    initOverview();
    initChannels();
    initRules();

    // Auth check + initial data load
    try {
        await loadHealth();
        await loadConfig();
    } catch (err) {
        if (err.message !== 'Redirecting to login') {
            showAlert(el('globalAlerts'), 'error', 'Initialisation error: ' + err.message, false);
        }
    }
}

document.addEventListener('DOMContentLoaded', init);
