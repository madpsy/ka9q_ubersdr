package ft8

/*
 * FT8 Extension Registration
 * Registers the FT8 decoder with UberSDR's audio extension framework
 */

// AudioExtensionFactory is a function that creates a new extension instance
type AudioExtensionFactory func(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error)

// AudioExtensionInfo contains metadata about a registered extension
type AudioExtensionInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Version     string `json:"version"`
}

// Factory creates a new FT8 extension instance
func Factory(audioParams AudioExtensionParams, extensionParams map[string]interface{}) (AudioExtension, error) {
	return NewFT8Extension(audioParams, extensionParams)
}

// Info returns metadata about the FT8 extension
func Info() AudioExtensionInfo {
	return AudioExtensionInfo{
		Name:        "ft8",
		Description: "FT8/FT4 digital mode decoder",
		Version:     "1.0.0",
	}
}

// GetInfo returns metadata as a map (for compatibility with main.go pattern)
func GetInfo() map[string]interface{} {
	info := Info()
	return map[string]interface{}{
		"name":        info.Name,
		"description": info.Description,
		"version":     info.Version,
	}
}
