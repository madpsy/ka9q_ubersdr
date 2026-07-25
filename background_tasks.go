package main

// background_tasks.go — in-memory registry of long-running background work.
//
// Subsystems that do slow, one-off work (the historical file→SQLite backfill,
// database downloads, addon installs, config migrations…) publish their
// progress here; the admin UI polls /admin/background-tasks and shows a
// single-line banner while anything is running.
//
// Design notes:
//   - The registry is a package-level singleton, NOT a field on AdminHandler.
//     The db importer starts long before the admin handler or the HTTP server
//     exist (main.go calls RunImportIfEmpty ~1400 lines earlier), so a producer
//     must be able to publish at any point in startup without wiring.
//   - Memory only. Nothing is persisted and nothing is read back at boot: a
//     restart legitimately means "that work is over", which is exactly what the
//     migration case wants.
//   - Producers never need nil checks — every method is nil-receiver safe, so
//     `var t *BackgroundTask` can be threaded through code paths that may not
//     have started a task at all.
//   - Finished tasks linger for backgroundTaskRetention so the UI has time to
//     show the terminal state ("complete — restarting") before they vanish.

import (
	"fmt"
	"sync"
	"time"
)

// bgTasks is the global registry. Safe to use from any goroutine at any point
// in startup.
var bgTasks = &BackgroundTaskRegistry{tasks: make(map[string]*BackgroundTask)}

// Task states.
const (
	BGTaskRunning  = "running"
	BGTaskComplete = "complete"
	BGTaskFailed   = "failed"
)

// Restart requirements. "automatic" means the server restarts itself when the
// task completes; "manual" means the operator has to press the button.
const (
	BGRestartNone      = "none"
	BGRestartManual    = "manual"
	BGRestartAutomatic = "automatic"
)

// backgroundTaskRetention is how long a completed or failed task stays visible
// before being swept. Long enough for a 15 s idle poll to catch the terminal
// state, short enough that a stale banner never lingers.
const backgroundTaskRetention = 2 * time.Minute

// backgroundTaskMinUpdate throttles progress pushes. Importers report per file
// and can process thousands per second; 250 ms keeps the mutex cold and is
// still far faster than the 2 s UI poll.
const backgroundTaskMinUpdate = 250 * time.Millisecond

// BackgroundTaskOpts describes a task at creation time. Only Name is required.
type BackgroundTaskOpts struct {
	Name            string // short title, e.g. "Historical data migration"
	Description     string // one line of context, shown when the banner is expanded
	Severity        string // "info" (default) | "warning"
	RestartRequired string // "none" (default) | "manual" | "automatic"
	Dismissible     bool   // may the operator hide the banner?
	Indeterminate   bool   // true when no percentage can be computed
}

// BackgroundTask is one unit of long-running work. All accessors are safe for
// concurrent use and safe to call on a nil receiver.
type BackgroundTask struct {
	mu sync.RWMutex

	id              string
	name            string
	description     string
	step            string
	state           string
	progress        float64 // 0..100, or -1 when indeterminate
	severity        string
	restartRequired string
	dismissible     bool
	dismissed       bool
	errMsg          string

	startedAt  time.Time
	updatedAt  time.Time
	finishedAt time.Time
}

// BackgroundTaskSnapshot is the JSON view of a task returned by the admin API.
type BackgroundTaskSnapshot struct {
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	Description     string    `json:"description,omitempty"`
	Step            string    `json:"step,omitempty"`
	State           string    `json:"state"`
	Progress        float64   `json:"progress"` // -1 when indeterminate
	Severity        string    `json:"severity"`
	RestartRequired string    `json:"restart_required"`
	Dismissible     bool      `json:"dismissible"`
	StartedAt       time.Time `json:"started_at"`
	ElapsedSeconds  int64     `json:"elapsed_seconds"`
	Error           string    `json:"error,omitempty"`
}

// BackgroundTaskRegistry holds every live and recently-finished task.
type BackgroundTaskRegistry struct {
	mu    sync.Mutex
	tasks map[string]*BackgroundTask
}

// Start registers (or replaces) the task with the given id and returns a handle
// the caller reports progress through. Re-starting a live id is deliberate:
// a retried job reuses its banner rather than stacking a second one.
func (r *BackgroundTaskRegistry) Start(id string, opts BackgroundTaskOpts) *BackgroundTask {
	if r == nil || id == "" {
		return nil
	}
	now := time.Now()
	t := &BackgroundTask{
		id:              id,
		name:            opts.Name,
		description:     opts.Description,
		state:           BGTaskRunning,
		progress:        0,
		severity:        opts.Severity,
		restartRequired: opts.RestartRequired,
		dismissible:     opts.Dismissible,
		startedAt:       now,
		updatedAt:       now,
	}
	if opts.Indeterminate {
		t.progress = -1
	}
	if t.severity == "" {
		t.severity = "info"
	}
	if t.restartRequired == "" {
		t.restartRequired = BGRestartNone
	}

	r.mu.Lock()
	r.tasks[id] = t
	r.mu.Unlock()
	return t
}

// Snapshot returns every visible task, oldest first, sweeping any finished task
// past its retention window. Called once per admin poll; O(number of tasks),
// which in practice is 0 or 1.
func (r *BackgroundTaskRegistry) Snapshot() []BackgroundTaskSnapshot {
	if r == nil {
		return nil
	}
	cutoff := time.Now().Add(-backgroundTaskRetention)

	r.mu.Lock()
	out := make([]BackgroundTaskSnapshot, 0, len(r.tasks))
	for id, t := range r.tasks {
		t.mu.RLock()
		expired := !t.finishedAt.IsZero() && t.finishedAt.Before(cutoff)
		hidden := t.dismissed
		t.mu.RUnlock()
		if expired {
			delete(r.tasks, id)
			continue
		}
		if hidden {
			continue
		}
		out = append(out, t.snapshot())
	}
	r.mu.Unlock()

	// Oldest first so the banner order is stable across polls.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].StartedAt.Before(out[j-1].StartedAt); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

// RestartPending reports whether a finished task is waiting on (or has just
// triggered) a server restart. The UI uses it to switch the banner into
// "restarting…" mode and start watching for the server to come back.
func (r *BackgroundTaskRegistry) RestartPending() bool {
	if r == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, t := range r.tasks {
		t.mu.RLock()
		pending := t.state == BGTaskComplete && t.restartRequired == BGRestartAutomatic
		t.mu.RUnlock()
		if pending {
			return true
		}
	}
	return false
}

// Dismiss hides a dismissible task's banner. Returns false when the id is
// unknown or the task refuses to be dismissed.
func (r *BackgroundTaskRegistry) Dismiss(id string) bool {
	if r == nil {
		return false
	}
	r.mu.Lock()
	t := r.tasks[id]
	r.mu.Unlock()
	if t == nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.dismissible {
		return false
	}
	t.dismissed = true
	return true
}

// snapshot copies the task under its own read lock.
func (t *BackgroundTask) snapshot() BackgroundTaskSnapshot {
	t.mu.RLock()
	defer t.mu.RUnlock()
	end := t.finishedAt
	if end.IsZero() {
		end = time.Now()
	}
	return BackgroundTaskSnapshot{
		ID:              t.id,
		Name:            t.name,
		Description:     t.description,
		Step:            t.step,
		State:           t.state,
		Progress:        t.progress,
		Severity:        t.severity,
		RestartRequired: t.restartRequired,
		Dismissible:     t.dismissible,
		StartedAt:       t.startedAt,
		ElapsedSeconds:  int64(end.Sub(t.startedAt).Seconds()),
		Error:           t.errMsg,
	}
}

// SetProgress updates the completion percentage (clamped to 0..100).
func (t *BackgroundTask) SetProgress(pct float64) {
	t.SetProgressStep(pct, "")
}

// SetStep updates the current sub-step without touching the percentage.
func (t *BackgroundTask) SetStep(step string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	t.step = step
	t.updatedAt = time.Now()
	t.mu.Unlock()
}

// SetProgressStep updates percentage and sub-step in one lock. An empty step
// leaves the previous one in place.
//
// Updates arriving less than backgroundTaskMinUpdate after the previous one are
// dropped: producers may call this per row or per file, and the UI cannot show
// more than a few frames a second anyway. Terminal values always land, because
// Complete and Fail bypass the throttle.
func (t *BackgroundTask) SetProgressStep(pct float64, step string) {
	if t == nil {
		return
	}
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	if now.Sub(t.updatedAt) < backgroundTaskMinUpdate {
		return
	}
	if pct < 0 {
		pct = -1 // indeterminate
	} else if pct > 100 {
		pct = 100
	}
	t.progress = pct
	if step != "" {
		t.step = step
	}
	t.updatedAt = now
}

// Complete marks the task finished successfully at 100%. An empty step leaves
// the previous one in place.
func (t *BackgroundTask) Complete(step string) {
	if t == nil {
		return
	}
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	t.state = BGTaskComplete
	t.progress = 100
	if step != "" {
		t.step = step
	}
	t.updatedAt = now
	t.finishedAt = now
}

// Fail marks the task finished unsuccessfully, keeping whatever progress it
// reached so the operator can see how far it got.
func (t *BackgroundTask) Fail(err error) {
	if t == nil {
		return
	}
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	t.state = BGTaskFailed
	t.severity = "warning"
	if err != nil {
		t.errMsg = err.Error()
	}
	t.updatedAt = now
	t.finishedAt = now
}

// formatCount renders n with thousands separators, for step strings like
// "3,904 / 5,210 files".
func formatCount(n int) string {
	s := fmt.Sprintf("%d", n)
	if len(s) <= 3 {
		return s
	}
	var b []byte
	for i, c := range []byte(s) {
		if i > 0 && (len(s)-i)%3 == 0 {
			b = append(b, ',')
		}
		b = append(b, c)
	}
	return string(b)
}
