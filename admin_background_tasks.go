package main

// admin_background_tasks.go — GET /admin/background-tasks
//                             POST /admin/background-tasks/dismiss?id=…
//
// Returns whatever long-running background work is currently registered (see
// background_tasks.go). The admin UI polls this and renders a single-line
// banner between the header and the tabs while anything is running.
//
// The handler does no work of its own: producers push progress into the
// registry, this only copies it out. An idle response is a few dozen bytes and
// one mutex acquisition, which is what lets the UI poll every 2 s during a long
// migration without costing anything the rest of the time.

import (
	"encoding/json"
	"net/http"
)

// BackgroundTasksResponse is the JSON body returned by GET /admin/background-tasks.
type BackgroundTasksResponse struct {
	Tasks []BackgroundTaskSnapshot `json:"tasks"`
	// RestartPending is true once a task that declared restart_required
	// "automatic" has completed — the server is about to go down, so the UI
	// switches to watching for it to come back instead of polling normally.
	RestartPending bool `json:"restart_pending"`
}

// HandleBackgroundTasks serves GET /admin/background-tasks.
func (ah *AdminHandler) HandleBackgroundTasks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	resp := BackgroundTasksResponse{
		Tasks:          bgTasks.Snapshot(),
		RestartPending: bgTasks.RestartPending(),
	}
	if resp.Tasks == nil {
		resp.Tasks = []BackgroundTaskSnapshot{} // always an array, never null
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(resp); err != nil {
		http.Error(w, "encode error", http.StatusInternalServerError)
	}
}

// HandleBackgroundTaskDismiss serves POST /admin/background-tasks/dismiss?id=…
// It hides the banner for a task that declared itself dismissible. The task
// keeps running; only its banner goes away, and only until the next restart
// (the registry is memory-only).
func (ah *AdminHandler) HandleBackgroundTaskDismiss(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}
	if !bgTasks.Dismiss(id) {
		http.Error(w, "unknown or non-dismissible task", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]bool{"dismissed": true})
}
