package main

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

// get_spot_activity: how much was heard, counted in SQL, rather than the spots
// themselves. A busy receiver decodes tens of thousands of stations a day;
// a chart or a map needs counts per band and time step, or per grid square,
// which this returns in a few kilobytes however busy the receiver is.

const (
	mcpActivityMaxSteps  = 288 // per group: 5-minute steps over a day
	mcpActivityMaxGroups = 64
	mcpActivityMaxCells  = 5000
)

func (m *MCPServer) registerSpotActivityTool() {
	m.mcpServer.AddTool(
		mcp.NewTool("get_spot_activity", append([]mcp.ToolOption{
			mcpReadOnlyTool,
			mcp.WithDescription("Count spots heard by this receiver instead of listing them: from the digital decoders (FT8, FT4, WSPR, ...) or the CW skimmer, per band, mode or both over time steps, or per Maidenhead grid square for a map. " +
				"Each count has spots (raw decodes), stations (distinct callsigns) and best_snr. Small however busy the receiver is; use it for charts, 'when was 15 m open', or where signals came from. For the individual spots use get_decoder_spots or get_cw_spots."),
			mcp.WithString("source",
				mcp.Enum("decoder", "cw"),
				mcp.Description("'decoder' (digital modes, default) or 'cw' (CW skimmer)"),
			),
			mcp.WithString("group_by",
				mcp.Enum("band", "mode", "band_mode", "grid"),
				mcp.Description("'band' (default), 'mode', 'band_mode', or 'grid' (per grid square over the whole window, no time steps)"),
			),
			mcp.WithNumber("step_minutes",
				mcp.Min(1),
				mcp.Max(1440),
				mcp.Description("Minutes per time step (default: chosen to give at most 144 steps)"),
			),
			mcp.WithString("grid_precision",
				mcp.Enum("square", "field"),
				mcp.Description("group_by grid: 'square' (4 characters, 2 x 1 degrees, default) or 'field' (2 characters, 20 x 10 degrees)"),
			),
			mcp.WithString("mode",
				mcp.Pattern(`^[A-Za-z0-9]+$`),
				mcp.MaxLength(32),
				mcp.Description("Only this mode, e.g. 'FT8'"),
			),
			mcp.WithString("band",
				mcp.Pattern(`^[A-Za-z0-9.\-]+$`),
				mcp.MaxLength(32),
				mcp.Description("Only this band, e.g. '20m'"),
			),
			mcp.WithNumber("min_snr",
				mcp.Min(-60),
				mcp.Max(60),
				mcp.Description("Only spots at or above this SNR in dB"),
			),
			mcp.WithNumber("hours",
				mcp.Min(1),
				mcp.Max(48),
				mcp.Description("Hours of history (default 24, max 48)"),
			),
			mcpSinceProp(),
			mcp.WithNumber("max_items",
				mcp.Min(1),
				mcp.Max(mcpActivityMaxCells),
				mcp.Description("group_by grid: most squares to return, busiest first (default 500)"),
			),
		}, mcpWindowProps()...)...),
		m.handleGetSpotActivity,
	)
}

// activitySource is where a source's spots live and what its columns are
// called.
type activitySource struct {
	table, callCol string
	available      bool
}

func (m *MCPServer) activitySource(name string) (activitySource, *sql.DB) {
	switch name {
	case "cw":
		if m.cwSpotsAvailable() && m.CWSkimmer.spotsLogger.readDB != nil {
			return activitySource{"cw_spots", "dx_call", true}, m.CWSkimmer.spotsLogger.readDB
		}
		return activitySource{}, nil
	default:
		if m.multiDecoder != nil && m.multiDecoder.spotsLogger != nil && m.multiDecoder.spotsLogger.readDB != nil {
			return activitySource{"spots", "callsign", true}, m.multiDecoder.spotsLogger.readDB
		}
		return activitySource{}, nil
	}
}

func (m *MCPServer) handleGetSpotActivity(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	sourceName := request.GetString("source", "decoder")
	src, db := m.activitySource(sourceName)
	if !src.available {
		return mcp.NewToolResultError(fmt.Sprintf("%s spot logging is not enabled on this receiver", sourceName)), nil
	}
	groupBy := request.GetString("group_by", "band")
	from, to, msg := mcpSpotWindow(request, 24, 48, time.Now().UTC())
	if msg != "" {
		return mcp.NewToolResultError(msg), nil
	}
	if !m.allowToolCall(ctx, "get_spot_activity") {
		return mcpRateLimited("get_spot_activity"), nil
	}

	where := []string{"ts >= ?", "ts < ?"}
	args := []interface{}{from.Unix(), to.Unix() + 1}
	if v := request.GetString("mode", ""); v != "" {
		where = append(where, "UPPER(mode) = ?")
		args = append(args, strings.ToUpper(v))
	}
	if v := request.GetString("band", ""); v != "" {
		where = append(where, "band = ?")
		args = append(args, v)
	}
	if _, ok := request.GetArguments()["min_snr"]; ok {
		where = append(where, "snr >= ?")
		args = append(args, int(math.Ceil(request.GetFloat("min_snr", -999))))
	}

	if groupBy == "grid" {
		return m.spotActivityGrid(ctx, db, src, sourceName, request, where, args, from, to)
	}

	spanMin := int(to.Sub(from).Minutes()) + 1
	step := int(request.GetFloat("step_minutes", 0))
	if step <= 0 {
		step = sgdAutoStep(spanMin, 144)
	}
	base, nSteps := sgdSteps(from, to, step)
	if nSteps > mcpActivityMaxSteps {
		return mcp.NewToolResultError(fmt.Sprintf("%d steps of %d minutes; at most %d: raise step_minutes or shorten the window",
			nSteps, step, mcpActivityMaxSteps)), nil
	}
	keyExpr := map[string]string{
		"band":      "COALESCE(band, '')",
		"mode":      "COALESCE(UPPER(mode), '')",
		"band_mode": "COALESCE(band, '') || ' ' || COALESCE(UPPER(mode), '')",
	}[groupBy]
	stepSec := int64(step) * 60
	cond := strings.Join(where, " AND ")

	rows, err := db.QueryContext(ctx, fmt.Sprintf(`
		SELECT (ts - ?) / ?, %s, COUNT(*), COUNT(DISTINCT %s), MAX(snr)
		FROM %s WHERE %s GROUP BY 1, 2`, keyExpr, src.callCol, src.table, cond),
		append([]interface{}{base, stepSec}, args...)...)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to count spots: %v", err)), nil
	}
	type series struct {
		Spots    []int  `json:"spots"`
		Stations []int  `json:"stations"`
		BestSNR  []*int `json:"best_snr"`
	}
	groups := map[string]*series{}
	for rows.Next() {
		var idx int64
		var key string
		var n, stations int
		var best sql.NullInt64
		if err := rows.Scan(&idx, &key, &n, &stations, &best); err != nil {
			rows.Close()
			return mcp.NewToolResultError(fmt.Sprintf("Failed to count spots: %v", err)), nil
		}
		if idx < 0 || idx >= int64(nSteps) {
			continue
		}
		g := groups[key]
		if g == nil {
			if len(groups) >= mcpActivityMaxGroups {
				continue
			}
			g = &series{Spots: make([]int, nSteps), Stations: make([]int, nSteps), BestSNR: make([]*int, nSteps)}
			groups[key] = g
		}
		g.Spots[idx], g.Stations[idx] = n, stations
		if best.Valid {
			v := int(best.Int64)
			g.BestSNR[idx] = &v
		}
	}
	rows.Close()

	// Window totals: distinct stations cannot be summed from the steps.
	totals := map[string]map[string]int{}
	trows, err := db.QueryContext(ctx, fmt.Sprintf(`SELECT %s, COUNT(*), COUNT(DISTINCT %s) FROM %s WHERE %s GROUP BY 1`,
		keyExpr, src.callCol, src.table, cond), args...)
	if err == nil {
		for trows.Next() {
			var key string
			var n, stations int
			if trows.Scan(&key, &n, &stations) == nil {
				totals[key] = map[string]int{"spots": n, "stations": stations}
			}
		}
		trows.Close()
	}

	return mcpCompactJSON(map[string]interface{}{
		"source":   sourceName,
		"group_by": groupBy,
		"time_axis": map[string]interface{}{
			"start_utc":    time.Unix(base, 0).UTC().Format(time.RFC3339),
			"step_minutes": step,
			"steps":        nSteps,
			"note":         "value i covers start_utc + i*step_minutes; spots = raw decodes, stations = distinct callsigns, best_snr null = none",
		},
		"from_utc": from.Format(time.RFC3339),
		"to_utc":   to.Format(time.RFC3339),
		"groups":   groups,
		"totals":   totals,
	})
}

// gridCell is a Maidenhead field (precision 2: 18 x 18 cells of 20 x 10
// degrees) or square (precision 4: 180 x 180 cells of 2 x 1 degrees).
type gridCell struct {
	lonIdx, latIdx int
}

func gridCellSize(precision int) (lonDeg, latDeg float64) {
	if precision == 2 {
		return 20, 10
	}
	return 2, 1
}

// gridCellFromLocator parses the first precision characters of a locator.
func gridCellFromLocator(loc string, precision int) (gridCell, bool) {
	loc = strings.ToUpper(strings.TrimSpace(loc))
	if len(loc) < precision || loc[0] < 'A' || loc[0] > 'R' || loc[1] < 'A' || loc[1] > 'R' {
		return gridCell{}, false
	}
	c := gridCell{int(loc[0] - 'A'), int(loc[1] - 'A')}
	if precision == 4 {
		if loc[2] < '0' || loc[2] > '9' || loc[3] < '0' || loc[3] > '9' {
			return gridCell{}, false
		}
		c = gridCell{c.lonIdx*10 + int(loc[2]-'0'), c.latIdx*10 + int(loc[3]-'0')}
	}
	return c, true
}

func gridCellFromLatLon(lat, lon float64, precision int) (gridCell, bool) {
	if lat < -90 || lat > 90 || lon < -180 || lon > 180 || math.IsNaN(lat) || math.IsNaN(lon) {
		return gridCell{}, false
	}
	w, h := gridCellSize(precision)
	n := 18
	if precision == 4 {
		n = 180
	}
	c := gridCell{int(math.Floor((lon + 180) / w)), int(math.Floor((lat + 90) / h))}
	c.lonIdx = min(c.lonIdx, n-1)
	c.latIdx = min(c.latIdx, n-1)
	return c, true
}

func (c gridCell) locator(precision int) string {
	if precision == 2 {
		return string([]byte{byte('A' + c.lonIdx), byte('A' + c.latIdx)})
	}
	return string([]byte{byte('A' + c.lonIdx/10), byte('A' + c.latIdx/10), byte('0' + c.lonIdx%10), byte('0' + c.latIdx%10)})
}

func (c gridCell) centre(precision int) (lat, lon float64) {
	w, h := gridCellSize(precision)
	return -90 + (float64(c.latIdx)+0.5)*h, -180 + (float64(c.lonIdx)+0.5)*w
}

func (m *MCPServer) spotActivityGrid(ctx context.Context, db *sql.DB, src activitySource, sourceName string,
	request mcp.CallToolRequest, where []string, args []interface{}, from, to time.Time) (*mcp.CallToolResult, error) {
	precision := 4
	if request.GetString("grid_precision", "square") == "field" {
		precision = 2
	}
	maxItems := int(request.GetFloat("max_items", 500))

	// Group in SQL by the finest key each table has, then fold into cells in
	// Go: decoder spots carry a locator, CW spots a latitude and longitude
	// (bucketed here to the cell size so SQL does the heavy grouping).
	var keyExpr string
	if src.table == "spots" {
		where = append(where, "LENGTH(locator) >= ?")
		args = append(args, precision)
		keyExpr = fmt.Sprintf("UPPER(SUBSTR(locator, 1, %d))", precision)
	} else {
		where = append(where, "latitude IS NOT NULL", "longitude IS NOT NULL")
		w, h := gridCellSize(precision)
		keyExpr = fmt.Sprintf("CAST((longitude + 180) / %g AS INTEGER) || ',' || CAST((latitude + 90) / %g AS INTEGER)", w, h)
	}
	// Distinct callsigns per cell must be counted per cell in SQL; bands are
	// listed so a map can colour by band.
	rows, err := db.QueryContext(ctx, fmt.Sprintf(`
		SELECT %s, COUNT(*), COUNT(DISTINCT %s), MAX(snr), GROUP_CONCAT(DISTINCT band)
		FROM %s WHERE %s GROUP BY 1`, keyExpr, src.callCol, src.table, strings.Join(where, " AND ")), args...)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to count spots: %v", err)), nil
	}
	type cellOut struct {
		Grid     string   `json:"grid"`
		Lat      float64  `json:"lat"`
		Lon      float64  `json:"lon"`
		Spots    int      `json:"spots"`
		Stations int      `json:"stations"`
		BestSNR  *int     `json:"best_snr"`
		Bands    []string `json:"bands"`
	}
	var cells []cellOut
	for rows.Next() {
		var key string
		var n, stations int
		var best sql.NullInt64
		var bands sql.NullString
		if err := rows.Scan(&key, &n, &stations, &best, &bands); err != nil {
			rows.Close()
			return mcp.NewToolResultError(fmt.Sprintf("Failed to count spots: %v", err)), nil
		}
		var c gridCell
		ok := false
		if src.table == "spots" {
			c, ok = gridCellFromLocator(key, precision)
		} else {
			var li, la int
			if _, err := fmt.Sscanf(key, "%d,%d", &li, &la); err == nil {
				w, h := gridCellSize(precision)
				c, ok = gridCellFromLatLon(-90+(float64(la)+0.5)*h, -180+(float64(li)+0.5)*w, precision)
			}
		}
		if !ok {
			continue
		}
		lat, lon := c.centre(precision)
		out := cellOut{Grid: c.locator(precision), Lat: lat, Lon: lon, Spots: n, Stations: stations}
		if best.Valid {
			v := int(best.Int64)
			out.BestSNR = &v
		}
		if bands.Valid && bands.String != "" {
			out.Bands = strings.Split(bands.String, ",")
			sort.Strings(out.Bands)
		}
		cells = append(cells, out)
	}
	rows.Close()
	sort.Slice(cells, func(i, j int) bool {
		if cells[i].Spots != cells[j].Spots {
			return cells[i].Spots > cells[j].Spots
		}
		return cells[i].Grid < cells[j].Grid
	})
	truncated := len(cells) > maxItems
	if truncated {
		cells = cells[:maxItems]
	}
	if cells == nil {
		cells = []cellOut{}
	}
	return mcpCompactJSON(map[string]interface{}{
		"source":         sourceName,
		"group_by":       "grid",
		"grid_precision": map[int]string{2: "field", 4: "square"}[precision],
		"from_utc":       from.Format(time.RFC3339),
		"to_utc":         to.Format(time.RFC3339),
		"cells":          cells,
		"count":          len(cells),
		"truncated":      truncated,
		"note":           "lat/lon are the square's centre; spots = raw decodes, stations = distinct callsigns",
	})
}
