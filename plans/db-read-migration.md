# DB Read Migration Plan

Migrate all file-based read operations (CSV/JSONL) to query the SQLite database instead.
Each component currently dual-writes to both files and DB. This plan replaces the read
path with DB queries, keeping the file write path intact as a fallback/backup.

---

## Cross-cutting principles

- **DB-first with file fallback**: If `db == nil` (DB not configured), fall back to the
  existing file-based read. This preserves backward compatibility for historical data
  predating the DB.
- **Historical data**: Data written before the DB was introduced only exists in files.
  A one-time migration script (separate task) can import it. Until then, the fallback
  handles it transparently.
- **No API contract changes**: All HTTP response shapes remain identical. Only the
  internal data source changes.
- **Unix timestamps in DB**: All `ts` columns store Unix seconds (INTEGER). Convert with
  `time.Unix(ts, 0).UTC()` when building response structs.
- **Read vs write connections**: `DBManager` exposes two pools:
  - `DB()` — single write connection (`MaxOpenConns=1`). Use for all `INSERT`/`UPDATE`/`DELETE`/`PRAGMA`.
  - `ReadDB()` — read-only pool (`MaxOpenConns=4`, `mode=ro`). **Use this for all `SELECT` queries.**
    WAL mode allows `ReadDB()` to run concurrently with the writer without any serialization delay.
  All subsystem structs that currently store `db *sql.DB` for writes should store a second
  `readDB *sql.DB` field (or receive it at construction) for reads. When `dbManager` is
  available, pass `dbManager.ReadDB()` to read paths and `dbManager.DB()` to write paths.

---

## Component 1 — `chat_messages` table ✅ MIGRATED

**DB table**: `chat_messages(id, ts, source_ip, username, message, country, country_code)`
**Status**: Fully migrated to SQLite. No file reads or writes at runtime.

### What was done

All three read operations and the write path were migrated. CSV file infrastructure removed entirely — no fallback, no dual-write.

#### 1.1 `HandleChatLogs` — `/admin/chat-logs` (GET) ✅

`readChatLogs()` replaced by `readChatLogsFromDB()` using `ah.dbManager.ReadDB()` directly:
```sql
SELECT ts, source_ip, username, message, country, country_code
FROM chat_messages
WHERE ts >= ? AND ts < ?
  [AND source_ip LIKE ?]
  [AND LOWER(username) LIKE ?]
  [AND LOWER(message) LIKE ?]
ORDER BY ts DESC LIMIT ?
```
Guard changed from `!ah.config.Chat.LogToCSV` to `ah.dbManager.ReadDB() == nil`.

#### 1.2 `LoadRecentMessages` — startup chat seed ✅

DB SELECT with `ts >= now-maxDays*24h ORDER BY ts ASC LIMIT maxMessages*2`; banned IPs filtered in Go after query.

#### 1.3 `GetLastKnownIPForUser` — reverse IP lookup ✅

Single `QueryRow`: `SELECT source_ip FROM chat_messages WHERE LOWER(username) = ? AND source_ip != '' AND ts >= ? ORDER BY ts DESC LIMIT 1`

#### Write path ✅

`LogMessage()` now does a direct SQLite INSERT only. `getOrCreateWriter()`, `rotateFile()` equivalent removed. `openFile`, `csvWriter`, `currentDay`, `fileMu` removed from struct. `Close()` is a no-op.

### Wiring chain

`main.go` → `dxClusterWsHandler.SetReadDB()` → `ChatManager.SetReadDB()` → `ChatLogger.SetReadDB()`

### Config changes

- `LogToCSV bool` removed from `ChatConfig` in [`config.go`](../config.go)
- `DataDir string` retained for [`db_import.go`](../db_import.go) (one-time historical CSV backfill)
- `log_to_csv` and `data_dir` removed from [`config/config.yaml.example`](../config/config.yaml.example) chat section
- `DataDir` resolution in [`main.go`](../main.go) no longer gated on `LogToCSV`

### Imports removed

From [`chat_logger.go`](../chat_logger.go): `encoding/csv`, `io`, `os`, `path/filepath`, `sync`
From [`chat_logs_api.go`](../chat_logs_api.go): `encoding/csv`, `io`, `os`, `path/filepath`, `sort`

---

## Component 2 — `noise_floor` table ✅ MIGRATED

**DB table**: `noise_floor(id, ts, band, min_db, max_db, mean_db, median_db, p5_db, p10_db, p95_db, dynamic_range, occupancy_pct, ft8_snr, snr_0_30_mhz, snr_1_8_30_mhz)`
**Status**: Fully migrated to SQLite. No file reads or writes at runtime.

### What was done

All five read operations and the write path were migrated. CSV file infrastructure removed entirely — no fallback, no dual-write.

#### 2.1 `GetHistoricalData` ✅ — DB SELECT with band + date range filter; returns error if `readDB == nil`

#### 2.2 `GetRecentData` ✅ — DB SELECT with `ts >= now-1h AND ts <= now`; optional band filter

#### 2.3 `GetTrendData` ✅ — DB SELECT for rolling 24h (today) or single day (historical); Go 10-min bucketing unchanged

#### 2.4 `GetTrendDataAllBands` ✅ — DB SELECT for rolling 24h, all bands; Go bucketing unchanged

#### 2.5 `GetAvailableDates` ✅ — `SELECT DISTINCT DATE(ts,'unixepoch')` replaces directory walk; `includeToday` filter applied in Go

#### Write path ✅ — `logToDB()` replaces `logMeasurement()` + `rotateFile()`; DB INSERT only

#### `GetAggregatedData` (`noise_floor_aggregate.go`) ✅ — also migrated to DB SELECT with band + time range

### Struct changes

- Removed: `currentFiles`, `csvWriters`, `currentDates`, `fileMu` (CSV infrastructure)
- Added: `readDB *sql.DB` + `SetReadDB()` method
- `Stop()`: removed CSV file close loop
- `NewNoiseFloorMonitor()`: removed `os.MkdirAll` for CSV data directory

### Config changes

- `DataDir string` retained in `NoiseFloorConfig` for [`db_import.go`](../db_import.go) (one-time historical CSV backfill)
- `data_dir` removed from [`config/config.yaml.example`](../config/config.yaml.example) noisefloor section
- `DataDir` resolution in [`main.go`](../main.go) no longer gated on `Enabled`
- `SetReadDB(dbManager.ReadDB())` wired in [`main.go`](../main.go) alongside existing `SetDB`

### Imports removed from `noise_floor.go`

`encoding/csv`, `path/filepath` — removed entirely. `os` retained (used by `os.Exit` in watchdog).

---

## Component 3 — `spots` table (decoder spots)

**DB table**: `spots(id, ts, mode, decoder_name, callsign, locator, snr, frequency, band, message, country, cq_zone, itu_zone, continent, distance_km, bearing_deg, dbm)`  
**Current read files**: [`decoder_spots_log.go`](../decoder_spots_log.go) · [`main.go`](../main.go)

### Operations to migrate

#### 3.1 `GetHistoricalSpots` — `/decoder-spots` (GET)

**Current**: [`decoder_spots_log.go:GetHistoricalSpots()`](../decoder_spots_log.go:337) iterates
dates × modes, reads CSV files, applies 15 filter parameters in Go, deduplicates, sorts.

**SQL replacement** (base query, conditions added dynamically):
```sql
SELECT ts, mode, decoder_name, callsign, locator, snr, frequency, band,
       message, country, cq_zone, itu_zone, continent, distance_km, bearing_deg, dbm
FROM spots
WHERE ts >= ?                          -- fromDate.Unix()
  AND ts <  ?                          -- toDate+1day.Unix()
  AND (? = '' OR mode = ?)             -- mode filter
  AND (? = '' OR band = ?)             -- band filter
  AND (? = '' OR decoder_name = ?)     -- name filter
  AND (? = '' OR callsign = ?)         -- exact callsign
  AND (? = '' OR locator = ?)          -- exact locator
  AND (? = '' OR continent = ?)        -- continent
  AND (? = 0  OR distance_km >= ?)     -- minDistanceKm
  AND (? = -999 OR snr >= ?)           -- minSNR
  AND (? = 0  OR locator != '')        -- locatorsOnly
  AND (? = '' OR (                     -- time-of-day filter (startTime HH:MM)
        CAST(strftime('%H', ts, 'unixepoch') AS INTEGER) * 60
      + CAST(strftime('%M', ts, 'unixepoch') AS INTEGER) >= ?
  ))
  AND (? = '' OR (
        CAST(strftime('%H', ts, 'unixepoch') AS INTEGER) * 60
      + CAST(strftime('%M', ts, 'unixepoch') AS INTEGER) <= ?
  ))
ORDER BY ts DESC
```

**Deduplication** (when `deduplicate=true`): Use a CTE or `GROUP BY` to keep the latest
row per `(callsign, locator, band, mode, DATE(ts,'unixepoch'))`:
```sql
WITH ranked AS (
    SELECT *, ROW_NUMBER() OVER (
        PARTITION BY callsign, locator, band, mode, DATE(ts,'unixepoch')
        ORDER BY ts DESC
    ) AS rn
    FROM spots
    WHERE ...  -- same filters as above
)
SELECT * FROM ranked WHERE rn = 1
ORDER BY ts DESC
```

**Direction filter**: SQLite has no bearing-to-direction function. Compute the bearing
range in Go (e.g. N = bearing >= 337.5 OR bearing < 22.5) and add `bearing_deg` range
conditions to the WHERE clause.

---

#### 3.2 `GetAvailableDates` — `/decoder-spots/dates` (GET)

**Current**: [`decoder_spots_log.go:GetAvailableDates()`](../decoder_spots_log.go:622) walks
the entire `MODE/YYYY/MM/DD/` directory tree.

**SQL replacement**:
```sql
SELECT DISTINCT DATE(ts, 'unixepoch') AS date
FROM spots
ORDER BY date DESC
```

---

#### 3.3 `GetAvailableNames` — `/decoder-spots/names` (GET)

**Current**: [`decoder_spots_log.go:GetAvailableNames()`](../decoder_spots_log.go:700) walks
the directory tree collecting `.csv` filenames (without extension).

**SQL replacement**:
```sql
SELECT DISTINCT decoder_name
FROM spots
WHERE decoder_name IS NOT NULL AND decoder_name != ''
ORDER BY decoder_name ASC
```

---

#### 3.4 `GetHistoricalCSV` — `/decoder-spots/csv` (GET)

**Current**: calls `GetHistoricalSpots()` then formats as CSV string.

**Migration**: Once `GetHistoricalSpots()` is migrated to DB, this function automatically
benefits — no separate change needed.

---

#### 3.5 `GetSpotsAnalytics` — `/decoder-spots/analytics` (GET)

**Current**: [`decoder_spots_log.go:GetSpotsAnalytics()`](../decoder_spots_log.go:918) calls
`GetHistoricalSpots()` then aggregates in Go (country → band → locator → callsign tree,
hourly distribution, best hours).

**SQL replacement** (aggregate query):
```sql
-- Per-country, per-band spot counts and SNR stats
SELECT
    country, continent, band,
    COUNT(*)                    AS spots,
    COUNT(DISTINCT callsign)    AS unique_callsigns,
    COUNT(DISTINCT locator)     AS unique_locators,
    MIN(snr)                    AS min_snr,
    AVG(snr)                    AS avg_snr,
    MAX(snr)                    AS max_snr
FROM spots
WHERE ts >= ?
  AND ts <  ?
  AND locator != ''
  AND (? = '' OR mode = ?)
  AND (? = '' OR band = ?)
  AND (? = '' OR continent = ?)
  AND (? = '' OR country = ?)
  AND snr >= ?
GROUP BY country, continent, band
ORDER BY spots DESC
```

The locator-level detail (per-locator callsign lists with mode+band combinations) is
complex to express in a single SQL query. Two options:

- **Option A**: Run the aggregate query above for the summary, then run a second query
  for locator detail only when a specific country is requested.
- **Option B**: Keep the Go aggregation logic but feed it rows from the DB query
  (replacing the file read with a DB scan). This is the lowest-risk approach.

**Recommended**: Option B for the initial migration — replace `GetHistoricalSpots()` with
a DB query, keep the Go aggregation logic unchanged.

---

#### 3.6 `GetSpotsAnalyticsHourly` — `/decoder-spots/analytics/hourly` (GET)

**Current**: [`decoder_spots_log.go:GetSpotsAnalyticsHourly()`](../decoder_spots_log.go:1350)
calls `GetHistoricalSpots()` then groups by UTC hour in Go.

**SQL replacement** (hourly aggregation):
```sql
SELECT
    CAST(strftime('%H', ts, 'unixepoch') AS INTEGER) AS hour,
    locator,
    COUNT(*)                    AS spots,
    COUNT(DISTINCT callsign)    AS unique_callsigns,
    AVG(snr)                    AS avg_snr
FROM spots
WHERE ts >= ?
  AND ts <  ?
  AND locator != ''
  AND (? = '' OR mode = ?)
  AND (? = '' OR band = ?)
  AND (? = '' OR continent = ?)
  AND (? = '' OR country = ?)
  AND snr >= ?
GROUP BY hour, locator
ORDER BY hour ASC, spots DESC
```

Same recommendation as 3.5: replace the data source with DB rows, keep Go aggregation.

---

**Files to change**: [`decoder_spots_log.go`](../decoder_spots_log.go) — add `db *sql.DB`
read path to `GetHistoricalSpots()`, `GetAvailableDates()`, `GetAvailableNames()`.
Keep file fallback when `db == nil`.

---

## Component 4 — `cw_spots` table

**DB table**: `cw_spots(id, ts, dx_call, spotter, snr, frequency, band, wpm, mode, comment, country, country_code, cq_zone, itu_zone, continent, latitude, longitude, distance_km, bearing_deg, op_name, state, grid, geoloc, tz_iana, loc_source)`  
**Current read files**: [`cwskimmer_spots_api.go`](../cwskimmer_spots_api.go) · [`cwskimmer_spots_log.go`](../cwskimmer_spots_log.go)

### Operations to migrate

#### 4.1 `GetCWHistoricalSpots` — `/cw-spots` (GET)

**Current**: [`cwskimmer_spots_api.go:GetCWHistoricalSpots()`](../cwskimmer_spots_api.go:52)
walks `YYYY/MM/DD/<band>.csv` files, applies filters, enriches with CTY lat/lon.

**SQL replacement**:
```sql
SELECT ts, dx_call, spotter, snr, frequency, band, wpm, mode, comment,
       country, country_code, cq_zone, itu_zone, continent,
       latitude, longitude, distance_km, bearing_deg,
       op_name, state, grid, geoloc, tz_iana, loc_source
FROM cw_spots
WHERE ts >= ?                          -- fromDate.Unix()
  AND ts <  ?                          -- toDate+1day.Unix()
  AND (? = '' OR band = ?)             -- band filter
  AND (? = '' OR dx_call = ?)          -- callsign exact match (or IN set)
  AND (? = '' OR continent = ?)        -- continent
  AND (? = 0  OR distance_km >= ?)     -- minDistanceKm
  AND (? = -999 OR snr >= ?)           -- minSNR
  AND (? = '' OR (                     -- time-of-day startTime
        CAST(strftime('%H', ts, 'unixepoch') AS INTEGER) * 60
      + CAST(strftime('%M', ts, 'unixepoch') AS INTEGER) >= ?
  ))
  AND (? = '' OR (                     -- time-of-day endTime
        CAST(strftime('%H', ts, 'unixepoch') AS INTEGER) * 60
      + CAST(strftime('%M', ts, 'unixepoch') AS INTEGER) <= ?
  ))
ORDER BY ts DESC
```

**Callsign set filter**: When `callsigns` is a non-empty map, generate
`dx_call IN (?,?,?)` with one placeholder per callsign.

**CTY lat/lon enrichment**: The `latitude`/`longitude` columns in `cw_spots` are already
populated at write time from CTY lookup. No post-query enrichment needed.

---

#### 4.2 CW spots analytics — `/cw-spots/analytics` (GET)

**Current**: [`cwskimmer_spots_analytics.go`](../cwskimmer_spots_analytics.go) calls
`GetCWHistoricalSpots()` then aggregates in Go.

**SQL replacement** (same Option B approach as decoder spots analytics):
Replace the data source with a DB query, keep Go aggregation logic.

```sql
SELECT ts, dx_call, snr, frequency, band, wpm, country, continent,
       latitude, longitude, distance_km, bearing_deg
FROM cw_spots
WHERE ts >= ?
  AND ts <  ?
  AND (? = '' OR band = ?)
  AND (? = '' OR continent = ?)
  AND snr >= ?
ORDER BY ts DESC
```

---

#### 4.3 `GetCWAvailableDates` — `/cw-spots/dates` (GET)

**Current**: [`cwskimmer_spots_api.go:GetCWAvailableDates()`](../cwskimmer_spots_api.go:288)
walks `YYYY/MM/DD/` directory tree.

**SQL replacement**:
```sql
SELECT DISTINCT DATE(ts, 'unixepoch') AS date
FROM cw_spots
ORDER BY date DESC
```

---

#### 4.4 `GetCWAvailableNames` — `/cw-spots/names` (GET)

**Current**: [`cwskimmer_spots_api.go:GetCWAvailableNames()`](../cwskimmer_spots_api.go:354)
walks `YYYY/MM/DD/` directory tree collecting `.csv` filenames (band names, e.g. "20m", "40m").
The "name" in this context is the **band** (the CSV filename without extension).

**SQL replacement** — distinct bands that have CW spot data:
```sql
SELECT DISTINCT band
FROM cw_spots
WHERE band IS NOT NULL AND band != ''
ORDER BY band ASC
```

**Note**: Confirmed from [`db_manager.go`](../db_manager.go:313) schema — `cw_spots` has a
`band` column (e.g. "20m") and a `spotter` column (skimmer callsign). The file-based
`GetCWAvailableNames()` returns band names from filenames, which maps to `band` in the DB.

---

#### 4.5 CW spots CSV export — `/cw-spots/csv` (GET)

**Current**: [`cwskimmer_spots_api.go:GetCWHistoricalCSV()`](../cwskimmer_spots_api.go:433)
calls `GetCWHistoricalSpots()` then formats as CSV.

**Migration**: Automatically benefits once `GetCWHistoricalSpots()` is migrated to DB.

---

**Files to change**: [`cwskimmer_spots_api.go`](../cwskimmer_spots_api.go) — add DB read path
to `GetCWHistoricalSpots()`, `GetCWAvailableDates()`, `GetCWAvailableNames()`.
[`cwskimmer_spots_analytics.go`](../cwskimmer_spots_analytics.go) — replace data source.

---

## Component 5 — `sessions` table ✅ MIGRATED

**DB table**: `sessions(id, snapshot_ts, event_type, user_session_id, client_ip, source_ip, auth_method, session_types, bands, modes, created_at, first_seen, user_agent, country, country_code)`
**Status**: Fully migrated to SQLite. No file reads or writes at runtime.

### What was done

#### Write path ✅

`logActivitySync()` now does a direct SQLite INSERT only. Removed: `getOrCreateFile()`, `cleanupOldFiles()`, `cleanupLoop()`, `currentFile`, `currentDate` from struct. `Stop()` no longer closes any file handle.

#### Read path ✅ — `ReadActivityLogsFromDB(db *sql.DB, startTime, endTime time.Time)`

Replaces `ReadActivityLogs()` (file-based). Groups rows by `(snapshot_ts, event_type)` to reconstruct `[]SessionActivityLog`. JSON-unmarshals `session_types`, `bands`, `modes` columns. All downstream Go functions (`aggregateLogsIntoBuckets`, `calculateSessionMetrics`, `convertLogsToEvents`, `FilterSessionsByAuthMethod`) unchanged.

#### 5.1–5.4 Admin handlers ✅

All 4 `admin.go` handlers updated: `ReadActivityLogs(ah.config.Server.SessionActivityLogDir, ...)` → `ReadActivityLogsFromDB(ah.dbManager.ReadDB(), ...)`. Guards changed from `!ah.config.Server.SessionActivityLogEnabled` → `ah.dbManager.ReadDB() == nil`.

#### 5.5 Public session stats ✅

`handlePublicSessionStats` gained `readDB *sql.DB` parameter. Guard changed to `readDB == nil`. Call site in `main.go` passes `dbManager.ReadDB()`.

#### 5.6 Telegram bot session stats ✅

`TelegramBotListener` gained `readDB *sql.DB` field. `TelegramListenerRegistry.SetReadDB()` added. `NotificationManager.SetReadDB()` added. Wired in `main.go` via `notifManager.SetReadDB(dbManager.ReadDB())`.

### Config changes

- `session_activity_log_dir` removed from [`config/config.yaml.example`](../config/config.yaml.example); `SessionActivityLogDir` retained in `ServerConfig` for [`db_import.go`](../db_import.go)
- `session_activity_log_retention_days` kept — now controls SQLite DB pruning via `DBManager.StartRetentionLoop`
- `SessionActivityLogDir` resolution in [`main.go`](../main.go) no longer gated on `SessionActivityLogEnabled`
- Disk-usage check in [`admin.go`](../admin.go): removed `SessionActivityLogEnabled` gate

### Imports removed from `session_activity_log.go`

`bufio`, `bytes`, `os`, `path/filepath`

---

## Component 6 — `space_weather` table ✅ MIGRATED

**DB table**: `space_weather(id, ts, solar_flux, k_index, k_index_status, a_index, solar_wind_bz, propagation_quality, forecast_*, day_*, night_*)`
**Status**: Fully migrated to SQLite. No file reads or writes at runtime.

### What was done

All three read operations and the write path were migrated in a single pass. CSV file
infrastructure was removed entirely — no fallback, no dual-write.

#### 6.1 `GetHistoricalData` — `/space-weather/historical` (GET) ✅

Replaced file-walking CSV parser with `getHistoricalDataFromDB()`:
```sql
SELECT ts, solar_flux, k_index, k_index_status, a_index, solar_wind_bz,
       propagation_quality,
       forecast_g_scale, forecast_g_text,
       forecast_r_scale, forecast_r_text, forecast_r_minor_prob, forecast_r_major_prob,
       forecast_s_scale, forecast_s_text, forecast_s_prob, forecast_summary,
       day_160m, day_80m, day_60m, day_40m, day_30m,
       day_20m, day_17m, day_15m, day_12m, day_10m,
       night_160m, night_80m, night_60m, night_40m, night_30m,
       night_20m, night_17m, night_15m, night_12m, night_10m
FROM space_weather
WHERE ts >= ? AND ts < ?
ORDER BY ts ASC
LIMIT 10000
```
`findClosestRecord()` and `filterByTimeRangeMultiDay()` retained as Go-side post-filters.
Returns error if `readDB == nil` (no fallback to files).

#### 6.2 `GetAvailableDates` — `/space-weather/dates` (GET) ✅

Replaced directory tree walk with:
```sql
SELECT DISTINCT DATE(ts, 'unixepoch') AS date
FROM space_weather
ORDER BY date DESC
```
Returns error if `readDB == nil`.

#### 6.3 `GetHistoricalCSV` — `/space-weather/csv` (GET) ✅

Now delegates to the DB-backed `GetHistoricalData()` and serialises the
`[]*SpaceWeatherData` slice to CSV text with a fixed 37-column header.
No raw file reads.

#### Write path ✅

`logToCSV()` and `rotateCSVFile()` replaced by `logToDB()` — SQLite INSERT only.
`currentFile`, `csvWriter`, `currentDate`, `fileMu` removed from struct.
`Stop()` no longer closes any file handle.
`NewSpaceWeatherMonitor()` no longer calls `os.MkdirAll`.

### Config changes

- `LogToCSV bool` removed from `SpaceWeatherConfig` in [`config.go`](../config.go)
- `DataDir string` retained in config solely for [`db_import.go`](../db_import.go) (one-time historical CSV backfill tool)
- `log_to_csv` and `data_dir` removed from [`config/config.yaml.example`](../config/config.yaml.example)
- Handler guards in [`main.go`](../main.go) and [`decoder_band_predictions.go`](../decoder_band_predictions.go) changed from `!swm.config.LogToCSV` → `swm.readDB == nil`
- `LogToCSV`/`DataDir` removed from `SpaceWeatherDiagnostics` in [`space_weather_health.go`](../space_weather_health.go)
- `LogToCSV` gate removed from disk-usage check in [`admin.go`](../admin.go)

---

## Component 7 — `decoder_metrics` table ✅ MIGRATED

**DB table**: `decoder_metrics(id, ts, mode, band, band_name, decodes_1h…24h, dpc_1m…60m, unique_calls_1h…24h, exec_avg/min/max_1m/5m, decodes_per_hour, callsigns_per_hour, activity_score)`
**Status**: Fully migrated to SQLite. No file reads or writes at runtime.

### What was done

#### Write path ✅
`MetricsLogger.writeSnapshot()` now writes exclusively to SQLite via `db.Exec(INSERT INTO decoder_metrics ...)`. File write, `getOrCreateFile()`, `CleanupOldFiles()`, `loadMetricsFromFile()`, `readSnapshotsFromFile()` all removed.

#### Read path ✅ — `ReadMetricsFromDB(db *sql.DB, startTime, endTime time.Time, filterMode, filterBand string)`
```sql
SELECT ts, mode, band, band_name, decodes_1h…24h, dpc_1m…60m,
       unique_calls_1h…24h, exec_avg/min/max_1m/5m,
       decodes_per_hour, callsigns_per_hour, activity_score
FROM decoder_metrics
WHERE ts >= ? AND ts <= ?
  AND (? = '' OR mode = ?)
  AND (? = '' OR band = ?)
ORDER BY ts ASC
```
Returns `map[string][]MetricsSnapshot` grouped by `mode:band`, matching the old return type.

#### 7.1 `/decoder-metrics` (GET) ✅
`handleDecodeMetrics` now accepts `readDB *sql.DB` and calls `ReadMetricsFromDB(readDB, ...)` instead of `md.metricsLogger.ReadMetricsFromFiles(...)`.

#### 7.2 `LoadRecentMetrics` — startup warm-up ✅
`MetricsLogger.LoadRecentMetrics(db *sql.DB, dm *DigitalDecodeMetrics)` now queries:
```sql
SELECT ts, mode, band, exec_avg_1m FROM decoder_metrics WHERE ts >= ? ORDER BY ts ASC
```
Called from `MultiDecoder.Start()` after `SetReadDB()` is wired.

#### 7.3 `/decoder/rates/all` (GET) ✅
`handleDecodeRatesAll` now accepts `readDB *sql.DB` (passed through for future use; currently uses in-memory summary aggregator).

### Config changes
- Removed `metrics_log_data_dir` from `config/decoder.yaml.example` — no longer needed (metrics go to SQLite)
- `metrics_log_enabled` and `metrics_log_interval_secs` retained (control write cadence to DB)

### Imports removed from `decoder_metrics_log.go`
- `bufio`, `encoding/json`, `os`, `path/filepath` — all removed
- Retained: `database/sql`, `fmt`, `log`, `sync`, `time`

### Wiring chain
`main.go` → `multiDecoder.SetReadDB(dbManager.ReadDB())` → `md.readDB` → used in `Start()` for `LoadRecentMetrics`
`main.go` → `handleDecodeMetrics(w, r, md, dbManager.ReadDB(), ...)` → `ReadMetricsFromDB(readDB, ...)`

---

## Component 8 — `cw_metrics` table ✅ MIGRATED

**DB table**: `cw_metrics(id, ts, band, spots_1h, spots_24h, unique_calls_1h, unique_calls_24h, spots_per_hour, callsigns_per_hour, activity_score, wpm_avg/min/max_1m/5m/10m)`
**Status**: Fully migrated to SQLite. No file reads or writes at runtime.

### What was done

#### Write path ✅
`CWSkimmerMetrics.WriteMetricsSnapshot()` now writes exclusively to SQLite via `db.Exec(INSERT INTO cw_metrics ...)`. File write (`os.OpenFile`, `os.MkdirAll`, `filepath.Join`, `json.NewEncoder`) removed.

#### Read path ✅ — `ReadCWMetricsFromDB(db *sql.DB, startTime, endTime time.Time, filterBand string)`
```sql
SELECT ts, band, spots_1h, spots_24h, unique_calls_1h, unique_calls_24h,
       spots_per_hour, callsigns_per_hour, activity_score,
       wpm_avg_1m, wpm_min_1m, wpm_max_1m,
       wpm_avg_5m, wpm_min_5m, wpm_max_5m,
       wpm_avg_10m, wpm_min_10m, wpm_max_10m
FROM cw_metrics
WHERE ts >= ? AND ts <= ?
  AND (? = '' OR band = ?)
ORDER BY ts ASC
```
Returns `map[string][]CWMetricsSnapshot` grouped by band, matching the old return type.

#### 8.1 `/cwskimmer/metrics` (GET) ✅
`handleCWMetrics` now accepts `readDB *sql.DB` and calls `ReadCWMetricsFromDB(readDB, startTime, endTime, band)` instead of `cwSkimmer.metrics.ReadMetricsFromFiles(...)`.

### Config changes
- Removed `metrics_log_data_dir` from `config/cwskimmer.yaml.example` — no longer needed
- `metrics_log_enabled` and `metrics_log_interval_secs` retained (control write cadence to DB)

### Imports removed from `cwskimmer_metrics.go`
- `bufio`, `encoding/json`, `os`, `path/filepath` — all removed
- Retained: `database/sql`, `fmt`, `log`, `sync`, `time`

### Wiring chain
`main.go` → `handleCWMetrics(w, r, cwSkimmer, dbManager.ReadDB(), ...)` → `ReadCWMetricsFromDB(readDB, ...)`

---

## Component 9 — `wspr_rank_windows` / `wspr_rank_rows` tables ✅ MIGRATED

**DB tables**:
`wspr_rank_windows(id, ts, window_name, fetched_at, fetched_ms, row_count, error)`
`wspr_rank_rows(id, ts, window_name, rank_pos, rx_sign, rx_loc, raw, dupe, unique_count, bands, uniques, gross, dupes, versions)`
**Status**: Fully migrated to SQLite. No file reads or writes at runtime.

These back the WSPR leaderboard panel of [`static/stats_history.html`](../static/stats_history.html)
via `GET /api/stats/wspr-rank`.

### Schema notes

- Unlike `sessions`, the snapshot envelope is a **separate table**, not denormalised onto
  every row. A window can legitimately have zero rows — a failed fetch still carries
  `fetched_ms` and `error` that the API response must reproduce, and there would be no
  row to carry them on.
- `ts` is `WSPRRankResponse.GeneratedAt` on **both** tables, so date-range queries and
  retention pruning work on either without a join.
- `rank_pos` is the 0-based array position. Rank is derived from position throughout the
  read path (`extractWSPRWindowRank` uses `targetIdx + 1`), so ordering must be preserved
  exactly — hence the explicit column rather than relying on insertion order.
- The parallel per-band arrays (`bands`/`uniques`/`gross`/`dupes`) and `versions` are
  stored as JSON TEXT. Normalising them would multiply row count by ~10 (one row per
  receiver per band per hour) for data only ever read back as a whole row.
- Column names avoid SQLite keywords: `window_name`, `row_count`, `unique_count`,
  `rank_pos`.

### What was done

#### 9.1 `ReadWSPR` — `/api/stats/wspr-rank` (GET) ✅

`readWSPRFromDB()` → `loadWSPRSnapshots()` in [`stats_logger_db.go`](../stats_logger_db.go).
Two passes: envelopes first (establishing which snapshots exist and their order), then
rows `ORDER BY ts, window_name, rank_pos`. Returns an error if `readDB == nil`.

#### 9.2 `LoadLatestWSPR` — startup cache seed ✅

`SELECT MAX(ts) FROM wspr_rank_windows`, then the same assembly routine with `ts = ?`.

#### Write path ✅

`WriteWSPR` delegates to `writeWSPRToDB()` — SQLite only. The whole snapshot (three
windows + all rows) goes in one transaction, preceded by a `DELETE … WHERE ts = ?` so a
re-write at the same `generated_at` replaces rather than duplicates.

---

## Component 10 — `psk_rank_snapshots` / `psk_rank_entries` / `psk_software` tables ✅ MIGRATED

**DB tables**:
`psk_rank_snapshots(id, ts, fetched_ms, error)`
`psk_rank_entries(id, ts, result_type, band, rank_pos, callsign, day_count, week_count)`
`psk_software(id, ts, callsign, name, version)`
**Status**: Fully migrated to SQLite. No file reads or writes at runtime.

Backs the PSKReporter leaderboard panel via `GET /api/stats/psk-rank`.

### Schema notes

- `PSKRankData` holds two `band → []PSKMonitorEntry` maps. Both flatten into
  `psk_rank_entries`; `result_type` is `"report"` (reportResult) or `"country"`
  (countryResult).
- Separate envelope table for the same reason as Component 9: a failed scrape has zero
  entries but a non-empty `error`.
- `rank_pos` preserves array order — `computeCallsignRank` derives rank from position.

### What was done

#### 10.1 `ReadPSK` — `/api/stats/psk-rank` (GET) ✅

`readPSKFromDB()` → `loadPSKSnapshots()`: three queries (snapshots, entries, software),
stitched by `ts`. Entries ordered `ts, result_type, band, rank_pos`.

#### 10.2 `LoadLatestPSK` — startup cache seed ✅

`SELECT MAX(ts) FROM psk_rank_snapshots` + the same assembly routine.

#### Write path ✅

`WritePSK` delegates to `writePSKToDB()` — SQLite only; one transaction, `DELETE … WHERE
ts = ?` across all three tables first.

---

## Component 11 — `rbn_skew` / `rbn_stats` tables ✅ MIGRATED

**DB tables**:
`rbn_skew(id, ts, source_comment, callsign, skew, spots, correction_factor)`
`rbn_stats(id, ts, source_comment, callsign, epoch_date, spot_count)`
**Status**: Fully migrated to SQLite. No file reads or writes at runtime.

Backs the RBN skimmer panel via `GET /api/stats/rbn`.

### Schema notes

- Both sources are flat CSV rows from sm7iun.se fetched once per day, so these are fully
  normalised — no JSON columns.
- RBN publishes once per day (the old JSONL writer used `O_TRUNC` for this reason). The
  DB writer deletes the day's rows (`ts >= dayStart AND ts < dayEnd`) before inserting, so
  there is exactly one snapshot per day and `ReadRBN`'s one-record-per-day contract holds.
- `source_comment` (the `# Calculated …` header line) is denormalised onto every row — a
  single short string, not worth a join.

### What was done

#### 11.1 `ReadRBN` — `/api/stats/rbn` (GET) ✅

`readRBNFromDB()` queries both tables over the date range and merges them into one
`RBNHistoryRecord` per UTC day, matching the file path's per-day semantics.

#### 11.2 `LoadLatestRBNSkew` / `LoadLatestRBNStats` — startup cache seed ✅

`SELECT MAX(ts)` on the respective table, then all rows at that `ts`, rebuilt into the
`map[callsign]Entry` shape `RBNDataStore` expects.

#### Write path ✅

`WriteRBNSkew` / `WriteRBNStats` delegate to `writeRBNSkewToDB()` /
`writeRBNStatsToDB()` — SQLite only.

---

## Components 9–11 — shared wiring

### Wiring chain

`main.go` → `statsLogger.SetDB(dbManager.DB())` + `statsLogger.SetReadDB(dbManager.ReadDB())`
→ `handleWSPRRankHistory` / `handlePSKRankHistory` / `handleRBNHistory` (unchanged — they
call `sl.Read*` as before).

### File path removal

[`stats_logger.go`](../stats_logger.go) lost `appendJSONL`, `overwriteJSONL`,
`readLastLine`, `filePath`, `ensureDir`, `candidateDays` and `dateRange`, along with the
`baseDir`/`enabled` fields and the `bufio`/`os`/`path/filepath`/`encoding/json` imports.
`NewStatsLogger()` now takes no arguments and returns no error.

`rbnSkewRecord` / `rbnStatsRecord` stay — [`mqtt_publisher.go`](../mqtt_publisher.go)
publishes those shapes, and [`db_import.go`](../db_import.go) parses the legacy files
into them.

`statsLogDir` (`<configDir>/stats`) survives in [`main.go`](../main.go) solely as
`DBImporter.StatsDir`, mirroring how `config.Chat.DataDir` was retained in Component 1.
Nothing writes there any more; the existing trees are left on disk untouched.

### Historical backfill

[`db_import.go`](../db_import.go) gained `StatsDir` plus `importWSPRRank`, `importPSKRank`
and `importRBN`, registered against `wspr_rank_windows`, `psk_rank_snapshots` and
`rbn_skew` respectively (`importRBN` fills both RBN tables — they are always written
together, so only `rbn_skew` is emptiness-checked).

**Import order**: the table list moved out of `RunImportIfEmpty` into `dbImportOrder()` so
it can be asserted in a test. The three stats imports sit **after** the other small tables
but **before** `cw_spots` and `spots`, which remain last by design. This ordering is now
load-bearing rather than cosmetic: with the JSONL readers gone, the stats tables are the
only source for `/api/stats/*`, so the history page stays blank until they land — queueing
them behind a multi-hour spots backfill would be visible to users.

Only `rolling_24h.jsonl` and `report_result.jsonl` are read: `WriteWSPR` and `WritePSK`
write byte-identical copies to the sibling files, so reading them all would triple the
work for no extra data.

`readJSONLMax` was added because a single `WSPRRankResponse` line holds three full
leaderboards and exceeds `readJSONL`'s 1 MiB cap; the stats importers use 32 MiB.

### Retention

`RetentionConfig.StatsDays` prunes all seven tables, and is left at **0 (unlimited)** in
[`main.go`](../main.go) — matching every other table with no config field, and deliberate
now that the DB is the only copy of the leaderboard archive.

Worth revisiting: `wspr_rank_rows` grows by roughly 150k rows/day (≈3 windows × ~2k
receivers × 24 fetches). Since `ParseStatsQueryParams` rejects ranges longer than
`statsMaxDays`, rows older than 30 days are already unreachable through the API, so
`statsMaxDays + 5` is the natural cap if disk becomes a concern.

### Tests

[`stats_logger_db_test.go`](../stats_logger_db_test.go) — round-trip through a real
SQLite file for all three sources, asserting `reflect.DeepEqual` against the original
struct so the API shape is provably unchanged. Covers a zero-row window with an error,
rewrite-at-same-timestamp replacement, RBN same-day replacement, and date-range bounds.

[`db_import_stats_test.go`](../db_import_stats_test.go) — lays down a legacy JSONL tree,
backfills, reads back through the DB, and re-runs the import to confirm idempotency. Also
asserts the stats imports are ordered ahead of `cw_spots`/`spots`.

---

## Implementation strategy

### Recommended order — ranked easiest to hardest

Each operation is ranked by implementation difficulty. Criteria:
- **Easier**: method on a struct that already has `db` field; simple SELECT; no callers to update; no struct reconstruction
- **Harder**: package-level function with many callers; complex struct reconstruction; many filter parameters; window functions

| Rank | Operation | File | Why easy/hard |
|------|-----------|------|---------------|
| 1 | `GetAvailableDates` (space_weather) | [`space_weather.go`](../space_weather.go) | Method, db field exists, trivial DISTINCT query |
| 2 | `GetLastKnownIPForUser` (chat) | [`chat_logger.go`](../chat_logger.go) | Method, cl.db exists, single-row query |
| 3 | `GetAvailableDates` (noise_floor) | [`noise_floor.go`](../noise_floor.go) | Method, db field exists, trivial DISTINCT query |
| 4 | `GetCWAvailableDates` (cw_spots) | [`cwskimmer_spots_api.go`](../cwskimmer_spots_api.go) | Method, db field exists, trivial DISTINCT query |
| 5 | `GetCWAvailableNames` (cw_spots) | [`cwskimmer_spots_api.go`](../cwskimmer_spots_api.go) | Method, db field exists, trivial DISTINCT band query |
| 6 | `GetAvailableDates` (spots) | [`decoder_spots_log.go`](../decoder_spots_log.go) | Method, db field exists, trivial DISTINCT query |
| 7 | `GetAvailableNames` (spots) | [`decoder_spots_log.go`](../decoder_spots_log.go) | Method, db field exists, trivial DISTINCT decoder_name query |
| 8 | `GetHistoricalData` (space_weather) | [`space_weather.go`](../space_weather.go) | Method, db field exists, simple SELECT; reuse existing Go filter helpers |
| 9 | `LoadRecentMessages` (chat) | [`chat_logger.go`](../chat_logger.go) | Method, cl.db exists, simple SELECT; Go ban filter unchanged |
| 10 | `GetHistoricalData` (noise_floor) | [`noise_floor.go`](../noise_floor.go) | Method, db field exists, simple SELECT |
| 11 | `GetRecentData` (noise_floor) | [`noise_floor.go`](../noise_floor.go) | Method, db field exists, simple SELECT with 1h window |
| 12 | `LoadRecentMetrics` (decoder_metrics) | [`decoder_metrics_log.go`](../decoder_metrics_log.go) | Method, db field exists, simple SELECT; Go RecordExecutionTime call unchanged |
| 13 | `ReadMetricsFromFiles` (decoder_metrics) | [`decoder_metrics_log.go`](../decoder_metrics_log.go) | Method, db field exists, flat column mapping; group by mode:band in Go |
| 14 | `ReadMetricsFromFiles` (cw_metrics) | [`cwskimmer_metrics.go`](../cwskimmer_metrics.go) | Method, db field exists, flat column mapping; group by band in Go |
| 15 | `GetTrendData` (noise_floor) | [`noise_floor.go`](../noise_floor.go) | Method, db field exists; rolling 24h vs historical date logic; Go 10-min bucketing unchanged |
| 16 | `GetTrendDataAllBands` (noise_floor) | [`noise_floor.go`](../noise_floor.go) | Same as above but all bands; Go bucketing unchanged |
| 17 | `HandleChatLogs` / `readChatLogs` | [`chat_logs_api.go`](../chat_logs_api.go) | Package-level fn needs db param; 1 call site to update |
| 18 | `GetCWHistoricalSpots` (cw_spots) | [`cwskimmer_spots_api.go`](../cwskimmer_spots_api.go) | Method, db field exists; ~10 filter params; callsign set IN clause |
| 19 | `GetHistoricalSpots` (spots) | [`decoder_spots_log.go`](../decoder_spots_log.go) | Method, db field exists; 15 filter params; deduplication window fn; direction→bearing range |
| 20 | `ReadActivityLogs` (sessions) | [`session_activity_log.go`](../session_activity_log.go) | Package-level fn; **6 call sites** to update; struct reconstruction from flat rows |

---

**Suggested grouping for implementation PRs**

- **PR 1** (ranks 1–7): All trivial DISTINCT/date queries — one-liners, zero risk
- **PR 2** (ranks 8–14): Simple SELECT reads — space_weather, chat seed, noise_floor historical/recent, metrics
- **PR 3** (ranks 15–17): Trend data + chat logs API — slightly more logic
- **PR 4** (ranks 18–19): Spots reads — most complex SQL
- **PR 5** (rank 20): Sessions — package-level fn refactor + 6 call sites

---

### Per-component implementation pattern

Each component follows the same pattern:

```go
func (x *Foo) GetHistoricalData(params...) ([]*Result, error) {
    if x.readDB != nil {
        return x.getHistoricalDataFromDB(params...)
    }
    return x.getHistoricalDataFromFiles(params...)  // existing code, unchanged
}

func (x *Foo) getHistoricalDataFromDB(params...) ([]*Result, error) {
    // Always use readDB (read-only pool) for SELECT queries.
    // readDB runs concurrently with the write connection via WAL — no serialization.
    rows, err := x.readDB.Query(`SELECT ... FROM table WHERE ...`, args...)
    if err != nil {
        return nil, err
    }
    defer rows.Close()
    var results []*Result
    for rows.Next() {
        var r Result
        var ts int64
        if err := rows.Scan(&ts, &r.Field1, ...); err != nil {
            return nil, err
        }
        r.Time = time.Unix(ts, 0).UTC()
        results = append(results, &r)
    }
    return results, rows.Err()
}
```

Key rules:
- **Always use `readDB` (not `db`) for SELECT queries.** `readDB` is the read-only pool
  opened with `mode=ro` and `MaxOpenConns=4`. WAL mode allows it to run concurrently with
  the single write connection. Using `db` for reads would serialize them behind write
  transactions (including the import goroutine).
- **Never remove the file-based path** — it remains the fallback for `readDB == nil` and
  for historical data predating the DB.
- **DB mutex**: `*sql.DB` is safe for concurrent reads without a mutex — the pool manages
  connection acquisition internally.
- **Error handling**: if the DB query fails, log the error and fall back to the file path
  rather than returning an error to the caller. This makes the migration transparent.

---

### Testing approach

1. Run with DB enabled; verify API responses are identical to file-based responses for
   the same date range.
2. Run with `db = nil` (DB disabled in config); verify file-based fallback still works.
3. For spots: verify deduplication produces the same result as the Go-based deduplication.
4. For sessions: verify `SessionActivityLog` struct reconstruction matches JSONL parsing.

---

### Historical data import (separate task)

Data written before the DB was introduced only exists in files. A one-time import script
can backfill the DB by reading all existing CSV/JSONL files and INSERTing rows. Until
that script exists, the file fallback handles historical queries transparently.

The import script should:
- Walk the same directory trees as the existing file readers
- Parse each file using the same CSV/JSON parsing logic
- INSERT with `ON CONFLICT DO NOTHING` to be idempotent
- Process oldest files first so retention pruning doesn't immediately delete them