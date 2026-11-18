package main

import (
	"context"
	"log"
	"time"
)

// obsoleteIndexes are indexes earlier versions created that no query needs.
// On a busy receiver each one cost about as much disk as a fifth of its table
// (arecibo, 62M decoder spots: 4.5 GB of 13.9 GB across the four spots ones)
// and a write on every spot logged. initSchema no longer creates them, and
// DropObsoleteIndexesAtStartup removes them from existing databases.
var obsoleteIndexes = []struct{ name, why string }{
	// The ts-first composite indexes serve every ts range, so a plain ts
	// index is never needed alongside them.
	{"spots_idx_ts", "spots_idx_ts_mode starts with ts"},
	{"cw_spots_idx_ts", "cw_spots_idx_ts_band starts with ts"},
	// Every spots query has a ts range. Without statistics the planner chose
	// this for one-day mode and band queries and read all 90 days instead.
	{"spots_idx_mode_band", "every spots query has a ts range"},
	// The dates lists now step back a day at a time through the ts index.
	{"spots_idx_date", "the dates list uses the ts index"},
	{"cw_spots_idx_date", "the dates list uses the ts index"},
	// Listed from spot_decoder_names instead; filtering by name always comes
	// with a ts range. spot_decoder_names is filled from it just before it
	// is dropped.
	{"spots_idx_decoder_name", "names are listed from spot_decoder_names"},
}

// indexDropTimeout bounds each DROP INDEX. Dropping takes about 9 ms per MB
// of index on an SSD (2.5 s for 280 MB); a drop that times out is rolled back
// and tried again on the next start.
var indexDropTimeout = 10 * time.Minute

// DropObsoleteIndexesAtStartup drops the obsoleteIndexes still in the
// database. It runs before the server starts: a DROP INDEX holds the only
// write connection until it has freed every page of the index (tens of
// seconds for gigabytes), and spots are written on the live decode path.
// Once they are gone it only reads sqlite_master.
//
// whileWorking, if not nil, is called once before the first drop, only when
// there is one to do, and the function it returns when they are done; main
// uses it to answer health checks meanwhile.
//
// It never stops startup: an error is logged, that index is kept and tried
// again on the next start. Cancelling ctx (a stop request) rolls back the
// drop in progress. The freed pages are returned to the filesystem by the
// retention loop's incremental vacuum, or the startup VACUUM on a database
// still in auto_vacuum NONE.
func (m *DBManager) DropObsoleteIndexesAtStartup(ctx context.Context, whileWorking func() (done func())) (dropped []string) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[DB] startup maintenance: index cleanup recovered from panic: %v", r)
		}
	}()

	present := map[string]bool{}
	rows, err := m.db.QueryContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'index'`)
	if err != nil {
		log.Printf("[DB] startup maintenance: listing indexes: %v", err)
		return nil
	}
	for rows.Next() {
		var name string
		if rows.Scan(&name) == nil {
			present[name] = true
		}
	}
	rows.Close()

	var todo []string
	for _, ix := range obsoleteIndexes {
		if present[ix.name] {
			todo = append(todo, ix.name)
		}
	}
	if len(todo) == 0 {
		return nil
	}
	if whileWorking != nil {
		if done := whileWorking(); done != nil {
			defer done()
		}
	}
	log.Printf("[DB] startup maintenance: dropping %d indexes no query uses; on a large database this takes a minute or two", len(todo))

	for _, name := range todo {
		if ctx.Err() != nil {
			log.Printf("[DB] startup maintenance: stop requested; remaining indexes are dropped on the next start")
			break
		}
		if name == "spots_idx_decoder_name" {
			n, err := m.fillDecoderNames(ctx)
			if err != nil {
				log.Printf("[DB] startup maintenance: filling spot_decoder_names: %v (keeping %s; tried again on the next start)", err, name)
				continue
			}
			log.Printf("[DB] startup maintenance: spot_decoder_names: %d decoder names", n)
		}
		tctx, cancel := context.WithTimeout(ctx, indexDropTimeout)
		start := time.Now()
		_, err := m.db.ExecContext(tctx, `DROP INDEX IF EXISTS "`+name+`"`)
		cancel()
		if err != nil {
			log.Printf("[DB] startup maintenance: dropping %s failed after %v (rolled back; tried again on the next start): %v",
				name, time.Since(start).Round(time.Millisecond), err)
			continue
		}
		log.Printf("[DB] startup maintenance: dropped %s in %v", name, time.Since(start).Round(time.Millisecond))
		dropped = append(dropped, name)
	}
	return dropped
}

// fillDecoderNames records every decoder name that has spots, with the time of
// its newest spot, using spots_idx_decoder_name while it still exists: a seek
// per name, rather than reading every spot. Safe to repeat.
func (m *DBManager) fillDecoderNames(ctx context.Context) (int, error) {
	rows, err := m.db.QueryContext(ctx,
		`WITH RECURSIVE n(name) AS (
		     SELECT MIN(decoder_name) FROM spots
		      WHERE decoder_name IS NOT NULL AND decoder_name != ''
		     UNION ALL
		     SELECT (SELECT MIN(decoder_name) FROM spots
		              WHERE decoder_name > n.name
		                AND decoder_name IS NOT NULL AND decoder_name != '')
		     FROM n WHERE n.name IS NOT NULL
		 )
		 SELECT name FROM n WHERE name IS NOT NULL`)
	if err != nil {
		return 0, err
	}
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return 0, err
		}
		names = append(names, name)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	for _, name := range names {
		// Rows are inserted in time order, so the newest spot for a name is
		// its highest rowid, the last entry under that name in the index.
		var lastTS int64
		if err := m.db.QueryRowContext(ctx,
			`SELECT ts FROM spots INDEXED BY spots_idx_decoder_name
			  WHERE decoder_name = ? AND decoder_name IS NOT NULL AND decoder_name != ''
			  ORDER BY rowid DESC LIMIT 1`, name).Scan(&lastTS); err != nil {
			return 0, err
		}
		if _, err := m.db.ExecContext(ctx, upsertDecoderNameSQL, name, lastTS); err != nil {
			return 0, err
		}
	}
	return len(names), nil
}

// upsertDecoderNameSQL records a decoder name, keeping the later last_ts.
const upsertDecoderNameSQL = `INSERT INTO spot_decoder_names (name, last_ts) VALUES (?, ?)
	ON CONFLICT(name) DO UPDATE SET last_ts = max(last_ts, excluded.last_ts)`
