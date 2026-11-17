package main

// stats_psk_store.go — SQLite storage for PSKRankData (the hourly
// pskreporter.info leaderboard scrape).
//
// Layout: one psk_snapshots row per scrape, holding two zstd-compressed blobs:
//
//	boards   — reportResult and countryResult (every band's ranked list)
//	software — the full callsign→software map from #software_in_use
//
// plus ts, fetched_ms and error as plain columns.
//
// Why blobs and not rows: every reader wants whole snapshots, never parts of
// one. LoadLatestPSK seeds the in-memory cache with a full scrape; ?at=
// replays a full leaderboard with its software; history without a callsign
// returns full leaderboards; and history with a callsign (the public endpoint
// and get_station_rankings) ranks an arbitrary caller-chosen callsign, which
// needs every band's list of every scrape in the range anyway. Nothing ever
// selected individual entries or software rows in SQL. The previous
// one-row-per-(scrape × table × band × position) and
// one-row-per-(scrape × callsign × software) layout bought no query power and
// turned each scrape into ~28,000 rows plus UNIQUE indexes over them: about
// 2.2 MB per scrape, 1.6 GB at 30 days on one production receiver. Here one
// production-sized scrape is ~16 KB of boards plus ~180 KB of software.
//
// Why two blobs: the software map is ~90% of a scrape and only the
// single-snapshot readers (LoadLatestPSK, ?at=) use it, so the range read
// behind the history endpoints never loads or decompresses it. A month of
// history then decodes in well under a second.
//
// Alternatives considered: a side table of just the receiver's own rank (the
// public history endpoint takes any callsign, so it could only serve the MCP
// tool); and a deduplicated software state table with first/last-seen
// intervals (measured churn is ~1,200 changed entries per scrape, with
// several-thousand swings a few times a day, so it would save little over the
// compressed map while adding interval bookkeeping that breaks on rewritten or
// out-of-order snapshots).
//
// The previous tables (psk_rank_snapshots, psk_rank_entries, psk_software)
// are emptied in the background and dropped by dropLegacyPSKTables; their
// contents are not migrated.

import (
	"context"
	"database/sql"
	"encoding/binary"
	"fmt"
	"log"
	"sort"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"
)

// pskEncodingZstdBinary marks blobs in the layout written by appendPSKBoards
// and appendPSKSoftware, zstd-compressed. Stored per row so the format can
// change later without a migration.
//
// A hand-rolled layout rather than JSON for the read side: a 30-day history
// query decodes ~720 boards, and encoding/json took several ms per snapshot on
// production-sized data against well under 1 ms for this.
const pskEncodingZstdBinary = 1

// The encoder and decoder are created on first use and shared: EncodeAll and
// DecodeAll are safe for concurrent use. One snapshot is written per hour, so
// the slower, tighter compression level costs nothing that matters.
var (
	pskZstdOnce sync.Once
	pskZstdEnc  *zstd.Encoder
	pskZstdDec  *zstd.Decoder
	pskZstdErr  error
)

func pskZstd() (*zstd.Encoder, *zstd.Decoder, error) {
	pskZstdOnce.Do(func() {
		pskZstdEnc, pskZstdErr = zstd.NewWriter(nil,
			zstd.WithEncoderLevel(zstd.SpeedBetterCompression),
			zstd.WithEncoderConcurrency(1))
		if pskZstdErr != nil {
			return
		}
		pskZstdDec, pskZstdErr = zstd.NewReader(nil,
			zstd.WithDecoderConcurrency(0),
			zstd.WithDecoderMaxMemory(64<<20))
	})
	return pskZstdEnc, pskZstdDec, pskZstdErr
}

func pskCompress(raw []byte) ([]byte, error) {
	enc, _, err := pskZstd()
	if err != nil {
		return nil, err
	}
	return enc.EncodeAll(raw, make([]byte, 0, len(raw)/4)), nil
}

func pskDecompress(encoding int, blob []byte) ([]byte, error) {
	if encoding != pskEncodingZstdBinary {
		return nil, fmt.Errorf("unknown psk encoding %d", encoding)
	}
	_, dec, err := pskZstd()
	if err != nil {
		return nil, err
	}
	raw, err := dec.DecodeAll(blob, nil)
	if err != nil {
		return nil, fmt.Errorf("decompress: %w", err)
	}
	return raw, nil
}

// encodePSKBoards and encodePSKSoftware return the two stored blobs of data.
// The software blob is nil when the scrape had no software table.
func encodePSKBoards(data *PSKRankData) ([]byte, error) {
	return pskCompress(appendPSKBoards(nil, nonEmptyBands(data.ReportResult), nonEmptyBands(data.CountryResult)))
}

func encodePSKSoftware(data *PSKRankData) ([]byte, error) {
	sw := normaliseSoftware(data.SoftwareInUse)
	if len(sw) == 0 {
		return nil, nil
	}
	return pskCompress(appendPSKSoftware(nil, sw))
}

// nonEmptyBands drops bands with no entries. The row-per-entry layout could
// not represent an empty band, so readers have never seen one; keeping that
// holds the endpoint output unchanged.
func nonEmptyBands(src PSKMonitorsByBand) PSKMonitorsByBand {
	for _, entries := range src {
		if len(entries) == 0 {
			out := make(PSKMonitorsByBand, len(src))
			for band, e := range src {
				if len(e) > 0 {
					out[band] = e
				}
			}
			return out
		}
	}
	return src
}

// normaliseSoftware returns a copy of sw with each callsign's list sorted by
// name then version and exact duplicates removed — the order and uniqueness
// the previous table's UNIQUE(ts, callsign, name, version) index gave readers.
func normaliseSoftware(sw map[string][]PSKSoftwareEntry) map[string][]PSKSoftwareEntry {
	if len(sw) == 0 {
		return nil
	}
	out := make(map[string][]PSKSoftwareEntry, len(sw))
	for callsign, list := range sw {
		if len(list) == 0 {
			continue
		}
		sorted := append([]PSKSoftwareEntry(nil), list...)
		sort.Slice(sorted, func(i, j int) bool {
			if sorted[i].Name != sorted[j].Name {
				return sorted[i].Name < sorted[j].Name
			}
			return sorted[i].Version < sorted[j].Version
		})
		uniq := sorted[:1]
		for _, e := range sorted[1:] {
			if e != uniq[len(uniq)-1] {
				uniq = append(uniq, e)
			}
		}
		out[callsign] = uniq
	}
	return out
}

// Uncompressed layouts (all integers are Go varints / uvarints):
//
//	boards   = board(report) board(country)
//	board    = uvarint nBands, then per band (sorted):
//	           string band, uvarint nEntries, then per entry in rank order:
//	           string callsign, varint day, varint week
//	software = uvarint nCallsigns, then per callsign (sorted):
//	           string callsign, uvarint nEntries, then per entry:
//	           string name, string version
//	string   = uvarint length, bytes

func appendPSKString(b []byte, s string) []byte {
	b = binary.AppendUvarint(b, uint64(len(s)))
	return append(b, s...)
}

func appendPSKBoards(b []byte, boards ...PSKMonitorsByBand) []byte {
	for _, board := range boards {
		bands := make([]string, 0, len(board))
		for band := range board {
			bands = append(bands, band)
		}
		sort.Strings(bands)
		b = binary.AppendUvarint(b, uint64(len(bands)))
		for _, band := range bands {
			b = appendPSKString(b, band)
			entries := board[band]
			b = binary.AppendUvarint(b, uint64(len(entries)))
			for _, e := range entries {
				b = appendPSKString(b, e.Callsign)
				b = binary.AppendVarint(b, int64(e.Day))
				b = binary.AppendVarint(b, int64(e.Week))
			}
		}
	}
	return b
}

func appendPSKSoftware(b []byte, sw map[string][]PSKSoftwareEntry) []byte {
	callsigns := make([]string, 0, len(sw))
	for cs := range sw {
		callsigns = append(callsigns, cs)
	}
	sort.Strings(callsigns)
	b = binary.AppendUvarint(b, uint64(len(callsigns)))
	for _, cs := range callsigns {
		b = appendPSKString(b, cs)
		b = binary.AppendUvarint(b, uint64(len(sw[cs])))
		for _, e := range sw[cs] {
			b = appendPSKString(b, e.Name)
			b = appendPSKString(b, e.Version)
		}
	}
	return b
}

// pskReader reads those layouts. The first malformed field sets err and every
// later read returns a zero value, so callers check err once at the end.
// Counts are checked against the bytes left (every element takes at least one
// byte), so a corrupt count cannot drive a huge allocation.
type pskReader struct {
	b   []byte
	err error
}

func (r *pskReader) fail(what string) {
	if r.err == nil {
		r.err = fmt.Errorf("psk blob: bad %s", what)
	}
	r.b = nil
}

func (r *pskReader) uvarint(what string) uint64 {
	v, n := binary.Uvarint(r.b)
	if n <= 0 {
		r.fail(what)
		return 0
	}
	r.b = r.b[n:]
	return v
}

func (r *pskReader) varint(what string) int64 {
	v, n := binary.Varint(r.b)
	if n <= 0 {
		r.fail(what)
		return 0
	}
	r.b = r.b[n:]
	return v
}

func (r *pskReader) count(what string) int {
	v := r.uvarint(what)
	if v > uint64(len(r.b)) {
		r.fail(what)
		return 0
	}
	return int(v)
}

func (r *pskReader) str(what string) string {
	n := r.uvarint(what)
	if n > uint64(len(r.b)) {
		r.fail(what)
		return ""
	}
	s := string(r.b[:n])
	r.b = r.b[n:]
	return s
}

// done reports the first error, or an error when bytes are left over.
func (r *pskReader) done() error {
	if r.err == nil && len(r.b) != 0 {
		r.err = fmt.Errorf("psk blob: %d trailing bytes", len(r.b))
	}
	return r.err
}

func (r *pskReader) board() PSKMonitorsByBand {
	nBands := r.count("band count")
	out := make(PSKMonitorsByBand, nBands)
	for i := 0; i < nBands && r.err == nil; i++ {
		band := r.str("band")
		entries := make([]PSKMonitorEntry, r.count("entry count"))
		for j := range entries {
			entries[j] = PSKMonitorEntry{
				Callsign: r.str("callsign"),
				Day:      int(r.varint("day")),
				Week:     int(r.varint("week")),
			}
		}
		out[band] = entries
	}
	return out
}

func (r *pskReader) software() map[string][]PSKSoftwareEntry {
	nCalls := r.count("software count")
	out := make(map[string][]PSKSoftwareEntry, nCalls)
	for i := 0; i < nCalls && r.err == nil; i++ {
		cs := r.str("software callsign")
		list := make([]PSKSoftwareEntry, r.count("software entry count"))
		for j := range list {
			list[j] = PSKSoftwareEntry{Name: r.str("software name"), Version: r.str("software version")}
		}
		out[cs] = list
	}
	return out
}

// decodePSKBoards fills data's two leaderboards from a boards blob. Both maps
// are always non-nil, matching what callers have always received.
func decodePSKBoards(encoding int, blob []byte, data *PSKRankData) error {
	data.ReportResult = make(PSKMonitorsByBand)
	data.CountryResult = make(PSKMonitorsByBand)
	if len(blob) == 0 {
		return nil
	}
	raw, err := pskDecompress(encoding, blob)
	if err != nil {
		return err
	}
	r := &pskReader{b: raw}
	report, country := r.board(), r.board()
	if err := r.done(); err != nil {
		return err
	}
	data.ReportResult, data.CountryResult = report, country
	return nil
}

// decodePSKSoftware fills data.SoftwareInUse from a software blob; it stays
// nil when the blob is empty, matching what callers have always received.
func decodePSKSoftware(encoding int, blob []byte, data *PSKRankData) error {
	data.SoftwareInUse = nil
	if len(blob) == 0 {
		return nil
	}
	raw, err := pskDecompress(encoding, blob)
	if err != nil {
		return err
	}
	r := &pskReader{b: raw}
	sw := r.software()
	if err := r.done(); err != nil {
		return err
	}
	if len(sw) > 0 {
		data.SoftwareInUse = sw
	}
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// PSK — write
// ─────────────────────────────────────────────────────────────────────────────

// writePSKToDB stores data as the snapshot at fetchedAt, replacing any
// snapshot already there. Errors are logged, not returned — see writeWSPRToDB.
func (sl *StatsLogger) writePSKToDB(data *PSKRankData, fetchedAt time.Time) {
	if sl == nil || sl.db == nil || data == nil {
		return
	}
	boards, err := encodePSKBoards(data)
	if err != nil {
		log.Printf("[StatsLogger] WritePSK: encode boards: %v", err)
		return
	}
	software, err := encodePSKSoftware(data)
	if err != nil {
		log.Printf("[StatsLogger] WritePSK: encode software: %v", err)
		return
	}
	if _, err := sl.db.Exec(`
		INSERT INTO psk_snapshots (ts, fetched_ms, error, encoding, boards, software)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(ts) DO UPDATE SET
			fetched_ms = excluded.fetched_ms,
			error      = excluded.error,
			encoding   = excluded.encoding,
			boards     = excluded.boards,
			software   = excluded.software`,
		fetchedAt.UTC().Unix(), data.FetchedMs, data.Error, pskEncodingZstdBinary, boards, software); err != nil {
		log.Printf("[StatsLogger] WritePSK: %v", err)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// PSK — read
// ─────────────────────────────────────────────────────────────────────────────

// The three read shapes. The table's only index besides the rowid is the
// UNIQUE(ts) autoindex, and each of these is a SEARCH on it (asserted by
// TestPSKSnapshotQueriesUseIndex): a ts range, a ts range then a sort of the
// few rows inside ±window, and a MAX(ts) lookup followed by ts = ?.
const (
	pskWhereRange   = `ts >= ? AND ts < ? ORDER BY ts`
	pskWhereNearest = `ts >= ? AND ts <= ? ORDER BY abs(ts - ?), ts LIMIT 1`
	pskWhereLatest  = `ts = (SELECT MAX(ts) FROM psk_snapshots)`
)

// pskSnapshotsSQL is the SELECT behind every read; tail is one of the
// pskWhere* shapes. The software column is replaced by NULL when not wanted,
// so its pages are never read.
func pskSnapshotsSQL(withSoftware bool, tail string) string {
	softwareCol := "NULL"
	if withSoftware {
		softwareCol = "software"
	}
	return `SELECT ts, fetched_ms, error, encoding, boards, ` + softwareCol + `
		FROM psk_snapshots
		WHERE ` + tail
}

// readPSKFromDB returns every snapshot in p's date range, oldest first, with
// both leaderboards but WITHOUT SoftwareInUse: the history readers (the
// /api/stats/psk-rank history mode and get_station_rankings) never use it, and
// it is ~90% of each snapshot.
func (sl *StatsLogger) readPSKFromDB(p StatsQueryParams) ([]PSKRankData, error) {
	if sl == nil || sl.readDB == nil {
		return nil, nil
	}
	from, to := rangeBounds(p)
	return sl.loadPSKSnapshots(false, pskWhereRange, from, to)
}

// readPSKAtFromDB returns the snapshot whose ts is closest to target, provided
// it falls within ±window, including its software map. Returns (nil, nil)
// when no snapshot qualifies. The ts range is served by the UNIQUE(ts) index;
// ties go to the earlier snapshot.
func (sl *StatsLogger) readPSKAtFromDB(target time.Time, window time.Duration) (*PSKRankData, error) {
	if sl == nil || sl.readDB == nil {
		return nil, nil
	}
	want := target.UTC().Unix()
	slack := int64(window / time.Second)
	out, err := sl.loadPSKSnapshots(true, pskWhereNearest, want-slack, want+slack, want)
	if err != nil || len(out) == 0 {
		return nil, err
	}
	return &out[0], nil
}

// loadLatestPSKFromDB returns the most recent snapshot, including its software
// map, or nil when the table is empty or no DB is attached.
func (sl *StatsLogger) loadLatestPSKFromDB() *PSKRankData {
	if sl == nil || sl.readDB == nil {
		return nil
	}
	out, err := sl.loadPSKSnapshots(true, pskWhereLatest)
	if err != nil {
		log.Printf("[StatsLogger] DB: load latest PSK: %v", err)
		return nil
	}
	if len(out) == 0 {
		return nil
	}
	data := out[0]
	log.Printf("[StatsLogger] Loaded PSK cache from DB (fetched_at=%s)", data.FetchedAt.Format(time.RFC3339))
	return &data
}

// loadPSKSnapshots decodes the psk_snapshots rows selected by tail (one of
// the pskWhere* shapes), in the order the query returns them.
// The software column is only read when withSoftware is set. A row that cannot
// be decoded is logged and skipped rather than failing the whole range.
func (sl *StatsLogger) loadPSKSnapshots(withSoftware bool, tail string, args ...interface{}) ([]PSKRankData, error) {
	rows, err := sl.readDB.Query(pskSnapshotsSQL(withSoftware, tail), args...)
	if err != nil {
		return nil, fmt.Errorf("query psk_snapshots: %w", err)
	}
	defer rows.Close()

	var out []PSKRankData
	for rows.Next() {
		var (
			ts               int64
			fetchedMs        sql.NullInt64
			errMessage       sql.NullString
			encoding         int
			boards, software []byte
		)
		if err := rows.Scan(&ts, &fetchedMs, &errMessage, &encoding, &boards, &software); err != nil {
			return nil, fmt.Errorf("scan psk_snapshots: %w", err)
		}
		data := PSKRankData{
			FetchedAt: time.Unix(ts, 0).UTC(),
			FetchedMs: fetchedMs.Int64,
			Error:     errMessage.String,
		}
		if err := decodePSKBoards(encoding, boards, &data); err != nil {
			log.Printf("[StatsLogger] DB: psk snapshot %d boards: %v (skipped)", ts, err)
			continue
		}
		if err := decodePSKSoftware(encoding, software, &data); err != nil {
			log.Printf("[StatsLogger] DB: psk snapshot %d software: %v (skipped)", ts, err)
			continue
		}
		out = append(out, data)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate psk_snapshots: %w", err)
	}
	return out, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy tables
// ─────────────────────────────────────────────────────────────────────────────

// legacyPSKTables are the row-per-entry tables psk_snapshots replaced. Children
// first, though nothing enforces an order (there are no foreign keys).
var legacyPSKTables = []string{"psk_rank_entries", "psk_software", "psk_rank_snapshots"}

const (
	// legacyDropStartDelay lets startup (schema, imports, the first retention
	// pass) settle before the cleanup starts competing for the write connection.
	legacyDropStartDelay = 2 * time.Minute
	// legacyDropBatchRows bounds how long each DELETE holds the single write
	// connection; legacyDropPause is the gap left between batches for every
	// other writer on this server.
	legacyDropBatchRows = 10_000
	legacyDropPause     = 100 * time.Millisecond
)

// StartLegacyPSKTableDrop removes the old PSK tables in the background after
// legacyDropStartDelay. Safe on every start: once the tables are gone it only
// checks sqlite_master.
func StartLegacyPSKTableDrop(ctx context.Context, db *sql.DB) {
	if db == nil {
		return
	}
	go func() {
		select {
		case <-ctx.Done():
			return
		case <-time.After(legacyDropStartDelay):
		}
		defer func() {
			if r := recover(); r != nil {
				log.Printf("[DB] legacy PSK table drop: recovered from panic: %v (tried again on next start)", r)
			}
		}()
		dropLegacyPSKTables(ctx, db, legacyDropBatchRows, legacyDropPause)
	}()
}

// dropLegacyPSKTables empties each legacy PSK table in batches of batchRows,
// pausing between batches, then drops it. A plain DROP TABLE would do the
// same work in one statement and hold the only write connection for as long
// as freeing a multi-GB table takes; batching keeps every other writer moving.
// Idempotent: a table that does not exist is skipped, and a run interrupted by
// shutdown resumes where it stopped on the next start.
//
// No VACUUM or incremental_vacuum runs here: the freed pages stay on the
// freelist (reused by later writes) and returning them to the filesystem is
// left to the database maintenance job.
func dropLegacyPSKTables(ctx context.Context, db *sql.DB, batchRows int, pause time.Duration) {
	for _, table := range legacyPSKTables {
		if ctx.Err() != nil {
			return
		}
		var n int
		if err := db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&n); err != nil {
			log.Printf("[DB] legacy %s: %v", table, err)
			return
		}
		if n == 0 {
			continue
		}

		log.Printf("[DB] legacy %s: emptying in batches of %d before drop", table, batchRows)
		start := time.Now()
		var total int64
		for {
			if ctx.Err() != nil {
				log.Printf("[DB] legacy %s: stopped after %d rows; resumes on next start", table, total)
				return
			}
			res, err := db.ExecContext(ctx, `DELETE FROM `+table+` WHERE rowid IN (
				SELECT rowid FROM `+table+` LIMIT ?)`, batchRows)
			if err != nil {
				log.Printf("[DB] legacy %s: delete: %v (retrying on next start)", table, err)
				return
			}
			deleted, _ := res.RowsAffected()
			total += deleted
			if deleted < int64(batchRows) {
				break
			}
			select {
			case <-ctx.Done():
			case <-time.After(pause):
			}
		}

		if _, err := db.ExecContext(ctx, `DROP TABLE IF EXISTS `+table); err != nil {
			log.Printf("[DB] legacy %s: drop: %v (retrying on next start)", table, err)
			return
		}
		log.Printf("[DB] legacy %s: deleted %d rows and dropped the table in %v",
			table, total, time.Since(start).Round(time.Second))
	}
}
