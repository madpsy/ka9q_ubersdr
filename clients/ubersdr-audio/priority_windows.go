//go:build windows

package main

import (
	"log"

	"golang.org/x/sys/windows"
)

// setAboveNormalPriority raises the current process to ABOVE_NORMAL_PRIORITY_CLASS.
//
// Why: Go's IOCP network poller runs on a dedicated OS thread. When the process
// is at normal priority and Windows deprioritises it (background window, power
// management, antivirus scan), the IOCP poller thread can be starved for several
// seconds. During that time conn.ReadMessage() blocks even though data is sitting
// in the kernel TCP receive buffer, causing the throughput counter to read zero
// and audio to go silent. Raising to ABOVE_NORMAL ensures the poller thread is
// scheduled promptly without making the process a real-time hog.
func setAboveNormalPriority() {
	const ABOVE_NORMAL_PRIORITY_CLASS = 0x00008000

	handle, err := windows.GetCurrentProcess()
	if err != nil {
		log.Printf("priority: GetCurrentProcess: %v", err)
		return
	}

	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	setPriorityClass := kernel32.NewProc("SetPriorityClass")

	r, _, err := setPriorityClass.Call(uintptr(handle), ABOVE_NORMAL_PRIORITY_CLASS)
	if r == 0 {
		log.Printf("priority: SetPriorityClass failed: %v", err)
		return
	}
	log.Printf("priority: process raised to ABOVE_NORMAL_PRIORITY_CLASS")
}
