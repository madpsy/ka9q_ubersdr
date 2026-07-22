package main

import (
	"database/sql"
	"fmt"
	"log"
	"strings"
	"time"
)

// ChatLogger handles logging of chat messages to SQLite.
type ChatLogger struct {
	dataDir string
	enabled bool

	// SQLite write connection (for INSERTs)
	db *sql.DB

	// SQLite read-only pool (for SELECTs)
	readDB *sql.DB
}

// SetDB wires the SQLite write connection into the chat logger.
func (cl *ChatLogger) SetDB(db *sql.DB) {
	cl.db = db
}

// SetReadDB wires the SQLite read-only pool into the chat logger.
func (cl *ChatLogger) SetReadDB(readDB *sql.DB) {
	cl.readDB = readDB
}

// NewChatLogger creates a new chat logger.
func NewChatLogger(dataDir string, enabled bool) (*ChatLogger, error) {
	if !enabled {
		return &ChatLogger{enabled: false}, nil
	}

	cl := &ChatLogger{
		dataDir: dataDir,
		enabled: true,
	}

	log.Printf("Chat logger initialized: enabled=%v", enabled)

	return cl, nil
}

// LogMessage inserts a chat message into the SQLite chat_messages table.
func (cl *ChatLogger) LogMessage(timestamp time.Time, sourceIP, username, message, country, countryCode string) error {
	if !cl.enabled {
		return nil
	}
	if cl.db == nil {
		return fmt.Errorf("chat database not configured")
	}
	_, err := cl.db.Exec(
		`INSERT INTO chat_messages (ts, source_ip, username, message, country, country_code)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		timestamp.Unix(), sourceIP, username, message, country, countryCode,
	)
	if err != nil {
		return fmt.Errorf("[DB] chat_messages insert error: %w", err)
	}
	return nil
}

// LoadRecentMessages reads up to maxMessages recent chat messages from the SQLite database.
// Messages from banned IPs are excluded. banManager may be nil (no IP filtering applied).
func (cl *ChatLogger) LoadRecentMessages(maxMessages int, maxDays int, banManager *IPBanManager) []ChatMessage {
	if !cl.enabled || maxMessages <= 0 || maxDays <= 0 || cl.readDB == nil {
		return nil
	}

	cutoff := time.Now().UTC().AddDate(0, 0, -maxDays).Unix()

	rows, err := cl.readDB.Query(
		`SELECT ts, source_ip, username, message
		 FROM chat_messages
		 WHERE ts >= ?
		 ORDER BY ts ASC
		 LIMIT ?`,
		cutoff, maxMessages*2, // fetch extra to account for ban filtering
	)
	if err != nil {
		log.Printf("Chat: LoadRecentMessages DB query error: %v", err)
		return nil
	}
	defer rows.Close()

	var all []ChatMessage
	for rows.Next() {
		var ts int64
		var sourceIP, username, message string
		if err := rows.Scan(&ts, &sourceIP, &username, &message); err != nil {
			log.Printf("Chat: LoadRecentMessages scan error: %v", err)
			continue
		}
		if banManager != nil && sourceIP != "" && banManager.IsBanned(sourceIP) {
			continue
		}
		all = append(all, ChatMessage{
			Username:  username,
			Message:   message,
			Timestamp: time.Unix(ts, 0).UTC(),
		})
	}
	if err := rows.Err(); err != nil {
		log.Printf("Chat: LoadRecentMessages rows error: %v", err)
	}

	// Take the last maxMessages entries (most recent).
	if len(all) > maxMessages {
		all = all[len(all)-maxMessages:]
	}

	log.Printf("Chat: Seeded message buffer with %d message(s) from DB", len(all))
	return all
}

// GetLastKnownIPForUser returns the most recent source_ip for the given username
// (case-insensitive) from the SQLite database, looking back up to 30 days.
// Returns "" if not found or logging is disabled.
func (cl *ChatLogger) GetLastKnownIPForUser(username string) string {
	if !cl.enabled || username == "" || cl.readDB == nil {
		return ""
	}

	cutoff := time.Now().UTC().AddDate(0, 0, -30).Unix()

	var ip string
	err := cl.readDB.QueryRow(
		`SELECT source_ip FROM chat_messages
		 WHERE LOWER(username) = ? AND source_ip != '' AND ts >= ?
		 ORDER BY ts DESC
		 LIMIT 1`,
		strings.ToLower(username), cutoff,
	).Scan(&ip)
	if err != nil {
		// sql.ErrNoRows is expected when not found — not an error worth logging
		return ""
	}
	return ip
}

// Close is a no-op — no file handles to close.
func (cl *ChatLogger) Close() error {
	return nil
}
