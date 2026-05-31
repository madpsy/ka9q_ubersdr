package main

// api_handlers_record.go — handlers for audio recording endpoints:
//
//	POST   /api/v1/record/start    — start a new recording
//	POST   /api/v1/record/stop     — stop the active recording
//	GET    /api/v1/record          — get current recording status
//	GET    /api/v1/record/download — download the last completed recording
//	DELETE /api/v1/record          — delete the completed recording file

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
)

// handleRecord dispatches GET and DELETE on /api/v1/record.
func (s *APIServer) handleRecord(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.getRecord(w, r)
	case http.MethodDelete:
		s.deleteRecord(w, r)
	default:
		methodOnly(w, r, http.MethodGet, http.MethodDelete)
	}
}

// handleRecordStart handles POST /api/v1/record/start.
func (s *APIServer) handleRecordStart(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodPost) {
		return
	}

	var body struct {
		Format *string `json:"format"` // "pcm" or "opus"; nil = use current transport format
	}
	if !decodeBody(w, r, &body) {
		return
	}

	// Determine recording format.
	recFormat := "pcm" // default
	if body.Format != nil {
		switch *body.Format {
		case "pcm", "opus":
			recFormat = *body.Format
		default:
			apiFieldError(w, "format", *body.Format, `"pcm" or "opus"`)
			return
		}
	} else {
		// Default: match the current transport format.
		s.state.Mu.RLock()
		tf := s.state.Format
		s.state.Mu.RUnlock()
		if tf == "opus" {
			recFormat = "opus"
		}
	}

	// Build freq/mode strings for the filename.
	s.state.Mu.RLock()
	freq := s.state.CurrentFreq
	mode := s.state.CurrentMode
	s.state.Mu.RUnlock()
	freqStr := fmt.Sprintf("%dkHz", freq/1000)

	if err := s.recordingMgr.Start(recFormat, freqStr, mode); err != nil {
		if err.Error() == "already recording" {
			st := s.recordingMgr.Status()
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":          "already recording",
				"started_at":     st.StartedAt,
				"elapsed_secs":   st.ElapsedSecs,
				"remaining_secs": st.RemainingSecs,
			})
			return
		}
		apiError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Update GUI button if callback is set.
	if s.state.DoStartRecording != nil {
		s.state.DoStartRecording(recFormat)
	}

	st := s.recordingMgr.Status()
	writeJSON(w, http.StatusOK, recordStatusJSON(st))
}

// handleRecordStop handles POST /api/v1/record/stop.
func (s *APIServer) handleRecordStop(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodPost) {
		return
	}

	if err := s.recordingMgr.Stop(); err != nil {
		if err.Error() == "not recording" {
			apiConflict(w, "state", "not recording")
			return
		}
		apiError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Update GUI button if callback is set.
	if s.state.DoStopRecording != nil {
		s.state.DoStopRecording()
	}

	st := s.recordingMgr.Status()
	writeJSON(w, http.StatusOK, recordStatusJSON(st))
}

// getRecord handles GET /api/v1/record.
func (s *APIServer) getRecord(w http.ResponseWriter, _ *http.Request) {
	st := s.recordingMgr.Status()
	writeJSON(w, http.StatusOK, recordStatusJSON(st))
}

// deleteRecord handles DELETE /api/v1/record.
func (s *APIServer) deleteRecord(w http.ResponseWriter, _ *http.Request) {
	if err := s.recordingMgr.DeleteFile(); err != nil {
		if err.Error() == "no completed recording to delete" {
			apiError(w, http.StatusNotFound, err.Error())
			return
		}
		apiError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}

// handleRecordDownload handles GET /api/v1/record/download.
func (s *APIServer) handleRecordDownload(w http.ResponseWriter, r *http.Request) {
	if !methodOnly(w, r, http.MethodGet) {
		return
	}

	st := s.recordingMgr.Status()
	if st.State != RecordingReady {
		apiError(w, http.StatusNotFound, "no completed recording available for download")
		return
	}

	f, err := os.Open(st.FilePath)
	if err != nil {
		apiError(w, http.StatusNotFound, "recording file not found on disk")
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		apiError(w, http.StatusInternalServerError, "could not stat recording file")
		return
	}

	// Set content type based on format.
	ct := "audio/wav"
	if st.Format == "opus" {
		ct = "audio/ogg"
	}

	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s"`, filepath.Base(st.FilePath)))
	w.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size()))
	http.ServeContent(w, r, st.Filename, info.ModTime(), f)
}

// recordStatusJSON converts a RecordingStatus to the API JSON shape.
func recordStatusJSON(st RecordingStatus) map[string]any {
	m := map[string]any{
		"state":             string(st.State),
		"format":            st.Format,
		"max_duration_secs": st.MaxDurationSecs,
	}
	if st.State != RecordingIdle {
		m["filename"] = st.Filename
		m["size_bytes"] = st.SizeBytes
		m["started_at"] = st.StartedAt
		m["elapsed_secs"] = st.ElapsedSecs
	}
	if st.State == RecordingActive {
		m["remaining_secs"] = st.RemainingSecs
	}
	if st.State == RecordingReady {
		m["stopped_at"] = st.StoppedAt
		m["auto_stopped"] = st.AutoStopped
		if st.ElapsedSecs > 0 {
			m["duration_secs"] = st.ElapsedSecs
		}
	}
	return m
}
