package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

// Propagation tools: band-opening predictions, SSB reach estimated from WSPR,
// sun times and greyline, and on-demand SNR.

func (m *MCPServer) registerPropagationTools() {
	m.mcpServer.AddTool(
		mcp.NewTool("get_propagation_predictions",
			mcp.WithDescription("Predict when each band will next open, from the hours at which this receiver has historically decoded digital spots (FT8, FT4, WSPR), weighed against how today's space weather compares with the conditions on those days. Each prediction has the UTC hour the band is expected to open, hours until then, and a confidence score. Filter by country or continent to ask when a band opens to that area."),
			mcp.WithString("country",
				mcp.Description("Country name, e.g. 'Japan' (default: all)"),
			),
			mcp.WithString("continent",
				mcp.Description("Continent code: AF, AS, EU, NA, OC, SA or AN (default: all)"),
			),
			mcp.WithString("mode",
				mcp.Description("Digital mode the history comes from: 'FT8', 'FT4' or 'WSPR' (default: all)"),
			),
			mcp.WithNumber("hours",
				mcp.Description("Hours of spot history to learn from (default: 24, max: 168)"),
				mcp.DefaultNumber(24),
			),
		),
		m.handleGetPropagationPredictions,
	)

	m.mcpServer.AddTool(
		mcp.NewTool("get_ssb_predictions",
			mcp.WithDescription("Estimate how well an SSB (phone) station in each country would be heard at this receiver, from WSPR beacons it decoded recently: each beacon's SNR is scaled from its own transmit power to the given phone power and corrected to SSB bandwidth. Predictions are 'excellent' (>=15 dB), 'good' (>=10), 'workable' (>=6), 'marginal' (>=3), 'poor' (>=0) or 'not_viable'. Returns a summary grouped by country (best band for each) or by band (countries reachable on each)."),
			mcp.WithNumber("minutes",
				mcp.Description("How far back to look at WSPR spots, in minutes (default: 60, max: 1440)"),
				mcp.DefaultNumber(60),
			),
			mcp.WithNumber("power_w",
				mcp.Description("Assumed SSB transmit power in watts: 10, 50, 100, 250, 500 or 1000 (default: 100)"),
				mcp.DefaultNumber(100),
			),
			mcp.WithString("band",
				mcp.Description("Only this band, e.g. '20m' (default: all WSPR bands)"),
			),
			mcp.WithString("group_by",
				mcp.Description("'country' (default) or 'band'"),
				mcp.Enum("country", "band"),
			),
			mcp.WithNumber("min_ssb_snr",
				mcp.Description("Leave out predictions below this SSB SNR in dB, -60 to 30 (default: 10, i.e. 'good' or better)"),
				mcp.DefaultNumber(10),
			),
		),
		m.handleGetSSBPredictions,
	)

	m.mcpServer.AddTool(
		mcp.NewTool("get_sun_times",
			mcp.WithDescription("Get sunrise, sunset and twilight times (UTC) and the sun's current position at the receiver, and optionally at a second location given as a Maidenhead locator or latitude/longitude. Reports whether each end is in daylight, twilight or night and on the greyline, plus the distance and bearing between them. Use this to explain day/night propagation changes or to find greyline openings on a path."),
			mcp.WithString("locator",
				mcp.Description("Maidenhead locator of the far end, e.g. 'PM95' or 'FN31pr'"),
			),
			mcp.WithNumber("latitude",
				mcp.Description("Latitude of the far end in degrees (with longitude, instead of locator)"),
			),
			mcp.WithNumber("longitude",
				mcp.Description("Longitude of the far end in degrees, east positive"),
			),
			mcp.WithString("date",
				mcp.Description("Day to calculate times for, YYYY-MM-DD in UTC (default: today). The current sun position is always for now."),
			),
		),
		m.handleGetSunTimes,
	)

	snrDesc := "Measure the signal-to-noise ratio and occupancy of a band or frequency range right now, from the receiver's live spectrum: SNR is the 95th minus the 5th percentile of the power in the range, occupancy the share of it more than 10 dB above the noise. Give a named range, or lo_khz and hi_khz, or nothing to measure every named range at once (a quick 'which bands are lively' overview)."
	if m.noiseFloorMonitor != nil {
		names := make([]string, 0)
		for _, p := range m.noiseFloorMonitor.snrPresets() {
			names = append(names, p.Name)
		}
		snrDesc += " Named ranges: " + strings.Join(names, ", ") + " (bc-* are broadcast bands, 'all' and 'hf' the whole receiver and 1.8-30 MHz)."
	}
	m.mcpServer.AddTool(
		mcp.NewTool("get_snr",
			mcp.WithDescription(snrDesc),
			mcp.WithString("range",
				mcp.Description("Named range, e.g. '20m', 'bc31m' or 'hf'"),
			),
			mcp.WithNumber("lo_khz",
				mcp.Description("Lower edge of a custom range in kHz (with hi_khz)"),
			),
			mcp.WithNumber("hi_khz",
				mcp.Description("Upper edge of a custom range in kHz"),
			),
			mcp.WithNumber("avg_sec",
				mcp.Description("Average the spectrum over this many seconds, 0-60 (default: 10; 0 = newest sample only)"),
				mcp.DefaultNumber(10),
			),
		),
		m.handleGetSNR,
	)
}

func (m *MCPServer) handleGetPropagationPredictions(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if m.multiDecoder == nil || m.multiDecoder.spotsLogger == nil {
		return mcp.NewToolResultError("Decoder spot logging, which predictions learn from, is not enabled on this receiver"), nil
	}
	if m.spaceWeatherMonitor == nil {
		return mcp.NewToolResultError("Space weather monitoring, which predictions need, is not enabled on this receiver"), nil
	}
	hours := mcpHoursParam(request, 24, 168)
	if !m.allowToolCall(ctx, "get_propagation_predictions") {
		return mcpRateLimited("get_propagation_predictions"), nil
	}
	predictions, err := GetBandPredictions(m.multiDecoder.spotsLogger, m.spaceWeatherMonitor,
		request.GetString("country", ""), strings.ToUpper(request.GetString("continent", "")),
		strings.ToUpper(request.GetString("mode", "")), hours)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to get predictions: %v", err)), nil
	}
	return mcpJSON(predictions)
}

// callPublicHandler runs one of the receiver's public HTTP handlers in-process
// and returns its status and body. Used where the HTTP handler holds the whole
// computation inline, so the tool gives exactly the answer the web page does
// without a second copy of the logic. The request carries the MCP caller's IP,
// so the handler's IP ban and rate limit apply to that client.
func callPublicHandler(ctx context.Context, handler http.HandlerFunc, path string, query url.Values) (int, []byte) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, path+"?"+query.Encode(), nil)
	if err != nil {
		return http.StatusInternalServerError, []byte(fmt.Sprintf(`{"error":%q}`, err.Error()))
	}
	ip := mcpClientIP(ctx)
	if ip == "" {
		ip = "127.0.0.1"
	}
	req.RemoteAddr = net.JoinHostPort(ip, "0")
	rec := httptest.NewRecorder()
	handler(rec, req)
	return rec.Code, rec.Body.Bytes()
}

// handlerError pulls the message out of an HTTP handler's JSON error body.
func handlerError(status int, body []byte) string {
	var e struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &e) == nil {
		if e.Error != "" {
			return e.Error
		}
		if e.Message != "" {
			return e.Message
		}
	}
	return fmt.Sprintf("request failed (HTTP %d)", status)
}

func (m *MCPServer) handleGetSSBPredictions(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if m.multiDecoder == nil || m.multiDecoder.spotsLogger == nil {
		return mcp.NewToolResultError("Decoder spot logging, which these predictions read WSPR spots from, is not enabled on this receiver"), nil
	}

	q := url.Values{}
	q.Set("summary", "true")
	q.Set("minutes", strconv.Itoa(int(request.GetFloat("minutes", 60))))
	q.Set("phone_power_w", strconv.Itoa(int(request.GetFloat("power_w", 100))))
	q.Set("min_ssb_snr", strconv.Itoa(int(request.GetFloat("min_ssb_snr", 10))))
	q.Set("by", request.GetString("group_by", "country"))
	if band := request.GetString("band", ""); band != "" {
		q.Set("band", band)
	}

	// The handler rate-limits unconditionally, so it always needs a limiter.
	limiter := m.RateLimiter
	if limiter == nil {
		limiter = NewFFTRateLimiter()
	}
	status, body := callPublicHandler(ctx, func(w http.ResponseWriter, r *http.Request) {
		handleWSPRPhonePrediction(w, r, m.multiDecoder, m.ipBanManager, limiter)
	}, "/api/wspr/phone-prediction", q)
	if status != http.StatusOK {
		return mcp.NewToolResultError(handlerError(status, body)), nil
	}
	return mcp.NewToolResultText(string(body)), nil
}

// Sun phase thresholds, in degrees of solar altitude.
const (
	// mcpGreylineDeg bounds the greyline: the band either side of the
	// terminator where D-layer absorption has faded on the dark side but the
	// F layer is still lit, from civil twilight to just after sunrise.
	mcpGreylineDeg = 6.0
	// mcpNightDeg is where nautical twilight ends.
	mcpNightDeg = -12.0
)

// sunPhase names the light at a solar altitude: "day" above the horizon,
// "twilight" down to nautical dusk, then "night".
func sunPhase(altDeg float64) string {
	switch {
	case altDeg > 0:
		return "day"
	case altDeg > mcpNightDeg:
		return "twilight"
	default:
		return "night"
	}
}

// sunTimeOrNil formats t, or returns nil when the sun never reaches that
// altitude that day (polar day or night), which suncalc reports as a time far
// from the date asked about or not a time at all.
func sunTimeOrNil(t, day time.Time) *string {
	if t.IsZero() || t.Year() < 1900 {
		return nil
	}
	if d := t.Sub(day); d < -36*time.Hour || d > 36*time.Hour {
		return nil
	}
	s := t.UTC().Format(time.RFC3339)
	return &s
}

// mcpSunReport is the sun at one location.
type mcpSunReport struct {
	Latitude       float64            `json:"latitude"`
	Longitude      float64            `json:"longitude"`
	Locator        string             `json:"locator"`
	SunAltitudeDeg float64            `json:"sun_altitude_deg"`
	SunAzimuthDeg  float64            `json:"sun_azimuth_deg"`
	Phase          string             `json:"phase"`
	OnGreyline     bool               `json:"on_greyline"`
	Times          map[string]*string `json:"times_utc"`
}

func sunReport(lat, lon float64, now, day time.Time, heightM float64) mcpSunReport {
	pos := GetPosition(now, lat, lon)
	altDeg := pos.Altitude / rad
	// suncalc measures azimuth from south, westwards; turn it into a compass
	// bearing from north.
	azDeg := math.Mod(pos.Azimuth/rad+180, 360)
	if azDeg < 0 {
		azDeg += 360
	}
	times := GetTimes(day.Add(12*time.Hour), lat, lon, heightM)
	return mcpSunReport{
		Latitude:       roundTo(lat, 4),
		Longitude:      roundTo(lon, 4),
		Locator:        latLonToGridSquare(lat, lon),
		SunAltitudeDeg: roundTo(altDeg, 1),
		SunAzimuthDeg:  roundTo(azDeg, 1),
		Phase:          sunPhase(altDeg),
		OnGreyline:     math.Abs(altDeg) <= mcpGreylineDeg,
		Times: map[string]*string{
			"dawn":       sunTimeOrNil(times.Dawn, day),
			"sunrise":    sunTimeOrNil(times.Sunrise, day),
			"solar_noon": sunTimeOrNil(times.SolarNoon, day),
			"sunset":     sunTimeOrNil(times.Sunset, day),
			"dusk":       sunTimeOrNil(times.Dusk, day),
		},
	}
}

func (m *MCPServer) handleGetSunTimes(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if m.config == nil || (m.config.Admin.GPS.Lat == 0 && m.config.Admin.GPS.Lon == 0) {
		return mcp.NewToolResultError("The receiver's location is not configured"), nil
	}

	now := time.Now().UTC()
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	if ds := request.GetString("date", ""); ds != "" {
		d, err := time.Parse("2006-01-02", ds)
		if err != nil {
			return mcp.NewToolResultError("date must be in the form YYYY-MM-DD"), nil
		}
		day = d
	}

	rxLat, rxLon := m.config.Admin.GPS.Lat, m.config.Admin.GPS.Lon
	rx := sunReport(rxLat, rxLon, now, day, float64(m.config.Admin.ASL))
	result := map[string]interface{}{
		"now_utc":  now.Format(time.RFC3339),
		"date":     day.Format("2006-01-02"),
		"receiver": rx,
		"definitions": map[string]string{
			"phase":       "day: sun above the horizon; twilight: down to 12 degrees below it; night: lower",
			"on_greyline": fmt.Sprintf("sun within %.0f degrees of the horizon", mcpGreylineDeg),
		},
	}

	// The far end, if one was given.
	args := request.GetArguments()
	_, hasLat := args["latitude"]
	_, hasLon := args["longitude"]
	locator := strings.TrimSpace(request.GetString("locator", ""))
	var farLat, farLon float64
	haveFar := false
	switch {
	case locator != "":
		lat, lon, err := MaidenheadToLatLon(locator)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Invalid Maidenhead locator %q", locator)), nil
		}
		farLat, farLon, haveFar = lat, lon, true
	case hasLat || hasLon:
		if !hasLat || !hasLon {
			return mcp.NewToolResultError("Give both latitude and longitude"), nil
		}
		farLat, farLon = request.GetFloat("latitude", 0), request.GetFloat("longitude", 0)
		if farLat < -90 || farLat > 90 || farLon < -180 || farLon > 180 {
			return mcp.NewToolResultError("latitude must be -90 to 90 and longitude -180 to 180"), nil
		}
		haveFar = true
	}
	if haveFar {
		far := sunReport(farLat, farLon, now, day, 0)
		dist, bearing := CalculateDistanceAndBearing(rxLat, rxLon, farLat, farLon)
		result["far_end"] = far
		result["path"] = map[string]interface{}{
			"distance_km":         math.Round(dist),
			"bearing_deg":         roundTo(bearing, 1),
			"both_on_greyline":    rx.OnGreyline && far.OnGreyline,
			"daylight_both_ends":  rx.Phase == "day" && far.Phase == "day",
			"darkness_both_ends":  rx.Phase != "day" && far.Phase != "day",
			"daylight_on_one_end": (rx.Phase == "day") != (far.Phase == "day"),
		}
	}
	return mcpJSON(result)
}

func (m *MCPServer) handleGetSNR(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	nfm := m.noiseFloorMonitor
	if nfm == nil {
		return mcp.NewToolResultError("Noise floor monitoring, which SNR is measured from, is not enabled on this receiver"), nil
	}

	avgSec := int(request.GetFloat("avg_sec", 10))
	if avgSec < 0 || avgSec > snrMaxAvgSec {
		return mcp.NewToolResultError(fmt.Sprintf("avg_sec must be from 0 to %d", snrMaxAvgSec)), nil
	}

	args := request.GetArguments()
	_, hasLo := args["lo_khz"]
	_, hasHi := args["hi_khz"]
	rangeName := strings.TrimSpace(request.GetString("range", ""))

	switch {
	case rangeName != "" && (hasLo || hasHi):
		return mcp.NewToolResultError("Give either range or lo_khz/hi_khz, not both"), nil

	case rangeName != "":
		for _, p := range nfm.snrPresets() {
			if strings.EqualFold(p.Name, rangeName) {
				st, _, err := nfm.snrMeasure(p.Name, p.LoHz, p.HiHz, avgSec)
				if err != nil {
					return mcp.NewToolResultError(fmt.Sprintf("Cannot measure %s: %v", p.Name, err)), nil
				}
				return mcpJSON(st)
			}
		}
		return mcp.NewToolResultError(fmt.Sprintf("Unknown range %q", truncateForError(rangeName))), nil

	case hasLo || hasHi:
		if !hasLo || !hasHi {
			return mcp.NewToolResultError("Give both lo_khz and hi_khz"), nil
		}
		lo, errLo := parseKHz(strconv.FormatFloat(request.GetFloat("lo_khz", -1), 'f', -1, 64))
		hi, errHi := parseKHz(strconv.FormatFloat(request.GetFloat("hi_khz", -1), 'f', -1, 64))
		if errLo != nil || errHi != nil {
			return mcp.NewToolResultError(fmt.Sprintf("lo_khz and hi_khz must be frequencies in kHz from 0 to %d", snrMaxKHz)), nil
		}
		if hi <= lo {
			return mcp.NewToolResultError("hi_khz must be above lo_khz"), nil
		}
		st, _, err := nfm.snrMeasure("", lo, hi, avgSec)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Cannot measure that range: %v", err)), nil
		}
		return mcpJSON(st)
	}

	// Nothing named: every range the receiver can measure.
	readings := make([]SNRStats, 0)
	unavailable := map[string]string{}
	for _, r := range nfm.snrRanges() {
		var preset snrPreset
		for _, p := range nfm.snrPresets() {
			if p.Name == r.Name {
				preset = p
				break
			}
		}
		st, _, err := nfm.snrMeasure(preset.Name, preset.LoHz, preset.HiHz, avgSec)
		if err != nil {
			unavailable[r.Name] = err.Error()
			continue
		}
		readings = append(readings, st)
	}
	out := map[string]interface{}{
		"avg_sec":  avgSec,
		"readings": readings,
	}
	if len(unavailable) > 0 {
		out["unavailable"] = unavailable
	}
	return mcpJSON(out)
}
