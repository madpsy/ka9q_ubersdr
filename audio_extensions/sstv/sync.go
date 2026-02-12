package sstv

import (
	"log"
	"math"
)

/*
 * Sync Detection and Slant Correction
 * Ported from slowrx by Oona Räisänen (OH2EIQ)
 *
 * Uses Linear Hough Transform to detect slant angle and adjust sample rate
 */

const (
	MinSlant = 30  // Minimum slant angle to consider (degrees)
	MaxSlant = 150 // Maximum slant angle to consider (degrees)
)

// SyncCorrector handles sync pulse detection and slant correction
type SyncCorrector struct {
	mode       *ModeSpec
	sampleRate float64
	hasSync    []bool // Sync detection buffer from video demodulator
}

// NewSyncCorrector creates a new sync corrector
func NewSyncCorrector(mode *ModeSpec, sampleRate float64, hasSync []bool) *SyncCorrector {
	return &SyncCorrector{
		mode:       mode,
		sampleRate: sampleRate,
		hasSync:    hasSync,
	}
}

// FindSync finds the slant angle and adjusts sample rate to correct it
// Returns: adjusted sample rate, skip amount (samples)
func (s *SyncCorrector) FindSync() (float64, int) {
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
		syncImg := s.drawSyncImage(rate, lineWidth)

		// Perform Linear Hough Transform to find dominant line angle
		slantAngle, distance := s.houghTransform(syncImg, lineWidth)

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
func (s *SyncCorrector) drawSyncImage(rate float64, lineWidth int) [][]bool {
	m := s.mode

	// Allocate sync image
	syncImg := make([][]bool, lineWidth)
	for i := range syncImg {
		syncImg[i] = make([]bool, m.NumLines)
	}

	// Draw sync signal
	for y := 0; y < m.NumLines; y++ {
		for x := 0; x < lineWidth; x++ {
			t := (float64(y) + float64(x)/float64(lineWidth)) * m.LineTime
			syncSampleNum := int(t * rate / 13.0)

			if syncSampleNum >= 0 && syncSampleNum < len(s.hasSync) {
				syncImg[x][y] = s.hasSync[syncSampleNum]
			}
		}
	}

	return syncImg
}

// houghTransform performs Linear Hough Transform to find the dominant line angle
// Returns: slant angle (degrees), distance
func (s *SyncCorrector) houghTransform(syncImg [][]bool, lineWidth int) (float64, int) {
	m := s.mode

	// Allocate line accumulator [distance][angle]
	lines := make([][]uint16, 600)
	for i := range lines {
		lines[i] = make([]uint16, (MaxSlant-MinSlant)*2)
	}

	dMost := 0
	qMost := 0

	// Find white pixels and accumulate lines
	for cy := 0; cy < m.NumLines; cy++ {
		for cx := 0; cx < lineWidth; cx++ {
			if !syncImg[cx][cy] {
				continue
			}

			// Try different slant angles
			for q := MinSlant * 2; q < MaxSlant*2; q++ {
				// Calculate line distance using Hesse normal form
				angle := deg2rad(float64(q) / 2.0)
				d := lineWidth + int(math.Round(
					-float64(cx)*math.Sin(angle)+float64(cy)*math.Cos(angle)))

				if d > 0 && d < lineWidth && d < len(lines) {
					qIdx := q - MinSlant*2
					if qIdx >= 0 && qIdx < len(lines[d]) {
						lines[d][qIdx]++

						qMostIdx := qMost - MinSlant*2
						if qMostIdx >= 0 && qMostIdx < len(lines[dMost]) &&
							lines[d][qIdx] > lines[dMost][qMostIdx] {
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
func (s *SyncCorrector) findSyncPosition(rate float64) int {
	m := s.mode

	// Accumulate sync pulse positions across all lines
	xAcc := make([]uint16, 700)
	for y := 0; y < m.NumLines; y++ {
		for x := 0; x < 700; x++ {
			t := float64(y)*m.LineTime + float64(x)/700.0*m.LineTime
			syncSampleNum := int(t / (13.0 / s.sampleRate) * rate / s.sampleRate)

			if syncSampleNum >= 0 && syncSampleNum < len(s.hasSync) && s.hasSync[syncSampleNum] {
				xAcc[x]++
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
			convd += float64(xAcc[x+i]) * convoFilter[i]
		}

		if convd > maxConvd {
			maxConvd = convd
			xMax = x + 4
		}
	}

	// If pulse is near the right edge, it probably slipped off the left edge
	if xMax > 350 {
		xMax -= 350
	}

	// Calculate skip to start of line
	skipTime := float64(xMax)/700.0*m.LineTime - m.SyncTime

	// Scottie modes don't start lines with sync (format: pGpBSpR)
	if m.Name == "Scottie S1" || m.Name == "Scottie S2" || m.Name == "Scottie DX" {
		syncOffset := m.PorchTime*2 - m.PixelTime*float64(m.ImgWidth)/2.0
		skipTime += syncOffset
	}

	skip := int(skipTime * rate)

	return skip
}

// deg2rad converts degrees to radians
func deg2rad(deg float64) float64 {
	return deg * math.Pi / 180.0
}
