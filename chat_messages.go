package main

import (
	"log"
	"sort"
	"strings"
	"time"
)

// chatSeedDays is how far back the replay buffer is seeded from the database
// on start-up, and how far back IP/username deletions reach into stored rows.
const chatSeedDays = 7

// pendingChatDeleteTTL bounds how long a deletion waits for its row's
// asynchronous insert before it is forgotten.
const pendingChatDeleteTTL = time.Minute

type pendingChatDelete struct {
	by string
	at time.Time
}

// nextMessageID hands out the next chat message id.
func (cm *ChatManager) nextMessageID() int64 {
	return cm.lastID.Add(1)
}

// seedLastID raises the id counter to at least v.
func (cm *ChatManager) seedLastID(v int64) {
	for {
		cur := cm.lastID.Load()
		if v <= cur || cm.lastID.CompareAndSwap(cur, v) {
			return
		}
	}
}

// sessionIP returns the IP bound to a user session id, falling back to any
// live audio/spectrum session for it.
func (cm *ChatManager) sessionIP(sessionID string) string {
	if cm.sessionManager == nil || sessionID == "" {
		return ""
	}
	if ip := cm.sessionManager.GetUUIDIP(sessionID); ip != "" {
		return ip
	}
	return cm.GetSessionIP(sessionID)
}

// chatMessagePayload builds the chat_message frame for a message. Messages
// without an id (the personalised welcome) carry no id field.
func chatMessagePayload(msg ChatMessage) map[string]interface{} {
	data := map[string]interface{}{
		"username":  msg.Username,
		"message":   msg.Message,
		"timestamp": msg.Timestamp.Format(time.RFC3339),
	}
	if msg.ID > 0 {
		data["id"] = msg.ID
	}
	return map[string]interface{}{
		"type": "chat_message",
		"data": data,
	}
}

// chatSyncPayload builds the chat_sync frame listing the live ids of a replay.
// An empty replay gives {min_id: 0, max_id: 0, ids: []}.
func chatSyncPayload(messages []ChatMessage) map[string]interface{} {
	ids := make([]int64, 0, len(messages))
	var minID, maxID int64
	for _, m := range messages {
		if m.ID <= 0 {
			continue
		}
		ids = append(ids, m.ID)
		if minID == 0 || m.ID < minID {
			minID = m.ID
		}
		if m.ID > maxID {
			maxID = m.ID
		}
	}
	return map[string]interface{}{
		"type": "chat_sync",
		"data": map[string]interface{}{
			"min_id": minID,
			"max_id": maxID,
			"ids":    ids,
		},
	}
}

// removeFromBuffer drops matching messages from the replay buffer and returns
// the ids of those that had one.
func (cm *ChatManager) removeFromBuffer(match func(ChatMessage) bool) []int64 {
	cm.messageBufferMu.Lock()
	defer cm.messageBufferMu.Unlock()

	var ids []int64
	kept := make([]ChatMessage, 0, len(cm.messageBuffer))
	for _, msg := range cm.messageBuffer {
		if match(msg) {
			if msg.ID > 0 {
				ids = append(ids, msg.ID)
			}
			continue
		}
		kept = append(kept, msg)
	}
	cm.messageBuffer = kept
	return ids
}

// finishDelete marks the given ids deleted in the database (bufferIDs may not
// have reached it yet, so they are remembered until their insert lands),
// broadcasts one chat_messages_deleted and returns the sorted, de-duplicated
// union of bufferIDs and the stored rows actually changed.
func (cm *ChatManager) finishDelete(bufferIDs, dbIDs []int64, by string) []int64 {
	at := cm.now().UTC()

	if len(bufferIDs) > 0 && cm.chatLogger != nil {
		cm.pendingDeletesMu.Lock()
		for id, p := range cm.pendingDeletes {
			if at.Sub(p.at) > pendingChatDeleteTTL {
				delete(cm.pendingDeletes, id)
			}
		}
		for _, id := range bufferIDs {
			cm.pendingDeletes[id] = pendingChatDelete{by: by, at: at}
		}
		cm.pendingDeletesMu.Unlock()
	}

	seen := make(map[int64]bool, len(bufferIDs)+len(dbIDs))
	for _, id := range bufferIDs {
		seen[id] = true
	}

	if cm.chatLogger != nil {
		toMark := make([]int64, 0, len(bufferIDs)+len(dbIDs))
		toMark = append(toMark, bufferIDs...)
		for _, id := range dbIDs {
			if !seen[id] {
				toMark = append(toMark, id)
			}
		}
		changed, err := cm.chatLogger.MarkDeleted(toMark, by, at)
		if err != nil {
			log.Printf("Chat: failed to mark messages deleted: %v", err)
		}
		for _, id := range changed {
			seen[id] = true
		}
	}

	all := make([]int64, 0, len(seen))
	for id := range seen {
		all = append(all, id)
	}
	sort.Slice(all, func(i, j int) bool { return all[i] < all[j] })

	if len(all) > 0 {
		cm.wsHandler.broadcast(map[string]interface{}{
			"type": "chat_messages_deleted",
			"data": map[string]interface{}{"ids": all},
		})
		log.Printf("Chat: %d message(s) deleted by %s", len(all), by)
	}
	return all
}

// applyPendingDelete is called after a message row is inserted; if the message
// was deleted before the insert landed, the deletion is applied now.
func (cm *ChatManager) applyPendingDelete(id int64) {
	cm.pendingDeletesMu.Lock()
	p, ok := cm.pendingDeletes[id]
	if ok {
		delete(cm.pendingDeletes, id)
	}
	cm.pendingDeletesMu.Unlock()
	if ok && cm.chatLogger != nil {
		if _, err := cm.chatLogger.MarkDeleted([]int64{id}, p.by, p.at); err != nil {
			log.Printf("Chat: failed to mark message %d deleted: %v", id, err)
		}
	}
}

// DeleteMessages removes every buffered message for which match returns true,
// marks those rows deleted in the database and tells chat clients to remove
// them. by is recorded as deleted_by. Returns the deleted ids.
func (cm *ChatManager) DeleteMessages(match func(ChatMessage) bool, by string) []int64 {
	return cm.finishDelete(cm.removeFromBuffer(match), nil, by)
}

// DeleteMessageIDs deletes messages by id, including stored rows that are no
// longer in the replay buffer. Returns the ids actually deleted.
func (cm *ChatManager) DeleteMessageIDs(ids []int64, by string) []int64 {
	if len(ids) == 0 {
		return nil
	}
	want := make(map[int64]bool, len(ids))
	for _, id := range ids {
		want[id] = true
	}
	buffered := cm.removeFromBuffer(func(m ChatMessage) bool { return want[m.ID] })
	return cm.finishDelete(buffered, ids, by)
}

// DeleteMessagesByIP deletes messages sent from an IP address or CIDR range,
// matching the stored sender IP, so it works after the user has left and
// after a restart. Stored rows from the last chatSeedDays days are included.
func (cm *ChatManager) DeleteMessagesByIP(ipOrCIDR, by string) []int64 {
	ipOrCIDR = strings.TrimSpace(ipOrCIDR)
	if ipOrCIDR == "" {
		return nil
	}
	matchFn := buildIPMatchFunc(ipOrCIDR)
	buffered := cm.removeFromBuffer(func(m ChatMessage) bool { return matchFn(m.SourceIP) })
	var stored []int64
	if cm.chatLogger != nil {
		stored = cm.chatLogger.FindMessageIDs(cm.now().AddDate(0, 0, -chatSeedDays), matchFn, "")
	}
	return cm.finishDelete(buffered, stored, by)
}

// DeleteMessagesByUsername deletes messages sent under a username
// (case-insensitive), including stored rows from the last chatSeedDays days.
func (cm *ChatManager) DeleteMessagesByUsername(username, by string) []int64 {
	username = strings.TrimSpace(username)
	if username == "" {
		return nil
	}
	buffered := cm.removeFromBuffer(func(m ChatMessage) bool { return strings.EqualFold(m.Username, username) })
	var stored []int64
	if cm.chatLogger != nil {
		stored = cm.chatLogger.FindMessageIDs(cm.now().AddDate(0, 0, -chatSeedDays), nil, username)
	}
	return cm.finishDelete(buffered, stored, by)
}

// DeleteMessagesForSession deletes a user session's messages: by its IP when
// known (catches earlier visits too), otherwise by the session id.
func (cm *ChatManager) DeleteMessagesForSession(sessionID, by string) []int64 {
	if ip := cm.sessionIP(sessionID); ip != "" {
		return cm.DeleteMessagesByIP(ip, by)
	}
	if sessionID == "" {
		return nil
	}
	return cm.DeleteMessages(func(m ChatMessage) bool { return m.SessionID == sessionID }, by)
}
