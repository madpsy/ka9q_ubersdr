package digitalvoice

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	messageEvent = byte(0x40)
	messageAudio = byte(0x41)
	messageError = byte(0x42)
)

var (
	ansiPattern        = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)
	colorCodePattern   = regexp.MustCompile(`(?i)color\s+code\s*=\s*(\d+)`)
	slotPattern        = regexp.MustCompile(`(?i)(?:slot|vc)\s*([12])`)
	sourcePattern      = regexp.MustCompile(`(?i)(?:source|src|from)\s*[:=]\s*(\d+)`)
	targetPattern      = regexp.MustCompile(`(?i)(?:target|tgt|to|group)\s*[:=]\s*(\d+)`)
	nacPattern         = regexp.MustCompile(`(?i)\bNAC\s*[:=]\s*([0-9a-f]+)`)
	encryptedPattern   = regexp.MustCompile(`(?i)\b(?:encrypted|encryption|enc)\b`)
	interestingPattern = regexp.MustCompile(`(?i)(sync:|DMR|P25|NXDN|D-?STAR|YSF|M17|dPMR|ProVoice|EDACS|X2-TDMA|voice|data|call|color\s+code|NAC|error|warning)`)
)

// Event is sent to the browser as a JSON payload prefixed with messageEvent.
// Raw contains DSD-FME's human-readable decode line; commonly useful fields
// are also normalized when present.
type Event struct {
	Type      string `json:"type"`
	Protocol  string `json:"protocol"`
	Timestamp string `json:"timestamp"`
	Raw       string `json:"raw"`
	Encrypted bool   `json:"encrypted,omitempty"`
	Slot      int    `json:"slot,omitempty"`
	ColorCode int    `json:"color_code,omitempty"`
	SourceID  int64  `json:"source_id,omitempty"`
	TargetID  int64  `json:"target_id,omitempty"`
	NAC       string `json:"nac,omitempty"`
}

func parseEvent(defaultProtocol, line string, now time.Time) (Event, bool) {
	line = strings.TrimSpace(ansiPattern.ReplaceAllString(line, ""))
	if line == "" || !interestingPattern.MatchString(line) {
		return Event{}, false
	}

	event := Event{
		Type:      "digital_voice_event",
		Protocol:  inferProtocol(defaultProtocol, line),
		Timestamp: now.UTC().Format(time.RFC3339Nano),
		Raw:       line,
		Encrypted: encryptedPattern.MatchString(line),
	}
	if match := slotPattern.FindStringSubmatch(line); len(match) == 2 {
		event.Slot, _ = strconv.Atoi(match[1])
	}
	if match := colorCodePattern.FindStringSubmatch(line); len(match) == 2 {
		event.ColorCode, _ = strconv.Atoi(match[1])
	}
	if match := sourcePattern.FindStringSubmatch(line); len(match) == 2 {
		event.SourceID, _ = strconv.ParseInt(match[1], 10, 64)
	}
	if match := targetPattern.FindStringSubmatch(line); len(match) == 2 {
		event.TargetID, _ = strconv.ParseInt(match[1], 10, 64)
	}
	if match := nacPattern.FindStringSubmatch(line); len(match) == 2 {
		event.NAC = strings.ToUpper(match[1])
	}
	return event, true
}

func inferProtocol(fallback, line string) string {
	upper := strings.ToUpper(line)
	switch {
	case strings.Contains(upper, "DMR"):
		return "dmr"
	case strings.Contains(upper, "P25"):
		return "p25"
	case strings.Contains(upper, "NXDN"), strings.Contains(upper, "IDAS"):
		return "nxdn"
	case strings.Contains(upper, "D-STAR"), strings.Contains(upper, "DSTAR"):
		return "dstar"
	case strings.Contains(upper, "YSF"):
		return "ysf"
	case strings.Contains(upper, "M17"):
		return "m17"
	case strings.Contains(upper, "DPMR"):
		return "dpmr"
	case strings.Contains(upper, "PROVOICE"):
		return "provoice"
	case strings.Contains(upper, "EDACS"):
		return "edacs"
	case strings.Contains(upper, "X2-TDMA"), strings.Contains(upper, "X2TDMA"):
		return "x2tdma"
	default:
		return fallback
	}
}

func eventMessage(event Event) []byte {
	payload, err := json.Marshal(event)
	if err != nil {
		return nil
	}
	return append([]byte{messageEvent}, payload...)
}
