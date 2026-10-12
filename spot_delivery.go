package main

// spot_delivery.go — when the spot stores and their delivery run.
//
// Digital spots (FT8, FT4, FT2, WSPR, JS8) and CW spots (CW, RTTY, JTTY) are
// stored, counted and broadcast by the MultiDecoder and the CWSkimmerClient.
// Those used to exist only with their own source enabled: decoder.yaml's
// decoders, cwskimmer.yaml's telnet connection.  The skimmer's feed
// (skimmer_feed in config.yaml) is a third source, meant for receivers with
// both of those off, so delivery runs whenever any source of its kind does:
//
//	digital: decoder.enabled  or skimmer_feed.enabled
//	CW:      cwskimmer.enabled or skimmer_feed.enabled
//
// With only the feed, the MultiDecoder runs ingest-only (no bands, no
// reporters) and the CWSkimmerClient has no telnet connection; their store
// settings come from decoder.yaml and cwskimmer.yaml when present (enabled
// or not), else from the defaults those files ship with.

import (
	"log"
	"strings"
)

// DigitalSpotsEnabled reports whether this receiver has digital spots: from
// its own decoders, or the skimmer's feed.
func (c *Config) DigitalSpotsEnabled() bool {
	return c.Decoder.Enabled || c.SkimmerFeed.Enabled
}

// CWSpotsEnabled reports whether this receiver has CW spots: from a CW
// Skimmer server (cwskimmer.yaml), or the skimmer's feed.
func (c *Config) CWSpotsEnabled(cw *CWSkimmerConfig) bool {
	return (cw != nil && cw.Enabled) || c.SkimmerFeed.Enabled
}

// resolveConfigPath makes a relative path relative to the config directory,
// or gives def (itself relative to it) when the path is empty.
func resolveConfigPath(configDir, path, def string) string {
	if path == "" {
		return configDir + "/" + def
	}
	if !strings.HasPrefix(path, "/") {
		return configDir + "/" + path
	}
	return path
}

// prepareDecoderStoreConfig readies the decoder's store settings when digital
// spots are delivered: its directories made relative to the config directory
// and spots_log_locators_only defaulted to true.  decoderYAMLLoaded says
// whether decoder.yaml was read; without one and with only the feed, the
// stores get decoder.yaml.example's settings (spots and metrics logged,
// spots kept 90 days), since otherwise the feed's spots would go nowhere.
func prepareDecoderStoreConfig(cfg *Config, configDir string, decoderYAMLLoaded bool) {
	if !cfg.DigitalSpotsEnabled() {
		return
	}
	d := &cfg.Decoder
	if !d.Enabled && !decoderYAMLLoaded {
		d.SpotsLogEnabled = true
		d.SpotsLogMaxAgeDays = 90
		d.MetricsLogEnabled = true
		d.MetricsLogIntervalSecs = 300
	}

	// The WAV and work directory: the local decoders' only.
	if d.Enabled {
		d.DataDir = resolveConfigPath(configDir, d.DataDir, "decoder_data")
	}
	if d.SpotsLogEnabled {
		d.SpotsLogDataDir = resolveConfigPath(configDir, d.SpotsLogDataDir, "decoder_spots")
		// Default to true (only log/show spots with valid locators). Users
		// must explicitly set it false to log/see all spots; *bool so "not
		// set" is distinguished from "explicitly false".
		if d.SpotsLogLocatorsOnly == nil {
			t := true
			d.SpotsLogLocatorsOnly = &t
		}
	}
	if d.MetricsLogEnabled {
		d.MetricsLogDataDir = resolveConfigPath(configDir, d.MetricsLogDataDir, "decoder_metrics")
		d.MetricsSummaryDataDir = resolveConfigPath(configDir, d.MetricsSummaryDataDir, "decoder_summaries")
	}
}

// prepareCWSkimmerStoreConfig readies the CW store settings when CW spots are
// delivered: directories made relative to the config directory.  loaded says
// whether cwskimmer.yaml was read; without one and with the feed on, the
// stores get cwskimmer.yaml.example's settings (spots and metrics logged) and
// the file's defaults.  Without the feed a missing file is left as it was.
func prepareCWSkimmerStoreConfig(cw *CWSkimmerConfig, feedEnabled bool, configDir string, loaded bool) {
	if !loaded && feedEnabled {
		applyCWSkimmerDefaults(cw)
		cw.SpotsLogEnabled = true
		cw.MetricsLogEnabled = true
	}
	if !cw.Enabled && !feedEnabled {
		return
	}
	if cw.SpotsLogEnabled {
		cw.SpotsLogDataDir = resolveConfigPath(configDir, cw.SpotsLogDataDir, "decoder_spots")
	}
	if cw.MetricsLogEnabled {
		cw.MetricsLogDataDir = resolveConfigPath(configDir, cw.MetricsLogDataDir, "cwskimmer_metrics")
		cw.MetricsSummaryDataDir = resolveConfigPath(configDir, cw.MetricsSummaryDataDir, "cwskimmer_summaries")
	}
}

// skimmerFeedOverlapWarnings are the reasons to warn when the skimmer's feed
// is on alongside UberSDR's own sources: the same stations would be spotted
// twice, and UberSDR would report its own copies as the skimmer reports its.
func skimmerFeedOverlapWarnings(cfg *Config, cw *CWSkimmerConfig, md *MultiDecoder, cwc *CWSkimmerClient) []string {
	if !cfg.SkimmerFeed.Enabled {
		return nil
	}
	var w []string
	if cfg.Decoder.Enabled {
		w = append(w, "decoder.yaml's decoders are on as well as the skimmer feed: a band both decode has its "+
			"FT8/FT4/WSPR/JS8 spots twice, and UberSDR reports its own to PSK Reporter and WSPRNet as the skimmer "+
			"reports its. Set decoder.enabled: false to take digital spots from the skimmer alone.")
	}
	if cw != nil && cw.Enabled {
		msg := "cwskimmer.yaml's CW Skimmer client is on as well as the skimmer feed: its CW spots come twice"
		if strings.EqualFold(cw.Host, "skimmer") {
			msg += " (it reads the skimmer's own telnet port, so every one)"
		}
		w = append(w, msg+". Set enabled: false in cwskimmer.yaml to take CW spots from the skimmer feed alone.")
	}
	if md == nil {
		w = append(w, "no decoder spot delivery could be made: the skimmer feed's digital spots will be dropped")
	}
	if cwc == nil {
		w = append(w, "no CW spot delivery could be made: the skimmer feed's CW spots will be dropped")
	}
	return w
}

// startSkimmerFeed starts reading the skimmer's feed when skimmer_feed is
// enabled, its digital spots into md and its CW-family spots into cwc (each
// may be nil: those spots are then dropped), never to a reporter.  It returns
// nil when the feed is off; the caller stops what it returns.
func startSkimmerFeed(cfg *Config, cw *CWSkimmerConfig, md *MultiDecoder, cwc *CWSkimmerClient) *SkimmerFeedClient {
	if !cfg.SkimmerFeed.Enabled {
		return nil
	}
	for _, w := range skimmerFeedOverlapWarnings(cfg, cw, md, cwc) {
		log.Printf("Warning: Skimmer feed: %s", w)
	}
	feed := NewSkimmerFeedClient(cfg.SkimmerFeed, cfg.Receiver.MaxFreq())
	feed.OnDigitalSpot(md.IngestDecode) // nil-safe
	feed.OnCWSpot(cwc.IngestSpot)       // nil-safe
	feed.Start()
	return feed
}
