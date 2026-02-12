package sstv

/*
 * SSTV Mode Specifications
 * Ported from slowrx by Oona Räisänen (OH2EIQ)
 *
 * References:
 *   - JL Barber N7CXI (2000): "Proposal for SSTV Mode Specifications"
 *   - Dave Jones KB4YZ (1999): "SSTV modes - line timing"
 */

// Mode constants (matching slowrx)
const (
	ModeUnknown = 0
	ModeM1      = 1
	ModeM2      = 2
	ModeM3      = 3
	ModeM4      = 4
	ModeS1      = 5
	ModeS2      = 6
	ModeSDX     = 7
	ModeR72     = 8
	ModeR36     = 9
	ModeR24     = 10
	ModeR24BW   = 11
	ModeR12BW   = 12
	ModeR8BW    = 13
	ModePD50    = 14
	ModePD90    = 15
	ModePD120   = 16
	ModePD160   = 17
	ModePD180   = 18
	ModePD240   = 19
	ModePD290   = 20
	ModeP3      = 21
	ModeP5      = 22
	ModeP7      = 23
	ModeW2120   = 24
	ModeW2180   = 25
)

// ColorEncoding represents the color format
type ColorEncoding int

const (
	ColorGBR ColorEncoding = 0
	ColorRGB ColorEncoding = 1
	ColorYUV ColorEncoding = 2
	ColorBW  ColorEncoding = 3
)

// ModeSpec defines the timing and format parameters for an SSTV mode
type ModeSpec struct {
	Name        string        // Long, human-readable name
	ShortName   string        // Abbreviation for filenames
	SyncTime    float64       // Duration of sync pulse (seconds)
	PorchTime   float64       // Duration of sync porch pulse (seconds)
	SeptrTime   float64       // Duration of channel separator pulse (seconds)
	PixelTime   float64       // Duration of one pixel (seconds)
	LineTime    float64       // Time from start of sync to start of next sync (seconds)
	ImgWidth    int           // Pixels per scanline
	NumLines    int           // Number of scanlines
	LineHeight  int           // Height of one scanline in pixels (1 or 2)
	ColorEnc    ColorEncoding // Color format
	Unsupported bool          // Whether this mode is supported
}

// ModeSpecs contains all mode specifications (indexed by mode constant)
var ModeSpecs = []ModeSpec{
	// 0: Unknown
	{
		Name:        "Unknown",
		Unsupported: true,
	},

	// 1: Martin M1
	{
		Name:       "Martin M1",
		ShortName:  "M1",
		SyncTime:   4.862e-3,
		PorchTime:  0.572e-3,
		SeptrTime:  0.572e-3,
		PixelTime:  0.4576e-3,
		LineTime:   446.446e-3,
		ImgWidth:   320,
		NumLines:   256,
		LineHeight: 1,
		ColorEnc:   ColorGBR,
	},

	// 2: Martin M2
	{
		Name:       "Martin M2",
		ShortName:  "M2",
		SyncTime:   4.862e-3,
		PorchTime:  0.572e-3,
		SeptrTime:  0.572e-3,
		PixelTime:  0.2288e-3,
		LineTime:   226.7986e-3,
		ImgWidth:   320,
		NumLines:   256,
		LineHeight: 1,
		ColorEnc:   ColorGBR,
	},

	// 3: Martin M3
	{
		Name:       "Martin M3",
		ShortName:  "M3",
		SyncTime:   4.862e-3,
		PorchTime:  0.572e-3,
		SeptrTime:  0.572e-3,
		PixelTime:  0.2288e-3,
		LineTime:   446.446e-3,
		ImgWidth:   320,
		NumLines:   128,
		LineHeight: 2,
		ColorEnc:   ColorGBR,
	},

	// 4: Martin M4
	{
		Name:       "Martin M4",
		ShortName:  "M4",
		SyncTime:   4.862e-3,
		PorchTime:  0.572e-3,
		SeptrTime:  0.572e-3,
		PixelTime:  0.2288e-3,
		LineTime:   226.7986e-3,
		ImgWidth:   320,
		NumLines:   128,
		LineHeight: 2,
		ColorEnc:   ColorGBR,
	},

	// 5: Scottie S1
	{
		Name:       "Scottie S1",
		ShortName:  "S1",
		SyncTime:   9e-3,
		PorchTime:  1.5e-3,
		SeptrTime:  1.5e-3,
		PixelTime:  0.4320e-3,
		LineTime:   428.38e-3,
		ImgWidth:   320,
		NumLines:   256,
		LineHeight: 1,
		ColorEnc:   ColorGBR,
	},

	// 6: Scottie S2
	{
		Name:       "Scottie S2",
		ShortName:  "S2",
		SyncTime:   9e-3,
		PorchTime:  1.5e-3,
		SeptrTime:  1.5e-3,
		PixelTime:  0.2752e-3,
		LineTime:   277.692e-3,
		ImgWidth:   320,
		NumLines:   256,
		LineHeight: 1,
		ColorEnc:   ColorGBR,
	},

	// 7: Scottie DX
	{
		Name:       "Scottie DX",
		ShortName:  "SDX",
		SyncTime:   9e-3,
		PorchTime:  1.5e-3,
		SeptrTime:  1.5e-3,
		PixelTime:  1.08053e-3,
		LineTime:   1050.3e-3,
		ImgWidth:   320,
		NumLines:   256,
		LineHeight: 1,
		ColorEnc:   ColorGBR,
	},

	// 8: Robot 72
	{
		Name:       "Robot 72",
		ShortName:  "R72",
		SyncTime:   9e-3,
		PorchTime:  3e-3,
		SeptrTime:  4.7e-3,
		PixelTime:  0.2875e-3,
		LineTime:   300e-3,
		ImgWidth:   320,
		NumLines:   240,
		LineHeight: 1,
		ColorEnc:   ColorYUV,
	},

	// 9: Robot 36
	{
		Name:       "Robot 36",
		ShortName:  "R36",
		SyncTime:   9e-3,
		PorchTime:  3e-3,
		SeptrTime:  6e-3,
		PixelTime:  0.1375e-3,
		LineTime:   150e-3,
		ImgWidth:   320,
		NumLines:   240,
		LineHeight: 1,
		ColorEnc:   ColorYUV,
	},

	// 10: Robot 24
	{
		Name:       "Robot 24",
		ShortName:  "R24",
		SyncTime:   9e-3,
		PorchTime:  3e-3,
		SeptrTime:  6e-3,
		PixelTime:  0.1375e-3,
		LineTime:   150e-3,
		ImgWidth:   320,
		NumLines:   240,
		LineHeight: 1,
		ColorEnc:   ColorYUV,
	},

	// 11: Robot 24 B/W
	{
		Name:       "Robot 24 B/W",
		ShortName:  "R24BW",
		SyncTime:   7e-3,
		PorchTime:  0e-3,
		SeptrTime:  0e-3,
		PixelTime:  0.291e-3,
		LineTime:   100e-3,
		ImgWidth:   320,
		NumLines:   240,
		LineHeight: 1,
		ColorEnc:   ColorBW,
	},

	// 12: Robot 12 B/W
	{
		Name:       "Robot 12 B/W",
		ShortName:  "R12BW",
		SyncTime:   7e-3,
		PorchTime:  0e-3,
		SeptrTime:  0e-3,
		PixelTime:  0.291e-3,
		LineTime:   100e-3,
		ImgWidth:   320,
		NumLines:   120,
		LineHeight: 2,
		ColorEnc:   ColorBW,
	},

	// 13: Robot 8 B/W
	{
		Name:       "Robot 8 B/W",
		ShortName:  "R8BW",
		SyncTime:   7e-3,
		PorchTime:  0e-3,
		SeptrTime:  0e-3,
		PixelTime:  0.1871875e-3,
		LineTime:   66.9e-3,
		ImgWidth:   320,
		NumLines:   120,
		LineHeight: 2,
		ColorEnc:   ColorBW,
	},

	// 14: PD-50
	{
		Name:       "PD-50",
		ShortName:  "PD50",
		SyncTime:   20e-3,
		PorchTime:  2.08e-3,
		SeptrTime:  0e-3,
		PixelTime:  0.286e-3,
		LineTime:   388.16e-3,
		ImgWidth:   320,
		NumLines:   256,
		LineHeight: 1,
		ColorEnc:   ColorYUV,
	},

	// 15: PD-90
	{
		Name:       "PD-90",
		ShortName:  "PD90",
		SyncTime:   20e-3,
		PorchTime:  2.08e-3,
		SeptrTime:  0e-3,
		PixelTime:  0.532e-3,
		LineTime:   703.04e-3,
		ImgWidth:   320,
		NumLines:   256,
		LineHeight: 1,
		ColorEnc:   ColorYUV,
	},

	// 16: PD-120
	{
		Name:       "PD-120",
		ShortName:  "PD120",
		SyncTime:   20e-3,
		PorchTime:  2.08e-3,
		SeptrTime:  0e-3,
		PixelTime:  0.19e-3,
		LineTime:   508.48e-3,
		ImgWidth:   640,
		NumLines:   496,
		LineHeight: 1,
		ColorEnc:   ColorYUV,
	},

	// 17: PD-160
	{
		Name:       "PD-160",
		ShortName:  "PD160",
		SyncTime:   20e-3,
		PorchTime:  2.08e-3,
		SeptrTime:  0e-3,
		PixelTime:  0.382e-3,
		LineTime:   804.416e-3,
		ImgWidth:   512,
		NumLines:   400,
		LineHeight: 1,
		ColorEnc:   ColorYUV,
	},

	// 18: PD-180
	{
		Name:       "PD-180",
		ShortName:  "PD180",
		SyncTime:   20e-3,
		PorchTime:  2.08e-3,
		SeptrTime:  0e-3,
		PixelTime:  0.286e-3,
		LineTime:   754.24e-3,
		ImgWidth:   640,
		NumLines:   496,
		LineHeight: 1,
		ColorEnc:   ColorYUV,
	},

	// 19: PD-240
	{
		Name:       "PD-240",
		ShortName:  "PD240",
		SyncTime:   20e-3,
		PorchTime:  2.08e-3,
		SeptrTime:  0e-3,
		PixelTime:  0.382e-3,
		LineTime:   1000e-3,
		ImgWidth:   640,
		NumLines:   496,
		LineHeight: 1,
		ColorEnc:   ColorYUV,
	},

	// 20: PD-290
	{
		Name:       "PD-290",
		ShortName:  "PD290",
		SyncTime:   20e-3,
		PorchTime:  2.08e-3,
		SeptrTime:  0e-3,
		PixelTime:  0.286e-3,
		LineTime:   937.28e-3,
		ImgWidth:   800,
		NumLines:   616,
		LineHeight: 1,
		ColorEnc:   ColorYUV,
	},

	// 21: Pasokon P3
	{
		Name:       "Pasokon P3",
		ShortName:  "P3",
		SyncTime:   5.208e-3,
		PorchTime:  1.042e-3,
		SeptrTime:  1.042e-3,
		PixelTime:  0.2083e-3,
		LineTime:   409.375e-3,
		ImgWidth:   640,
		NumLines:   496,
		LineHeight: 1,
		ColorEnc:   ColorRGB,
	},

	// 22: Pasokon P5
	{
		Name:       "Pasokon P5",
		ShortName:  "P5",
		SyncTime:   7.813e-3,
		PorchTime:  1.563e-3,
		SeptrTime:  1.563e-3,
		PixelTime:  0.3125e-3,
		LineTime:   614.065e-3,
		ImgWidth:   640,
		NumLines:   496,
		LineHeight: 1,
		ColorEnc:   ColorRGB,
	},

	// 23: Pasokon P7
	{
		Name:       "Pasokon P7",
		ShortName:  "P7",
		SyncTime:   10.417e-3,
		PorchTime:  2.083e-3,
		SeptrTime:  2.083e-3,
		PixelTime:  0.4167e-3,
		LineTime:   818.747e-3,
		ImgWidth:   640,
		NumLines:   496,
		LineHeight: 1,
		ColorEnc:   ColorRGB,
	},

	// 24: Wraase SC-2 120
	{
		Name:       "Wraase SC-2 120",
		ShortName:  "W2120",
		SyncTime:   5.5225e-3,
		PorchTime:  0.5e-3,
		SeptrTime:  0e-3,
		PixelTime:  0.489039081e-3,
		LineTime:   475.530018e-3,
		ImgWidth:   320,
		NumLines:   256,
		LineHeight: 1,
		ColorEnc:   ColorRGB,
	},

	// 25: Wraase SC-2 180
	{
		Name:       "Wraase SC-2 180",
		ShortName:  "W2180",
		SyncTime:   5.5225e-3,
		PorchTime:  0.5e-3,
		SeptrTime:  0e-3,
		PixelTime:  0.734532e-3,
		LineTime:   711.0225e-3,
		ImgWidth:   320,
		NumLines:   256,
		LineHeight: 1,
		ColorEnc:   ColorRGB,
	},
}

// VISMap maps 7-bit VIS codes to mode constants
// Reference: Dave Jones KB4YZ (1998): "List of SSTV Modes with VIS Codes"
var VISMap = [128]uint8{
	// 0x00-0x0F
	0, 0, ModeR8BW, 0, ModeR24, 0, ModeR12BW, 0,
	ModeR36, 0, ModeR24BW, 0, ModeR72, 0, 0, 0,

	// 0x10-0x1F
	0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0,

	// 0x20-0x2F
	ModeM4, 0, 0, 0, ModeM3, 0, 0, 0,
	ModeM2, 0, 0, 0, ModeM1, 0, 0, 0,

	// 0x30-0x3F
	0, 0, 0, 0, 0, 0, 0, ModeW2180,
	ModeS2, 0, 0, 0, ModeS1, 0, 0, ModeW2120,

	// 0x40-0x4F
	0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, ModeSDX, 0, 0, 0,

	// 0x50-0x5F
	0, 0, 0, 0, 0, 0, 0, 0,
	0, 0, 0, 0, 0, ModePD50, ModePD290, ModePD120,

	// 0x60-0x6F
	ModePD180, ModePD240, ModePD160, ModePD90, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0,

	// 0x70-0x7F
	0, ModeP3, ModeP5, ModeP7, 0, 0, 0, 0,
	0, 0, 0, 0, 0, 0, 0, 0,
}

// GetModeByIndex returns the mode specification for a given mode index
func GetModeByIndex(mode uint8) *ModeSpec {
	if int(mode) >= len(ModeSpecs) {
		return nil
	}
	return &ModeSpecs[mode]
}

// GetModeByVIS returns the mode index for a given VIS code
func GetModeByVIS(vis uint8) uint8 {
	if vis >= 128 {
		return ModeUnknown
	}
	return VISMap[vis]
}
