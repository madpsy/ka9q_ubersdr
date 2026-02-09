package sstv

import (
	"log"
	"math"
)

/*
 * Sync Detection and Slant Correction
 * Ported from KiwiSDR/extensions/SSTV/sstv_sync.cpp
 *
 * Original copyright (c) 2007-2013, Oona Räisänen (OH2EIQ [at] sral.fi)
 * Go port (c) 2026, UberSDR project
 *
 * Uses Linear Hough Transform to detect slant angle and adjust sample rate
 */

const (
	minSlant = 30  // Minimum slant angle to consider (degrees)
	maxSlant = 150 // Maximum slant angle to consider (degrees)
)

// SyncDetector handles sync pulse detection and slant correction
type SyncDetector struct {
	mode       *ModeSpec
	sampleRate float64
	hasSync    []bool // Sync detection buffer from video demodulator

	// Hough transform buffers
	syncImg [][]bool   // 2D sync signal image
	lines   [][]uint16 // Line accumulator for Hough transform
	xAcc    []uint16   // 1D accumulator for sync pulse position
}

// NewSyncDetector creates a new sync detector
func NewSyncDetector(mode *ModeSpec, sampleRate float64, hasSync []bool) *SyncDetector {
	// Allocate sync image buffer
	syncImg := make([][]bool, 700)
	for i := range syncImg {
		syncImg[i] = make([]bool, 630)
	}

	// Allocate Hough transform line accumulator
	// Dimensions: [distance][angle]
	lines := make([][]uint16, 700)
	for i := range lines {
		lines[i] = make([]uint16, (maxSlant-minSlant)*2)
	}

	return &SyncDetector{
		mode:       mode,
		sampleRate: sampleRate,
		hasSync:    hasSync,
		syncImg:    syncImg,
		lines:      lines,
		xAcc:       make([]uint16, 700),
	}
}

// FindSlantAndAdjust finds the slant angle and adjusts sample rate to correct it
// Returns: adjusted sample rate, skip amount (samples)
func (s *SyncDetector) FindSlantAndAdjust() (float64, int) {
	m := s.mode
	rate := s.sampleRate
	lineWidth := int(m.LineTime / m.SyncTime * 4)

	var skip int
	retries := 0
	maxRetries := 3

	log.Printf("[SSTV Sync] Starting slant detection and correction")

	// Repeat until slant < 0.5° or until we give up
	for {
		// Draw the 2D sync signal at current rate
		s.drawSyncImage(rate, lineWidth)

		// Perform Linear Hough Transform to find dominant line angle
		slantAngle, distance := s.houghTransform(lineWidth)

		if slantAngle == 0 {
			log.Printf("[SSTV Sync] No sync signal found, giving up")
			break
		}

		log.Printf("[SSTV Sync] Try #%d: slant %.1f° (d=%d) @ %.1f Hz",
			retries+1, slantAngle, distance, rate)

		// Adjust sample rate based on slant angle
		rate += math.Tan(deg2rad(90-slantAngle)) / float64(lineWidth) * rate

		// Check if slant is acceptable (89-91 degrees = nearly vertical)
		if slantAngle > 89.0 && slantAngle < 91.0 {
			log.Printf("[SSTV Sync] Slant OK")
			break
		}

		if retries >= maxRetries {
			log.Printf("[SSTV Sync] Still slanted after %d retries, giving up", maxRetries)
			rate = s.sampleRate // Reset to nominal rate
			break
		}

		log.Printf("[SSTV Sync] Adjusting rate to %.1f Hz, recalculating", rate)
		retries++
	}

	// Find the exact position of the sync pulse
	skip = s.findSyncPosition(rate)

	log.Printf("[SSTV Sync] Final rate: %.1f Hz, skip: %d samples (%.1f ms)",
		rate, skip, float64(skip)*1000.0/rate)

	return rate, skip
}

// drawSyncImage creates a 2D image of the sync signal
func (s *SyncDetector) drawSyncImage(rate float64, lineWidth int) {
	m := s.mode

	// Clear sync image
	for x := range s.syncImg {
		for y := range s.syncImg[x] {
			s.syncImg[x][y] = false
		}
	}

	// Draw sync signal
	for y := 0; y < m.NumLines && y < len(s.syncImg[0]); y++ {
		for x := 0; x < lineWidth && x < len(s.syncImg); x++ {
			t := (float64(y) + float64(x)/float64(lineWidth)) * m.LineTime
			syncSampleNum := int(t * rate / 13.0)

			if syncSampleNum >= 0 && syncSampleNum < len(s.hasSync) {
				s.syncImg[x][y] = s.hasSync[syncSampleNum]
			}
		}
	}
}

// houghTransform performs Linear Hough Transform to find the dominant line angle
// Returns: slant angle (degrees), distance
func (s *SyncDetector) houghTransform(lineWidth int) (float64, int) {
	m := s.mode

	// Clear line accumulator
	for i := range s.lines {
		for j := range s.lines[i] {
			s.lines[i][j] = 0
		}
	}

	dMost := 0
	qMost := minSlant * 2 // Bias up so qMost_min_slant is zero initially

	// Find white pixels and accumulate lines
	for cy := 0; cy < m.NumLines && cy < len(s.syncImg[0]); cy++ {
		for cx := 0; cx < lineWidth && cx < len(s.syncImg); cx++ {
			if !s.syncImg[cx][cy] {
				continue
			}

			// Try different slant angles
			for q := minSlant * 2; q < maxSlant*2; q++ {
				// Calculate line distance using Hesse normal form
				angle := deg2rad(float64(q) / 2.0)
				d := lineWidth + int(math.Round(
					-float64(cx)*math.Sin(angle)+float64(cy)*math.Cos(angle)))

				if d > 0 && d < lineWidth && d < len(s.lines) {
					// Zero-biased indices
					qMinSlant := q - minSlant*2
					qMostMinSlant := qMost - minSlant*2

					if qMinSlant >= 0 && qMinSlant < len(s.lines[d]) {
						s.lines[d][qMinSlant]++

						if qMostMinSlant >= 0 && qMostMinSlant < len(s.lines[dMost]) &&
							s.lines[d][qMinSlant] > s.lines[dMost][qMostMinSlant] {
							dMost = d
							qMost = q
						}
					}
				}
			}
		}
	}

	if qMost == 0 {
		return 0, 0
	}

	slantAngle := float64(qMost) / 2.0
	return slantAngle, dMost
}

// findSyncPosition finds the exact position of the sync pulse
func (s *SyncDetector) findSyncPosition(rate float64) int {
	m := s.mode

	// Clear accumulator
	for i := range s.xAcc {
		s.xAcc[i] = 0
	}

	// Accumulate sync pulse positions across all lines
	for y := 0; y < m.NumLines; y++ {
		for x := 0; x < 700 && x < len(s.xAcc); x++ {
			t := float64(y)*m.LineTime + float64(x)/700.0*m.LineTime
			syncSampleNum := int(t / (13.0 / s.sampleRate) * rate / s.sampleRate)

			if syncSampleNum >= 0 && syncSampleNum < len(s.hasSync) && s.hasSync[syncSampleNum] {
				s.xAcc[x]++
			}
		}
	}

	// Find falling edge of sync pulse using 8-point convolution
	convoFilter := []float64{1, 1, 1, 1, -1, -1, -1, -1}
	maxConvd := 0.0
	xMax := 0

	for x := 0; x < 700-8; x++ {
		convd := 0.0
		for i := 0; i < 8; i++ {
			if x+i < len(s.xAcc) {
				convd += float64(s.xAcc[x+i]) * convoFilter[i]
			}
		}

		if convd > maxConvd {
			maxConvd = convd
			xMax = x + 4
		}
	}

	log.Printf("[SSTV Sync] Sync pulse position: %d/700 (%.3f)", xMax, float64(xMax)/700.0)

	// If pulse is near the right edge, it probably slipped off the left edge
	if xMax > 350 {
		xMax -= 350
		log.Printf("[SSTV Sync] Adjusted for right edge: %d/700 (%.3f)", xMax, float64(xMax)/700.0)
	}

	// Calculate skip to start of line
	skipTime := float64(xMax)/700.0*m.LineTime - m.SyncTime

	// Scottie modes don't start lines with sync (format: pGpBSpR)
	if m.VIS == ModeS1 || m.VIS == ModeS2 || m.VIS == ModeSDX {
		syncOffset := m.PorchTime*2 - m.PixelTime*float64(m.ImgWidth)/2.0
		skipTime += syncOffset
		log.Printf("[SSTV Sync] Scottie mode offset: %.3f (%.1f samples)",
			syncOffset, syncOffset*rate)
	}

	skip := int(skipTime * rate)
	log.Printf("[SSTV Sync] Skip: %.3f seconds = %d samples", skipTime, skip)

	return skip
}

// deg2rad converts degrees to radians
func deg2rad(deg float64) float64 {
	return deg * math.Pi / 180.0
}
