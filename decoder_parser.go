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
	// FT8 format: HHMMSS  SNR  DT  Freq  [~]  Message
	// Example: 203530   2  0.1 2535 ~  EI3CTB RT6C -16
	ft8Pattern = regexp.MustCompile(`^(\d{6})\s+(-?\d+)\s+([-\d.]+)\s+(\d+)\s+[~]?\s+(.+)$`)

	// FT4 format: Same as FT8 - HHMMSS  SNR  DT  Freq  [+~]  Message
	// Example: 130637   1  0.4  477 +  CQ RC6OD KN87
	ft4Pattern = regexp.MustCompile(`^(\d{6})\s+(-?\d+)\s+([-\d.]+)\s+(\d+)\s+[+~]?\s+(.+)$`)

	// WSPR format varies by wsprd version, typically:
	// Date Time Seq SNR DT Freq Call Grid dBm [optional extra columns]
	// Example: 251108 1552   1 -17  0.5   7.040119  IV3JJO JN66 37          0   223    0
	// Note: Seq is a sequence number, Grid can be 4 or 6 chars, or missing entirely (dBm comes right after call)
	// The regex captures call and everything after it, then we parse grid/dBm separately
	wsprPattern = regexp.MustCompile(`^(\d{6})\s+(\d{4})\s+\d+\s+(-?\d+)\s+([-\d.]+)\s+([\d.]+)\s+(\S+)\s+(.+)$`)

	// Callsign pattern (basic validation)
	// Supports standard callsigns and portable/mobile suffixes like /P, /M, /T, etc.
	// Also supports prefix notation like TA4/G8SCU or G8SCU/P
	callsignPattern = regexp.MustCompile(`^[A-Z0-9]{1,3}[0-9][A-Z0-9]{0,3}[A-Z]$|^[A-Z0-9/]+[0-9][A-Z0-9/]+$`)

	// Grid locator pattern (4, 6, or 8 characters)
	gridPattern = regexp.MustCompile(`^[A-R]{2}[0-9]{2}([a-x]{2}([0-9]{2})?)?$`)
)

// ParseFT8Line parses a line of FT8/FT4 decoder output
func ParseFT8Line(line string, dialFreq uint64, mode DecoderMode) (*DecodeInfo, error) {
	trimmed := strings.TrimSpace(line)

	// Use appropriate regex pattern based on mode
	var matches []string
	if mode == ModeFT4 {
		matches = ft4Pattern.FindStringSubmatch(trimmed)
	} else {
		matches = ft8Pattern.FindStringSubmatch(trimmed)
	}

	if matches == nil {
		return nil, fmt.Errorf("line does not match %s format", mode.String())
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
	// For FT4, the frequency may have a decimal point (e.g., "319.")
	freqStr := strings.TrimSuffix(matches[4], ".")
	freqOffset, err := strconv.ParseUint(freqStr, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("invalid frequency: %w", err)
	}

	// Calculate actual frequency
	frequency := dialFreq + freqOffset

	// Parse message
	message := strings.TrimSpace(matches[5])

	// Extract callsign and locator from message
	callsign, locator := extractCallsignLocator(message)

	// Lookup full CTY information from database
	ctyInfo := GetCallsignInfo(callsign)

	info := &DecodeInfo{
		Callsign:      callsign,
		Locator:       locator,
		SNR:           snr,
		Frequency:     frequency,
		DialFrequency: dialFreq,
		Timestamp:     timestamp,
		Mode:          mode.String(),
		Message:       message,
		HasCallsign:   callsign != "",
		HasLocator:    isValidGridLocatorForMode(locator, mode),
		IsWSPR:        false,
	}

	// Populate CTY information if available
	if ctyInfo != nil {
		info.Country = ctyInfo.Country
		info.CQZone = ctyInfo.CQZone
		info.ITUZone = ctyInfo.ITUZone
		info.Continent = ctyInfo.Continent
		info.TimeOffset = ctyInfo.TimeOffset
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
	// Strip angle brackets if present (some decoders output <CALLSIGN>)
	callsign := strings.Trim(strings.TrimSpace(matches[6]), "<>")

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

	// Lookup full CTY information from database
	ctyInfo := GetCallsignInfo(callsign)

	info := &DecodeInfo{
		Callsign:      callsign,
		Locator:       locator,
		SNR:           snr,
		Frequency:     dialFreq, // Receiver frequency
		DialFrequency: dialFreq,
		TxFrequency:   txFrequency,
		Timestamp:     timestamp,
		Mode:          "WSPR",
		Message:       fmt.Sprintf("%s %s %d", callsign, locator, dbm),
		DT:            float32(dt),
		Drift:         0, // Drift not in wsprd output format
		DBm:           dbm,
		HasCallsign:   isValidCallsign(callsign),
		HasLocator:    locator != "" && isValidGridLocator(locator),
		IsWSPR:        true,
	}

	// Populate CTY information if available
	if ctyInfo != nil {
		info.Country = ctyInfo.Country
		info.CQZone = ctyInfo.CQZone
		info.ITUZone = ctyInfo.ITUZone
		info.Continent = ctyInfo.Continent
		info.TimeOffset = ctyInfo.TimeOffset
	}

	return info, nil
}

// extractCallsignLocator extracts callsign and grid locator from FT8/FT4 message
// Per FT8 protocol: The transmitting station is ALWAYS the first callsign in the message
// Examples:
//
//	CQ K1ABC FN31        → TX = K1ABC, Grid = FN31
//	K1ABC M0DEF IO91     → TX = K1ABC, Grid = IO91
//	K1ABC M0DEF -10      → TX = K1ABC, Grid = ""
//	K1ABC M0DEF R-09     → TX = K1ABC, Grid = ""
//	K1ABC M0DEF RR73     → TX = K1ABC, Grid = ""
//
// Special case: If message starts with <...>, it's truncated and we can't determine
// the transmitter reliably, so we skip it:
//
//	<...> CU6AB HM58     → TX = "", Grid = "" (truncated, unreliable)
func extractCallsignLocator(message string) (string, string) {
	fields := strings.Fields(message)
	if len(fields) < 2 {
		return "", ""
	}

	// Check if message is truncated (starts with <...>)
	// In this case, we can't reliably determine the transmitter
	if fields[0] == "<...>" {
		return "", ""
	}

	// Find the first valid callsign in the message (this is the transmitter)
	var transmitterCall string
	for _, field := range fields {
		if isValidCallsign(field) {
			transmitterCall = field
			break
		}
	}

	// If no valid callsign found, return empty
	if transmitterCall == "" {
		return "", ""
	}

	// Now find any grid locator in the message (search all fields)
	var locator string
	for _, field := range fields {
		if isValidGridLocatorForMode(field, ModeFT8) {
			locator = field
			break
		}
	}

	return transmitterCall, locator
}

// isValidCallsign checks if a string looks like a valid amateur radio callsign
func isValidCallsign(s string) bool {
	// Strip angle brackets if present (some decoders output <CALLSIGN>)
	s = strings.Trim(s, "<>")

	if len(s) < 3 || len(s) > 15 {
		return false
	}
	// Convert to uppercase for pattern matching
	s = strings.ToUpper(s)
	return callsignPattern.MatchString(s)
}

// isValidGridLocator checks if a string looks like a valid Maidenhead grid locator
// Accepts 4, 6, or 8 character locators (used for WSPR)
func isValidGridLocator(s string) bool {
	if len(s) != 4 && len(s) != 6 && len(s) != 8 {
		return false
	}

	// Exclude FT8 protocol messages that look like grid locators
	upper := strings.ToUpper(s)
	if upper == "RR73" || upper == "RRR" || strings.HasPrefix(upper, "R-") ||
		strings.HasPrefix(upper, "R+") || upper == "73" {
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

// isValidGridLocatorForMode checks if a string is a valid grid locator for the given mode
// FT8/FT4 only accept 4-character locators, WSPR accepts 4 or 6 characters
func isValidGridLocatorForMode(s string, mode DecoderMode) bool {
	// FT8 and FT4 only support 4-character grid locators
	if mode == ModeFT8 || mode == ModeFT4 {
		if len(s) != 4 {
			return false
		}
	}

	return isValidGridLocator(s)
}

// ParseDecoderLog reads and parses a decoder log file
func ParseDecoderLog(filename string, dialFreq uint64, mode DecoderMode, bandName string, receiverLocator string) ([]*DecodeInfo, error) {
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
			if DebugMode || mode == ModeFT4 {
				log.Printf("DEBUG: Failed to parse line %d for %s: %v - Line: %q", lineCount, mode.String(), err, line)
			}
			skippedCount++
			continue
		}

		parsedCount++

		// Set band name for all decoded spots
		info.BandName = bandName

		// Calculate distance and bearing if we have both locators
		if receiverLocator != "" && info.Locator != "" {
			if IsValidMaidenheadLocator(receiverLocator) && IsValidMaidenheadLocator(info.Locator) {
				dist, bearing, err := CalculateDistanceAndBearingFromLocators(receiverLocator, info.Locator)
				if err == nil {
					info.DistanceKm = &dist
					info.BearingDeg = &bearing
				}
			}
		}

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
