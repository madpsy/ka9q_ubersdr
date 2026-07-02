package main

import (
	"context"
	"log"
	"sort"
	"strings"
	"time"
)

// notification_digital_rank.go — rank-change notifier for PSK Reporter, WSPR Live, and RBN.
//
// StartDigitalRankNotifier starts an always-running background goroutine that
// polls the three external leaderboard caches every pollInterval and fires a
// DigitalRankEvent whenever our station's rank changes in any of them.
//
// The goroutine checks for digital_rank rules on every tick, so adding or
// enabling a rule via the admin UI takes effect within one poll interval
// without requiring a server restart.
//
// Startup behaviour: on the first observation of each (component, dimension)
// pair the current rank is stored as the baseline. If a rule is active at that
// moment, a "current rank" event is fired immediately (OldRank=0) so the user
// gets an instant status notification on startup or when they first add a rule.
// If no rule is active yet, the baseline is stored silently so that when a rule
// is later added via the admin UI, only genuine rank changes trigger events.
//
// Component / dimension mapping:
//
//	PSK  → "reports"    (reportResult["All"]  — spot count, 24 h)
//	PSK  → "countries"  (countryResult["All"] — distinct countries, 24 h)
//	WSPR → "rolling_24h", "yesterday", "today"  (unique spots per window)
//	RBN  → "spots"      (cumulative spot count from statistics.csv)
//
// receiverCallsign is used for PSK and WSPR lookups (config.Decoder.ReceiverCallsign).
// cwSkimmerCallsign is used for RBN lookups (cwskimmerConfig.Callsign).

// rankState holds the last-known rank and value for one (component, dimension) key.
type rankState struct {
	rank  int
	value int
}

// StartDigitalRankNotifier starts the background rank-change monitor.
// Any of psk, wspr, rbn may be nil — that component is simply skipped.
// receiverCallsign is used for PSK and WSPR; cwSkimmerCallsign is used for RBN.
func StartDigitalRankNotifier(
	ctx context.Context,
	nm *NotificationManager,
	psk *PSKRankFetcher,
	wspr *WSPRRankFetcher,
	rbn *RBNDataStore,
	receiverCallsign string,
	cwSkimmerCallsign string,
	pollInterval time.Duration,
) {
	if nm == nil {
		return
	}

	go func() {
		// last holds the most-recently-observed rank/value per "component:dimension" key.
		// A key is absent until the first observation (baseline); present thereafter.
		//
		// IMPORTANT: rank state is always updated on every tick (regardless of whether
		// any rules are currently enabled) so that when a rule is first added via the
		// admin UI, the baseline is already established and no spurious "rank changed"
		// events fire on the first matching tick.
		last := make(map[string]*rankState)

		ticker := time.NewTicker(pollInterval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				now := time.Now()

				// Always update rank state so the baseline is current when a rule
				// is first added. fireRankChange only calls nm.Publish when a rule
				// exists AND the rank has changed; the hasRule check inside it
				// prevents spurious notifications.
				notifCfg := nm.Config()
				hasRule := notifCfg.Enabled && hasDigitalRankRule(notifCfg)

				if psk != nil && receiverCallsign != "" {
					checkPSKRanks(nm, psk, receiverCallsign, last, now, hasRule)
				}
				if wspr != nil && receiverCallsign != "" {
					checkWSPRRanks(nm, wspr, receiverCallsign, last, now, hasRule)
				}
				if rbn != nil && cwSkimmerCallsign != "" {
					checkRBNRank(nm, rbn, cwSkimmerCallsign, last, now, hasRule)
				}
			}
		}
	}()

	log.Printf("[DigitalRankNotifier] Started (poll interval %s)", pollInterval)
}

// hasDigitalRankRule reports whether cfg has at least one enabled digital_rank rule.
func hasDigitalRankRule(cfg *NotificationsConfig) bool {
	for _, r := range cfg.Rules {
		if r.IsEnabled() && r.Event == EventTypeDigitalRank {
			return true
		}
	}
	return false
}

// ─── PSK ─────────────────────────────────────────────────────────────────────

// checkPSKRanks checks the "All" band rank in both reportResult (spots) and
// countryResult (countries) from the PSKReporter leaderboard cache.
// hasRule controls whether a rank change triggers nm.Publish; state is always updated.
func checkPSKRanks(
	nm *NotificationManager,
	psk *PSKRankFetcher,
	callsign string,
	last map[string]*rankState,
	now time.Time,
	hasRule bool,
) {
	cached := psk.Cached()
	if cached == nil || cached.Error != "" {
		return
	}

	dims := []struct {
		key     string
		src     PSKMonitorsByBand
		dimName string
	}{
		{"psk:reports", cached.ReportResult, "reports"},
		{"psk:countries", cached.CountryResult, "countries"},
	}

	upper := strings.ToUpper(callsign)

	for _, d := range dims {
		allEntries, ok := d.src["All"]
		if !ok {
			continue
		}

		newRank := 0
		newValue := 0
		for i, e := range allEntries {
			if strings.ToUpper(e.Callsign) == upper {
				newRank = i + 1
				newValue = e.Day // 24 h count
				break
			}
		}

		fireRankChange(nm, d.key, "psk", d.dimName, upper, newRank, newValue, 0, last, now, hasRule)
	}
}

// ─── WSPR ─────────────────────────────────────────────────────────────────────

// checkWSPRRanks checks all three time windows from the WSPR Live cache.
// hasRule controls whether a rank change triggers nm.Publish; state is always updated.
func checkWSPRRanks(
	nm *NotificationManager,
	wspr *WSPRRankFetcher,
	callsign string,
	last map[string]*rankState,
	now time.Time,
	hasRule bool,
) {
	cached := wspr.Cached()
	if cached == nil {
		return
	}

	windows := []struct {
		key     string
		win     WSPRRankWindow
		dimName string
	}{
		{"wspr:rolling_24h", cached.Rolling24h, "rolling_24h"},
		{"wspr:yesterday", cached.Yesterday, "yesterday"},
		{"wspr:today", cached.Today, "today"},
	}

	upper := strings.ToUpper(callsign)

	for _, w := range windows {
		newRank := 0
		newValue := 0
		for i, row := range w.win.Data {
			if strings.ToUpper(row.RxSign) == upper {
				newRank = i + 1
				newValue = int(row.Unique)
				break
			}
		}

		fireRankChange(nm, w.key, "wspr", w.dimName, upper, newRank, newValue, 0, last, now, hasRule)
	}
}

// ─── RBN ──────────────────────────────────────────────────────────────────────

// checkRBNRank computes the station's rank among all RBN skimmers by spot count.
// hasRule controls whether a rank change triggers nm.Publish; state is always updated.
func checkRBNRank(
	nm *NotificationManager,
	rbn *RBNDataStore,
	callsign string,
	last map[string]*rankState,
	now time.Time,
	hasRule bool,
) {
	rbn.mu.RLock()
	defer rbn.mu.RUnlock()

	if rbn.statsUpdatedAt == nil {
		return // no data fetched yet
	}

	type entry struct {
		cs    string
		count int
	}
	all := make([]entry, 0, len(rbn.statsData))
	for cs, e := range rbn.statsData {
		all = append(all, entry{cs, e.SpotCount})
	}
	// Sort descending by spot count; stable by callsign for ties.
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].count != all[j].count {
			return all[i].count > all[j].count
		}
		return all[i].cs < all[j].cs
	})

	upper := strings.ToUpper(callsign)
	newRank := 0
	newValue := 0
	for i, e := range all {
		if strings.ToUpper(e.cs) == upper {
			newRank = i + 1
			newValue = e.count
			break
		}
	}

	fireRankChange(nm, "rbn:spots", "rbn", "spots", upper, newRank, newValue, len(all), last, now, hasRule)
}

// ─── Common helper ────────────────────────────────────────────────────────────

// fireRankChange compares newRank against the last-known state for key and
// publishes a DigitalRankEvent if the rank has changed AND hasRule is true.
// State is always updated regardless of hasRule so that the baseline is current
// when a rule is first added via the admin UI — preventing a spurious flood of
// "rank changed" events on the first matching tick.
func fireRankChange(
	nm *NotificationManager,
	key string,
	component string,
	dimension string,
	callsign string,
	newRank int,
	newValue int,
	totalRanked int,
	last map[string]*rankState,
	now time.Time,
	hasRule bool,
) {
	st, seen := last[key]
	if !seen {
		// First observation — store baseline and fire if a rule is active and
		// we have a real rank. This gives the user an immediate "current rank"
		// notification when they first set up the rule, rather than waiting for
		// a rank change that might not happen for hours or days.
		last[key] = &rankState{rank: newRank, value: newValue}
		if hasRule && newRank > 0 {
			nm.Publish(DigitalRankEvent{
				Component:   component,
				Dimension:   dimension,
				Callsign:    callsign,
				OldRank:     0, // 0 = first observation / no previous rank
				NewRank:     newRank,
				OldValue:    0,
				NewValue:    newValue,
				TotalRanked: totalRanked,
				Time:        now,
			})
		}
		return
	}

	if newRank == st.rank {
		// No change — update value in case it drifted (rank same, count different).
		st.value = newValue
		return
	}

	// Always update stored state so the next tick compares against the latest rank,
	// even if we don't publish (no rule active).
	oldRank := st.rank
	oldValue := st.value
	st.rank = newRank
	st.value = newValue

	if !hasRule {
		// No active rule — state updated above; nothing to publish.
		return
	}

	nm.Publish(DigitalRankEvent{
		Component:   component,
		Dimension:   dimension,
		Callsign:    callsign,
		OldRank:     oldRank,
		NewRank:     newRank,
		OldValue:    oldValue,
		NewValue:    newValue,
		TotalRanked: totalRanked,
		Time:        now,
	})
}
