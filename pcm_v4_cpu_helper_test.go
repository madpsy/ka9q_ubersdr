package main

import "math"

// mathFloat32frombits is split out so the CPU comparison file needs no direct
// math import alongside its timing code.
func mathFloat32frombits(b uint32) float32 { return math.Float32frombits(b) }
