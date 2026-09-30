package ui

import (
	"fmt"
	"runtime/metrics"
	"time"
)

// procStats is the bridge's own CPU and memory for the status header.
//
// CPU is the process's user and system time from the OS, as a percentage of
// one core like top shows it, averaged over at least procWindow so the 4 Hz
// redraw does not make it jitter. Memory is what the Go runtime holds from the
// OS less what it has handed back: close to the resident size, and the same
// measure on every platform without reaching for per-OS APIs.
type procStats struct {
	lastCPU time.Duration
	lastAt  time.Time
	pct     float64
	have    bool // pct is a measurement, not a placeholder
}

const procWindow = time.Second

// sample takes a reading if procWindow has passed since the last.
func (p *procStats) sample(now time.Time) {
	cpu, ok := cpuTime()
	if !ok {
		return
	}
	if p.lastAt.IsZero() {
		p.lastCPU, p.lastAt = cpu, now
		return
	}
	if dt := now.Sub(p.lastAt); dt >= procWindow {
		p.pct = 100 * float64(cpu-p.lastCPU) / float64(dt)
		p.have = true
		p.lastCPU, p.lastAt = cpu, now
	}
}

func (p *procStats) String() string {
	cpu := "CPU -"
	if p.have {
		cpu = fmt.Sprintf("CPU %.0f%%", p.pct)
	}
	return cpu + "  mem " + fmt.Sprintf("%.0f MB", float64(memBytes())/(1<<20))
}

var memSamples = []metrics.Sample{
	{Name: "/memory/classes/total:bytes"},
	{Name: "/memory/classes/heap/released:bytes"},
}

// memBytes is the memory the Go runtime holds from the OS, less released.
func memBytes() uint64 {
	s := make([]metrics.Sample, len(memSamples))
	copy(s, memSamples)
	metrics.Read(s)
	if s[0].Value.Kind() != metrics.KindUint64 || s[1].Value.Kind() != metrics.KindUint64 {
		return 0
	}
	return s[0].Value.Uint64() - s[1].Value.Uint64()
}
