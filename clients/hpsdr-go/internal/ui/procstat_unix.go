//go:build linux || darwin

package ui

import (
	"syscall"
	"time"
)

// cpuTime is the user and system CPU this process has used.
func cpuTime() (time.Duration, bool) {
	var ru syscall.Rusage
	if syscall.Getrusage(syscall.RUSAGE_SELF, &ru) != nil {
		return 0, false
	}
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano()), true
}
