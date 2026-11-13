package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

// maxChatDeleteIDs caps how many ids one delete request may name.
const maxChatDeleteIDs = 10000

// chatManagerOrNil returns the live chat manager, or nil when chat is off.
func (ah *AdminHandler) chatManagerOrNil() *ChatManager {
	if ah.dxClusterWsHandler == nil {
		return nil
	}
	return ah.dxClusterWsHandler.chatManager
}

// chatModHistory returns the moderation history: the chat manager's when chat
// is on, straight from the database otherwise, nil when neither exists (a nil
// history ignores writes).
func (ah *AdminHandler) chatModHistory() *chatModActions {
	if cm := ah.chatManagerOrNil(); cm != nil {
		return cm.modActions
	}
	if ah.dbManager != nil && ah.dbManager.DB() != nil {
		return &chatModActions{db: ah.dbManager.DB(), readDB: ah.dbManager.ReadDB()}
	}
	return nil
}

// recordSDRBan writes a Ban from SDR to the moderation history, unless chat
// moderation started it (it records its own). username may be empty.
func (ah *AdminHandler) recordSDRBan(ip, username, by, reason string, deleted int) {
	cm := ah.chatManagerOrNil()
	if cm != nil && cm.ClaimSDRBanFromChat(ip, deleted) {
		return
	}
	action := chatActionSDRBan
	if by == "auto" {
		action = chatActionAutoSDRBan
	}
	if _, err := ah.chatModHistory().RecordCount(action, ip, username, by, reason, time.Time{}, deleted); err != nil {
		log.Printf("Chat: failed to record Ban from SDR: %v", err)
	}
}

// chatNameForIP is the chat name last seen on ip, or "" (chat off or unknown).
func (ah *AdminHandler) chatNameForIP(ip string) string {
	if cm := ah.chatManagerOrNil(); cm != nil {
		return cm.usernameForIP(ip)
	}
	return ""
}

// recordIDDeletes writes one "delete" row per sender address for messages
// deleted by id. sources maps each id to its sender, looked up before the delete.
func recordIDDeletes(hist *chatModActions, deleted []int64, sources map[int64]chatMessageSource, by string) {
	type group struct {
		username string
		count    int
	}
	groups := map[string]*group{}
	var order []string
	for _, id := range deleted {
		src, ok := sources[id]
		if !ok {
			continue
		}
		ip := src.IP
		if ip == "unknown" {
			ip = ""
		}
		g := groups[ip]
		if g == nil {
			g = &group{}
			groups[ip] = g
			order = append(order, ip)
		}
		if g.username == "" {
			g.username = src.Username
		}
		g.count++
	}
	sort.Strings(order)
	for _, ip := range order {
		g := groups[ip]
		if _, err := hist.RecordCount(chatActionDelete, ip, g.username, by, "", time.Time{}, g.count); err != nil {
			log.Printf("Chat: failed to record delete: %v", err)
		}
	}
}

// HandleChatDelete removes chat messages for everyone: from the live chat
// window and (marked as removed) in the stored logs.
//
// POST /admin/chat/delete {ids?:[int], ip?:string, username?:string}
// -> {status:"success", deleted:int, message}
func (ah *AdminHandler) HandleChatDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		IDs      []int64 `json:"ids"`
		IP       string  `json:"ip"`
		Username string  `json:"username"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	req.IP = strings.TrimSpace(req.IP)
	req.Username = strings.TrimSpace(req.Username)

	if len(req.IDs) == 0 && req.IP == "" && req.Username == "" {
		http.Error(w, "Choose the messages to delete (ids, ip or username)", http.StatusBadRequest)
		return
	}
	if len(req.IDs) > maxChatDeleteIDs {
		http.Error(w, fmt.Sprintf("Too many messages in one request (maximum %d)", maxChatDeleteIDs), http.StatusBadRequest)
		return
	}
	if req.IP != "" {
		if _, _, err := net.ParseCIDR(req.IP); err != nil && net.ParseIP(req.IP) == nil {
			http.Error(w, "Not a valid IP address", http.StatusBadRequest)
			return
		}
	}

	const by = "admin"
	deleted := map[int64]bool{}
	add := func(ids []int64) {
		for _, id := range ids {
			deleted[id] = true
		}
	}

	// Who sent each id, looked up before the delete so it can be recorded:
	// the live buffer first (newest rows may not be stored yet), then the logs.
	var sources map[int64]chatMessageSource
	if len(req.IDs) > 0 {
		if ah.dbManager != nil {
			sources = chatMessageSources(ah.dbManager.ReadDB(), req.IDs)
		} else {
			sources = map[int64]chatMessageSource{}
		}
		if cm := ah.chatManagerOrNil(); cm != nil {
			want := make(map[int64]bool, len(req.IDs))
			for _, id := range req.IDs {
				want[id] = true
			}
			for _, m := range cm.GetBufferedMessages() {
				if want[m.ID] {
					sources[m.ID] = chatMessageSource{IP: m.SourceIP, Username: m.Username}
				}
			}
		}
	}
	var byID []int64

	if cm := ah.chatManagerOrNil(); cm != nil {
		if len(req.IDs) > 0 {
			byID = cm.DeleteMessageIDs(req.IDs, by)
			add(byID)
		}
		if req.IP != "" {
			add(cm.DeleteMessagesByIP(req.IP, by))
		}
		if req.Username != "" {
			add(cm.DeleteMessagesByUsername(req.Username, by))
		}
	} else {
		// Chat is switched off: only the stored logs need updating.
		if ah.dbManager == nil || ah.dbManager.DB() == nil {
			http.Error(w, "Chat logs are not available (database not configured)", http.StatusServiceUnavailable)
			return
		}
		now := time.Now().UTC()
		if len(req.IDs) > 0 {
			changed, err := chatMarkDeleted(ah.dbManager.DB(), req.IDs, by, now)
			if err != nil {
				log.Printf("Chat: admin delete failed: %v", err)
				http.Error(w, "Could not delete the messages", http.StatusInternalServerError)
				return
			}
			byID = changed
			add(changed)
		}
		var ids []int64
		since := now.AddDate(0, 0, -chatSeedDays)
		if req.IP != "" {
			ids = append(ids, chatFindMessageIDs(ah.dbManager.ReadDB(), since, buildIPMatchFunc(req.IP), "")...)
		}
		if req.Username != "" {
			ids = append(ids, chatFindMessageIDs(ah.dbManager.ReadDB(), since, nil, req.Username)...)
		}
		changed, err := chatMarkDeleted(ah.dbManager.DB(), ids, by, now)
		if err != nil {
			log.Printf("Chat: admin delete failed: %v", err)
			http.Error(w, "Could not delete the messages", http.StatusInternalServerError)
			return
		}
		add(changed)
	}

	n := len(deleted)
	hist := ah.chatModHistory()

	// Deleting someone's messages is part of their moderation record: one row
	// per sender for deletes by id ...
	if len(byID) > 0 {
		recordIDDeletes(hist, byID, sources, by)
	}
	// ... and one row for a delete by address or name (what it added).
	if extra := n - len(byID); extra > 0 && (req.IP != "" || req.Username != "") {
		ip := req.IP
		if ip == "" {
			if cm := ah.chatManagerOrNil(); cm != nil {
				ip, _ = cm.GetIPForUsername(req.Username)
			}
		}
		if _, err := hist.RecordCount(chatActionDelete, ip, req.Username, by, "", time.Time{}, extra); err != nil {
			log.Printf("Chat: failed to record delete: %v", err)
		}
	}

	ids := make([]int64, 0, n)
	for id := range deleted {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })

	var msg string
	switch n {
	case 0:
		msg = "No messages to delete. They may already have been removed."
	case 1:
		msg = "Deleted 1 message"
	default:
		msg = fmt.Sprintf("Deleted %d messages", n)
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"deleted": n,
		"ids":     ids,
		"message": msg,
	}); err != nil {
		log.Printf("Error encoding chat delete response: %v", err)
	}
}

// chatAdminBodyLimit caps the request body of the moderation endpoints.
const chatAdminBodyLimit = 64 << 10

// ChatModAdminAPI serves Admin -> Chat -> Moderation: the word/link settings,
// the test box, chat bans and the moderation history.
type ChatModAdminAPI struct {
	ah    *AdminHandler
	store *ChatModerationStore
}

// NewChatModAdminAPI ties the moderation endpoints to the admin handler (for
// the chat manager and database) and the settings store.
func NewChatModAdminAPI(ah *AdminHandler, store *ChatModerationStore) *ChatModAdminAPI {
	return &ChatModAdminAPI{ah: ah, store: store}
}

func (api *ChatModAdminAPI) chat() *ChatManager {
	if api.ah == nil {
		return nil
	}
	return api.ah.chatManagerOrNil()
}

// actions returns the moderation history, from the chat manager when chat is
// on and straight from the database otherwise.
func (api *ChatModAdminAPI) actions() *chatModActions {
	if cm := api.chat(); cm != nil {
		return cm.modActions
	}
	if api.ah != nil && api.ah.dbManager != nil {
		return &chatModActions{db: api.ah.dbManager.DB(), readDB: api.ah.dbManager.ReadDB()}
	}
	return nil
}

func chatWriteJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("Chat admin: error encoding response: %v", err)
	}
}

// chatDecodeBody reads a JSON body of at most chatAdminBodyLimit bytes into v,
// writing a plain 400 and returning false when it can't.
func chatDecodeBody(w http.ResponseWriter, r *http.Request, v interface{}) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, chatAdminBodyLimit))
	if err := dec.Decode(v); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			http.Error(w, "The request is too large", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "The request could not be read (invalid JSON)", http.StatusBadRequest)
		}
		return false
	}
	return true
}

// HandleModeration reads (GET) or saves (PUT) the chat moderation settings.
//
// GET /admin/chat/moderation -> {settings, builtin_words, builtin_count}
// PUT /admin/chat/moderation <settings> -> {status, settings, notes, rejected}
func (api *ChatModAdminAPI) HandleModeration(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		words := BuiltinChatWords()
		chatWriteJSON(w, http.StatusOK, map[string]interface{}{
			"settings":      api.store.Settings(),
			"builtin_words": words,
			"builtin_count": len(words),
		})
	case http.MethodPut:
		// Start from the current settings so a partial body only changes what it names.
		in := api.store.Settings()
		if !chatDecodeBody(w, r, &in) {
			return
		}
		out, notes, rejected, err := api.store.Update(in)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if notes == nil {
			notes = []string{}
		}
		if rejected == nil {
			rejected = []RejectedWord{}
		}
		log.Printf("Chat: moderation settings saved by admin")
		chatWriteJSON(w, http.StatusOK, map[string]interface{}{
			"status":   "success",
			"settings": out,
			"notes":    notes,
			"rejected": rejected,
		})
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// HandleModerationTest shows what chat would do with a message.
//
// POST /admin/chat/moderation/test {message} -> {result, output, matches, reason}
func (api *ChatModAdminAPI) HandleModerationTest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Message *string `json:"message"`
	}
	if !chatDecodeBody(w, r, &req) {
		return
	}
	if req.Message == nil || strings.TrimSpace(*req.Message) == "" {
		http.Error(w, "Type a message to test", http.StatusBadRequest)
		return
	}
	// Same steps as a real message: tidy, then filter.
	text := preventAllCaps(sanitizeMessage(*req.Message))
	res := api.store.Filter().Check(text)
	matches := res.Matches
	if matches == nil {
		matches = []string{}
	}
	chatWriteJSON(w, http.StatusOK, map[string]interface{}{
		"result":  res.Status,
		"output":  res.Output,
		"matches": matches,
		"reason":  res.Reason,
	})
}

// HandleBans lists the chat bans in force.
//
// GET /admin/chat/bans -> {bans:[{ip, username, reason, by, created, until}]}
func (api *ChatModAdminAPI) HandleBans(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	type banJSON struct {
		IP       string `json:"ip"`
		Username string `json:"username"`
		Reason   string `json:"reason"`
		By       string `json:"by"`
		Created  string `json:"created"`
		Until    string `json:"until"`
	}
	bans := []banJSON{}
	if cm := api.chat(); cm != nil {
		for _, b := range cm.ChatBans() {
			bans = append(bans, banJSON{b.IP, b.Username, b.Reason, b.By, b.Created.UTC().Format(time.RFC3339), b.Until.UTC().Format(time.RFC3339)})
		}
	} else if a := api.actions(); a != nil {
		latest := map[string]chatStoredBan{}
		for _, b := range a.ActiveBans() {
			latest[b.IP] = b
		}
		for _, b := range latest {
			bans = append(bans, banJSON{b.IP, b.Username, b.Reason, b.By, b.Created.Format(time.RFC3339), b.Until.Format(time.RFC3339)})
		}
		sort.Slice(bans, func(i, j int) bool { return bans[i].Until < bans[j].Until })
	}
	chatWriteJSON(w, http.StatusOK, map[string]interface{}{"bans": bans})
}

// HandleBan chat-bans someone by name or IP address.
//
// POST /admin/chat/ban {username?|ip?, duration_sec, reason?, delete?} -> {status, message}
func (api *ChatModAdminAPI) HandleBan(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		Username    string `json:"username"`
		IP          string `json:"ip"`
		DurationSec int64  `json:"duration_sec"`
		Reason      string `json:"reason"`
		Delete      bool   `json:"delete"`
	}
	if !chatDecodeBody(w, r, &req) {
		return
	}
	req.Username = strings.TrimSpace(req.Username)
	req.IP = strings.TrimSpace(req.IP)
	req.Reason = trimString(strings.TrimSpace(req.Reason), 200)

	if req.Username == "" && req.IP == "" {
		http.Error(w, "Enter a chat name or an IP address", http.StatusBadRequest)
		return
	}
	if !chatBanPresetOK(req.DurationSec) {
		http.Error(w, "Choose a chat ban length: 15 minutes, 1 hour, 24 hours, 7 days or 30 days", http.StatusBadRequest)
		return
	}
	if req.IP != "" && net.ParseIP(req.IP) == nil {
		http.Error(w, "Not a valid IP address", http.StatusBadRequest)
		return
	}
	cm := api.chat()
	if cm == nil {
		http.Error(w, "Chat is switched off on this receiver", http.StatusServiceUnavailable)
		return
	}
	if strings.HasPrefix(req.Username, "~") {
		http.Error(w, "Relayed users can't be chat-banned. Delete their messages instead.", http.StatusBadRequest)
		return
	}
	ip := req.IP
	if ip == "" {
		ip, _ = cm.GetIPForUsername(req.Username)
		if strings.HasPrefix(ip, "telegram:") {
			http.Error(w, "Relayed users can't be chat-banned. Delete their messages instead.", http.StatusBadRequest)
			return
		}
		if net.ParseIP(ip) == nil {
			http.Error(w, "No address is known for "+req.Username+". Try their IP address instead.", http.StatusNotFound)
			return
		}
	}

	dur := time.Duration(req.DurationSec) * time.Second
	res, err := cm.ChatBan(ip, dur, "admin", req.Reason, req.Username, req.Delete)
	if err != nil {
		http.Error(w, "Could not chat-ban: "+err.Error(), http.StatusBadRequest)
		return
	}
	who := req.Username
	if who == "" {
		who = ip
	}
	msg := fmt.Sprintf("%s is banned from chat for %s", who, formatChatDuration(dur))
	if res.Deleted > 0 {
		if res.Deleted == 1 {
			msg += " (1 message deleted)"
		} else {
			msg += fmt.Sprintf(" (%d messages deleted)", res.Deleted)
		}
	}
	if res.SDRBanned {
		msg += ". This was their repeat chat ban, so they are now also banned from the SDR"
	}
	chatWriteJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "success",
		"message": msg,
		"until":   res.Until.Format(time.RFC3339),
	})
}

// HandleLift ends a chat ban early.
//
// POST /admin/chat/lift {ip} -> {status, message}
func (api *ChatModAdminAPI) HandleLift(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		IP string `json:"ip"`
	}
	if !chatDecodeBody(w, r, &req) {
		return
	}
	req.IP = strings.TrimSpace(req.IP)
	if req.IP == "" {
		http.Error(w, "Which IP address? (ip is missing)", http.StatusBadRequest)
		return
	}
	cm := api.chat()
	if cm == nil {
		http.Error(w, "Chat is switched off on this receiver", http.StatusServiceUnavailable)
		return
	}
	ban, ok := cm.activeChatBan(req.IP)
	if !ok || !cm.LiftChatBan(req.IP, "admin") {
		http.Error(w, "There is no chat ban on that address. It may already have ended.", http.StatusNotFound)
		return
	}
	who := ban.Username
	if who == "" {
		who = req.IP
	}
	chatWriteJSON(w, http.StatusOK, map[string]interface{}{
		"status":  "success",
		"message": "Chat ban lifted for " + who,
	})
}

// HandleActions lists recent moderation actions, newest first.
//
// GET /admin/chat/actions?limit=50&q=<name or ip> -> {actions:[...]}
func (api *ChatModAdminAPI) HandleActions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 500 {
			http.Error(w, "limit must be a number from 1 to 500", http.StatusBadRequest)
			return
		}
		limit = n
	}
	q := trimString(strings.TrimSpace(r.URL.Query().Get("q")), 64)
	list, err := api.actions().Recent(limit, q)
	if err != nil {
		log.Printf("Chat admin: actions query failed: %v", err)
		http.Error(w, "Could not read the moderation history", http.StatusInternalServerError)
		return
	}
	chatWriteJSON(w, http.StatusOK, map[string]interface{}{"actions": list})
}
