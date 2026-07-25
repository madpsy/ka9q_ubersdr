package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// newTestRegistry returns an isolated registry so tests never touch the global.
func newTestRegistry() *BackgroundTaskRegistry {
	return &BackgroundTaskRegistry{tasks: make(map[string]*BackgroundTask)}
}

func TestBackgroundTaskLifecycle(t *testing.T) {
	r := newTestRegistry()
	if got := r.Snapshot(); len(got) != 0 {
		t.Fatalf("empty registry: got %d tasks", len(got))
	}

	task := r.Start("job", BackgroundTaskOpts{
		Name:            "Job",
		Description:     "does a thing",
		RestartRequired: BGRestartAutomatic,
	})

	snap := r.Snapshot()
	if len(snap) != 1 || snap[0].State != BGTaskRunning || snap[0].Progress != 0 {
		t.Fatalf("after Start: %+v", snap)
	}
	if snap[0].Severity != "info" {
		t.Errorf("severity should default to info, got %q", snap[0].Severity)
	}
	if r.RestartPending() {
		t.Error("restart must not be pending while the task is still running")
	}

	// Progress updates land once the throttle window has passed.
	time.Sleep(backgroundTaskMinUpdate)
	task.SetProgressStep(42.5, "step two")
	snap = r.Snapshot()
	if snap[0].Progress != 42.5 || snap[0].Step != "step two" {
		t.Fatalf("after SetProgressStep: %+v", snap[0])
	}

	// Updates inside the throttle window are dropped.
	task.SetProgressStep(99, "too soon")
	if snap = r.Snapshot(); snap[0].Progress != 42.5 {
		t.Errorf("throttled update should have been dropped, got %v", snap[0].Progress)
	}

	// Completion always lands, throttle or not, and pins progress at 100.
	task.Complete("all done")
	snap = r.Snapshot()
	if snap[0].State != BGTaskComplete || snap[0].Progress != 100 || snap[0].Step != "all done" {
		t.Fatalf("after Complete: %+v", snap[0])
	}
	if !r.RestartPending() {
		t.Error("completed automatic-restart task should report restart pending")
	}
}

func TestBackgroundTaskProgressClamped(t *testing.T) {
	r := newTestRegistry()
	task := r.Start("job", BackgroundTaskOpts{Name: "Job"})

	time.Sleep(backgroundTaskMinUpdate)
	task.SetProgress(150)
	if got := r.Snapshot()[0].Progress; got != 100 {
		t.Errorf("over-100 progress should clamp to 100, got %v", got)
	}

	time.Sleep(backgroundTaskMinUpdate)
	task.SetProgress(-7)
	if got := r.Snapshot()[0].Progress; got != -1 {
		t.Errorf("negative progress should normalise to -1 (indeterminate), got %v", got)
	}
}

func TestBackgroundTaskFailKeepsProgress(t *testing.T) {
	r := newTestRegistry()
	task := r.Start("job", BackgroundTaskOpts{Name: "Job", RestartRequired: BGRestartAutomatic})

	time.Sleep(backgroundTaskMinUpdate)
	task.SetProgress(30)
	task.Fail(errors.New("disk full"))

	snap := r.Snapshot()[0]
	if snap.State != BGTaskFailed {
		t.Fatalf("state = %q, want failed", snap.State)
	}
	if snap.Progress != 30 {
		t.Errorf("Fail should keep the progress reached, got %v", snap.Progress)
	}
	if snap.Error != "disk full" {
		t.Errorf("error = %q", snap.Error)
	}
	if snap.Severity != "warning" {
		t.Errorf("failed task should be a warning, got %q", snap.Severity)
	}
	if r.RestartPending() {
		t.Error("a failed task must not promise a restart")
	}
}

func TestBackgroundTaskRetentionSweep(t *testing.T) {
	r := newTestRegistry()
	task := r.Start("job", BackgroundTaskOpts{Name: "Job"})
	task.Complete("done")

	if len(r.Snapshot()) != 1 {
		t.Fatal("a just-finished task must stay visible")
	}

	// Age it past the retention window.
	task.mu.Lock()
	task.finishedAt = time.Now().Add(-backgroundTaskRetention - time.Second)
	task.mu.Unlock()

	if got := r.Snapshot(); len(got) != 0 {
		t.Fatalf("expired task should have been swept, got %+v", got)
	}
	r.mu.Lock()
	n := len(r.tasks)
	r.mu.Unlock()
	if n != 0 {
		t.Errorf("expired task left in the map (%d entries)", n)
	}
}

func TestBackgroundTaskDismiss(t *testing.T) {
	r := newTestRegistry()
	r.Start("sticky", BackgroundTaskOpts{Name: "Sticky"})
	r.Start("hideable", BackgroundTaskOpts{Name: "Hideable", Dismissible: true})

	if r.Dismiss("sticky") {
		t.Error("non-dismissible task should refuse to be dismissed")
	}
	if r.Dismiss("nope") {
		t.Error("unknown id should return false")
	}
	if !r.Dismiss("hideable") {
		t.Fatal("dismissible task should be dismissed")
	}

	snap := r.Snapshot()
	if len(snap) != 1 || snap[0].ID != "sticky" {
		t.Fatalf("dismissed task should be hidden, got %+v", snap)
	}
}

func TestBackgroundTaskSnapshotOrderedOldestFirst(t *testing.T) {
	r := newTestRegistry()
	first := r.Start("a", BackgroundTaskOpts{Name: "A"})
	first.mu.Lock()
	first.startedAt = time.Now().Add(-time.Hour)
	first.mu.Unlock()
	r.Start("b", BackgroundTaskOpts{Name: "B"})

	snap := r.Snapshot()
	if len(snap) != 2 || snap[0].ID != "a" || snap[1].ID != "b" {
		t.Fatalf("snapshot should be oldest-first, got %+v", snap)
	}
	if snap[0].ElapsedSeconds < 3600 {
		t.Errorf("elapsed = %d, want >= 3600", snap[0].ElapsedSeconds)
	}
}

func TestBackgroundTaskNilSafe(t *testing.T) {
	var task *BackgroundTask // producer that never started one
	task.SetProgress(50)
	task.SetStep("x")
	task.SetProgressStep(50, "x")
	task.Complete("x")
	task.Fail(errors.New("x")) // must not panic
}

func TestHandleBackgroundTasksJSON(t *testing.T) {
	// Uses the global registry, which is what the handler reads.
	bgTasks = newTestRegistry()
	defer func() { bgTasks = newTestRegistry() }()

	ah := &AdminHandler{}

	// Idle: an empty array, never null.
	rec := httptest.NewRecorder()
	ah.HandleBackgroundTasks(rec, httptest.NewRequest(http.MethodGet, "/admin/background-tasks", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if body := rec.Body.String(); !contains(body, `"tasks":[]`) {
		t.Errorf("idle body should carry an empty array, got %s", body)
	}

	task := bgTasks.Start("db-migration", BackgroundTaskOpts{
		Name:            "Historical data migration",
		RestartRequired: BGRestartAutomatic,
	})
	task.Complete("migration complete — restarting server")

	rec = httptest.NewRecorder()
	ah.HandleBackgroundTasks(rec, httptest.NewRequest(http.MethodGet, "/admin/background-tasks", nil))
	var resp BackgroundTasksResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(resp.Tasks) != 1 || resp.Tasks[0].ID != "db-migration" {
		t.Fatalf("tasks = %+v", resp.Tasks)
	}
	if !resp.RestartPending {
		t.Error("restart_pending should be true after an automatic-restart task completes")
	}

	// Non-GET is rejected.
	rec = httptest.NewRecorder()
	ah.HandleBackgroundTasks(rec, httptest.NewRequest(http.MethodPost, "/admin/background-tasks", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST status = %d, want 405", rec.Code)
	}
}

func TestHandleBackgroundTaskDismiss(t *testing.T) {
	bgTasks = newTestRegistry()
	defer func() { bgTasks = newTestRegistry() }()
	bgTasks.Start("hideable", BackgroundTaskOpts{Name: "Hideable", Dismissible: true})

	ah := &AdminHandler{}

	rec := httptest.NewRecorder()
	ah.HandleBackgroundTaskDismiss(rec, httptest.NewRequest(http.MethodPost, "/admin/background-tasks/dismiss", nil))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("missing id status = %d, want 400", rec.Code)
	}

	rec = httptest.NewRecorder()
	ah.HandleBackgroundTaskDismiss(rec, httptest.NewRequest(http.MethodPost, "/admin/background-tasks/dismiss?id=nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("unknown id status = %d, want 404", rec.Code)
	}

	rec = httptest.NewRecorder()
	ah.HandleBackgroundTaskDismiss(rec, httptest.NewRequest(http.MethodPost, "/admin/background-tasks/dismiss?id=hideable", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("dismiss status = %d", rec.Code)
	}
	if len(bgTasks.Snapshot()) != 0 {
		t.Error("dismissed task should be hidden from the snapshot")
	}
}

func TestFormatCount(t *testing.T) {
	cases := map[int]string{0: "0", 12: "12", 999: "999", 1000: "1,000", 12345: "12,345", 1234567: "1,234,567"}
	for in, want := range cases {
		if got := formatCount(in); got != want {
			t.Errorf("formatCount(%d) = %q, want %q", in, got, want)
		}
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
