package main

import (
	"fmt"
	"os"
	"time"
)

// debugMode is set to true when --debug is passed on the command line.
// All debug output goes to stderr so it doesn't interfere with --stdout PCM.
var debugMode bool

// dbg prints a timestamped debug line to stderr when debugMode is true.
func dbg(format string, args ...interface{}) {
	if !debugMode {
		return
	}
	ts := time.Now().Format("15:04:05.000")
	fmt.Fprintf(os.Stderr, "[DEBUG %s] %s\n", ts, fmt.Sprintf(format, args...))
}
