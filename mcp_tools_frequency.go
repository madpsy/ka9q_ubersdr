package main

import (
	"context"
	"math"
	"sort"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
)

// whats_on_frequency: everything the receiver knows about one frequency, from
// the broadcast schedules, the operator's bookmarks, the DX cluster and the
// listeners tuned there now.

const (
	mcpFreqDefaultToleranceKHz = 5.0
	mcpFreqMaxToleranceKHz     = 50.0
	// mcpFreqDXSpotWindow is how far back DX cluster spots count as describing
	// what is on a frequency now; it matches the voice-activity enrichment TTL.
	mcpFreqDXSpotWindow = 30 * time.Minute
	// mcpFreqMaxSchedule caps the full-day EiBi schedule, which on a busy
	// broadcast channel can run to dozens of entries.
	mcpFreqMaxSchedule = 50
)

func (m *MCPServer) registerFrequencyTools() {
	m.mcpServer.AddTool(
		mcp.NewTool("whats_on_frequency",
			mcpReadOnlyTool,
			mcp.WithDescription("Find out what is on a frequency: shortwave broadcasts scheduled now (EiBi database) with station, language and target area; DRM digital broadcasts scheduled now; the operator's bookmarks; DX cluster spots from the last 30 minutes; and how many listeners on this receiver are tuned there, with their modes and client protocols. Use this to identify a signal or to explain why listeners are on a frequency."),
			mcp.WithNumber("frequency_khz",
				mcp.Min(0.001),
				mcp.Max(10000000),
				mcp.Required(),
				mcp.Description("Frequency in kHz, e.g. 9410 or 14205.5"),
			),
			mcp.WithNumber("tolerance_khz",
				mcp.Min(0),
				mcp.Max(mcpFreqMaxToleranceKHz),
				mcp.Description("How far either side counts as the same frequency for listeners, spots, bookmarks and DRM, in kHz (default: 5, max: 50). EiBi broadcasts always match within 1 kHz."),
				mcp.DefaultNumber(mcpFreqDefaultToleranceKHz),
			),
			mcp.WithBoolean("include_schedule",
				mcp.Description("Also list every EiBi broadcast on this frequency across the day, not only those on air now (default: false)"),
				mcp.DefaultBool(false),
			),
		),
		m.handleWhatsOnFrequency,
	)
}

// mcpBroadcast is an EiBi schedule entry as the tools return it.
type mcpBroadcast struct {
	FrequencyKHz float64 `json:"frequency_khz"`
	Station      string  `json:"station"`
	Schedule     string  `json:"schedule"` // e.g. "0600–0800 UTC Mon–Fri"
	Language     string  `json:"language,omitempty"`
	Target       string  `json:"target,omitempty"`
	Country      string  `json:"transmitter_country,omitempty"` // ITU code
	Remarks      string  `json:"remarks,omitempty"`
	OnAirNow     bool    `json:"on_air_now"`
}

func toMCPBroadcast(e EiBiEntry, onAir bool) mcpBroadcast {
	return mcpBroadcast{
		FrequencyKHz: e.FreqKHz,
		Station:      e.Station,
		Schedule:     EiBiBookmarkComment(e),
		Language:     e.Language,
		Target:       e.Target,
		Country:      e.ITU,
		Remarks:      e.Remarks,
		OnAirNow:     onAir,
	}
}

// mcpFreqListeners summarises the listeners tuned near a frequency. It carries
// counts only: no locations or identities.
type mcpFreqListeners struct {
	Count      int            `json:"count"`
	ByMode     map[string]int `json:"by_mode"`
	ByProtocol map[string]int `json:"by_protocol"`
}

// listenersNear counts the audio sessions tuned within tolHz of freqHz, the
// same set get_active_sessions reports: real listeners, one per VFO, excluding
// spectrum-only and limit-bypassed sessions.
func (m *MCPServer) listenersNear(freqHz, tolHz float64) mcpFreqListeners {
	out := mcpFreqListeners{ByMode: map[string]int{}, ByProtocol: map[string]int{}}
	if m.sessions == nil {
		return out
	}
	m.sessions.mu.RLock()
	defer m.sessions.mu.RUnlock()
	for _, session := range m.sessions.sessions {
		if session.IsSpectrum || session.ClientIP == "" {
			continue
		}
		if m.sessions.config != nil && m.sessions.config.Server.IsIPTimeoutBypassed(session.ClientIP) {
			continue
		}
		session.mu.RLock()
		freq, mode, uid := session.Frequency, session.Mode, session.UserSessionID
		session.mu.RUnlock()
		if math.Abs(float64(freq)-freqHz) > tolHz {
			continue
		}
		out.Count++
		out.ByMode[mode]++
		out.ByProtocol[protocolFromUserSessionID(uid)]++
	}
	return out
}

func (m *MCPServer) handleWhatsOnFrequency(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	freqKHz, err := request.RequireFloat("frequency_khz")
	if err != nil || freqKHz <= 0 || math.IsNaN(freqKHz) || freqKHz > 1e7 {
		return mcp.NewToolResultError("frequency_khz must be a positive frequency in kHz"), nil
	}
	tolKHz := request.GetFloat("tolerance_khz", mcpFreqDefaultToleranceKHz)
	if tolKHz < 0 || math.IsNaN(tolKHz) {
		tolKHz = mcpFreqDefaultToleranceKHz
	}
	if tolKHz > mcpFreqMaxToleranceKHz {
		tolKHz = mcpFreqMaxToleranceKHz
	}
	freqHz, tolHz := freqKHz*1e3, tolKHz*1e3
	now := time.Now().UTC()

	result := map[string]interface{}{
		"frequency_khz": freqKHz,
		"tolerance_khz": tolKHz,
		"band":          frequencyToBand(freqHz),
		"time_utc":      now.Format(time.RFC3339),
	}

	// Shortwave broadcasts (EiBi). The schedule's day qualifiers ("Mo-Fr",
	// "irr", dates) are reported, not applied: "on air now" means the time
	// window matches today.
	if m.EiBi != nil && m.EiBi.IsLoaded() {
		active := m.EiBi.LookupFrequency(freqHz, now)
		broadcasts := make([]mcpBroadcast, 0, len(active))
		for _, e := range active {
			broadcasts = append(broadcasts, toMCPBroadcast(e, true))
		}
		result["broadcasts_now"] = broadcasts

		if request.GetBool("include_schedule", false) {
			onAir := map[EiBiEntry]bool{}
			for _, e := range active {
				onAir[e] = true
			}
			all := m.EiBi.LookupFrequencyAll(freqHz)
			sort.SliceStable(all, func(i, j int) bool { return all[i].StartUTC < all[j].StartUTC })
			schedule := make([]mcpBroadcast, 0, len(all))
			for _, e := range all {
				if len(schedule) == mcpFreqMaxSchedule {
					break
				}
				schedule = append(schedule, toMCPBroadcast(e, onAir[e]))
			}
			result["broadcast_schedule"] = schedule
			result["broadcast_schedule_truncated"] = len(all) > mcpFreqMaxSchedule
		}
	} else {
		result["broadcasts_note"] = "the EiBi broadcast schedule is not enabled or not yet loaded on this receiver"
	}

	// DRM digital broadcasts on air now.
	if m.DRM != nil && m.DRM.IsLoaded() {
		var drm []DRMScheduleEntry
		for _, e := range m.DRM.GetActiveEntries(now, 0, 0) {
			if math.Abs(float64(e.FreqHz)-freqHz) <= math.Max(tolHz, 1e3) {
				drm = append(drm, e)
			}
		}
		if drm == nil {
			drm = []DRMScheduleEntry{}
		}
		result["drm_now"] = drm
	}

	// Operator bookmarks.
	if m.config != nil {
		bookmarks := []Bookmark{}
		for _, b := range m.config.Bookmarks {
			if math.Abs(float64(b.Frequency)-freqHz) <= tolHz {
				bookmarks = append(bookmarks, b)
			}
		}
		result["bookmarks"] = bookmarks
	}

	// DX cluster spots, newest first.
	if m.DXCluster != nil && m.config != nil && m.config.DXCluster.Enabled {
		near := []mcpDXSpot{}
		for _, s := range filterDXSpots(m.DXCluster.GetBufferedSpots(), now.Add(-mcpFreqDXSpotWindow), "", "", "") {
			if math.Abs(s.FrequencyHz-freqHz) <= tolHz {
				near = append(near, s)
			}
		}
		result["dx_spots"] = near
	}

	result["listeners"] = m.listenersNear(freqHz, tolHz)
	return mcpJSON(result)
}
