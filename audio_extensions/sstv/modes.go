package sstv

/*
 * SSTV Mode Specifications
 * Ported from KiwiSDR/extensions/SSTV/sstv_modespec.cpp
 *
 * Original copyright (c) 2007-2013, Oona Räisänen (OH2EIQ [at] sral.fi)
 * Go port (c) 2026, UberSDR project
 *
 * References:
 *   - Martin Bruchanov OK2MNM (2012, 2019): www.sstv-handbook.com/download/sstv_04.pdf
 *   - JL Barber N7CXI: "Proposal for SSTV Mode Specifications" (Dayton SSTV forum, 2000)
 *   - Dave Jones KB4YZ (1999): "SSTV Modes - Line Timing"
 *   - github.com/ON4QZ/QSSTV
 */

// Mode constants - must match VIS code mapping
const (
	ModeUnknown = 0
	ModeVISX    = 1 // Extended VIS code marker

	// AVT modes
	ModeAVT24 = 2
	ModeAVT90 = 3
	ModeAVT94 = 4

	// Martin modes
	ModeM1 = 5
	ModeM2 = 6
	ModeM3 = 7
	ModeM4 = 8

	// Scottie modes
	ModeS1  = 9
	ModeS2  = 10
	ModeSDX = 11

	// Robot modes
	ModeR12   = 12
	ModeR24   = 13
	ModeR36   = 14
	ModeR72   = 15
	ModeR8BW  = 16
	ModeR12BW = 17
	ModeR24BW = 18
	ModeR36BW = 19

	// Wraase SC modes
	ModeSC60  = 20
	ModeSC120 = 21
	ModeSC180 = 22

	// PD modes
	ModePD50  = 23
	ModePD90  = 24
	ModePD120 = 25
	ModePD160 = 26
	ModePD180 = 27
	ModePD240 = 28
	ModePD290 = 29

	// Pasokon modes
	ModeP3 = 30
	ModeP5 = 31
	ModeP7 = 32

	// MMSSTV MP modes
	ModeMP73  = 33
	ModeMP115 = 34
	ModeMP140 = 35
	ModeMP175 = 36

	// MMSSTV MR modes
	ModeMR73  = 37
	ModeMR90  = 38
	ModeMR115 = 39
	ModeMR140 = 40
	ModeMR175 = 41

	// MMSSTV ML modes
	ModeML180 = 42
	ModeML240 = 43
	ModeML280 = 44
	ModeML320 = 45

	// FAX480
	ModeFX480 = 46
)

// ColorEncoding represents the color format
type ColorEncoding int

const (
	ColorGBR  ColorEncoding = 0
	ColorRGB  ColorEncoding = 1
	ColorYUV  ColorEncoding = 2
	ColorYUVY ColorEncoding = 3
	ColorBW   ColorEncoding = 4
)

// ScanlineFormat represents the format of scanline data
type ScanlineFormat int

const (
	Format111    ScanlineFormat = 0 // Sp0g1g2 (sync, porch, chan0, gap, chan1, gap, chan2)
	FormatBW     ScanlineFormat = 1 // S0 (sync, luma)
	Format420    ScanlineFormat = 2 // Sp00g[12] (4:2:0 subsampling)
	Format422    ScanlineFormat = 3 // Sp00g1g2 (4:2:2 subsampling)
	Format242    ScanlineFormat = 4 // S0112 (2:4:2 subsampling)
	Format111Rev ScanlineFormat = 5 // g0g1Sp2 (reversed order)
)

// ModeSpec defines the parameters for an SSTV mode
type ModeSpec struct {
	Name        string         // Long, human-readable name
	ShortName   string         // Abbreviation for the mode
	VIS         uint8          // VIS code (7-bit)
	SyncTime    float64        // Duration of sync pulse (seconds)
	PorchTime   float64        // Duration of sync porch pulse (seconds)
	SeptrTime   float64        // Duration of channel separator pulse (seconds)
	PixelTime   float64        // Duration of one pixel (seconds)
	LineTime    float64        // Time from start of sync to start of next sync (seconds)
	ImgWidth    int            // Pixels per scanline
	NumLines    int            // Number of scanlines (after LineHeight adjustment)
	LineHeight  int            // Height of one scanline in pixels (1 or 2)
	ColorEnc    ColorEncoding  // Color format
	Format      ScanlineFormat // Scanline format
	Unsupported bool           // True if mode is not supported
	ImgHeight   int            // Total image height (NumLines * LineHeight for some modes)
}

// ModeSpecs contains all SSTV mode specifications
var ModeSpecs = []ModeSpec{
	// UNKNOWN
	{},
	// VISX - Extended VIS code marker
	{},

	// AVT modes (unsupported)
	{
		Name: "Amiga Video Transceiver 24", ShortName: "AVT24", VIS: ModeAVT24,
		SyncTime: 0, PorchTime: 0, SeptrTime: 0, PixelTime: 0, LineTime: 0,
		ImgWidth: 128, NumLines: 120, LineHeight: 1,
		ColorEnc: ColorRGB, Format: Format111, Unsupported: true,
	},
	{
		Name: "Amiga Video Transceiver 90", ShortName: "AVT90", VIS: ModeAVT90,
		SyncTime: 0, PorchTime: 0, SeptrTime: 0, PixelTime: 0, LineTime: 0,
		ImgWidth: 320, NumLines: 256, LineHeight: 1,
		ColorEnc: ColorRGB, Format: Format111, Unsupported: true,
	},
	{
		Name: "Amiga Video Transceiver 94", ShortName: "AVT94", VIS: ModeAVT94,
		SyncTime: 0, PorchTime: 0, SeptrTime: 0, PixelTime: 0, LineTime: 0,
		ImgWidth: 320, NumLines: 200, LineHeight: 1,
		ColorEnc: ColorRGB, Format: Format111, Unsupported: true,
	},

	// Martin modes
	{
		Name: "Martin M1", ShortName: "M1", VIS: ModeM1,
		SyncTime: 4.862e-3, PorchTime: 0.572e-3, SeptrTime: 0.572e-3,
		PixelTime: 0.4576e-3, LineTime: 446.446e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 1,
		ColorEnc: ColorGBR, Format: Format111,
	},
	{
		Name: "Martin M2", ShortName: "M2", VIS: ModeM2,
		SyncTime: 4.862e-3, PorchTime: 0.572e-3, SeptrTime: 0.572e-3,
		PixelTime: 0.2288e-3, LineTime: 226.798e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 1,
		ColorEnc: ColorGBR, Format: Format111,
	},
	{
		Name: "Martin M3", ShortName: "M3", VIS: ModeM3,
		SyncTime: 4.862e-3, PorchTime: 0.572e-3, SeptrTime: 0.572e-3,
		PixelTime: 0.4576e-3, LineTime: 446.446e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 2,
		ColorEnc: ColorGBR, Format: Format111,
	},
	{
		Name: "Martin M4", ShortName: "M4", VIS: ModeM4,
		SyncTime: 4.862e-3, PorchTime: 0.572e-3, SeptrTime: 0.572e-3,
		PixelTime: 0.2288e-3, LineTime: 226.798e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 2,
		ColorEnc: ColorGBR, Format: Format111,
	},

	// Scottie modes
	{
		Name: "Scottie S1", ShortName: "S1", VIS: ModeS1,
		SyncTime: 9e-3, PorchTime: 1.5e-3, SeptrTime: 1.5e-3,
		PixelTime: 0.4320125e-3, LineTime: 428.232e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 1,
		ColorEnc: ColorGBR, Format: Format111Rev,
	},
	{
		Name: "Scottie S2", ShortName: "S2", VIS: ModeS2,
		SyncTime: 9e-3, PorchTime: 1.5e-3, SeptrTime: 1.5e-3,
		PixelTime: 0.2752e-3, LineTime: 277.692e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 1,
		ColorEnc: ColorGBR, Format: Format111Rev,
	},
	{
		Name: "Scottie DX", ShortName: "SDX", VIS: ModeSDX,
		SyncTime: 9e-3, PorchTime: 1.5e-3, SeptrTime: 1.5e-3,
		PixelTime: 1.08e-3, LineTime: 1050.3e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 1,
		ColorEnc: ColorGBR, Format: Format111Rev,
	},

	// Robot modes
	{
		Name: "Robot 12", ShortName: "R12", VIS: ModeR12,
		SyncTime: 9e-3, PorchTime: 3e-3, SeptrTime: 6e-3,
		PixelTime: 0.085415625e-3, LineTime: 100e-3,
		ImgWidth: 320, NumLines: 240, LineHeight: 2,
		ColorEnc: ColorYUV, Format: Format420,
	},
	{
		Name: "Robot 24", ShortName: "R24", VIS: ModeR24,
		SyncTime: 6e-3, PorchTime: 2e-3, SeptrTime: 4e-3,
		PixelTime: 0.14375e-3, LineTime: 200e-3,
		ImgWidth: 320, NumLines: 240, LineHeight: 2,
		ColorEnc: ColorYUV, Format: Format422,
	},
	{
		Name: "Robot 36", ShortName: "R36", VIS: ModeR36,
		SyncTime: 9e-3, PorchTime: 3e-3, SeptrTime: 6e-3,
		PixelTime: 0.1375e-3, LineTime: 150e-3,
		ImgWidth: 320, NumLines: 240, LineHeight: 1,
		ColorEnc: ColorYUV, Format: Format420,
	},
	{
		Name: "Robot 72", ShortName: "R72", VIS: ModeR72,
		SyncTime: 9e-3, PorchTime: 3e-3, SeptrTime: 6e-3,
		PixelTime: 0.215625e-3, LineTime: 300e-3,
		ImgWidth: 320, NumLines: 240, LineHeight: 1,
		ColorEnc: ColorYUV, Format: Format422,
	},
	{
		Name: "Robot 8 B/W", ShortName: "R8-BW", VIS: ModeR8BW,
		SyncTime: 6.666e-3, PorchTime: 0, SeptrTime: 0,
		PixelTime: 0.1875e-3, LineTime: 66.666e-3,
		ImgWidth: 320, NumLines: 240, LineHeight: 2,
		ColorEnc: ColorBW, Format: FormatBW,
	},
	{
		Name: "Robot 12 B/W", ShortName: "R12-BW", VIS: ModeR12BW,
		SyncTime: 7e-3, PorchTime: 0, SeptrTime: 0,
		PixelTime: 0.290625e-3, LineTime: 100e-3,
		ImgWidth: 320, NumLines: 240, LineHeight: 2,
		ColorEnc: ColorBW, Format: FormatBW,
	},
	{
		Name: "Robot 24 B/W", ShortName: "R24-BW", VIS: ModeR24BW,
		SyncTime: 7e-3, PorchTime: 0, SeptrTime: 0,
		PixelTime: 0.290625e-3, LineTime: 100e-3,
		ImgWidth: 320, NumLines: 240, LineHeight: 1,
		ColorEnc: ColorBW, Format: FormatBW,
	},
	{
		Name: "Robot 36 B/W", ShortName: "R36-BW", VIS: ModeR36BW,
		SyncTime: 7e-3, PorchTime: 0, SeptrTime: 0,
		PixelTime: 0.446875e-3, LineTime: 150e-3,
		ImgWidth: 320, NumLines: 240, LineHeight: 1,
		ColorEnc: ColorBW, Format: FormatBW,
	},

	// Wraase SC modes
	{
		Name: "Wraase SC-2 60", ShortName: "SC60", VIS: ModeSC60,
		SyncTime: 5.5006e-3, PorchTime: 0.5e-3, SeptrTime: 0,
		PixelTime: 0.24415e-3, LineTime: 240.3846e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 1,
		ColorEnc: ColorRGB, Format: Format111,
	},
	{
		Name: "Wraase SC-2 120", ShortName: "SC120", VIS: ModeSC120,
		SyncTime: 5.52248e-3, PorchTime: 0.5e-3, SeptrTime: 0,
		PixelTime: 0.4890625e-3, LineTime: 475.52248e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 1,
		ColorEnc: ColorRGB, Format: Format111,
	},
	{
		Name: "Wraase SC-2 180", ShortName: "SC180", VIS: ModeSC180,
		SyncTime: 5.5437e-3, PorchTime: 0.5e-3, SeptrTime: 0,
		PixelTime: 0.734375e-3, LineTime: 711.0437e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 1,
		ColorEnc: ColorRGB, Format: Format111,
	},

	// PD modes (YUVY format - Yodd U V Yeven)
	{
		Name: "PD-50", ShortName: "PD50", VIS: ModePD50,
		SyncTime: 20e-3, PorchTime: 2.08e-3, SeptrTime: 0,
		PixelTime: 0.286e-3, LineTime: 388.16e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 2,
		ColorEnc: ColorYUVY, Format: Format111,
	},
	{
		Name: "PD-90", ShortName: "PD90", VIS: ModePD90,
		SyncTime: 20e-3, PorchTime: 2.08e-3, SeptrTime: 0,
		PixelTime: 0.532e-3, LineTime: 703.04e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 2,
		ColorEnc: ColorYUVY, Format: Format111,
	},
	{
		Name: "PD-120", ShortName: "PD120", VIS: ModePD120,
		SyncTime: 20e-3, PorchTime: 2.08e-3, SeptrTime: 0,
		PixelTime: 0.19e-3, LineTime: 508.48e-3,
		ImgWidth: 640, NumLines: 496, LineHeight: 2,
		ColorEnc: ColorYUVY, Format: Format111,
	},
	{
		Name: "PD-160", ShortName: "PD160", VIS: ModePD160,
		SyncTime: 20e-3, PorchTime: 2.08e-3, SeptrTime: 0,
		PixelTime: 0.382e-3, LineTime: 804.416e-3,
		ImgWidth: 512, NumLines: 400, LineHeight: 2,
		ColorEnc: ColorYUVY, Format: Format111,
	},
	{
		Name: "PD-180", ShortName: "PD180", VIS: ModePD180,
		SyncTime: 20e-3, PorchTime: 2.08e-3, SeptrTime: 0,
		PixelTime: 0.286e-3, LineTime: 754.24e-3,
		ImgWidth: 640, NumLines: 496, LineHeight: 2,
		ColorEnc: ColorYUVY, Format: Format111,
	},
	{
		Name: "PD-240", ShortName: "PD240", VIS: ModePD240,
		SyncTime: 20e-3, PorchTime: 2.08e-3, SeptrTime: 0,
		PixelTime: 0.382e-3, LineTime: 1000e-3,
		ImgWidth: 640, NumLines: 496, LineHeight: 2,
		ColorEnc: ColorYUVY, Format: Format111,
	},
	{
		Name: "PD-290", ShortName: "PD290", VIS: ModePD290,
		SyncTime: 20e-3, PorchTime: 2.08e-3, SeptrTime: 0,
		PixelTime: 0.286e-3, LineTime: 937.28e-3,
		ImgWidth: 800, NumLines: 616, LineHeight: 2,
		ColorEnc: ColorYUVY, Format: Format111,
	},

	// Pasokon modes
	{
		Name: "Pasokon P3", ShortName: "P3", VIS: ModeP3,
		SyncTime: 25.0 / 4800.0, PorchTime: 0, SeptrTime: 5.0 / 4800.0,
		PixelTime: 1.0 / 4800.0, LineTime: 409.375e-3,
		ImgWidth: 640, NumLines: 496, LineHeight: 1,
		ColorEnc: ColorRGB, Format: Format111,
	},
	{
		Name: "Pasokon P5", ShortName: "P5", VIS: ModeP5,
		SyncTime: 25.0 / 3200.0, PorchTime: 0, SeptrTime: 5.0 / 3200.0,
		PixelTime: 1.0 / 3200.0, LineTime: 614.0625e-3,
		ImgWidth: 640, NumLines: 496, LineHeight: 1,
		ColorEnc: ColorRGB, Format: Format111,
	},
	{
		Name: "Pasokon P7", ShortName: "P7", VIS: ModeP7,
		SyncTime: 25.0 / 2400.0, PorchTime: 0, SeptrTime: 5.0 / 2400.0,
		PixelTime: 1.0 / 2400.0, LineTime: 818.75e-3,
		ImgWidth: 640, NumLines: 496, LineHeight: 1,
		ColorEnc: ColorRGB, Format: Format111,
	},

	// MMSSTV MP modes (YUVY format like PD)
	{
		Name: "MMSSTV MP73", ShortName: "MP73", VIS: ModeMP73,
		SyncTime: 9.0e-3, PorchTime: 1.0e-3, SeptrTime: 0,
		PixelTime: 0.4375e-3, LineTime: 570.0e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 2,
		ColorEnc: ColorYUVY, Format: Format111,
	},
	{
		Name: "MMSSTV MP115", ShortName: "MP115", VIS: ModeMP115,
		SyncTime: 9.0e-3, PorchTime: 1.0e-3, SeptrTime: 0,
		PixelTime: 0.696875e-3, LineTime: 902.0e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 2,
		ColorEnc: ColorYUVY, Format: Format111,
	},
	{
		Name: "MMSSTV MP140", ShortName: "MP140", VIS: ModeMP140,
		SyncTime: 9.0e-3, PorchTime: 1.0e-3, SeptrTime: 0,
		PixelTime: 0.84375e-3, LineTime: 1090.0e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 2,
		ColorEnc: ColorYUVY, Format: Format111,
	},
	{
		Name: "MMSSTV MP175", ShortName: "MP175", VIS: ModeMP175,
		SyncTime: 9.0e-3, PorchTime: 1.0e-3, SeptrTime: 0,
		PixelTime: 1.0625e-3, LineTime: 1370.0e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 2,
		ColorEnc: ColorYUVY, Format: Format111,
	},

	// MMSSTV MR modes (YUV 4:2:2)
	{
		Name: "MMSSTV MR73", ShortName: "MR73", VIS: ModeMR73,
		SyncTime: 9.0e-3, PorchTime: 1.0e-3, SeptrTime: 0.1e-3,
		PixelTime: 0.215625e-3, LineTime: 286.3e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 1,
		ColorEnc: ColorYUV, Format: Format422,
	},
	{
		Name: "MMSSTV MR90", ShortName: "MR90", VIS: ModeMR90,
		SyncTime: 9.0e-3, PorchTime: 1.0e-3, SeptrTime: 0.1e-3,
		PixelTime: 0.2671875e-3, LineTime: 352.3e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 1,
		ColorEnc: ColorYUV, Format: Format422,
	},
	{
		Name: "MMSSTV MR115", ShortName: "MR115", VIS: ModeMR115,
		SyncTime: 9.0e-3, PorchTime: 1.0e-3, SeptrTime: 0.1e-3,
		PixelTime: 0.34375e-3, LineTime: 450.3e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 1,
		ColorEnc: ColorYUV, Format: Format422,
	},
	{
		Name: "MMSSTV MR140", ShortName: "MR140", VIS: ModeMR140,
		SyncTime: 9.0e-3, PorchTime: 1.0e-3, SeptrTime: 0.1e-3,
		PixelTime: 0.4203125e-3, LineTime: 548.3e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 1,
		ColorEnc: ColorYUV, Format: Format422,
	},
	{
		Name: "MMSSTV MR175", ShortName: "MR175", VIS: ModeMR175,
		SyncTime: 9.0e-3, PorchTime: 1.0e-3, SeptrTime: 0.1e-3,
		PixelTime: 0.5265625e-3, LineTime: 684.3e-3,
		ImgWidth: 320, NumLines: 256, LineHeight: 1,
		ColorEnc: ColorYUV, Format: Format422,
	},

	// MMSSTV ML modes (YUV 4:2:2, higher resolution)
	{
		Name: "MMSSTV ML180", ShortName: "ML180", VIS: ModeML180,
		SyncTime: 9.0e-3, PorchTime: 1.0e-3, SeptrTime: 0.1e-3,
		PixelTime: 0.137890625e-3, LineTime: 363.3e-3,
		ImgWidth: 640, NumLines: 496, LineHeight: 1,
		ColorEnc: ColorYUV, Format: Format422,
	},
	{
		Name: "MMSSTV ML240", ShortName: "ML240", VIS: ModeML240,
		SyncTime: 9.0e-3, PorchTime: 1.0e-3, SeptrTime: 0.1e-3,
		PixelTime: 0.184765625e-3, LineTime: 483.3e-3,
		ImgWidth: 640, NumLines: 496, LineHeight: 1,
		ColorEnc: ColorYUV, Format: Format422,
	},
	{
		Name: "MMSSTV ML280", ShortName: "ML280", VIS: ModeML280,
		SyncTime: 9.0e-3, PorchTime: 1.0e-3, SeptrTime: 0.1e-3,
		PixelTime: 0.216796875e-3, LineTime: 565.3e-3,
		ImgWidth: 640, NumLines: 496, LineHeight: 1,
		ColorEnc: ColorYUV, Format: Format422,
	},
	{
		Name: "MMSSTV ML320", ShortName: "ML320", VIS: ModeML320,
		SyncTime: 9.0e-3, PorchTime: 1.0e-3, SeptrTime: 0.1e-3,
		PixelTime: 0.248046875e-3, LineTime: 645.3e-3,
		ImgWidth: 640, NumLines: 496, LineHeight: 1,
		ColorEnc: ColorYUV, Format: Format422,
	},

	// FAX480
	{
		Name: "FAX480", ShortName: "FAX480", VIS: ModeFX480,
		SyncTime: 5.12e-3, PorchTime: 0, SeptrTime: 0,
		PixelTime: 0.512e-3, LineTime: 267.264e-3,
		ImgWidth: 512, NumLines: 480, LineHeight: 1,
		ColorEnc: ColorBW, Format: FormatBW,
	},
}

// VISMap maps 7-bit VIS codes to mode indices
// Reference: Dave Jones KB4YZ (1998): "List of SSTV Modes with VIS Codes"
var VISMap = [128]uint8{
	// x0        x1  x2        x3  x4        x5        x6        x7  x8        x9  xA        xB  xC        xD  xE        xF
	ModeR12, 0, ModeR8BW, 0, ModeR24, ModeFX480, ModeR12BW, 0, ModeR36, 0, ModeR24BW, 0, ModeR72, 0, ModeR36BW, 0, // 0x
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 1x
	ModeM4, 0, 0, ModeVISX, ModeM3, 0, 0, 0, ModeM2, 0, 0, 0, ModeM1, 0, 0, 0, // 2x
	0, 0, 0, 0, 0, 0, 0, ModeSC180, ModeS2, 0, 0, ModeSC60, ModeS1, 0, 0, ModeSC120, // 3x
	ModeAVT24, 0, 0, 0, ModeAVT90, 0, 0, 0, ModeAVT94, 0, 0, 0, ModeSDX, 0, 0, 0, // 4x
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ModePD50, ModePD290, ModePD120, // 5x
	ModePD180, ModePD240, ModePD160, ModePD90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 6x
	0, ModeP3, ModeP5, ModeP7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 7x
}

// VISXMap maps extended VIS codes (MMSSTV) to mode indices
var VISXMap = [128]uint8{
	// x0  x1  x2  x3  x4  x5        x6        x7  x8  x9        xA        xB  xC        xD  xE  xF
	0, 0, 0, 0, 0, ModeML180, ModeML240, 0, 0, ModeML280, ModeML320, 0, 0, 0, 0, 0, // 0x
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 1x
	0, 0, 0, 0, 0, ModeMP73, 0, 0, 0, ModeMP115, ModeMP140, 0, ModeMP175, 0, 0, 0, // 2x
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 3x
	0, 0, 0, 0, 0, ModeMR73, ModeMR90, 0, 0, ModeMR115, ModeMR140, 0, ModeMR175, 0, 0, 0, // 4x
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 5x
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 6x
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 7x
}

// GetModeByVIS returns the mode specification for a given VIS code
func GetModeByVIS(vis uint8) *ModeSpec {
	if vis >= 128 {
		return nil
	}

	modeIdx := VISMap[vis]
	if modeIdx == 0 {
		return nil
	}

	// Check for extended VIS code
	if modeIdx == ModeVISX {
		return nil // Caller should check extended VIS
	}

	if int(modeIdx) >= len(ModeSpecs) {
		return nil
	}

	return &ModeSpecs[modeIdx]
}

// GetModeByExtendedVIS returns the mode specification for an extended VIS code
func GetModeByExtendedVIS(vis uint8) *ModeSpec {
	if vis >= 128 {
		return nil
	}

	modeIdx := VISXMap[vis]
	if modeIdx == 0 {
		return nil
	}

	if int(modeIdx) >= len(ModeSpecs) {
		return nil
	}

	return &ModeSpecs[modeIdx]
}

// GetModeByIndex returns the mode specification for a given mode index
func GetModeByIndex(idx uint8) *ModeSpec {
	if int(idx) >= len(ModeSpecs) {
		return nil
	}
	return &ModeSpecs[idx]
}

// InitializeModes adjusts mode specifications (called once at startup)
func InitializeModes() {
	// Adjust ImgHeight for modes with LineHeight > 1 or YUVY encoding
	for i := range ModeSpecs {
		m := &ModeSpecs[i]
		if m.Name == "" {
			continue
		}

		m.ImgHeight = m.NumLines

		// YUVY modes have NumLines that represent pairs of lines
		if m.ColorEnc == ColorYUVY {
			m.NumLines /= 2
		} else if m.LineHeight > 1 {
			// Modes with LineHeight > 1 need NumLines adjustment
			m.NumLines /= m.LineHeight
		}
	}
}
