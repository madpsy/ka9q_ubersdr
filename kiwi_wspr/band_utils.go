package main

// frequencyToBand converts a frequency in kHz to an amateur radio band name
// This matches the logic used in the main ubersdr application
func frequencyToBand(freqKHz float64) string {
	// Convert to MHz for easier comparison
	freqMHz := freqKHz / 1000.0

	// Amateur radio bands from 2200m to 6m
	switch {
	case freqMHz >= 0.1357 && freqMHz <= 0.1378:
		return "2200m"
	case freqMHz >= 0.470 && freqMHz < 0.480:
		return "630m"
	case freqMHz >= 1.8 && freqMHz <= 2.0:
		return "160m"
	case freqMHz >= 3.5 && freqMHz <= 4.0:
		return "80m"
	case freqMHz >= 5.25 && freqMHz <= 5.45:
		return "60m"
	case freqMHz >= 7.0 && freqMHz <= 7.3:
		return "40m"
	case freqMHz >= 10.1 && freqMHz <= 10.15:
		return "30m"
	case freqMHz >= 14.0 && freqMHz <= 14.35:
		return "20m"
	case freqMHz >= 18.068 && freqMHz <= 18.168:
		return "17m"
	case freqMHz >= 21.0 && freqMHz <= 21.45:
		return "15m"
	case freqMHz >= 24.89 && freqMHz <= 24.99:
		return "12m"
	case freqMHz >= 28.0 && freqMHz <= 29.7:
		return "10m"
	case freqMHz >= 50.0 && freqMHz <= 54.0:
		return "6m"
	default:
		return "other"
	}
}
