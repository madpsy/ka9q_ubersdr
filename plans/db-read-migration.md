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

## Component 1 — `chat_messages` table

**DB table**: `chat_messages(id, ts, source_ip, username, message, country, country_code)`
**Current read files**: [`chat_logs_api.go`](../chat_logs_api.go) · [`chat_logger.go`](../chat_logger.go)

### DB access pattern for this component

`HandleChatLogs` is a method on `AdminHandler`, which already has `dbManager *DBManager`
(field added in the dual-write phase). The package-level `readChatLogs(dataDir, filter)` function
should gain a `readDB *sql.DB` parameter: `readChatLogs(dataDir string, readDB *sql.DB, filter *ChatLogFilter)`.
When `readDB != nil`, use the DB path; otherwise fall back to the file walk.
In `HandleChatLogs`, pass `ah.dbManager.ReadDB()` as the `readDB` argument.

`ChatLogger` already has a `db *sql.DB` field (added for dual-write). Add a `readDB *sql.DB`
field alongside it. Pass `dbManager.ReadDB()` at construction for read queries.

### Operations to migrate

#### 1.1 `HandleChatLogs` — `/admin/chat-logs` (GET)

**Current**: [`readChatLogs()`](../chat_logs_api.go:158) walks `YYYY/MM/DD/chat.csv` files day by day,
applies IP/nickname/message filters in Go, sorts descending, truncates to limit.

**SQL replacement**:
```sql
SELECT ts, source_ip, username, message, country, country_code
FROM chat_messages
WHERE ts >= ?          -- filter.StartDate.Unix()
  AND ts <  ?          -- filter.EndDate.Add(24h).Unix()
  AND (? = '' OR source_ip LIKE '%' || ? || '%')   -- IP partial match
  AND (? = '' OR LOWER(username) LIKE '%' || LOWER(?) || '%')  -- nickname
  AND (? = '' OR LOWER(message)  LIKE '%' || LOWER(?) || '%')  -- message
ORDER BY ts DESC
LIMIT ?                -- filter.Limit
```

**Notes**: SQLite `LIKE` is case-insensitive for ASCII by default, matching the existing
`strings.ToLower` behaviour. The `EndDate` bound should be `EndDate + 24h` to include
the full last day (current code iterates through `EndDate` inclusive).

**File to change**: [`chat_logs_api.go`](../chat_logs_api.go) — add `readDB *sql.DB` parameter to
`readChatLogs()`; add DB query path inside; keep file walk as fallback when `readDB == nil`.
In `HandleChatLogs`, pass `ah.dbManager.ReadDB()` as the `readDB` argument.

---

#### 1.2 `LoadRecentMessages` — startup chat seed

**Current**: [`chat_logger.go:LoadRecentMessages()`](../chat_logger.go:183) walks back up to
`maxDays` day-files, reads all rows, filters banned IPs, returns last `maxMessages`.

**SQL replacement**:
```sql
SELECT ts, source_ip, username, message
FROM chat_messages
WHERE ts >= ?          -- now - maxDays*24h
ORDER BY ts ASC
LIMIT ?                -- maxMessages (take tail = most recent)
```

Since there is no `banned_ips` table in the DB, filter banned IPs in Go after the query
(same as today, just operating on DB rows instead of CSV rows).

**File to change**: [`chat_logger.go`](../chat_logger.go) — use `cl.readDB` field for the
DB read path in `LoadRecentMessages()`; fall back to file walk when `cl.readDB == nil`.

---

#### 1.3 `GetLastKnownIPForUser` — reverse IP lookup

**Current**: [`chat_logger.go:GetLastKnownIPForUser()`](../chat_logger.go:332) walks back 30 days
of CSV files via `findLastIPInDayFile()`, returns the most recent `source_ip` for a given
username (case-insensitive).

**SQL replacement**:
```sql
SELECT source_ip
FROM chat_messages
WHERE LOWER(username) = LOWER(?)
  AND source_ip != ''
ORDER BY ts DESC
LIMIT 1
```

**File to change**: [`chat_logger.go`](../chat_logger.go) — use `cl.readDB` field; replace
file walk with DB query when `cl.readDB != nil`.

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

## Component 5 — `sessions` table

**DB table**: `sessions(id, snapshot_ts, event_type, user_session_id, client_ip, source_ip, auth_method, session_types, bands, modes, created_at, first_seen, user_agent, country, country_code)`
**Current read files**: [`session_activity_log.go`](../session_activity_log.go) · [`admin.go`](../admin.go)

### DB access pattern for this component

`ReadActivityLogs` is a **package-level function** (not a method), called from 6 places:
- [`admin.go`](../admin.go:5600) — `HandleSessionActivityLogs`
- [`admin.go`](../admin.go:5686) — `HandleSessionActivityMetrics`
- [`admin.go`](../admin.go:5785) — `HandleSessionActivityChartData`
- [`admin.go`](../admin.go:5988) — `HandleSessionActivityEvents`
- [`session_stats_api.go`](../session_stats_api.go:81) — public stats endpoint
- [`telegram_bot_logs_stats.go`](../telegram_bot_logs_stats.go:123) — Telegram bot

**Recommended approach**: Add a `readDB *sql.DB` parameter to `ReadActivityLogs`:
```go
func ReadActivityLogs(dataDir string, readDB *sql.DB, startTime, endTime time.Time) ([]SessionActivityLog, error)
```
When `readDB != nil`, use the DB path; otherwise fall back to the JSONL file walk.
All 6 call sites must be updated to pass the read pool. The `AdminHandler` already has
`dbManager *DBManager` — pass `ah.dbManager.ReadDB()`. The `session_stats_api.go` handler
and Telegram bot handler need the read pool threaded in via their respective structs or
function parameters.

### Operations to migrate

#### 5.1 `ReadActivityLogs` — core data fetch used by all session endpoints

**Current**: [`session_activity_log.go:ReadActivityLogs()`](../session_activity_log.go:714)
walks `YYYY/MM/DD/sessions.jsonl` files, parses JSON lines, filters by time range.

**SQL replacement**:
```sql
SELECT snapshot_ts, event_type, user_session_id, client_ip, source_ip,
       auth_method, session_types, bands, modes,
       created_at, first_seen, user_agent, country, country_code
FROM sessions
WHERE snapshot_ts >= ?    -- startTime.Unix()
  AND snapshot_ts <  ?    -- endTime.Unix()
ORDER BY snapshot_ts ASC
```

**Struct reconstruction**: Each DB row represents one session entry. Group rows by
`(snapshot_ts, event_type)` in Go to reconstruct `SessionActivityLog` structs with
`ActiveSessions []SessionActivityEntry`. The `session_types`, `bands`, `modes` columns
are JSON arrays — unmarshal with `json.Unmarshal([]byte(col), &slice)`.

The existing callers (`aggregateLogsIntoBuckets`, `calculateSessionMetrics`,
`convertLogsToEvents`, `FilterSessionsByAuthMethod`) all operate on `[]SessionActivityLog`
and remain unchanged — only the data source changes.

---

#### 5.2 Session activity chart data — `/admin/session-activity/chart` (GET)

**Current**: [`admin.go:HandleSessionActivityChartData()`](../admin.go:5723) calls
`ReadActivityLogs()` then `aggregateLogsIntoBuckets()` in Go.

**Migration**: Once `ReadActivityLogs()` is migrated to DB, this handler automatically
benefits. The `aggregateLogsIntoBuckets()` Go function remains unchanged.

**Optional direct SQL** (if performance requires it):
```sql
SELECT
    (snapshot_ts / (? * 60)) * (? * 60) AS bucket_ts,
    MAX(concurrent_in_snapshot) AS peak_regular,
    MAX(concurrent_password) AS peak_password,
    MAX(concurrent_bypassed) AS peak_bypassed
FROM (
    SELECT snapshot_ts,
        COUNT(DISTINCT CASE WHEN auth_method = '' THEN user_session_id END) AS concurrent_in_snapshot,
        COUNT(DISTINCT CASE WHEN auth_method = 'password' THEN user_session_id END) AS concurrent_password,
        COUNT(DISTINCT CASE WHEN auth_method = 'ip_bypass' THEN user_session_id END) AS concurrent_bypassed
    FROM sessions
    WHERE snapshot_ts >= ? AND snapshot_ts < ?
      AND event_type = 'snapshot'
    GROUP BY snapshot_ts
)
GROUP BY bucket_ts
ORDER BY bucket_ts ASC
```

---

#### 5.3 Session activity metrics — `/admin/session-activity/metrics` (GET)

**Current**: [`admin.go:HandleSessionActivityMetrics()`](../admin.go:5634) calls
`ReadActivityLogs()` then `calculateSessionMetrics()` in Go.

**Migration**: Once `ReadActivityLogs()` is migrated to DB, this handler automatically
benefits. The `calculateSessionMetrics()` Go function remains unchanged.

---

#### 5.4 Session activity events — `/admin/session-activity/events` (GET)

**Current**: [`admin.go:HandleSessionActivityEvents()`](../admin.go:5911) calls
`ReadActivityLogs()` then `convertLogsToEvents()` in Go.

**Migration**: Once `ReadActivityLogs()` is migrated to DB, this handler automatically
benefits. The `convertLogsToEvents()` Go function remains unchanged.

---

#### 5.5 Public session stats — `/session-stats` (GET)

**Current**: [`session_stats_api.go`](../session_stats_api.go:81) calls `ReadActivityLogs()`
for the last 28 days.

**Migration**: Once `ReadActivityLogs()` is migrated to DB, this handler automatically
benefits. The DB must be threaded into the handler (currently takes `config *Config` and
`geoIPService *GeoIPService` — add `db *sql.DB` parameter or store on a struct).

---

#### 5.6 Telegram bot session stats

**Current**: [`telegram_bot_logs_stats.go`](../telegram_bot_logs_stats.go:123) calls
`ReadActivityLogs()` for the last 24 hours.

**Migration**: Once `ReadActivityLogs()` is migrated to DB, this caller automatically
benefits. The Telegram bot struct needs a `db *sql.DB` field added and wired from main.

---

**Files to change**:
- [`session_activity_log.go`](../session_activity_log.go) — add `readDB *sql.DB` parameter to `ReadActivityLogs()`; add DB read path; keep JSONL fallback
- [`admin.go`](../admin.go) — update 4 `ReadActivityLogs()` call sites to pass `ah.dbManager.ReadDB()`
- [`session_stats_api.go`](../session_stats_api.go) — thread read pool into handler; update call site
- [`telegram_bot_logs_stats.go`](../telegram_bot_logs_stats.go) — add `readDB *sql.DB` to bot struct; update call site

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

## Component 7 — `decoder_metrics` table

**DB table**: `decoder_metrics(id, ts, mode, band, band_name, decodes_1h…24h, dpc_1m…60m, unique_calls_1h…24h, exec_avg/min/max_1m/5m, decodes_per_hour, callsigns_per_hour, activity_score)`  
**Current read files**: [`decoder_metrics_log.go`](../decoder_metrics_log.go) · [`decoder_metrics_api.go`](../decoder_metrics_api.go)

### Operations to migrate

#### 7.1 `ReadMetricsFromFiles` — used by `/decoder-metrics` (GET)

**Current**: [`decoder_metrics_log.go:ReadMetricsFromFiles()`](../decoder_metrics_log.go:520)
walks `YYYY/MM/DD/MODE-BAND.jsonl` files, returns `map[string][]MetricsSnapshot` grouped
by `mode:band`.

**SQL replacement**:
```sql
SELECT ts, mode, band, band_name,
       decodes_1h, decodes_3h, decodes_6h, decodes_12h, decodes_24h,
       dpc_1m, dpc_5m, dpc_15m, dpc_30m, dpc_60m,
       unique_calls_1h, unique_calls_3h, unique_calls_6h, unique_calls_12h, unique_calls_24h,
       exec_avg_1m, exec_min_1m, exec_max_1m,
       exec_avg_5m, exec_min_5m, exec_max_5m,
       decodes_per_hour, callsigns_per_hour, activity_score
FROM decoder_metrics
WHERE ts >= ?              -- startTime.Unix()
  AND ts <= ?              -- endTime.Unix()
  AND (? = '' OR mode = ?)
  AND (? = '' OR band = ?)
ORDER BY ts ASC
```

Group results by `mode:band` key in Go to match the existing return type.

---

#### 7.2 `LoadRecentMetrics` — startup warm-up

**Current**: [`decoder_metrics_log.go:LoadRecentMetrics()`](../decoder_metrics_log.go:406)
reads the last 24h of JSONL files to restore `DigitalDecodeMetrics` in-memory state.

**SQL replacement**:
```sql
SELECT ts, mode, band, exec_avg_1m
FROM decoder_metrics
WHERE ts >= ?    -- now - 24h
ORDER BY ts ASC
```

Then call `dm.RecordExecutionTime(mode, band, execTime)` for each row, same as today.

---

**Files to change**: [`decoder_metrics_log.go`](../decoder_metrics_log.go) — add DB read path
to `ReadMetricsFromFiles()` and `LoadRecentMetrics()`.

---

## Component 8 — `cw_metrics` table

**DB table**: `cw_metrics(id, ts, band, spots_1h, spots_24h, unique_calls_1h, unique_calls_24h, spots_per_hour, callsigns_per_hour, activity_score, wpm_avg/min/max_1m/5m/10m)`  
**Current read files**: [`cwskimmer_metrics.go`](../cwskimmer_metrics.go) · [`decoder_metrics_api.go`](../decoder_metrics_api.go)

### Operations to migrate

#### 8.1 `ReadMetricsFromFiles` — used by CW metrics API

**Current**: [`cwskimmer_metrics.go:ReadMetricsFromFiles()`](../cwskimmer_metrics.go:715)
walks `YYYY/MM/DD/BAND.jsonl` files, returns `map[string][]CWMetricsSnapshot` grouped by band.

**SQL replacement**:
```sql
SELECT ts, band,
       spots_1h, spots_24h,
       unique_calls_1h, unique_calls_24h,
       spots_per_hour, callsigns_per_hour, activity_score,
       wpm_avg_1m, wpm_min_1m, wpm_max_1m,
       wpm_avg_5m, wpm_min_5m, wpm_max_5m,
       wpm_avg_10m, wpm_min_10m, wpm_max_10m
FROM cw_metrics
WHERE ts >= ?              -- startTime.Unix()
  AND ts <= ?              -- endTime.Unix()
  AND (? = '' OR band = ?)
ORDER BY ts ASC
```

Group results by `band` key in Go to match the existing return type.

---

**Files to change**: [`cwskimmer_metrics.go`](../cwskimmer_metrics.go) — add DB read path
to `ReadMetricsFromFiles()`.

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