package main

// Sizing a noise-floor band, and the admin endpoint that answers it.
//
// Adding a band is not a matter of taste: bin_bandwidth decides which of radiod's two
// spectrum algorithms runs for that channel, and the two cost wildly different things.
//
//	bin_bandwidth <= radiodSpectrumCrossoverHz
//	    radiod downconverts to the band and transforms only that. Cost is the band's
//	    width and nothing else -- notably NOT the poll rate, and NOT the bin count.
//	bin_bandwidth >  radiodSpectrumCrossoverHz
//	    radiod transforms the ENTIRE front end at that resolution and keeps the bins
//	    asked for. A 300 kHz band at 500 Hz/bin is a 259,200-point FFT of all
//	    129.6 MHz, on every poll, to look at 300 kHz of it.
//
// The defaults were once all on the wrong side of that line and cost two full cores at
// the 100 ms background poll operators usually set for the SSE spectrum stream. This
// exists so nobody has to rediscover that by watching their CPU graph.

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"
)

const (
	// noiseFloorTargetBins is the bin count a band is sized towards. Percentiles are
	// taken across bins, so too few makes the noise estimate jumpy; below the
	// crossover extra bins cost no CPU at all, only packet size.
	noiseFloorTargetBins = 500

	// A narrowband spectrum channel costs a fixed amount plus a share proportional to
	// the span it downconverts. Both terms were fitted to measured per-thread CPU on a
	// 129.6 Msps receiver, across ten bands from 50 kHz to 500 kHz wide:
	//
	//	actual% = 0.43 + 5.46 * span_MHz     (residuals inside the CSV's own 0.05% quantisation)
	//
	// The fixed term is the part a purely proportional model cannot express at any
	// constant, and ignoring it is why the old estimate ran ~35% high on wide bands and
	// ~5% low on narrow ones. It also carries a real consequence the old model hid:
	// bands are not free just because they are narrow. Ten 50 kHz bands cost more than
	// one 500 kHz band, because each one is a channel before it is a width.
	//
	// These are a starting point, not a constant of nature -- CPU, clock and memory
	// bandwidth all move them. noiseFloorCalibration re-fits them against whatever the
	// receiver is actually reporting.
	noiseFloorChannelFixedPct = 0.43
	noiseFloorPctPerMHz       = 5.46

	// noiseFloorCalibrationMinPct is the smallest measured reading worth calibrating
	// against. thread-stats.py writes one decimal place, so a 0.5% reading carries
	// +/-10% of quantisation error and a 0.2% one is mostly noise.
	noiseFloorCalibrationMinPct = 1.5

	// noiseFloorSuggestMinSavingPct is how much of a CPU core a proposed change must
	// save before it is worth showing. Below this it is churn: a reconfigure, a
	// restart, and a step in the band's history, for nothing measurable.
	noiseFloorSuggestMinSavingPct = 0.25

	// noiseFloorMaxBins keeps one response inside a sane datagram. Bins reach us as
	// BIN_DATA, a float32 vector, so this is a 16 KB packet at roughly twelve IP
	// fragments -- and losing any one of them loses the whole frame.
	noiseFloorMaxBins = maxSpectrumBins
)

// noiseFloorBandParams is the geometry to configure for a frequency range, with the
// working shown.
type noiseFloorBandParams struct {
	Name            string  `json:"name,omitempty"`
	Start           uint64  `json:"start"`
	End             uint64  `json:"end"`
	CenterFrequency uint64  `json:"center_frequency"`
	BinCount        int     `json:"bin_count"`
	BinBandwidth    float64 `json:"bin_bandwidth"`

	SpanHz          uint64   `json:"span_hz"`
	DeliveredSpanHz float64  `json:"delivered_span_hz"`
	Algorithm       string   `json:"radiod_algorithm"`
	FFTLength       int      `json:"radiod_fft_length"`
	ChannelSamprate int      `json:"radiod_channel_samprate"`
	EstimatedCPUPct float64  `json:"estimated_cpu_percent"`
	BytesPerPoll    int      `json:"bytes_per_poll"`
	YAML            string   `json:"yaml"`
	Warnings        []string `json:"warnings,omitempty"`
}

// noiseFloorBandParamsFor sizes a band for a frequency range.
//
// Bin bandwidth is the coarsest ladder value at or below the crossover that still
// reaches noiseFloorTargetBins, stepping coarser if that would need more bins than one
// datagram carries, and skipping any value radiod's own FFT search cannot resolve.
// Coarsest-that-qualifies rather than finest-available because below the crossover
// resolution is free in CPU but not in bytes.
func noiseFloorBandParamsFor(name string, start, end uint64, calibration float64) (noiseFloorBandParams, error) {
	if end <= start {
		return noiseFloorBandParams{}, fmt.Errorf("end (%d Hz) must be above start (%d Hz)", end, start)
	}
	span := end - start
	p := noiseFloorBandParams{
		Name:            name,
		Start:           start,
		End:             end,
		CenterFrequency: start + span/2,
		SpanHz:          span,
	}

	type candidate struct {
		binBW   float64
		bins    int
		fftLen  int
		samprat int
	}
	var best *candidate
	for _, binBW := range radiodBinBandwidthLadder {
		if binBW > radiodSpectrumCrossoverHz {
			break // the expensive algorithm; never worth it for a band
		}
		bins := int(math.Ceil(float64(span) / binBW))
		if bins%2 != 0 {
			bins++ // the FFT unwrap swaps two halves; an odd count drops a bin
		}
		if bins > noiseFloorMaxBins {
			continue
		}
		fftLen, samprate := radiodNarrowbandFFT(binBW, bins)
		if fftLen == 0 {
			continue // radiod's search cannot resolve this pairing
		}
		// setup_narrowband reserves radiodFilterMarginHz for the filter skirts, so
		// a band only fits if the channel rate clears it by that much.
		if float64(samprate)-radiodFilterMarginHz < float64(span) {
			continue
		}
		c := candidate{binBW, bins, fftLen, samprate}
		if bins >= noiseFloorTargetBins {
			// Coarsest that reaches the target wins; the ladder ascends, so keep
			// overwriting and the last qualifying one is the coarsest.
			best = &c
		} else if best == nil {
			// Nothing reaches the target yet -- hold the finest that works, for
			// bands too narrow to ever get there.
			best = &c
		}
	}
	if best == nil {
		return p, fmt.Errorf("no bin bandwidth at or below %.0f Hz can cover %d Hz within %d bins; split the range into smaller bands",
			radiodSpectrumCrossoverHz, span, noiseFloorMaxBins)
	}

	p.BinBandwidth = best.binBW
	p.BinCount = best.bins
	p.FFTLength = best.fftLen
	p.ChannelSamprate = best.samprat
	p.DeliveredSpanHz = float64(best.bins) * best.binBW
	p.Algorithm = "narrowband (downconverter)"
	// Cost is the delivered span: measured at 4.5% of a core for a 469 kHz
	// downconverter on a 129.6 Msps receiver, and independent of the poll rate.
	p.EstimatedCPUPct = noiseFloorEstimatedCPUPct(p.DeliveredSpanHz, calibration)
	p.BytesPerPoll = best.bins * 4 // BIN_DATA is a float32 vector

	if best.bins < noiseFloorTargetBins {
		p.Warnings = append(p.Warnings, fmt.Sprintf(
			"only %d bins: the range is too narrow to reach %d even at radiod's finest bin bandwidth, "+
				"so percentile estimates will be noisier than for a wider band",
			best.bins, noiseFloorTargetBins))
	}
	if p.EstimatedCPUPct > 5 {
		p.Warnings = append(p.Warnings, fmt.Sprintf(
			"about %.1f%% of a CPU core, continuously: the downconverter runs at the band's width "+
				"whether or not anyone is looking", p.EstimatedCPUPct))
	}

	label := name
	if label == "" {
		label = "newband"
	}
	p.YAML = fmt.Sprintf(`    - name: %s
      start: %d
      end: %d
      center_frequency: %d
      bin_count: %d
      bin_bandwidth: %g
`, label, start, end, p.CenterFrequency, p.BinCount, p.BinBandwidth)

	return p, nil
}

// formatHz renders a frequency span the way the admin UI does.
func formatHz(hz float64) string {
	switch {
	case hz >= 1e6:
		return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.3f", hz/1e6), "0"), ".") + " MHz"
	case hz >= 1e3:
		return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.2f", hz/1e3), "0"), ".") + " kHz"
	default:
		return fmt.Sprintf("%.0f Hz", hz)
	}
}

// noiseFloorEstimatedCPUPct is what a narrowband channel of this delivered span should
// cost, as a percentage of one core. calibration scales the model to a particular
// receiver; pass 1 for the raw figure.
func noiseFloorEstimatedCPUPct(deliveredSpanHz, calibration float64) float64 {
	if calibration <= 0 {
		calibration = 1
	}
	return calibration * (noiseFloorChannelFixedPct + noiseFloorPctPerMHz*deliveredSpanHz/1e6)
}

// noiseFloorCalibration fits the model to what radiod is actually reporting, returning
// a scale factor and how many bands it was fitted over.
//
// Only bands whose measurement clears noiseFloorCalibrationMinPct are used: below that
// the CSV's single decimal place is a bigger effect than anything being measured, and
// including them drags the fit around for no reason.
func noiseFloorCalibration(bands []noiseFloorBandCost) (factor float64, samples int) {
	var measured, modelled float64
	for _, b := range bands {
		if b.MeasuredCPUPct == nil || *b.MeasuredCPUPct < noiseFloorCalibrationMinPct {
			continue
		}
		if b.BinBandwidth > radiodSpectrumCrossoverHz {
			continue // a different cost model entirely
		}
		measured += *b.MeasuredCPUPct
		modelled += noiseFloorEstimatedCPUPct(float64(b.BinCount)*b.BinBandwidth, 1)
		samples++
	}
	if samples < 2 || modelled <= 0 {
		return 1, samples
	}
	return measured / modelled, samples
}

// noiseFloorBandParamsRequest is the POST body.
type noiseFloorBandParamsRequest struct {
	Name  string `json:"name"`
	Start uint64 `json:"start"`
	End   uint64 `json:"end"`
}

// noiseFloorBandCost is one live band: what it is configured as, what that ought to
// cost, and what it is actually costing radiod right now.
type noiseFloorBandCost struct {
	Name            string  `json:"name"`
	Start           uint64  `json:"start"`
	End             uint64  `json:"end"`
	SpanHz          uint64  `json:"span_hz"`
	BinCount        int     `json:"bin_count"`
	BinBandwidth    float64 `json:"bin_bandwidth"`
	SSRC            uint32  `json:"ssrc"`
	SSRCHex         string  `json:"ssrc_hex"`
	Algorithm       string  `json:"radiod_algorithm"`
	EstimatedCPUPct float64 `json:"estimated_cpu_percent"`

	// MeasuredCPUPct is the real per-thread figure radiod reports for this
	// channel, as a percentage of one core. Absent when the thread-stats CSV has
	// no row for the SSRC -- the channel may not be up yet, or thread names may
	// have outgrown Linux's 15-character limit (see thread-stats.py).
	MeasuredCPUPct  *float64 `json:"measured_cpu_percent,omitempty"`
	MeasuredCPUCore *int     `json:"measured_cpu_core,omitempty"`

	// Latest measurement, so the tab shows what the CPU is actually buying.
	NoiseFloorDB   *float32 `json:"noise_floor_db,omitempty"` // P5 of the bin powers
	OccupancyPct   *float32 `json:"occupancy_pct,omitempty"`
	DynamicRangeDB *float32 `json:"dynamic_range_db,omitempty"`
	FT8SNRDB       *float32 `json:"ft8_snr_db,omitempty"`
	MeasuredAgeSec *int64   `json:"measurement_age_sec,omitempty"`

	// NoiseFloorDBPerHz is NoiseFloorDB referred to a 1 Hz bandwidth.
	//
	// The stored figure is per-BIN power, so a band measured at 200 Hz per bin reads
	// about 3 dB above one measured at 100 Hz for identical noise -- the difference
	// is the bin width, not the band. Normalising here makes the bands comparable
	// without rewriting any history: the database keeps meaning exactly what it
	// always meant, and the column that is comparable is derived on the way out.
	NoiseFloorDBPerHz *float64 `json:"noise_floor_db_per_hz,omitempty"`

	// Suggested is an alternative configuration, present only when it would
	// materially REDUCE CPU -- not merely when it differs. A suggestion that saves
	// nothing is noise, and worse than noise on a page about cost: it draws the eye
	// to the cheapest bands and says nothing about the dearest.
	Suggested *noiseFloorBandParams `json:"suggested,omitempty"`

	// AtCostFloor says this band cannot be made cheaper by configuration. Below the
	// crossover a band's cost is its width, so once it is on the downconverter and
	// delivering no more span than it was asked for, the only lever left is a
	// narrower frequency range. Reported explicitly because otherwise an expensive
	// band and an optimal one look identical -- both simply have no suggestion.
	AtCostFloor bool   `json:"at_cost_floor"`
	CostNote    string `json:"cost_note,omitempty"`

	// Set when config.yaml asks for something other than what is running, because
	// the loader corrected a band that would otherwise have used radiod's expensive
	// algorithm. The receiver is already getting the cheap behaviour; the file has
	// simply not caught up.
	ConfiguredBinBandwidth float64 `json:"configured_bin_bandwidth,omitempty"`
	ConfiguredBinCount     int     `json:"configured_bin_count,omitempty"`

	Warnings []string `json:"warnings,omitempty"`
}

// noiseFloorCostReport is the GET response.
type noiseFloorCostReport struct {
	Bands []noiseFloorBandCost `json:"bands"`

	EstimatedTotalCPUPct float64  `json:"estimated_total_cpu_percent"`
	MeasuredTotalCPUPct  *float64 `json:"measured_total_cpu_percent,omitempty"`
	ThreadStatsAvailable bool     `json:"thread_stats_available"`

	// EstimateCalibration is measured/modelled over the bands with readings solid
	// enough to fit against, and EstimateCalibrationBands is how many that was. 1
	// means the model is being used as-is, either because nothing could be measured
	// or because it already agrees.
	EstimateCalibration      float64  `json:"estimate_calibration"`
	EstimateCalibrationBands int      `json:"estimate_calibration_bands"`
	BackgroundPollMs         int      `json:"background_poll_period_ms"`
	CrossoverHz              float64  `json:"radiod_crossover_hz"`
	Notes                    []string `json:"notes,omitempty"`
}

// handleNoiseFloorBandCosts answers GET /admin/noisefloor-band-params: every
// configured band, what it should cost, and what it is costing.
//
// The measured figure comes from the same per-thread CSV the channel table uses,
// matched on the SSRC the noise floor monitor created the channel with -- so it is
// radiod's own accounting rather than anything inferred here.
func handleNoiseFloorBandCosts(w http.ResponseWriter, cfg *Config, nfm *NoiseFloorMonitor) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(noiseFloorCostsFor(cfg, nfm))
}

// costNoiseFloorBands fills in every band's estimate, suggestion and cost note, plus
// the report's estimated total, from rows that already carry their geometry and their
// measured CPU. Split out from noiseFloorCostsFor because it is the part worth testing
// directly: it needs no radiod, no thread-stats CSV and no live monitor.
func costNoiseFloorBands(report *noiseFloorCostReport, cfg *Config) {
	// The model was fitted on one receiver; measured across three others it ran at
	// 147%, 79% and 100% of it. That spread is the machine -- CPU, clock and memory
	// bandwidth -- not the shape of the model, and no edit to the constants can fix
	// more than one of them at a time. Scaling by what this receiver's own measured
	// bands are doing fixes all of them, and leaves the constants meaning what they
	// say: the cost on the reference machine.
	report.EstimateCalibration, report.EstimateCalibrationBands = noiseFloorCalibration(report.Bands)
	calibration := report.EstimateCalibration
	for i := range report.Bands {
		row := &report.Bands[i]
		delivered := float64(row.BinCount) * row.BinBandwidth
		if row.BinBandwidth > radiodSpectrumCrossoverHz {
			// The poll rate multiplies this one, and the calibration is fitted
			// on narrowband bands -- but it measures the machine, which is what
			// both models are ultimately expressed in.
			if cfg != nil && cfg.Spectrum.BackgroundPollPeriodMs > 0 {
				fftN := float64(cfg.Receiver.Samprate()) / row.BinBandwidth
				pollHz := 1000.0 / float64(cfg.Spectrum.BackgroundPollPeriodMs)
				avg := math.Floor(float64(maxWidebandTransformPoints) / fftN)
				avg = math.Max(1, math.Min(float64(defaultSpectrumFFTAverages), avg))
				row.EstimatedCPUPct = calibration * 27.0 / 2.835e6 * pollHz * avg * fftN
			}
		} else {
			row.EstimatedCPUPct = noiseFloorEstimatedCPUPct(delivered, calibration)
		}
		report.EstimatedTotalCPUPct += row.EstimatedCPUPct

		// Only propose a change that actually saves something.
		//
		// The threshold is absolute rather than proportional on purpose: a 2 kHz
		// band can be "improved" by 20% of nothing, and surfacing that next to a
		// 500 kHz band that cannot be improved at all inverts the whole page.
		// Both sides are calibrated, so the saving is in this receiver's CPU.
		s, err := noiseFloorBandParamsFor(row.Name, row.Start, row.End, calibration)
		if err != nil {
			continue
		}
		saving := row.EstimatedCPUPct - s.EstimatedCPUPct
		switch {
		case row.BinBandwidth > radiodSpectrumCrossoverHz:
			// Wrong algorithm entirely: always worth saying, whatever the
			// arithmetic works out to.
			row.Suggested = &s
			row.CostNote = fmt.Sprintf("moving below the crossover would cost about %.2f%% instead", s.EstimatedCPUPct)
		case saving >= noiseFloorSuggestMinSavingPct:
			row.Suggested = &s
			row.CostNote = fmt.Sprintf("delivers %.0f Hz for a %d Hz range; trimming it saves about %.2f%%",
				delivered, row.SpanHz, saving)
		default:
			row.AtCostFloor = true
			row.CostNote = fmt.Sprintf(
				"at the floor: on the downconverter, delivering %s for a %s range. Below the crossover a band's "+
					"cost is its width, so only a narrower range reduces it.",
				formatHz(delivered), formatHz(float64(row.SpanHz)))
		}
	}
}

// noiseFloorCostsFor builds the report: every configured band, what it should cost, and
// what radiod says it is costing.
//
// Separate from the handler because the POST path needs the calibration out of it --
// a band that does not exist yet has nothing to measure, so the honest prediction is
// the model corrected by whatever the live bands are doing.
func noiseFloorCostsFor(cfg *Config, nfm *NoiseFloorMonitor) *noiseFloorCostReport {
	if cfg == nil {
		return &noiseFloorCostReport{EstimateCalibration: 1, CrossoverHz: radiodSpectrumCrossoverHz}
	}
	var latest map[string]*BandMeasurement
	if nfm != nil {
		latest = nfm.GetLatestMeasurements()
	}
	report := noiseFloorCostReport{
		CrossoverHz: radiodSpectrumCrossoverHz,
	}
	if cfg != nil {
		report.BackgroundPollMs = cfg.Spectrum.BackgroundPollPeriodMs
	}

	threadStats, statsAvailable := readThreadStats()
	report.ThreadStatsAvailable = statsAvailable

	// SSRC per band name, from the live monitor. bandSpectrums is built once at
	// startup and only read afterwards, which is how noise_floor_health.go reads it
	// too; each entry's own mutex guards its mutable fields, not the map.
	ssrcs := map[string]uint32{}
	if nfm != nil {
		for name, bs := range nfm.bandSpectrums {
			ssrcs[name] = bs.SSRC
		}
	}

	var measuredTotal float64
	var anyMeasured bool
	for _, b := range cfg.NoiseFloor.Bands {
		span := b.End - b.Start
		row := noiseFloorBandCost{
			Name: b.Name, Start: b.Start, End: b.End, SpanHz: span,
			BinCount: b.BinCount, BinBandwidth: b.BinBandwidth,
		}

		if b.BinBandwidth > radiodSpectrumCrossoverHz {
			// The expensive algorithm: an FFT over the whole front end, every
			// poll, so the poll rate multiplies it.
			row.Algorithm = "wideband (whole front end)"
			row.Warnings = append(row.Warnings, fmt.Sprintf(
				"%.0f Hz per bin is above the %.0f Hz crossover, so radiod transforms the whole "+
					"front end for this band on every poll; its cost rises with background_poll_period_ms",
				b.BinBandwidth, radiodSpectrumCrossoverHz))
		} else {
			row.Algorithm = "narrowband (downconverter)"
		}

		if ssrc, ok := ssrcs[b.Name]; ok && ssrc != 0 {
			row.SSRC = ssrc
			row.SSRCHex = fmt.Sprintf("0x%08x", ssrc)
			if stat, found := matchThreadToSSRC(threadStats, ssrc); found {
				pct, core := stat.cpuPct, stat.cpuNum
				row.MeasuredCPUPct, row.MeasuredCPUCore = &pct, &core
				measuredTotal += pct
				anyMeasured = true
			}
		} else {
			row.Warnings = append(row.Warnings,
				"no live radiod channel for this band; it may be outside the receiver's coverage and pruned at startup")
		}

		if b.ConfiguredBinBandwidth > 0 {
			row.ConfiguredBinBandwidth = b.ConfiguredBinBandwidth
			row.ConfiguredBinCount = b.ConfiguredBinCount
			row.Warnings = append(row.Warnings, fmt.Sprintf(
				"config.yaml asks for %d bins at %g Hz, which is above the crossover; it is being run as "+
					"%d bins at %g Hz instead. Update the file so the two agree.",
				b.ConfiguredBinCount, b.ConfiguredBinBandwidth, b.BinCount, b.BinBandwidth))
		}

		if m := latest[b.Name]; m != nil {
			nf, occ, dr, ft8 := m.P5DB, m.OccupancyPct, m.DynamicRange, m.FT8SNR
			row.NoiseFloorDB, row.OccupancyPct, row.DynamicRangeDB, row.FT8SNRDB = &nf, &occ, &dr, &ft8
			age := int64(time.Since(m.Timestamp).Seconds())
			row.MeasuredAgeSec = &age
			if b.BinBandwidth > 0 {
				perHz := float64(m.P5DB) - 10*math.Log10(b.BinBandwidth)
				row.NoiseFloorDBPerHz = &perHz
			}
		}

		report.Bands = append(report.Bands, row)
	}

	costNoiseFloorBands(&report, cfg)

	if anyMeasured {
		report.MeasuredTotalCPUPct = &measuredTotal
	}
	if !statsAvailable {
		report.Notes = append(report.Notes,
			"radiod thread stats are not available, so only estimates are shown")
	}
	report.Notes = append(report.Notes,
		"percentages are of one CPU core; below the crossover a band's cost is its width alone "+
			"and does not change with the poll rate")
	report.Notes = append(report.Notes,
		"noise_floor_db is per-bin power, so bands with different bin_bandwidth are not directly "+
			"comparable; noise_floor_db_per_hz refers them all to 1 Hz and is the column to compare")

	if report.EstimateCalibrationBands >= 2 && math.Abs(report.EstimateCalibration-1) > 0.05 {
		report.Notes = append(report.Notes, fmt.Sprintf(
			"this receiver runs at %.0f%% of the modelled cost across %d measured bands; every estimate here is "+
				"scaled by that, so the column reads in this receiver's CPU and not the reference machine's",
			100*report.EstimateCalibration, report.EstimateCalibrationBands))
	}
	return &report
}

// handleNoiseFloorBandParams answers /admin/noisefloor-band-params: GET reports every
// configured band's cost, POST sizes a new one.
func handleNoiseFloorBandParams(w http.ResponseWriter, r *http.Request, cfg *Config, nfm *NoiseFloorMonitor) {
	if r.Method == http.MethodGet {
		handleNoiseFloorBandCosts(w, cfg, nfm)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "GET or POST required", http.StatusMethodNotAllowed)
		return
	}
	var req noiseFloorBandParamsRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		writeJSONError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	// Predictions use this receiver's own calibration; there is no measurement to
	// compare a band that does not exist yet against, so the best available number is
	// the model corrected by what the live bands are doing.
	calibration := 1.0
	if nfm != nil {
		if report := noiseFloorCostsFor(cfg, nfm); report != nil {
			calibration = report.EstimateCalibration
		}
	}
	params, err := noiseFloorBandParamsFor(req.Name, req.Start, req.End, calibration)
	if err != nil {
		writeJSONError(w, err.Error(), http.StatusBadRequest)
		return
	}

	// A band outside what the receiver covers would be pruned at startup and never
	// measured, so say so here rather than let it vanish silently.
	if cfg != nil {
		rx := cfg.Receiver
		if req.Start < rx.MinFreq() || req.End > rx.MaxFreq() {
			params.Warnings = append(params.Warnings, fmt.Sprintf(
				"outside this receiver's %d-%d Hz coverage; the band would be dropped at startup",
				rx.MinFreq(), rx.MaxFreq()))
		}
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(params)
}
