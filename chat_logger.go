package main

import (
	"database/sql"
	"fmt"
	"log"
	"net"
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

// LogMessage inserts a chat message into the SQLite chat_messages table with
// an automatically assigned id and status "ok".
func (cl *ChatLogger) LogMessage(timestamp time.Time, sourceIP, username, message, country, countryCode string) error {
	return cl.LogMessageFull(0, timestamp, sourceIP, username, message, country, countryCode, chatStatusOK, "")
}

// Chat message status values stored in chat_messages.status.
const (
	chatStatusOK       = "ok"
	chatStatusCensored = "censored"
	chatStatusBlocked  = "blocked"
)

// LogMessageFull inserts a chat message with an explicit id (0 = let SQLite
// assign one), a status (ok|censored|blocked, empty = ok) and the original text
// when it differs from what was shown (empty otherwise).
func (cl *ChatLogger) LogMessageFull(id int64, timestamp time.Time, sourceIP, username, message, country, countryCode, status, raw string) error {
	if !cl.enabled {
		return nil
	}
	if cl.db == nil {
		return fmt.Errorf("chat database not configured")
	}
	if status == "" {
		status = chatStatusOK
	}
	var idArg interface{}
	if id > 0 {
		idArg = id
	}
	var rawArg interface{}
	if raw != "" {
		rawArg = raw
	}
	_, err := cl.db.Exec(
		`INSERT INTO chat_messages (id, ts, source_ip, username, message, country, country_code, status, message_raw)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		idArg, timestamp.Unix(), sourceIP, username, message, country, countryCode, status, rawArg,
	)
	if err != nil {
		return fmt.Errorf("[DB] chat_messages insert error: %w", err)
	}
	return nil
}

// MaxMessageID returns the highest chat message id ever handed out: the larger
// of MAX(id) and the AUTOINCREMENT sequence, so ids never repeat even after
// retention has pruned the newest rows.
func (cl *ChatLogger) MaxMessageID() int64 {
	db := cl.readDB
	if db == nil {
		db = cl.db
	}
	if !cl.enabled || db == nil {
		return 0
	}
	var maxID, seq sql.NullInt64
	if err := db.QueryRow(`SELECT MAX(id) FROM chat_messages`).Scan(&maxID); err != nil {
		log.Printf("Chat: MaxMessageID query error: %v", err)
	}
	_ = db.QueryRow(`SELECT seq FROM sqlite_sequence WHERE name = 'chat_messages'`).Scan(&seq)
	if seq.Int64 > maxID.Int64 {
		return seq.Int64
	}
	return maxID.Int64
}

// MarkDeleted sets deleted_at/deleted_by on the given rows that are not already
// deleted. Returns the ids that were changed.
func (cl *ChatLogger) MarkDeleted(ids []int64, by string, at time.Time) ([]int64, error) {
	if !cl.enabled || cl.db == nil || len(ids) == 0 {
		return nil, nil
	}
	return chatMarkDeleted(cl.db, ids, by, at)
}

// chatMarkDeleted marks rows deleted in chunks and returns the ids it changed.
func chatMarkDeleted(db *sql.DB, ids []int64, by string, at time.Time) ([]int64, error) {
	var changed []int64
	const chunk = 500
	for start := 0; start < len(ids); start += chunk {
		end := start + chunk
		if end > len(ids) {
			end = len(ids)
		}
		part := ids[start:end]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(part)), ",")
		args := make([]interface{}, 0, len(part)+2)
		args = append(args, at.Unix(), by)
		for _, id := range part {
			args = append(args, id)
		}
		rows, err := db.Query(`UPDATE chat_messages SET deleted_at = ?, deleted_by = ?
			WHERE deleted_at IS NULL AND id IN (`+placeholders+`) RETURNING id`, args...)
		if err != nil {
			return changed, fmt.Errorf("[DB] chat_messages delete mark: %w", err)
		}
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err == nil {
				changed = append(changed, id)
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return changed, err
		}
	}
	return changed, nil
}

// FindMessageIDs returns ids of not-yet-deleted rows newer than since whose
// source IP matches ipMatch (when non-nil) and whose username equals username
// case-insensitively (when non-empty).
func (cl *ChatLogger) FindMessageIDs(since time.Time, ipMatch func(string) bool, username string) []int64 {
	db := cl.readDB
	if db == nil {
		db = cl.db
	}
	if !cl.enabled || db == nil {
		return nil
	}
	return chatFindMessageIDs(db, since, ipMatch, username)
}

func chatFindMessageIDs(db *sql.DB, since time.Time, ipMatch func(string) bool, username string) []int64 {
	// Blocked messages were never shown to anyone, so there is nothing to delete.
	query := `SELECT id, COALESCE(source_ip, '') FROM chat_messages
		WHERE ts >= ? AND deleted_at IS NULL AND COALESCE(status, 'ok') != 'blocked'`
	args := []interface{}{since.Unix()}
	if username != "" {
		query += ` AND LOWER(username) = ?`
		args = append(args, strings.ToLower(username))
	}
	rows, err := db.Query(query, args...)
	if err != nil {
		log.Printf("Chat: FindMessageIDs query error: %v", err)
		return nil
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		var ip string
		if err := rows.Scan(&id, &ip); err != nil {
			continue
		}
		if ipMatch != nil && !ipMatch(ip) {
			continue
		}
		ids = append(ids, id)
	}
	return ids
}

// LoadRecentMessages reads the newest maxMessages chat messages (oldest first
// in the result) from the last maxDays days. Deleted and blocked messages and
// messages from banned IPs are skipped. banManager may be nil.
func (cl *ChatLogger) LoadRecentMessages(maxMessages int, maxDays int, banManager *IPBanManager) []ChatMessage {
	return cl.loadRecentMessagesAt(time.Now(), maxMessages, maxDays, banManager)
}

func (cl *ChatLogger) loadRecentMessagesAt(now time.Time, maxMessages int, maxDays int, banManager *IPBanManager) []ChatMessage {
	if !cl.enabled || maxMessages <= 0 || maxDays <= 0 || cl.readDB == nil {
		return nil
	}

	cutoff := now.UTC().AddDate(0, 0, -maxDays).Unix()

	rows, err := cl.readDB.Query(
		`SELECT id, ts, COALESCE(source_ip, ''), COALESCE(username, ''), COALESCE(message, '')
		 FROM chat_messages
		 WHERE ts >= ? AND deleted_at IS NULL AND COALESCE(status, 'ok') != 'blocked'
		 ORDER BY ts DESC, id DESC
		 LIMIT ?`,
		cutoff, maxMessages*20, // headroom for ban filtering
	)
	if err != nil {
		log.Printf("Chat: LoadRecentMessages DB query error: %v", err)
		return nil
	}
	defer rows.Close()

	var newest []ChatMessage
	for rows.Next() && len(newest) < maxMessages {
		var id, ts int64
		var sourceIP, username, message string
		if err := rows.Scan(&id, &ts, &sourceIP, &username, &message); err != nil {
			log.Printf("Chat: LoadRecentMessages scan error: %v", err)
			continue
		}
		if banManager != nil && sourceIP != "" && banManager.IsBanned(sourceIP) {
			continue
		}
		newest = append(newest, ChatMessage{
			ID:        id,
			SourceIP:  sourceIP,
			Username:  username,
			Message:   message,
			Timestamp: time.Unix(ts, 0).UTC(),
		})
	}
	if err := rows.Err(); err != nil {
		log.Printf("Chat: LoadRecentMessages rows error: %v", err)
	}

	// Oldest first, as the replay buffer expects.
	for i, j := 0, len(newest)-1; i < j; i, j = i+1, j-1 {
		newest[i], newest[j] = newest[j], newest[i]
	}

	log.Printf("Chat: Seeded message buffer with %d message(s) from DB", len(newest))
	return newest
}

// GetLastKnownIPForUser returns the most recent source_ip for the given username
// (case-insensitive) from the SQLite database, looking back up to 30 days.
// Values that aren't IP addresses ("unknown", relay sources) are skipped.
// Returns "" if not found or logging is disabled.
func (cl *ChatLogger) GetLastKnownIPForUser(username string) string {
	if !cl.enabled || username == "" || cl.readDB == nil {
		return ""
	}

	cutoff := time.Now().UTC().AddDate(0, 0, -30).Unix()

	rows, err := cl.readDB.Query(
		`SELECT source_ip, MAX(ts) AS last FROM chat_messages
		 WHERE LOWER(username) = ? AND source_ip IS NOT NULL AND source_ip != '' AND ts >= ?
		 GROUP BY source_ip
		 ORDER BY last DESC`,
		strings.ToLower(username), cutoff,
	)
	if err != nil {
		return ""
	}
	defer rows.Close()
	for rows.Next() {
		var ip string
		var last int64
		if rows.Scan(&ip, &last) == nil && net.ParseIP(ip) != nil {
			return ip
		}
	}
	return ""
}

// chatMessageSource is who sent a stored message.
type chatMessageSource struct {
	IP, Username string
}

// chatMessageSources looks up the sender of each id in chat_messages. Ids
// that aren't stored are missing from the result.
func chatMessageSources(db *sql.DB, ids []int64) map[int64]chatMessageSource {
	out := make(map[int64]chatMessageSource, len(ids))
	if db == nil {
		return out
	}
	const chunk = 500
	for start := 0; start < len(ids); start += chunk {
		end := start + chunk
		if end > len(ids) {
			end = len(ids)
		}
		part := ids[start:end]
		args := make([]interface{}, len(part))
		for i, id := range part {
			args[i] = id
		}
		rows, err := db.Query(
			`SELECT id, COALESCE(source_ip, ''), COALESCE(username, '') FROM chat_messages WHERE id IN (?`+
				strings.Repeat(",?", len(part)-1)+`)`, args...)
		if err != nil {
			log.Printf("Chat: message source lookup failed: %v", err)
			continue
		}
		for rows.Next() {
			var id int64
			var src chatMessageSource
			if rows.Scan(&id, &src.IP, &src.Username) == nil {
				out[id] = src
			}
		}
		rows.Close()
	}
	return out
}

// Close is a no-op — no file handles to close.
func (cl *ChatLogger) Close() error {
	return nil
}
