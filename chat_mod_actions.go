package main

import (
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// Chat moderation actions stored in chat_mod_actions.action.
const (
	chatActionWarn        = "warn"
	chatActionAutoWarn    = "auto_warn"
	chatActionDelete      = "delete"
	chatActionChatBan     = "chat_ban"
	chatActionAutoChatBan = "auto_chat_ban"
	chatActionLift        = "lift"
	chatActionSDRBan      = "sdr_ban"
	chatActionAutoSDRBan  = "auto_sdr_ban"
)

// chatRecordDays is how far back the moderation record shown to moderators
// (warnings, chat bans, removed messages) reaches.
const chatRecordDays = 30

// chatModActions reads and writes the chat moderation history
// (chat_mod_actions). Writes go to db, reads to readDB (falling back to db).
// A nil database makes every call a harmless no-op.
type chatModActions struct {
	db     *sql.DB
	readDB *sql.DB
	now    func() time.Time
}

// ChatModAction is one row of the moderation history.
type ChatModAction struct {
	ID        int64  `json:"id"`
	TS        string `json:"ts"` // RFC3339 UTC
	Action    string `json:"action"`
	IP        string `json:"ip"`
	Username  string `json:"username"`
	By        string `json:"by"`
	Reason    string `json:"reason"`
	ExpiresAt string `json:"expires_at,omitempty"` // RFC3339 UTC, chat bans only
	LiftedAt  string `json:"lifted_at,omitempty"`
	Count     int    `json:"count,omitempty"`
}

// ChatModRecord summarises one address's last 30 days.
type ChatModRecord struct {
	Warnings int `json:"warnings"`
	ChatBans int `json:"chat_bans"`
	Deleted  int `json:"deleted"`
}

// chatStoredBan is an active chat ban as stored in the database.
type chatStoredBan struct {
	IP, Username, By, Reason string
	Created, Until           time.Time
}

func (a *chatModActions) clock() time.Time {
	if a.now != nil {
		return a.now()
	}
	return time.Now()
}

func (a *chatModActions) reader() *sql.DB {
	if a == nil {
		return nil
	}
	if a.readDB != nil {
		return a.readDB
	}
	return a.db
}

// Record writes one action. expires is zero for anything but a chat ban.
func (a *chatModActions) Record(action, ip, username, by, reason string, expires time.Time) (int64, error) {
	return a.RecordCount(action, ip, username, by, reason, expires, 0)
}

// RecordCount is Record with a count (e.g. how many messages were deleted).
func (a *chatModActions) RecordCount(action, ip, username, by, reason string, expires time.Time, count int) (int64, error) {
	if a == nil || a.db == nil {
		return 0, nil
	}
	var exp, cnt interface{}
	if !expires.IsZero() {
		exp = expires.UTC().Unix()
	}
	if count > 0 {
		cnt = count
	}
	res, err := a.db.Exec(
		`INSERT INTO chat_mod_actions (ts, action, ip, username, by_who, reason, expires_at, count)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		a.clock().UTC().Unix(), action, ip, username, by, reason, exp, cnt,
	)
	if err != nil {
		return 0, fmt.Errorf("[DB] chat_mod_actions insert error: %w", err)
	}
	return res.LastInsertId()
}

// MarkLifted closes every open chat ban for ip.
func (a *chatModActions) MarkLifted(ip string) error {
	if a == nil || a.db == nil {
		return nil
	}
	_, err := a.db.Exec(
		`UPDATE chat_mod_actions SET lifted_at = ?
		 WHERE ip = ? AND action IN (?, ?) AND lifted_at IS NULL`,
		a.clock().UTC().Unix(), ip, chatActionChatBan, chatActionAutoChatBan,
	)
	return err
}

// Record30d counts warnings, chat bans and removed messages for ip over the
// last 30 days.
func (a *chatModActions) Record30d(ip string) ChatModRecord {
	var rec ChatModRecord
	db := a.reader()
	if db == nil || ip == "" {
		return rec
	}
	since := a.clock().UTC().AddDate(0, 0, -chatRecordDays).Unix()
	_ = db.QueryRow(
		`SELECT
			COALESCE(SUM(CASE WHEN action IN (?, ?) THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN action IN (?, ?) THEN 1 ELSE 0 END), 0)
		 FROM chat_mod_actions WHERE ip = ? AND ts >= ?`,
		chatActionWarn, chatActionAutoWarn, chatActionChatBan, chatActionAutoChatBan, ip, since,
	).Scan(&rec.Warnings, &rec.ChatBans)
	_ = db.QueryRow(
		`SELECT COUNT(*) FROM chat_messages
		 WHERE source_ip = ? AND deleted_at IS NOT NULL AND deleted_at >= ? AND COALESCE(status, 'ok') != 'blocked'`,
		ip, since,
	).Scan(&rec.Deleted)
	return rec
}

// ChatBansSince counts chat bans (by anyone) for ip since t.
func (a *chatModActions) ChatBansSince(ip string, t time.Time) int {
	db := a.reader()
	if db == nil {
		return 0
	}
	var n int
	_ = db.QueryRow(
		`SELECT COUNT(*) FROM chat_mod_actions WHERE ip = ? AND action IN (?, ?) AND ts >= ?`,
		ip, chatActionChatBan, chatActionAutoChatBan, t.UTC().Unix(),
	).Scan(&n)
	return n
}

// WarningsByUsername counts warnings per username since t.
func (a *chatModActions) WarningsByUsername(t time.Time) map[string]int {
	out := map[string]int{}
	db := a.reader()
	if db == nil {
		return out
	}
	rows, err := db.Query(
		`SELECT username, COUNT(*) FROM chat_mod_actions
		 WHERE action IN (?, ?) AND ts >= ? AND username IS NOT NULL AND username != ''
		 GROUP BY username`,
		chatActionWarn, chatActionAutoWarn, t.UTC().Unix(),
	)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		var n int
		if rows.Scan(&name, &n) == nil {
			out[name] += n
		}
	}
	return out
}

// Recent returns the newest actions first. q (optional) matches part of the
// username (any case) or IP.
func (a *chatModActions) Recent(limit int, q string) ([]ChatModAction, error) {
	out := []ChatModAction{}
	db := a.reader()
	if db == nil {
		return out, nil
	}
	if limit <= 0 {
		limit = 50
	}
	query := `SELECT id, ts, action, COALESCE(ip, ''), COALESCE(username, ''), COALESCE(by_who, ''),
			COALESCE(reason, ''), expires_at, lifted_at, COALESCE(count, 0)
		 FROM chat_mod_actions`
	args := []interface{}{}
	if q = strings.TrimSpace(q); q != "" {
		like := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(strings.ToLower(q)) + "%"
		query += ` WHERE LOWER(username) LIKE ? ESCAPE '\' OR ip LIKE ? ESCAPE '\'`
		args = append(args, like, like)
	}
	query += ` ORDER BY ts DESC, id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := db.Query(query, args...)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var r ChatModAction
		var ts int64
		var exp, lifted sql.NullInt64
		if err := rows.Scan(&r.ID, &ts, &r.Action, &r.IP, &r.Username, &r.By, &r.Reason, &exp, &lifted, &r.Count); err != nil {
			return out, err
		}
		r.TS = time.Unix(ts, 0).UTC().Format(time.RFC3339)
		if exp.Valid {
			r.ExpiresAt = time.Unix(exp.Int64, 0).UTC().Format(time.RFC3339)
		}
		if lifted.Valid {
			r.LiftedAt = time.Unix(lifted.Int64, 0).UTC().Format(time.RFC3339)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ActiveBans returns the chat bans still in force (not expired, not lifted),
// newest last, so a later ban for the same IP wins when loaded into a map.
func (a *chatModActions) ActiveBans() []chatStoredBan {
	var out []chatStoredBan
	db := a.reader()
	if db == nil {
		return out
	}
	rows, err := db.Query(
		`SELECT COALESCE(ip, ''), COALESCE(username, ''), COALESCE(by_who, ''), COALESCE(reason, ''), ts, expires_at
		 FROM chat_mod_actions
		 WHERE action IN (?, ?) AND expires_at > ? AND lifted_at IS NULL AND ip IS NOT NULL AND ip != ''
		 ORDER BY ts, id`,
		chatActionChatBan, chatActionAutoChatBan, a.clock().UTC().Unix(),
	)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var b chatStoredBan
		var ts, exp int64
		if rows.Scan(&b.IP, &b.Username, &b.By, &b.Reason, &ts, &exp) == nil {
			b.Created = time.Unix(ts, 0).UTC()
			b.Until = time.Unix(exp, 0).UTC()
			out = append(out, b)
		}
	}
	return out
}
