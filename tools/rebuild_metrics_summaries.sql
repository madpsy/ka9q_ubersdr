-- ---------------------------------------------------------------------------
-- rebuild_metrics_summaries.sql
--
-- Repairs decoder_metrics_summary / cw_metrics_summary rows that were
-- overwritten by the live aggregators during the JSON→SQLite migration.
--
-- Symptom this fixes: the yearly chart on decode_metrics.html shows monthly
-- history for only one mode, and cw_metrics.html shows only one band for
-- previous months. The aggregators started against an empty summary table,
-- built fresh summaries containing only the current month, and their periodic
-- flush upserted those over the rows the background backfill had inserted.
--
-- Every summary is rebuilt from the raw spots / cw_spots tables, which hold one
-- row per spot with a timestamp, so the result is exact for whatever range spot
-- retention still covers.
--
-- SAFETY: an existing row is only replaced when the rebuilt total_spots is
-- HIGHER than what is stored. Periods that fall outside spot retention (where
-- the rebuild would produce a small or empty total) therefore keep whatever
-- summary they already have. Nothing is deleted.
--
-- USAGE — the server must be stopped, or its in-memory summaries will flush
-- back over the repair within a minute:
--
--     systemctl stop ubersdr          # or however you run it
--     sqlite3 /path/to/ubersdr.db < tools/rebuild_metrics_summaries.sql
--     systemctl start ubersdr
--
-- On restart, loadExistingSummaries() reads the repaired current-period rows
-- back into memory and live aggregation continues from them.
--
-- NOTES
--  * All period boundaries are UTC, matching the summary writers.
--  * decoder summaries key their "band" on the decoder config name, which is
--    spots.decoder_name — NOT spots.band (that one is derived from frequency).
--  * unique_callsigns is computed here from the spot callsigns. The live
--    decoder aggregator does not track callsigns, so that field will stay at
--    the rebuilt value rather than growing; the CW aggregator does track them
--    and will carry on from it.
-- ---------------------------------------------------------------------------

PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

-- 24 hour slots, so daily hourly_breakdown arrays are complete even for hours
-- with no spots (the Go writer always emits all 24).
CREATE TEMP TABLE hours24 (h INTEGER PRIMARY KEY);
WITH RECURSIVE seq(h) AS (SELECT 0 UNION ALL SELECT h + 1 FROM seq WHERE h < 23)
INSERT INTO hours24 (h) SELECT h FROM seq;

-- ===========================================================================
-- Decoder spots, normalised once: period boundaries per spot.
-- ===========================================================================
CREATE TEMP TABLE dsp AS
SELECT
    s.mode                                                   AS mode,
    s.decoder_name                                           AS band,
    s.callsign                                               AS callsign,
    date(s.ts, 'unixepoch')                                  AS day,
    CAST(strftime('%H', s.ts, 'unixepoch') AS INTEGER)       AS hour,
    date(s.ts, 'unixepoch', '-6 days', 'weekday 1')          AS week_start,
    date(s.ts, 'unixepoch', 'start of month')                AS month_start,
    date(s.ts, 'unixepoch', 'start of year')                 AS year_start
FROM spots s
WHERE s.mode IS NOT NULL AND s.mode <> ''
  AND s.decoder_name IS NOT NULL AND s.decoder_name <> '';

CREATE INDEX temp.dsp_day   ON dsp(mode, band, day);
CREATE INDEX temp.dsp_week  ON dsp(mode, band, week_start);
CREATE INDEX temp.dsp_month ON dsp(mode, band, month_start);
CREATE INDEX temp.dsp_year  ON dsp(mode, band, year_start);

-- ---------------------------------------------------------------------------
-- decoder: day
-- ---------------------------------------------------------------------------
INSERT INTO decoder_metrics_summary (ts, mode, band, period, period_key, end_ts, updated_ts, data)
SELECT
    CAST(strftime('%s', t.day) AS INTEGER),
    t.mode, t.band, 'day', t.day,
    CAST(strftime('%s', t.day, '+1 day') AS INTEGER),
    CAST(strftime('%s', 'now') AS INTEGER),
    json_object(
        'period',              'day',
        'start_time',          t.day || 'T00:00:00Z',
        'end_time',            date(t.day, '+1 day') || 'T00:00:00Z',
        'mode',                t.mode,
        'band',                t.band,
        'last_processed_snapshot', '0001-01-01T00:00:00Z',
        'last_updated',        strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        'total_spots',         t.total,
        'unique_callsigns',    t.uniq,
        'peak_spots_per_hour', 0,
        'avg_spots_per_hour',  t.total / 24.0,
        'hourly_breakdown',    (
            SELECT json_group_array(json_object(
                       'hour', o.h,
                       'spots', o.spots,
                       'unique_callsigns', o.uniq))
            FROM (SELECT hh.h                                   AS h,
                         COALESCE(COUNT(d.callsign), 0)         AS spots,
                         COUNT(DISTINCT d.callsign)             AS uniq
                  FROM hours24 hh
                  LEFT JOIN dsp d
                         ON d.mode = t.mode AND d.band = t.band
                        AND d.day = t.day AND d.hour = hh.h
                  GROUP BY hh.h
                  ORDER BY hh.h) o
        )
    )
FROM (SELECT mode, band, day,
             COUNT(*) AS total, COUNT(DISTINCT callsign) AS uniq
      FROM dsp GROUP BY mode, band, day) t
WHERE t.total > 0
ON CONFLICT(mode, band, period, period_key) DO UPDATE SET
    end_ts     = excluded.end_ts,
    updated_ts = excluded.updated_ts,
    data       = excluded.data
WHERE json_extract(excluded.data, '$.total_spots')
    > COALESCE(json_extract(decoder_metrics_summary.data, '$.total_spots'), 0);

-- ---------------------------------------------------------------------------
-- decoder: week (daily_breakdown)
-- ---------------------------------------------------------------------------
INSERT INTO decoder_metrics_summary (ts, mode, band, period, period_key, end_ts, updated_ts, data)
SELECT
    CAST(strftime('%s', t.week_start) AS INTEGER),
    t.mode, t.band, 'week',
    strftime('%Y', t.week_start, '+3 days') || '-W' ||
        printf('%02d', (CAST(strftime('%j', t.week_start, '+3 days') AS INTEGER) - 1) / 7 + 1),
    CAST(strftime('%s', t.week_start, '+7 days') AS INTEGER),
    CAST(strftime('%s', 'now') AS INTEGER),
    json_object(
        'period',              'week',
        'start_time',          t.week_start || 'T00:00:00Z',
        'end_time',            date(t.week_start, '+7 days') || 'T00:00:00Z',
        'mode',                t.mode,
        'band',                t.band,
        'last_processed_snapshot', '0001-01-01T00:00:00Z',
        'last_updated',        strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        'total_spots',         t.total,
        'unique_callsigns',    t.uniq,
        'peak_spots_per_hour', 0,
        'avg_spots_per_hour',  t.total / 168.0,
        'daily_breakdown',     (
            SELECT json_group_array(json_object(
                       'date', o.day, 'spots', o.spots, 'unique_callsigns', o.uniq))
            FROM (SELECT d.day AS day, COUNT(*) AS spots,
                         COUNT(DISTINCT d.callsign) AS uniq
                  FROM dsp d
                  WHERE d.mode = t.mode AND d.band = t.band
                    AND d.week_start = t.week_start
                  GROUP BY d.day ORDER BY d.day) o
        )
    )
FROM (SELECT mode, band, week_start,
             COUNT(*) AS total, COUNT(DISTINCT callsign) AS uniq
      FROM dsp GROUP BY mode, band, week_start) t
WHERE t.total > 0
ON CONFLICT(mode, band, period, period_key) DO UPDATE SET
    end_ts     = excluded.end_ts,
    updated_ts = excluded.updated_ts,
    data       = excluded.data
WHERE json_extract(excluded.data, '$.total_spots')
    > COALESCE(json_extract(decoder_metrics_summary.data, '$.total_spots'), 0);

-- ---------------------------------------------------------------------------
-- decoder: month (daily_breakdown)
-- ---------------------------------------------------------------------------
INSERT INTO decoder_metrics_summary (ts, mode, band, period, period_key, end_ts, updated_ts, data)
SELECT
    CAST(strftime('%s', t.month_start) AS INTEGER),
    t.mode, t.band, 'month', strftime('%Y-%m', t.month_start),
    CAST(strftime('%s', t.month_start, '+1 month') AS INTEGER),
    CAST(strftime('%s', 'now') AS INTEGER),
    json_object(
        'period',              'month',
        'start_time',          t.month_start || 'T00:00:00Z',
        'end_time',            date(t.month_start, '+1 month') || 'T00:00:00Z',
        'mode',                t.mode,
        'band',                t.band,
        'last_processed_snapshot', '0001-01-01T00:00:00Z',
        'last_updated',        strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        'total_spots',         t.total,
        'unique_callsigns',    t.uniq,
        'peak_spots_per_hour', 0,
        'avg_spots_per_hour',  t.total /
            ((CAST(strftime('%s', t.month_start, '+1 month') AS REAL)
            - CAST(strftime('%s', t.month_start) AS REAL)) / 3600.0),
        'daily_breakdown',     (
            SELECT json_group_array(json_object(
                       'date', o.day, 'spots', o.spots, 'unique_callsigns', o.uniq))
            FROM (SELECT d.day AS day, COUNT(*) AS spots,
                         COUNT(DISTINCT d.callsign) AS uniq
                  FROM dsp d
                  WHERE d.mode = t.mode AND d.band = t.band
                    AND d.month_start = t.month_start
                  GROUP BY d.day ORDER BY d.day) o
        )
    )
FROM (SELECT mode, band, month_start,
             COUNT(*) AS total, COUNT(DISTINCT callsign) AS uniq
      FROM dsp GROUP BY mode, band, month_start) t
WHERE t.total > 0
ON CONFLICT(mode, band, period, period_key) DO UPDATE SET
    end_ts     = excluded.end_ts,
    updated_ts = excluded.updated_ts,
    data       = excluded.data
WHERE json_extract(excluded.data, '$.total_spots')
    > COALESCE(json_extract(decoder_metrics_summary.data, '$.total_spots'), 0);

-- ---------------------------------------------------------------------------
-- decoder: year (monthly_breakdown) — this is the one the yearly chart reads
-- ---------------------------------------------------------------------------
INSERT INTO decoder_metrics_summary (ts, mode, band, period, period_key, end_ts, updated_ts, data)
SELECT
    CAST(strftime('%s', t.year_start) AS INTEGER),
    t.mode, t.band, 'year', strftime('%Y', t.year_start),
    CAST(strftime('%s', t.year_start, '+1 year') AS INTEGER),
    CAST(strftime('%s', 'now') AS INTEGER),
    json_object(
        'period',              'year',
        'start_time',          t.year_start || 'T00:00:00Z',
        'end_time',            date(t.year_start, '+1 year') || 'T00:00:00Z',
        'mode',                t.mode,
        'band',                t.band,
        'last_processed_snapshot', '0001-01-01T00:00:00Z',
        'last_updated',        strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        'total_spots',         t.total,
        'unique_callsigns',    t.uniq,
        'peak_spots_per_hour', 0,
        'avg_spots_per_hour',  t.total /
            ((CAST(strftime('%s', t.year_start, '+1 year') AS REAL)
            - CAST(strftime('%s', t.year_start) AS REAL)) / 3600.0),
        'monthly_breakdown',   (
            SELECT json_group_array(json_object(
                       'month', o.m, 'spots', o.spots, 'unique_callsigns', o.uniq))
            FROM (SELECT strftime('%Y-%m', d.month_start) AS m,
                         COUNT(*) AS spots,
                         COUNT(DISTINCT d.callsign) AS uniq
                  FROM dsp d
                  WHERE d.mode = t.mode AND d.band = t.band
                    AND d.year_start = t.year_start
                  GROUP BY d.month_start ORDER BY d.month_start) o
        )
    )
FROM (SELECT mode, band, year_start,
             COUNT(*) AS total, COUNT(DISTINCT callsign) AS uniq
      FROM dsp GROUP BY mode, band, year_start) t
WHERE t.total > 0
ON CONFLICT(mode, band, period, period_key) DO UPDATE SET
    end_ts     = excluded.end_ts,
    updated_ts = excluded.updated_ts,
    data       = excluded.data
WHERE json_extract(excluded.data, '$.total_spots')
    > COALESCE(json_extract(decoder_metrics_summary.data, '$.total_spots'), 0);

-- ===========================================================================
-- CW spots. Band here is cw_spots.band directly, and WPM stats come along.
-- ===========================================================================
CREATE TEMP TABLE csp AS
SELECT
    s.band                                                   AS band,
    s.dx_call                                                AS callsign,
    CASE WHEN s.wpm > 0 THEN s.wpm END                       AS wpm,
    date(s.ts, 'unixepoch')                                  AS day,
    CAST(strftime('%H', s.ts, 'unixepoch') AS INTEGER)       AS hour,
    date(s.ts, 'unixepoch', '-6 days', 'weekday 1')          AS week_start,
    date(s.ts, 'unixepoch', 'start of month')                AS month_start,
    date(s.ts, 'unixepoch', 'start of year')                 AS year_start
FROM cw_spots s
WHERE s.band IS NOT NULL AND s.band <> '';

CREATE INDEX temp.csp_day   ON csp(band, day);
CREATE INDEX temp.csp_week  ON csp(band, week_start);
CREATE INDEX temp.csp_month ON csp(band, month_start);
CREATE INDEX temp.csp_year  ON csp(band, year_start);

-- ---------------------------------------------------------------------------
-- cw: day
-- ---------------------------------------------------------------------------
INSERT INTO cw_metrics_summary (ts, band, period, period_key, end_ts, updated_ts, data)
SELECT
    CAST(strftime('%s', t.day) AS INTEGER),
    t.band, 'day', t.day,
    CAST(strftime('%s', t.day, '+1 day') AS INTEGER),
    CAST(strftime('%s', 'now') AS INTEGER),
    json_object(
        'period',              'day',
        'start_time',          t.day || 'T00:00:00Z',
        'end_time',            date(t.day, '+1 day') || 'T00:00:00Z',
        'band',                t.band,
        'last_updated',        strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        'total_spots',         t.total,
        'unique_callsigns',    t.uniq,
        'peak_spots_per_hour', 0,
        'avg_spots_per_hour',  t.total / 24.0,
        'avg_wpm',             COALESCE(t.avg_wpm, 0),
        'min_wpm',             COALESCE(t.min_wpm, 0),
        'max_wpm',             COALESCE(t.max_wpm, 0),
        'hourly_breakdown',    (
            SELECT json_group_array(json_object(
                       'hour', o.h, 'spots', o.spots,
                       'unique_callsigns', o.uniq, 'avg_wpm', o.avg_wpm))
            FROM (SELECT hh.h                           AS h,
                         COALESCE(COUNT(c.callsign), 0) AS spots,
                         COUNT(DISTINCT c.callsign)     AS uniq,
                         COALESCE(AVG(c.wpm), 0)        AS avg_wpm
                  FROM hours24 hh
                  LEFT JOIN csp c
                         ON c.band = t.band AND c.day = t.day AND c.hour = hh.h
                  GROUP BY hh.h ORDER BY hh.h) o
        )
    )
FROM (SELECT band, day, COUNT(*) AS total, COUNT(DISTINCT callsign) AS uniq,
             AVG(wpm) AS avg_wpm, MIN(wpm) AS min_wpm, MAX(wpm) AS max_wpm
      FROM csp GROUP BY band, day) t
WHERE t.total > 0
ON CONFLICT(band, period, period_key) DO UPDATE SET
    end_ts     = excluded.end_ts,
    updated_ts = excluded.updated_ts,
    data       = excluded.data
WHERE json_extract(excluded.data, '$.total_spots')
    > COALESCE(json_extract(cw_metrics_summary.data, '$.total_spots'), 0);

-- ---------------------------------------------------------------------------
-- cw: week
-- ---------------------------------------------------------------------------
INSERT INTO cw_metrics_summary (ts, band, period, period_key, end_ts, updated_ts, data)
SELECT
    CAST(strftime('%s', t.week_start) AS INTEGER),
    t.band, 'week',
    strftime('%Y', t.week_start, '+3 days') || '-W' ||
        printf('%02d', (CAST(strftime('%j', t.week_start, '+3 days') AS INTEGER) - 1) / 7 + 1),
    CAST(strftime('%s', t.week_start, '+7 days') AS INTEGER),
    CAST(strftime('%s', 'now') AS INTEGER),
    json_object(
        'period',              'week',
        'start_time',          t.week_start || 'T00:00:00Z',
        'end_time',            date(t.week_start, '+7 days') || 'T00:00:00Z',
        'band',                t.band,
        'last_updated',        strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        'total_spots',         t.total,
        'unique_callsigns',    t.uniq,
        'peak_spots_per_hour', 0,
        'avg_spots_per_hour',  t.total / 168.0,
        'avg_wpm',             COALESCE(t.avg_wpm, 0),
        'min_wpm',             COALESCE(t.min_wpm, 0),
        'max_wpm',             COALESCE(t.max_wpm, 0),
        'daily_breakdown',     (
            SELECT json_group_array(json_object(
                       'date', o.day, 'spots', o.spots,
                       'unique_callsigns', o.uniq, 'avg_wpm', o.avg_wpm))
            FROM (SELECT c.day AS day, COUNT(*) AS spots,
                         COUNT(DISTINCT c.callsign) AS uniq,
                         COALESCE(AVG(c.wpm), 0) AS avg_wpm
                  FROM csp c
                  WHERE c.band = t.band AND c.week_start = t.week_start
                  GROUP BY c.day ORDER BY c.day) o
        )
    )
FROM (SELECT band, week_start, COUNT(*) AS total, COUNT(DISTINCT callsign) AS uniq,
             AVG(wpm) AS avg_wpm, MIN(wpm) AS min_wpm, MAX(wpm) AS max_wpm
      FROM csp GROUP BY band, week_start) t
WHERE t.total > 0
ON CONFLICT(band, period, period_key) DO UPDATE SET
    end_ts     = excluded.end_ts,
    updated_ts = excluded.updated_ts,
    data       = excluded.data
WHERE json_extract(excluded.data, '$.total_spots')
    > COALESCE(json_extract(cw_metrics_summary.data, '$.total_spots'), 0);

-- ---------------------------------------------------------------------------
-- cw: month
-- ---------------------------------------------------------------------------
INSERT INTO cw_metrics_summary (ts, band, period, period_key, end_ts, updated_ts, data)
SELECT
    CAST(strftime('%s', t.month_start) AS INTEGER),
    t.band, 'month', strftime('%Y-%m', t.month_start),
    CAST(strftime('%s', t.month_start, '+1 month') AS INTEGER),
    CAST(strftime('%s', 'now') AS INTEGER),
    json_object(
        'period',              'month',
        'start_time',          t.month_start || 'T00:00:00Z',
        'end_time',            date(t.month_start, '+1 month') || 'T00:00:00Z',
        'band',                t.band,
        'last_updated',        strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        'total_spots',         t.total,
        'unique_callsigns',    t.uniq,
        'peak_spots_per_hour', 0,
        'avg_spots_per_hour',  t.total /
            ((CAST(strftime('%s', t.month_start, '+1 month') AS REAL)
            - CAST(strftime('%s', t.month_start) AS REAL)) / 3600.0),
        'avg_wpm',             COALESCE(t.avg_wpm, 0),
        'min_wpm',             COALESCE(t.min_wpm, 0),
        'max_wpm',             COALESCE(t.max_wpm, 0),
        'daily_breakdown',     (
            SELECT json_group_array(json_object(
                       'date', o.day, 'spots', o.spots,
                       'unique_callsigns', o.uniq, 'avg_wpm', o.avg_wpm))
            FROM (SELECT c.day AS day, COUNT(*) AS spots,
                         COUNT(DISTINCT c.callsign) AS uniq,
                         COALESCE(AVG(c.wpm), 0) AS avg_wpm
                  FROM csp c
                  WHERE c.band = t.band AND c.month_start = t.month_start
                  GROUP BY c.day ORDER BY c.day) o
        )
    )
FROM (SELECT band, month_start, COUNT(*) AS total, COUNT(DISTINCT callsign) AS uniq,
             AVG(wpm) AS avg_wpm, MIN(wpm) AS min_wpm, MAX(wpm) AS max_wpm
      FROM csp GROUP BY band, month_start) t
WHERE t.total > 0
ON CONFLICT(band, period, period_key) DO UPDATE SET
    end_ts     = excluded.end_ts,
    updated_ts = excluded.updated_ts,
    data       = excluded.data
WHERE json_extract(excluded.data, '$.total_spots')
    > COALESCE(json_extract(cw_metrics_summary.data, '$.total_spots'), 0);

-- ---------------------------------------------------------------------------
-- cw: year (monthly_breakdown) — the one cw_metrics.html's yearly chart reads
-- ---------------------------------------------------------------------------
INSERT INTO cw_metrics_summary (ts, band, period, period_key, end_ts, updated_ts, data)
SELECT
    CAST(strftime('%s', t.year_start) AS INTEGER),
    t.band, 'year', strftime('%Y', t.year_start),
    CAST(strftime('%s', t.year_start, '+1 year') AS INTEGER),
    CAST(strftime('%s', 'now') AS INTEGER),
    json_object(
        'period',              'year',
        'start_time',          t.year_start || 'T00:00:00Z',
        'end_time',            date(t.year_start, '+1 year') || 'T00:00:00Z',
        'band',                t.band,
        'last_updated',        strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        'total_spots',         t.total,
        'unique_callsigns',    t.uniq,
        'peak_spots_per_hour', 0,
        'avg_spots_per_hour',  t.total /
            ((CAST(strftime('%s', t.year_start, '+1 year') AS REAL)
            - CAST(strftime('%s', t.year_start) AS REAL)) / 3600.0),
        'avg_wpm',             COALESCE(t.avg_wpm, 0),
        'min_wpm',             COALESCE(t.min_wpm, 0),
        'max_wpm',             COALESCE(t.max_wpm, 0),
        'monthly_breakdown',   (
            SELECT json_group_array(json_object(
                       'month', o.m, 'spots', o.spots,
                       'unique_callsigns', o.uniq, 'avg_wpm', o.avg_wpm))
            FROM (SELECT strftime('%Y-%m', c.month_start) AS m,
                         COUNT(*) AS spots,
                         COUNT(DISTINCT c.callsign) AS uniq,
                         COALESCE(AVG(c.wpm), 0) AS avg_wpm
                  FROM csp c
                  WHERE c.band = t.band AND c.year_start = t.year_start
                  GROUP BY c.month_start ORDER BY c.month_start) o
        )
    )
FROM (SELECT band, year_start, COUNT(*) AS total, COUNT(DISTINCT callsign) AS uniq,
             AVG(wpm) AS avg_wpm, MIN(wpm) AS min_wpm, MAX(wpm) AS max_wpm
      FROM csp GROUP BY band, year_start) t
WHERE t.total > 0
ON CONFLICT(band, period, period_key) DO UPDATE SET
    end_ts     = excluded.end_ts,
    updated_ts = excluded.updated_ts,
    data       = excluded.data
WHERE json_extract(excluded.data, '$.total_spots')
    > COALESCE(json_extract(cw_metrics_summary.data, '$.total_spots'), 0);

DROP TABLE temp.dsp;
DROP TABLE temp.csp;
DROP TABLE temp.hours24;

COMMIT;

-- Post-run sanity check: how many modes/bands now carry a multi-month yearly
-- breakdown. Before the repair this shows 1 row for the affected pages.
SELECT 'decoder year' AS what, mode, band,
       json_array_length(data, '$.monthly_breakdown') AS months,
       json_extract(data, '$.total_spots') AS spots
FROM decoder_metrics_summary WHERE period = 'year'
ORDER BY months DESC, spots DESC;

SELECT 'cw year' AS what, band,
       json_array_length(data, '$.monthly_breakdown') AS months,
       json_extract(data, '$.total_spots') AS spots
FROM cw_metrics_summary WHERE period = 'year'
ORDER BY months DESC, spots DESC;
