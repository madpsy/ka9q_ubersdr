package ft8

import (
	"math"
	"sort"
)

// calculateBaseline fits a baseline to the spectrum to find noise floor
func calculateBaseline(s []float64, nfa, nfb int) []float64 {
	npts := len(s)
	sbase := make([]float64, npts)

	if nfb <= nfa || nfa < 0 || nfb >= npts {
		// Invalid range, return zeros
		return sbase
	}

	// Convert to dB scale
	sDB := make([]float64, npts)
	for i := nfa; i <= nfb; i++ {
		if s[i] > 0 {
			sDB[i] = 10.0 * math.Log10(s[i])
		} else {
			sDB[i] = -120.0 // Minimum dB
		}
	}

	nseg := 10  // Number of segments
	npct := 10  // Percentile for lower envelope (10th percentile)
	nterms := 5 // Polynomial order

	nlen := (nfb - nfa + 1) / nseg // Length of each segment
	if nlen < 1 {
		nlen = 1
	}

	i0 := (nfb - nfa + 1) / 2 // Midpoint

	// Collect lower envelope points
	var xPoints, yPoints []float64

	// Loop over all segments
	for n := 0; n < nseg; n++ {
		ja := nfa + n*nlen
		jb := ja + nlen - 1
		if jb > nfb {
			jb = nfb
		}

		// Find lowest npct percentile in this segment
		base := pctile(sDB[ja:jb+1], npct)

		// Save all points at or below this percentile
		for i := ja; i <= jb; i++ {
			if sDB[i] <= base {
				xPoints = append(xPoints, float64(i-i0))
				yPoints = append(yPoints, sDB[i])
			}
		}
	}

	// Fit polynomial to lower envelope points
	coeffs := polyfit(xPoints, yPoints, nterms)

	// Evaluate polynomial to get baseline
	for i := nfa; i <= nfb; i++ {
		t := float64(i - i0)
		// Evaluate polynomial: a0 + a1*t + a2*t^2 + a3*t^3 + a4*t^4
		sbase[i] = coeffs[0] + t*(coeffs[1]+t*(coeffs[2]+t*(coeffs[3]+t*coeffs[4]))) + 0.65
	}

	return sbase
}

// pctile calculates the nth percentile of a dataset
func pctile(data []float64, npct int) float64 {
	if len(data) == 0 {
		return 0
	}

	// Make a copy and sort
	sorted := make([]float64, len(data))
	copy(sorted, data)
	sort.Float64s(sorted)

	// Calculate percentile index
	idx := (len(sorted) * npct) / 100
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	if idx < 0 {
		idx = 0
	}

	return sorted[idx]
}

// polyfit fits a polynomial to data points using least squares
// Returns coefficients [a0, a1, a2, ..., an] for polynomial of degree n
func polyfit(x, y []float64, nterms int) []float64 {
	if len(x) != len(y) || len(x) == 0 {
		return make([]float64, nterms)
	}

	n := len(x)

	// Build normal equations matrix
	// For polynomial: y = a0 + a1*x + a2*x^2 + ... + an*x^n
	// We need to solve: A * coeffs = b
	// where A is the design matrix and b is the target vector

	maxTerms := nterms
	if maxTerms > 10 {
		maxTerms = 10 // Limit to avoid numerical issues
	}

	// Use simplified approach for small polynomial orders
	// Build sums for normal equations
	sums := make([]float64, 2*maxTerms)
	for i := 0; i < n; i++ {
		xi := 1.0
		for j := 0; j < 2*maxTerms; j++ {
			sums[j] += xi
			xi *= x[i]
		}
	}

	// Build right-hand side
	b := make([]float64, maxTerms)
	for i := 0; i < n; i++ {
		xi := 1.0
		for j := 0; j < maxTerms; j++ {
			b[j] += y[i] * xi
			xi *= x[i]
		}
	}

	// Build matrix A
	A := make([][]float64, maxTerms)
	for i := 0; i < maxTerms; i++ {
		A[i] = make([]float64, maxTerms)
		for j := 0; j < maxTerms; j++ {
			A[i][j] = sums[i+j]
		}
	}

	// Solve using Gaussian elimination
	coeffs := gaussianElimination(A, b)

	return coeffs
}

// gaussianElimination solves A*x = b using Gaussian elimination with partial pivoting
func gaussianElimination(A [][]float64, b []float64) []float64 {
	n := len(b)
	if n == 0 || len(A) != n {
		return make([]float64, n)
	}

	// Make copies to avoid modifying inputs
	a := make([][]float64, n)
	for i := 0; i < n; i++ {
		a[i] = make([]float64, n)
		copy(a[i], A[i])
	}
	x := make([]float64, n)
	copy(x, b)

	// Forward elimination with partial pivoting
	for k := 0; k < n-1; k++ {
		// Find pivot
		maxVal := math.Abs(a[k][k])
		maxRow := k
		for i := k + 1; i < n; i++ {
			if math.Abs(a[i][k]) > maxVal {
				maxVal = math.Abs(a[i][k])
				maxRow = i
			}
		}

		// Swap rows if needed
		if maxRow != k {
			a[k], a[maxRow] = a[maxRow], a[k]
			x[k], x[maxRow] = x[maxRow], x[k]
		}

		// Eliminate column
		for i := k + 1; i < n; i++ {
			if a[k][k] != 0 {
				factor := a[i][k] / a[k][k]
				for j := k; j < n; j++ {
					a[i][j] -= factor * a[k][j]
				}
				x[i] -= factor * x[k]
			}
		}
	}

	// Back substitution
	for i := n - 1; i >= 0; i-- {
		sum := 0.0
		for j := i + 1; j < n; j++ {
			sum += a[i][j] * x[j]
		}
		if a[i][i] != 0 {
			x[i] = (x[i] - sum) / a[i][i]
		} else {
			x[i] = 0
		}
	}

	return x
}
