package main

import "time"

// Config holds the configuration for the KiwiSDR client
type Config struct {
	ServerHost  string
	ServerPort  int
	Frequency   float64
	Modulation  string
	User        string
	Password    string
	Duration    time.Duration
	OutputDir   string
	Filename    string
	LowCut      float64
	HighCut     float64
	AGCGain     float64
	Compression bool // Audio compression (IMA ADPCM)
	Quiet       bool
}

// DefaultPassbands defines default passband settings for each mode
var DefaultPassbands = map[string][2]float64{
	"am":   {-4900, 4900},
	"amn":  {-2500, 2500},
	"amw":  {-6000, 6000},
	"sam":  {-4900, 4900},
	"sal":  {-4900, 0},
	"sau":  {0, 4900},
	"sas":  {-4900, 4900},
	"qam":  {-4900, 4900},
	"drm":  {-5000, 5000},
	"lsb":  {-2700, -300},
	"lsn":  {-2400, -300},
	"usb":  {300, 2700},
	"usn":  {300, 2400},
	"cw":   {300, 700},
	"cwn":  {470, 530},
	"nbfm": {-6000, 6000},
	"nnfm": {-3000, 3000},
	"iq":   {-5000, 5000},
}

// GetPassband returns the passband for a given modulation mode
func (c *Config) GetPassband() (float64, float64) {
	if pb, ok := DefaultPassbands[c.Modulation]; ok {
		lowCut := c.LowCut
		highCut := c.HighCut

		// Use defaults if not specified
		if lowCut == 0 && highCut == 0 {
			return pb[0], pb[1]
		}
		if lowCut == 0 {
			lowCut = pb[0]
		}
		if highCut == 0 {
			highCut = pb[1]
		}
		return lowCut, highCut
	}
	// Default passband
	return c.LowCut, c.HighCut
}

// IsStereo returns true if the modulation mode is stereo
func (c *Config) IsStereo() bool {
	return c.Modulation == "iq" || c.Modulation == "drm" ||
		c.Modulation == "sas" || c.Modulation == "qam"
}
