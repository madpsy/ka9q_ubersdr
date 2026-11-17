//go:build unix

package main

import (
	"path/filepath"
	"syscall"
)

// dbDiskFree is the space available to this process on the filesystem that
// holds path.
func dbDiskFree(path string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(filepath.Dir(path), &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}
