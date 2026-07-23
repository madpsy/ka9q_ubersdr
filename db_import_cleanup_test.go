package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestCleanupImportedDirs verifies the deferred, all-at-once source-directory
// cleanup: directories whose imports all succeeded are removed, directories
// with any failed import are kept, and empty/duplicate entries are ignored.
func TestCleanupImportedDirs(t *testing.T) {
	root := t.TempDir()

	okDir := filepath.Join(root, "ok")
	failDir := filepath.Join(root, "fail")
	sharedDir := filepath.Join(root, "shared")
	goneDir := filepath.Join(root, "gone") // never created on disk

	for _, d := range []string{okDir, failDir, sharedDir} {
		if err := os.MkdirAll(filepath.Join(d, "2025", "01", "01"), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}

	imp := &DBImporter{}

	// sharedDir simulates StatsDir: appears for multiple imports. If ANY of
	// them failed, dirOK[sharedDir] must be false. Here we mark it false to
	// prove a partially-failed shared dir is preserved.
	dirOK := map[string]bool{
		okDir:     true,
		failDir:   false,
		sharedDir: false,
		goneDir:   true, // success but directory doesn't exist — must be a no-op
		"":        true, // unconfigured subsystem — must be ignored
	}

	imp.cleanupImportedDirs(dirOK)

	if _, err := os.Stat(okDir); !os.IsNotExist(err) {
		t.Errorf("okDir should have been removed, stat err = %v", err)
	}
	if _, err := os.Stat(failDir); err != nil {
		t.Errorf("failDir should have been kept, stat err = %v", err)
	}
	if _, err := os.Stat(sharedDir); err != nil {
		t.Errorf("sharedDir (partial failure) should have been kept, stat err = %v", err)
	}
}

// TestCleanupImportedDirsAllSuccess verifies that when every import succeeds,
// all configured directories are removed.
func TestCleanupImportedDirsAllSuccess(t *testing.T) {
	root := t.TempDir()
	a := filepath.Join(root, "a")
	b := filepath.Join(root, "b")
	for _, d := range []string{a, b} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}

	imp := &DBImporter{}
	imp.cleanupImportedDirs(map[string]bool{a: true, b: true})

	for _, d := range []string{a, b} {
		if _, err := os.Stat(d); !os.IsNotExist(err) {
			t.Errorf("%s should have been removed, stat err = %v", d, err)
		}
	}
}
