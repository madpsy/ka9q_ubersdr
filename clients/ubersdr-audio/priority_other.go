//go:build !windows

package main

// setAboveNormalPriority is a no-op on non-Windows platforms.
func setAboveNormalPriority() {}
