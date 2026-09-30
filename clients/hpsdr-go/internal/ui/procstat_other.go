//go:build !linux && !darwin && !windows

package ui

import "time"

// cpuTime is unknown here; the header shows "CPU -".
func cpuTime() (time.Duration, bool) { return 0, false }
