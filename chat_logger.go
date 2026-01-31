package main

import (
	"encoding/csv"
	"fmt"
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
