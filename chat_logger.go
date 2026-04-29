package main

import (
	"encoding/csv"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ChatLogger handles CSV logging of chat messages
// Logs all messages to CSV files organized by year/month/day
type ChatLogger struct {
	dataDir string
	enabled bool

	// CSV logging (one file per day)
	openFile   *os.File
	csvWriter  *csv.Writer
	currentDay string
	fileMu     sync.Mutex
}

// NewChatLogger creates a new chat logger
func NewChatLogger(dataDir string, enabled bool) (*ChatLogger, error) {
	if !enabled {
		return &ChatLogger{enabled: false}, nil
	}

	// Create data directory if it doesn't exist
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create chat log directory: %w", err)
	}

	cl := &ChatLogger{
		dataDir: dataDir,
		enabled: true,
	}

	log.Printf("Chat logger initialized: enabled=%v, dataDir=%s", enabled, dataDir)

	return cl, nil
}

// LogMessage writes a chat message to the appropriate CSV file (organized by date)
func (cl *ChatLogger) LogMessage(timestamp time.Time, sourceIP, username, message, country, countryCode string) error {
	if !cl.enabled {
		return nil
	}

	cl.fileMu.Lock()
	defer cl.fileMu.Unlock()

	// Get or create the CSV writer for this date
	writer, err := cl.getOrCreateWriter(timestamp)
	if err != nil {
		return err
	}

	// Write CSV record - csv.Writer handles all escaping automatically!
	record := []string{
		timestamp.Format(time.RFC3339),
		sourceIP,
		username,
		message, // No manual escaping needed - csv.Writer handles it
		country,
		countryCode,
	}

	if err := writer.Write(record); err != nil {
		return err
	}

	// Flush after each write to ensure data is saved
	writer.Flush()
	return writer.Error()
}

// getOrCreateWriter gets or creates a CSV writer for the given date
// File path structure: base_dir/YYYY/MM/DD/chat.csv
func (cl *ChatLogger) getOrCreateWriter(timestamp time.Time) (*csv.Writer, error) {
	dateStr := timestamp.Format("2006-01-02")

	// Check if we need to rotate to a new file
	if cl.currentDay != dateStr {
		// Close old file if open
		if cl.openFile != nil {
			cl.csvWriter.Flush()
			cl.openFile.Close()
			log.Printf("Chat logger: Closed previous log file")
		}

		// Create directory structure: dataDir/YYYY/MM/DD/
		dirPath := filepath.Join(
			cl.dataDir,
			fmt.Sprintf("%04d", timestamp.Year()),
			fmt.Sprintf("%02d", timestamp.Month()),
			fmt.Sprintf("%02d", timestamp.Day()),
		)

		if err := os.MkdirAll(dirPath, 0755); err != nil {
			return nil, fmt.Errorf("failed to create directory structure: %w", err)
		}

		// Create file: base_dir/YYYY/MM/DD/chat.csv
		filename := filepath.Join(dirPath, "chat.csv")

		file, err := os.OpenFile(filename, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			return nil, fmt.Errorf("failed to open chat log file: %w", err)
		}

		// Check if file is new (needs header)
		stat, _ := file.Stat()
		needsHeader := stat.Size() == 0

		// Create CSV writer
		writer := csv.NewWriter(file)

		// Store file and writer
		cl.openFile = file
		cl.csvWriter = writer
		cl.currentDay = dateStr

		// Write header if new file
		if needsHeader {
			header := []string{"timestamp", "source_ip", "username", "message", "country", "country_code"}
			if err := writer.Write(header); err != nil {
				return nil, fmt.Errorf("failed to write CSV header: %w", err)
			}
			writer.Flush()
			log.Printf("Chat logger: Created new log file: %s", filename)
		} else {
			log.Printf("Chat logger: Opened existing log file: %s", filename)
		}
	}

	return cl.csvWriter, nil
}

// LoadRecentMessages reads up to maxMessages recent chat messages from disk,
// walking back up to maxDays days. Messages from banned IPs are excluded.
// banManager may be nil (no IP filtering applied). Never panics on corrupt data.
func (cl *ChatLogger) LoadRecentMessages(maxMessages int, maxDays int, banManager *IPBanManager) []ChatMessage {
	if !cl.enabled || maxMessages <= 0 || maxDays <= 0 {
		return nil
	}

	// Collect day-slices in reverse chronological order, then assemble final list.
	type dayMessages struct {
		msgs []ChatMessage
	}
	days := make([]dayMessages, 0, maxDays)

	now := time.Now().UTC()

	for i := 0; i < maxDays; i++ {
		day := now.AddDate(0, 0, -i)
		filePath := filepath.Join(
			cl.dataDir,
			fmt.Sprintf("%04d", day.Year()),
			fmt.Sprintf("%02d", day.Month()),
			fmt.Sprintf("%02d", day.Day()),
			"chat.csv",
		)

		msgs, err := cl.readDayFile(filePath, banManager)
		if err != nil {
			if !os.IsNotExist(err) {
				log.Printf("Chat: Skipping corrupt/unreadable log file %s: %v", filePath, err)
			}
			continue
		}

		if len(msgs) > 0 {
			days = append(days, dayMessages{msgs: msgs})
		}

		// Early exit: if we already have more than enough messages across collected days,
		// no need to go further back.
		total := 0
		for _, d := range days {
			total += len(d.msgs)
		}
		if total >= maxMessages {
			break
		}
	}

	if len(days) == 0 {
		return nil
	}

	// days[0] = today, days[1] = yesterday, etc.
	// Rebuild in chronological order (oldest first) so we can take the tail.
	var all []ChatMessage
	for i := len(days) - 1; i >= 0; i-- {
		all = append(all, days[i].msgs...)
	}

	// Take the last maxMessages entries (most recent).
	if len(all) > maxMessages {
		all = all[len(all)-maxMessages:]
	}

	log.Printf("Chat: Seeded message buffer with %d message(s) from disk (walked back %d day(s))", len(all), len(days))
	return all
}

// readDayFile reads all valid chat messages from a single CSV day file.
// Corrupt rows are skipped with a warning; the function never returns a partial error
// that would cause the caller to skip the whole file unless the file cannot be opened at all.
func (cl *ChatLogger) readDayFile(filePath string, banManager *IPBanManager) ([]ChatMessage, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.FieldsPerRecord = -1 // Allow variable columns for forward/backward compat
	reader.LazyQuotes = true    // Be lenient with quoting to avoid getting stuck on bad data

	// Read and validate header
	header, err := reader.Read()
	if err != nil {
		return nil, fmt.Errorf("failed to read header: %w", err)
	}

	// Accept 4-column (old) or 6-column (new) format
	hasCountry := false
	switch len(header) {
	case 6:
		hasCountry = true
	case 4:
		hasCountry = false
	default:
		return nil, fmt.Errorf("unexpected header column count: %d", len(header))
	}

	var msgs []ChatMessage

	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			// Log and skip corrupt rows — never get stuck
			log.Printf("Chat: Skipping malformed CSV row in %s: %v", filePath, err)
			continue
		}

		expectedCols := 4
		if hasCountry {
			expectedCols = 6
		}
		if len(record) < expectedCols {
			log.Printf("Chat: Skipping short CSV row (%d cols, want %d) in %s", len(record), expectedCols, filePath)
			continue
		}

		// Parse timestamp — skip rows with unparseable timestamps
		ts, err := time.Parse(time.RFC3339, record[0])
		if err != nil {
			log.Printf("Chat: Skipping row with invalid timestamp %q in %s: %v", record[0], filePath, err)
			continue
		}

		sourceIP := record[1]
		username := record[2]
		message := record[3]

		// Skip messages from banned IPs
		if banManager != nil && sourceIP != "" && banManager.IsBanned(sourceIP) {
			continue
		}

		msgs = append(msgs, ChatMessage{
			Username:  username,
			Message:   message,
			Timestamp: ts.UTC(),
			// SessionID intentionally left empty — not available from logs
		})
	}

	return msgs, nil
}

// Close closes the open CSV file
func (cl *ChatLogger) Close() error {
	if !cl.enabled {
		return nil
	}

	cl.fileMu.Lock()
	defer cl.fileMu.Unlock()

	// Close open file
	if cl.openFile != nil {
		cl.csvWriter.Flush()
		if err := cl.openFile.Close(); err != nil {
			log.Printf("Warning: error closing chat log file: %v", err)
			return err
		}
		log.Printf("Chat logger: Closed log file")
	}

	return nil
}
