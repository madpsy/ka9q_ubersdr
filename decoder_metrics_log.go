package main

import (
	"database/sql"
	"fmt"
	"log"
	"sync"
	"time"
)

// MetricsLogger handles logging of decoder metrics to SQLite
type MetricsLogger struct {
	// SQLite write connection
	db   *sql.DB
	dbMu sync.Mutex

	// Control
	enabled       bool
	writeInterval time.Duration
	lastWrite     time.Time
}

// SetDB wires the SQLite database for write. Safe to call at any time.
func (ml *MetricsLogger) SetDB(db *sql.DB) {
	ml.dbMu.Lock()
	ml.db = db
	ml.dbMu.Unlock()
}

// MetricsSnapshot represents a single metrics snapshot
type MetricsSnapshot struct {
	Timestamp time.Time `json:"timestamp"`
	Mode      string    `json:"mode"`
	Band      string    `json:"band"`
	BandName  string    `json:"band_name"` // Decoder config name

	// Decode counts
	DecodeCounts struct {
		Last1Hour   int64 `json:"last_1h"`
		Last3Hours  int64 `json:"last_3h"`
		Last6Hours  int64 `json:"last_6h"`
		Last12Hours int64 `json:"last_12h"`
		Last24Hours int64 `json:"last_24h"`
	} `json:"decode_counts"`

	// Decodes per cycle
	DecodesPerCycle struct {
		Last1Min  float64 `json:"last_1m"`
		Last5Min  float64 `json:"last_5m"`
		Last15Min float64 `json:"last_15m"`
		Last30Min float64 `json:"last_30m"`
		Last60Min float64 `json:"last_60m"`
	} `json:"decodes_per_cycle"`

	// Unique callsigns
	UniqueCallsigns struct {
		Last1Hour   int `json:"last_1h"`
		Last3Hours  int `json:"last_3h"`
		Last6Hours  int `json:"last_6h"`
		Last12Hours int `json:"last_12h"`
		Last24Hours int `json:"last_24h"`
	} `json:"unique_callsigns"`

	// Execution time statistics
	ExecutionTime struct {
		Last1Min struct {
			Avg float64 `json:"avg_seconds"`
			Min float64 `json:"min_seconds"`
			Max float64 `json:"max_seconds"`
		} `json:"last_1m"`
		Last5Min struct {
			Avg float64 `json:"avg_seconds"`
			Min float64 `json:"min_seconds"`
			Max float64 `json:"max_seconds"`
		} `json:"last_5m"`
		Last10Min struct {
			Avg float64 `json:"avg_seconds"`
			Min float64 `json:"min_seconds"`
			Max float64 `json:"max_seconds"`
		} `json:"last_10m"`
	} `json:"execution_time"`

	// Activity metrics
	Activity struct {
		DecodesPerHour   float64 `json:"decodes_per_hour"`
		CallsignsPerHour float64 `json:"callsigns_per_hour"`
		ActivityScore    float64 `json:"activity_score"`
	} `json:"activity"`
}

// NewMetricsLogger creates a new metrics logger
func NewMetricsLogger(dataDir string, enabled bool, writeInterval time.Duration) (*MetricsLogger, error) {
	if !enabled {
		return &MetricsLogger{enabled: false}, nil
	}

	ml := &MetricsLogger{
		enabled:       true,
		writeInterval: writeInterval,
		lastWrite:     time.Now(),
	}

	return ml, nil
}

// ShouldWrite returns true if enough time has passed since last write
func (ml *MetricsLogger) ShouldWrite() bool {
	if !ml.enabled {
		return false
	}
	return time.Since(ml.lastWrite) >= ml.writeInterval
}

// WriteMetrics writes current metrics snapshot for all active mode/band combinations
func (ml *MetricsLogger) WriteMetrics(dm *DigitalDecodeMetrics) error {
	if !ml.enabled || dm == nil {
		return nil
	}

	now := time.Now()
	ml.lastWrite = now

	// Get all active mode/band combinations
	combinations := dm.GetAllModeBandCombinations()

	if len(combinations) == 0 {
		log.Printf("No active mode/band combinations to write metrics for (dm=%p, dm.decodesByModeBand has %d modes)", dm, len(dm.decodesByModeBand))
		return nil
	}

	log.Printf("Writing metrics snapshot for %d mode/band combinations", len(combinations))

	successCount := 0
	for _, combo := range combinations {
		snapshot := ml.createSnapshot(dm, combo.Mode, combo.Band, now)
		if err := ml.writeSnapshot(snapshot); err != nil {
			log.Printf("Error writing metrics snapshot for %s/%s: %v", combo.Mode, combo.Band, err)
			continue
		}
		successCount++
	}

	log.Printf("Wrote metrics snapshot: %d/%d successful", successCount, len(combinations))
	return nil
}

// createSnapshot creates a metrics snapshot for a specific mode/band
func (ml *MetricsLogger) createSnapshot(dm *DigitalDecodeMetrics, mode, band string, timestamp time.Time) *MetricsSnapshot {
	snapshot := &MetricsSnapshot{
		Timestamp: timestamp,
		Mode:      mode,
		Band:      band,
		BandName:  band, // Use band as band name for now
	}

	// Get cycle seconds
	cycleSeconds := 15
	if mode == "FT4" {
		cycleSeconds = 7
	} else if mode == "WSPR" {
		cycleSeconds = 120
	}

	// Decode counts
	snapshot.DecodeCounts.Last1Hour = dm.GetTotalDecodes(mode, band, 1)
	snapshot.DecodeCounts.Last3Hours = dm.GetTotalDecodes(mode, band, 3)
	snapshot.DecodeCounts.Last6Hours = dm.GetTotalDecodes(mode, band, 6)
	snapshot.DecodeCounts.Last12Hours = dm.GetTotalDecodes(mode, band, 12)
	snapshot.DecodeCounts.Last24Hours = dm.GetTotalDecodes(mode, band, 24)

	// Decodes per cycle
	snapshot.DecodesPerCycle.Last1Min = dm.GetAverageDecodesPerCycle(mode, band, cycleSeconds, 1)
	snapshot.DecodesPerCycle.Last5Min = dm.GetAverageDecodesPerCycle(mode, band, cycleSeconds, 5)
	snapshot.DecodesPerCycle.Last15Min = dm.GetAverageDecodesPerCycle(mode, band, cycleSeconds, 15)
	snapshot.DecodesPerCycle.Last30Min = dm.GetAverageDecodesPerCycle(mode, band, cycleSeconds, 30)
	snapshot.DecodesPerCycle.Last60Min = dm.GetAverageDecodesPerCycle(mode, band, cycleSeconds, 60)

	// Unique callsigns
	snapshot.UniqueCallsigns.Last1Hour = dm.GetUniqueCallsigns(mode, band, 1)
	snapshot.UniqueCallsigns.Last3Hours = dm.GetUniqueCallsigns(mode, band, 3)
	snapshot.UniqueCallsigns.Last6Hours = dm.GetUniqueCallsigns(mode, band, 6)
	snapshot.UniqueCallsigns.Last12Hours = dm.GetUniqueCallsigns(mode, band, 12)
	snapshot.UniqueCallsigns.Last24Hours = dm.GetUniqueCallsigns(mode, band, 24)

	// Execution time
	avg1m, min1m, max1m := dm.GetExecutionTimeStats(mode, band, 1)
	snapshot.ExecutionTime.Last1Min.Avg = avg1m
	snapshot.ExecutionTime.Last1Min.Min = min1m
	snapshot.ExecutionTime.Last1Min.Max = max1m

	avg5m, min5m, max5m := dm.GetExecutionTimeStats(mode, band, 5)
	snapshot.ExecutionTime.Last5Min.Avg = avg5m
	snapshot.ExecutionTime.Last5Min.Min = min5m
	snapshot.ExecutionTime.Last5Min.Max = max5m

	avg10m, min10m, max10m := dm.GetExecutionTimeStats(mode, band, 10)
	snapshot.ExecutionTime.Last10Min.Avg = avg10m
	snapshot.ExecutionTime.Last10Min.Min = min10m
	snapshot.ExecutionTime.Last10Min.Max = max10m

	// Activity metrics
	if snapshot.DecodeCounts.Last24Hours > 0 {
		snapshot.Activity.DecodesPerHour = float64(snapshot.DecodeCounts.Last24Hours) / 24.0
		snapshot.Activity.CallsignsPerHour = float64(snapshot.UniqueCallsigns.Last24Hours) / 24.0
		snapshot.Activity.ActivityScore = (snapshot.Activity.DecodesPerHour / 100.0) * 100.0
		if snapshot.Activity.ActivityScore > 100 {
			snapshot.Activity.ActivityScore = 100
		}
	}

	return snapshot
}

// writeSnapshot writes a single metrics snapshot to SQLite
func (ml *MetricsLogger) writeSnapshot(snapshot *MetricsSnapshot) error {
	ml.dbMu.Lock()
	db := ml.db
	ml.dbMu.Unlock()

	if db == nil {
		return nil
	}

	_, err := db.Exec(`
		INSERT INTO decoder_metrics (
			ts, mode, band, band_name,
			decodes_1h, decodes_3h, decodes_6h, decodes_12h, decodes_24h,
			dpc_1m, dpc_5m, dpc_15m, dpc_30m, dpc_60m,
			unique_calls_1h, unique_calls_3h, unique_calls_6h, unique_calls_12h, unique_calls_24h,
			exec_avg_1m, exec_min_1m, exec_max_1m,
			exec_avg_5m, exec_min_5m, exec_max_5m,
			decodes_per_hour, callsigns_per_hour, activity_score
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		snapshot.Timestamp.Unix(),
		snapshot.Mode, snapshot.Band, snapshot.BandName,
		snapshot.DecodeCounts.Last1Hour, snapshot.DecodeCounts.Last3Hours,
		snapshot.DecodeCounts.Last6Hours, snapshot.DecodeCounts.Last12Hours,
		snapshot.DecodeCounts.Last24Hours,
		snapshot.DecodesPerCycle.Last1Min, snapshot.DecodesPerCycle.Last5Min,
		snapshot.DecodesPerCycle.Last15Min, snapshot.DecodesPerCycle.Last30Min,
		snapshot.DecodesPerCycle.Last60Min,
		snapshot.UniqueCallsigns.Last1Hour, snapshot.UniqueCallsigns.Last3Hours,
		snapshot.UniqueCallsigns.Last6Hours, snapshot.UniqueCallsigns.Last12Hours,
		snapshot.UniqueCallsigns.Last24Hours,
		snapshot.ExecutionTime.Last1Min.Avg, snapshot.ExecutionTime.Last1Min.Min,
		snapshot.ExecutionTime.Last1Min.Max,
		snapshot.ExecutionTime.Last5Min.Avg, snapshot.ExecutionTime.Last5Min.Min,
		snapshot.ExecutionTime.Last5Min.Max,
		snapshot.Activity.DecodesPerHour, snapshot.Activity.CallsignsPerHour,
		snapshot.Activity.ActivityScore,
	)
	if err != nil {
		return fmt.Errorf("db insert error: %w", err)
	}

	return nil
}

// Close is a no-op kept for API compatibility.
func (ml *MetricsLogger) Close() error {
	return nil
}

// LoadRecentMetrics reads recent metrics from SQLite and populates in-memory metrics.
// Reads the last 24 hours to restore DigitalDecodeMetrics state after a restart.
func (ml *MetricsLogger) LoadRecentMetrics(db *sql.DB, dm *DigitalDecodeMetrics) error {
	if !ml.enabled || dm == nil || db == nil {
		return nil
	}

	startTime := time.Now().Add(-24 * time.Hour)

	log.Printf("Loading recent metrics from DB (last 24 hours)...")

	rows, err := db.Query(`
		SELECT ts, mode, band, exec_avg_1m
		FROM decoder_metrics
		WHERE ts >= ?
		ORDER BY ts ASC`,
		startTime.Unix(),
	)
	if err != nil {
		return fmt.Errorf("query error: %w", err)
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var ts int64
		var mode, band string
		var execAvg1m float64

		if err := rows.Scan(&ts, &mode, &band, &execAvg1m); err != nil {
			log.Printf("[decoder_metrics] scan error: %v", err)
			continue
		}

		if execAvg1m > 0 {
			execTime := time.Duration(execAvg1m * float64(time.Second))
			dm.RecordExecutionTime(mode, band, execTime)
		}
		count++
	}

	if err := rows.Err(); err != nil {
		return fmt.Errorf("rows error: %w", err)
	}

	if count > 0 {
		log.Printf("Loaded %d metric snapshots from DB", count)
	} else {
		log.Printf("No recent metrics found in DB")
	}

	return nil
}

// ReadMetricsFromDB reads metrics snapshots from SQLite for a given time range.
// Returns snapshots grouped by "mode:band" key, matching the old ReadMetricsFromFiles return type.
func ReadMetricsFromDB(db *sql.DB, startTime, endTime time.Time, filterMode, filterBand string) (map[string][]MetricsSnapshot, error) {
	if db == nil {
		return nil, nil
	}

	rows, err := db.Query(`
		SELECT ts, mode, band, band_name,
		       decodes_1h, decodes_3h, decodes_6h, decodes_12h, decodes_24h,
		       dpc_1m, dpc_5m, dpc_15m, dpc_30m, dpc_60m,
		       unique_calls_1h, unique_calls_3h, unique_calls_6h, unique_calls_12h, unique_calls_24h,
		       exec_avg_1m, exec_min_1m, exec_max_1m,
		       exec_avg_5m, exec_min_5m, exec_max_5m,
		       decodes_per_hour, callsigns_per_hour, activity_score
		FROM decoder_metrics
		WHERE ts >= ?
		  AND ts <= ?
		  AND (? = '' OR mode = ?)
		  AND (? = '' OR band = ?)
		ORDER BY ts ASC`,
		startTime.Unix(), endTime.Unix(),
		filterMode, filterMode,
		filterBand, filterBand,
	)
	if err != nil {
		return nil, fmt.Errorf("query error: %w", err)
	}
	defer rows.Close()

	result := make(map[string][]MetricsSnapshot)

	for rows.Next() {
		var ts int64
		var s MetricsSnapshot

		err := rows.Scan(
			&ts, &s.Mode, &s.Band, &s.BandName,
			&s.DecodeCounts.Last1Hour, &s.DecodeCounts.Last3Hours,
			&s.DecodeCounts.Last6Hours, &s.DecodeCounts.Last12Hours,
			&s.DecodeCounts.Last24Hours,
			&s.DecodesPerCycle.Last1Min, &s.DecodesPerCycle.Last5Min,
			&s.DecodesPerCycle.Last15Min, &s.DecodesPerCycle.Last30Min,
			&s.DecodesPerCycle.Last60Min,
			&s.UniqueCallsigns.Last1Hour, &s.UniqueCallsigns.Last3Hours,
			&s.UniqueCallsigns.Last6Hours, &s.UniqueCallsigns.Last12Hours,
			&s.UniqueCallsigns.Last24Hours,
			&s.ExecutionTime.Last1Min.Avg, &s.ExecutionTime.Last1Min.Min,
			&s.ExecutionTime.Last1Min.Max,
			&s.ExecutionTime.Last5Min.Avg, &s.ExecutionTime.Last5Min.Min,
			&s.ExecutionTime.Last5Min.Max,
			&s.Activity.DecodesPerHour, &s.Activity.CallsignsPerHour,
			&s.Activity.ActivityScore,
		)
		if err != nil {
			log.Printf("[decoder_metrics] scan error: %v", err)
			continue
		}

		s.Timestamp = time.Unix(ts, 0)
		key := fmt.Sprintf("%s:%s", s.Mode, s.Band)
		result[key] = append(result[key], s)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows error: %w", err)
	}

	return result, nil
}
