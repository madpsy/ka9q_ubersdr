package main

// band_snr_quality.go — shared FT8 SNR quality helpers.
//
// These thresholds match the UI in bandconditions.js and the Telegram bot
// in telegram_bot_commands.go.  Centralised here so every consumer uses the
// same breakpoints.

// BandSNRQuality returns a quality label for an FT8 SNR value.
//
//	snr < 6   → "POOR"
//	snr 6–19  → "FAIR"
//	snr 20–29 → "GOOD"
//	snr ≥ 30  → "EXCELLENT"
func BandSNRQuality(snr float32) string {
	switch {
	case snr >= 30:
		return "EXCELLENT"
	case snr >= 20:
		return "GOOD"
	case snr >= 6:
		return "FAIR"
	default:
		return "POOR"
	}
}

// BandSNRColor returns the display colour name for a quality label.
//
//	EXCELLENT / GOOD → "lime"
//	FAIR             → "amber"
//	POOR             → "red"
func BandSNRColor(quality string) string {
	switch quality {
	case "EXCELLENT", "GOOD":
		return "lime"
	case "FAIR":
		return "amber"
	default:
		return "red"
	}
}
