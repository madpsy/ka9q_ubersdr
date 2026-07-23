package main

import (
	"database/sql"
	"fmt"
	"log"
	"sync"
)

// CWSkimmerSpotsLogger persists CW Skimmer spots to SQLite.
// Spots are written to the cw_spots table; there is no file-based path.
type CWSkimmerSpotsLogger struct {
	// dataDir is retained solely so db_import.go can backfill historical CSV
	// files written before the SQLite migration. Nothing is written here at
	// runtime any more.
	dataDir string

	// Async logging
	logChan  chan *CWSkimmerSpot
	stopChan chan struct{}
	wg       sync.WaitGroup

	// Control
	enabled bool

	// SQLite write connection (single-writer pool). nil when DB not available.
	db *sql.DB

	// SQLite read-only connection pool. Used for all SELECT queries.
	readDB *sql.DB
}

// SetDB wires the SQLite write connection into the CW skimmer spots logger.
func (sl *CWSkimmerSpotsLogger) SetDB(db *sql.DB) {
	sl.db = db
}

// SetReadDB wires the SQLite read-only pool used for all SELECT queries.
func (sl *CWSkimmerSpotsLogger) SetReadDB(readDB *sql.DB) {
	sl.readDB = readDB
}

// NewCWSkimmerSpotsLogger creates a new CW Skimmer spots logger
func NewCWSkimmerSpotsLogger(dataDir string, enabled bool) (*CWSkimmerSpotsLogger, error) {
	if !enabled {
		return &CWSkimmerSpotsLogger{enabled: false}, nil
	}

	sl := &CWSkimmerSpotsLogger{
		dataDir:  dataDir,
		enabled:  true,
		logChan:  make(chan *CWSkimmerSpot, 1000), // Buffered channel for async logging
		stopChan: make(chan struct{}),
	}

	// Start async logging goroutine
	sl.wg.Add(1)
	go sl.logWorker()

	return sl, nil
}

// LogSpot queues a CW Skimmer spot for async writing (non-blocking)
func (sl *CWSkimmerSpotsLogger) LogSpot(spot *CWSkimmerSpot) error {
	if !sl.enabled {
		return nil
	}

	// Non-blocking send to channel
	select {
	case sl.logChan <- spot:
		return nil
	default:
		// Channel full, log warning but don't block
		log.Printf("CW Skimmer: WARNING - log channel full (%d/%d), dropping spot for %s",
			len(sl.logChan), cap(sl.logChan), spot.DXCall)
		return fmt.Errorf("log channel full")
	}
}

// logWorker processes spots from the channel and writes them to the database
func (sl *CWSkimmerSpotsLogger) logWorker() {
	defer sl.wg.Done()

	for {
		select {
		case spot := <-sl.logChan:
			if err := sl.writeSpot(spot); err != nil {
				log.Printf("CW Skimmer: Failed to write spot: %v", err)
			}
		case <-sl.stopChan:
			// Drain remaining spots before exiting
			for {
				select {
				case spot := <-sl.logChan:
					if err := sl.writeSpot(spot); err != nil {
						log.Printf("CW Skimmer: Failed to write spot during shutdown: %v", err)
					}
				default:
					return
				}
			}
		}
	}
}

// writeSpot writes a CW Skimmer spot to the cw_spots table (internal, called by logWorker)
func (sl *CWSkimmerSpotsLogger) writeSpot(spot *CWSkimmerSpot) error {
	if sl.db == nil {
		return nil
	}

	_, err := sl.db.Exec(
		`INSERT INTO cw_spots
		 (ts, dx_call, spotter, snr, frequency, band, wpm, mode, comment,
		  country, country_code, cq_zone, itu_zone, continent,
		  latitude, longitude, distance_km, bearing_deg,
		  op_name, state, grid, geoloc, tz_iana, loc_source)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		spot.Time.Unix(),
		spot.DXCall,
		spot.Spotter,
		spot.SNR,
		spot.Frequency,
		spot.Band,
		spot.WPM,
		spot.Mode,
		spot.Comment,
		spot.Country,
		spot.CountryCode,
		spot.CQZone,
		spot.ITUZone,
		spot.Continent,
		spot.Latitude,
		spot.Longitude,
		spot.DistanceKm, // *float64 — nil becomes NULL
		spot.BearingDeg, // *float64 — nil becomes NULL
		spot.Name,
		spot.State,
		spot.Grid,
		spot.GeoLoc,
		spot.Timezone,
		spot.LocSource,
	)
	if err != nil {
		log.Printf("[DB] cw_spots insert error: %v", err)
		return err
	}

	return nil
}

// Close stops the async worker and drains any pending spots.
func (sl *CWSkimmerSpotsLogger) Close() error {
	if !sl.enabled {
		return nil
	}

	// Signal worker to stop
	close(sl.stopChan)

	// Wait for worker to finish processing remaining spots
	sl.wg.Wait()

	return nil
}
