package main

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Regex patterns for parsing decoder output
var (
	// FT8/FT4 format: HHMMSS  SNR  DT  Freq  [~]  Message
	// Example: 203530   2  0.1 2535 ~  EI3CTB RT6C -16
	ft8Pattern = regexp.MustCompile(`^(\d{6})\s+(-?\d+)\s+([-\d.]+)\s+(\d+)\s+[~]?\s+(.+)$`)

	// WSPR format varies by wsprd version, typically:
	// Date Time Seq SNR DT Freq Call Grid dBm [optional extra columns]
	// Example: 251108 1552   1 -17  0.5   7.040119  IV3JJO JN66 37          0   223    0
	// Note: Seq is a sequence number, Grid can be 4 or 6 chars, or missing entirely (dBm comes right after call)
	// The regex captures call and everything after it, then we parse grid/dBm separately
	wsprPattern = regexp.MustCompile(`^(\d{6})\s+(\d{4})\s+\d+\s+(-?\d+)\s+([-\d.]+)\s+([\d.]+)\s+(\S+)\s+(.+)$`)

	// Callsign pattern (basic validation)
	callsignPattern = regexp.MustCompile(`^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,3}[A-Z]$`)

	// Grid locator pattern (4, 6, or 8 characters)
	gridPattern = regexp.MustCompile(`^[A-R]{2}[0-9]{2}([a-x]{2}([0-9]{2})?)?$`)
)

// ParseFT8Line parses a line of FT8/FT4 decoder output
func ParseFT8Line(line string, dialFreq uint64, mode DecoderMode) (*DecodeInfo, error) {
	matches := ft8Pattern.FindStringSubmatch(strings.TrimSpace(line))
	if matches == nil {
		return nil, fmt.Errorf("line does not match FT8/FT4 format")
	}

	// Parse time (HHMMSS)
	timeStr := matches[1]
	hour, _ := strconv.Atoi(timeStr[0:2])
	minute, _ := strconv.Atoi(timeStr[2:4])
	second, _ := strconv.Atoi(timeStr[4:6])

	// Create timestamp for today at the decoded time
	now := time.Now().UTC()
	timestamp := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, second, 0, time.UTC)

	// If the decoded time is in the future, it must be from yesterday
	if timestamp.After(now) {
		timestamp = timestamp.Add(-24 * time.Hour)
	}

	// Parse SNR
	snr, err := strconv.Atoi(matches[2])
	if err != nil {
		return nil, fmt.Errorf("invalid SNR: %w", err)
	}

	// Parse frequency offset (in Hz from dial frequency)
	freqOffset, err := strconv.ParseUint(matches[4], 10, 64)
	if err != nil {
		return nil, fmt.Errorf("invalid frequency: %w", err)
	}

	// Calculate actual frequency
	frequency := dialFreq + freqOffset

	// Parse message
	message := strings.TrimSpace(matches[5])

	// Extract callsign and locator from message
	callsign, locator := extractCallsignLocator(message)

	info := &DecodeInfo{
		Callsign:    callsign,
		Locator:     locator,
		SNR:         snr,
		Frequency:   frequency,
		Timestamp:   timestamp,
		Mode:        mode.String(),
		Message:     message,
		HasCallsign: callsign != "",
		HasLocator:  isValidGridLocator(locator),
		IsWSPR:      false,
	}

	return info, nil
}

// ParseWSPRLine parses a line of WSPR decoder output
func ParseWSPRLine(line string, dialFreq uint64) (*DecodeInfo, error) {
	trimmed := strings.TrimSpace(line)
	matches := wsprPattern.FindStringSubmatch(trimmed)
	if matches == nil {
		if DebugMode {
			log.Printf("WSPR DEBUG: Line did not match regex: %q", trimmed)
		}
		return nil, fmt.Errorf("line does not match WSPR format")
	}

	if DebugMode {
		log.Printf("WSPR DEBUG: Regex matched! Groups: %d", len(matches))
	}

	// Parse date and time (YYMMDD HHMM)
	dateStr := matches[1]
	timeStr := matches[2]

	year, _ := strconv.Atoi("20" + dateStr[0:2])
	month, _ := strconv.Atoi(dateStr[2:4])
	day, _ := strconv.Atoi(dateStr[4:6])
	hour, _ := strconv.Atoi(timeStr[0:2])
	minute, _ := strconv.Atoi(timeStr[2:4])

	timestamp := time.Date(year, time.Month(month), day, hour, minute, 0, 0, time.UTC)

	// Parse SNR (now matches[3] after skipping sequence number)
	snr, err := strconv.Atoi(matches[3])
	if err != nil {
		return nil, fmt.Errorf("invalid SNR: %w", err)
	}

	// Parse DT (time drift)
	dt, err := strconv.ParseFloat(matches[4], 32)
	if err != nil {
		return nil, fmt.Errorf("invalid DT: %w", err)
	}

	// Parse frequency (absolute frequency in MHz)
	freqMHz, err := strconv.ParseFloat(matches[5], 64)
	if err != nil {
		return nil, fmt.Errorf("invalid frequency: %w", err)
	}
	txFrequency := uint64(freqMHz * 1e6)

	// Parse callsign (matches[6] now, drift removed from wsprd output)
	callsign := strings.TrimSpace(matches[6])

	// Parse the remaining fields (grid and dBm, with grid being optional)
	remaining := strings.Fields(strings.TrimSpace(matches[7]))
	if len(remaining) < 1 {
		return nil, fmt.Errorf("missing dBm field")
	}

	var locator string
	var dbm int

	// Check if first field is a grid locator (4 or 6 chars, starts with letter)
	// or if it's the dBm value (number)
	if len(remaining) >= 2 && len(remaining[0]) >= 2 &&
		remaining[0][0] >= 'A' && remaining[0][0] <= 'R' {
		// First field looks like a grid locator
		locator = remaining[0]
		var dbmErr error
		dbm, dbmErr = strconv.Atoi(remaining[1])
		if dbmErr != nil {
			return nil, fmt.Errorf("invalid dBm: %w", dbmErr)
		}
	} else {
		// No grid locator, first field is dBm
		locator = ""
		var dbmErr error
		dbm, dbmErr = strconv.Atoi(remaining[0])
		if dbmErr != nil {
			return nil, fmt.Errorf("invalid dBm: %w", dbmErr)
		}
	}

	info := &DecodeInfo{
		Callsign:    callsign,
		Locator:     locator,
		SNR:         snr,
		Frequency:   dialFreq, // Receiver frequency
		TxFrequency: txFrequency,
		Timestamp:   timestamp,
		Mode:        "WSPR",
		Message:     fmt.Sprintf("%s %s %d", callsign, locator, dbm),
		DT:          float32(dt),
		Drift:       0, // Drift not in wsprd output format
		DBm:         dbm,
		HasCallsign: isValidCallsign(callsign),
		HasLocator:  locator != "" && isValidGridLocator(locator),
		IsWSPR:      true,
	}

	return info, nil
}

// extractCallsignLocator extracts callsign and grid locator from FT8/FT4 message
func extractCallsignLocator(message string) (string, string) {
	fields := strings.Fields(message)
	if len(fields) < 2 {
		return "", ""
	}

	var callsign, locator string

	// Look for callsign and grid in the message
	for _, field := range fields {
		// Check if it looks like a callsign
		if callsign == "" && isValidCallsign(field) {
			callsign = field
		}
		// Check if it looks like a grid locator
		if locator == "" && isValidGridLocator(field) {
			locator = field
		}
	}

	return callsign, locator
}

// isValidCallsign checks if a string looks like a valid amateur radio callsign
func isValidCallsign(s string) bool {
	if len(s) < 3 || len(s) > 10 {
		return false
	}
	// Convert to uppercase for pattern matching
	s = strings.ToUpper(s)
	return callsignPattern.MatchString(s)
}

// isValidGridLocator checks if a string looks like a valid Maidenhead grid locator
func isValidGridLocator(s string) bool {
	if len(s) != 4 && len(s) != 6 && len(s) != 8 {
		return false
	}
	// Convert to proper case for pattern matching (uppercase letters, lowercase letters)
	if len(s) >= 2 {
		s = strings.ToUpper(s[0:2]) + s[2:]
	}
	if len(s) >= 6 {
		s = s[0:4] + strings.ToLower(s[4:6]) + s[6:]
	}
	return gridPattern.MatchString(s)
}

// ParseDecoderLog reads and parses a decoder log file
func ParseDecoderLog(filename string, dialFreq uint64, mode DecoderMode) ([]*DecodeInfo, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, fmt.Errorf("failed to open log file: %w", err)
	}
	defer file.Close()

	var decodes []*DecodeInfo
	scanner := bufio.NewScanner(file)
	lineCount := 0
	skippedCount := 0
	parsedCount := 0

	for scanner.Scan() {
		line := scanner.Text()
		lineCount++

		// Skip empty lines and noise lines
		if line == "" || strings.Contains(line, "EOF on input") ||
			strings.Contains(line, "<DecodeFinished>") || strings.Contains(line, "****") {
			skippedCount++
			continue
		}

		var info *DecodeInfo
		var err error

		// Parse based on mode
		if mode == ModeWSPR {
			info, err = ParseWSPRLine(line, dialFreq)
		} else {
			info, err = ParseFT8Line(line, dialFreq, mode)
		}

		if err != nil {
			// Skip lines that don't parse (may be decoder status messages)
			if DebugMode && mode == ModeWSPR {
				log.Printf("WSPR DEBUG: Failed to parse line: %v", err)
			}
			skippedCount++
			continue
		}

		parsedCount++

		// Only include decodes with valid callsigns
		if info.HasCallsign {
			decodes = append(decodes, info)
		} else if DebugMode && mode == ModeWSPR {
			log.Printf("WSPR DEBUG: Skipping decode without valid callsign: %s", info.Callsign)
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("error reading log file: %w", err)
	}

	if DebugMode && mode == ModeWSPR {
		log.Printf("WSPR DEBUG: ParseDecoderLog stats - Total lines: %d, Skipped: %d, Parsed: %d, Valid decodes: %d",
			lineCount, skippedCount, parsedCount, len(decodes))
	}

	return decodes, nil
}

// DeduplicateDecodes removes duplicate decodes, keeping the one with the highest SNR
func DeduplicateDecodes(decodes []*DecodeInfo) []*DecodeInfo {
	if len(decodes) == 0 {
		return decodes
	}

	// Map callsign to best decode
	bestDecodes := make(map[string]*DecodeInfo)

	for _, decode := range decodes {
		if !decode.HasCallsign {
			continue
		}

		existing, exists := bestDecodes[decode.Callsign]
		if !exists || decode.SNR > existing.SNR {
			bestDecodes[decode.Callsign] = decode
		}
	}

	// Convert map back to slice
	result := make([]*DecodeInfo, 0, len(bestDecodes))
	for _, decode := range bestDecodes {
		result = append(result, decode)
	}

	return result
}
