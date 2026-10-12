package main

// skimmer_feed_health.go — the skimmer feed's health, for the admin Monitor
// tab (GET /admin/skimmer-feed-health), /admin/monitor-health, the Telegram
// /monitor command and the system health notifications.  All of them use
// buildSkimmerFeedHealthPayload, so they agree.
//
// Two things are judged: the feed itself (connected, not stalled), and the
// skimmer's own health as its feed reports it every 10 s (receivers, its
// decoders, and its PSK Reporter, wsprnet and RBN uploads).

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"
)

// skimmerFeedDownGrace: a feed not connected for less than this is mid-
// reconnect, not down, and raises no issue (the Monitor tab polls every
// 10 s; a skimmer restart takes a few).
const skimmerFeedDownGrace = 30 * time.Second

// buildSkimmerFeedHealthPayload is the feed's health as the /admin/*-health
// endpoints give theirs: enabled, healthy, issues, and a status ("ok",
// "warning", "critical"), with the client's state and the skimmer's latest
// health message (its "skimmer" object, as the skimmer sent it).
func buildSkimmerFeedHealthPayload(enabled bool, feed *SkimmerFeedClient) map[string]interface{} {
	out := map[string]interface{}{
		"enabled": enabled,
		"healthy": true,
		"status":  "ok",
		"issues":  []string{},
	}
	if !enabled {
		return out
	}
	if feed == nil {
		out["healthy"] = false
		out["status"] = "critical"
		out["issues"] = []string{"Skimmer feed client not started"}
		return out
	}

	st := feed.Status()
	now := time.Now()
	var critical, warnings []string

	out["url"] = st.URL
	out["connected"] = st.Connected
	out["stalled"] = st.Stalled
	out["reconnects"] = st.Reconnects
	out["last_error"] = st.LastError
	out["last_event_id"] = st.LastEventID
	out["spots"] = st.Spots
	out["held"] = st.Held
	out["skipped"] = st.Skipped
	out["gaps"] = st.Gaps
	since := now.Sub(st.ChangedAt)
	out["seconds_in_state"] = int(since.Seconds())
	out["time_in_state"] = formatDuration(since)
	if !st.LastSpot.IsZero() {
		out["last_spot"] = st.LastSpot.Format(time.RFC3339)
		out["seconds_since_spot"] = int(now.Sub(st.LastSpot).Seconds())
		out["time_since_spot"] = formatDuration(now.Sub(st.LastSpot))
	}
	if !st.HealthAt.IsZero() {
		out["health_at"] = st.HealthAt.Format(time.RFC3339)
		out["seconds_since_health"] = int(now.Sub(st.HealthAt).Seconds())
	}

	switch {
	case st.Stalled:
		critical = append(critical, "The skimmer is stuck: its feed stays open but its health messages have stopped")
	case !st.Connected && since >= skimmerFeedDownGrace:
		msg := fmt.Sprintf("Not connected to the skimmer feed (%s)", formatDuration(since))
		if st.LastError != "" {
			msg += ": " + st.LastError
		}
		critical = append(critical, msg)
	}

	if h := st.Health; h != nil {
		var skimmer map[string]interface{}
		if len(h.Raw) > 0 && json.Unmarshal(h.Raw, &skimmer) == nil {
			out["skimmer"] = skimmer
		}
		// The skimmer's own problems, unless the feed is down (then they are
		// stale: the last word before it went).
		if st.Connected && !st.Stalled {
			for _, p := range h.Problems {
				msg := "Skimmer " + p.Part + ": " + p.Text
				if p.Level == "error" {
					critical = append(critical, msg)
				} else {
					warnings = append(warnings, msg)
				}
			}
			if h.Status == "error" && len(h.Problems) == 0 {
				critical = append(critical, "The skimmer reports an error")
			}
		}
	}

	issues := append(critical, warnings...)
	if issues == nil {
		issues = []string{}
	}
	out["issues"] = issues
	switch {
	case len(critical) > 0:
		out["status"] = "critical"
		out["healthy"] = false
	case len(warnings) > 0:
		out["status"] = "warning"
		out["healthy"] = false
	}
	return out
}

// skimmerFeedMonitorItem is the feed as a /admin/monitor-health and Telegram
// /monitor item, or false when the feed is off.
func skimmerFeedMonitorItem(enabled bool, feed *SkimmerFeedClient) (MonitorHealthItem, bool) {
	if !enabled {
		return MonitorHealthItem{}, false
	}
	p := buildSkimmerFeedHealthPayload(enabled, feed)
	status, _ := p["status"].(string)
	issues, _ := p["issues"].([]string)
	return MonitorHealthItem{Name: "Skimmer Feed", Status: status, Issues: issues}, true
}

// HandleSkimmerFeedHealth serves GET /admin/skimmer-feed-health: 503 when
// unhealthy, as the other /admin/*-health endpoints.
func (ah *AdminHandler) HandleSkimmerFeedHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	p := buildSkimmerFeedHealthPayload(ah.config.SkimmerFeed.Enabled, ah.skimmerFeed)
	if healthy, _ := p["healthy"].(bool); !healthy {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	if err := json.NewEncoder(w).Encode(p); err != nil {
		log.Printf("Error encoding skimmer feed health: %v", err)
	}
}
