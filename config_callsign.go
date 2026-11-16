package main

import (
	"fmt"
	"strings"
)

// validateConfigCallsign rejects values that cannot be a callsign. It backs
// the setup wizard's client-side check so a hand-crafted request (or a stale
// wizard page) cannot store something like "-" as the station callsign.
//
// Station names such as WESSEX are accepted even though they are not strictly
// callsigns; it is the leading/trailing separator rule that rules out "-".
// allowSlash permits portable/prefix forms such as M9PSY/P, which the decoder and DX
// cluster logins accept; the station callsign is letters, digits and hyphens.
func validateConfigCallsign(field, raw string, allowSlash bool) error {
	cs := strings.ToUpper(strings.TrimSpace(raw))
	if cs == "" {
		return fmt.Errorf("%s is required", field)
	}
	maxLen := 10
	if allowSlash {
		maxLen = 15
	}
	if len(cs) < 3 {
		return fmt.Errorf("%s must be at least 3 characters", field)
	}
	if len(cs) > maxLen {
		return fmt.Errorf("%s must be %d characters or less", field, maxLen)
	}
	for _, ch := range cs {
		switch {
		case ch >= 'A' && ch <= 'Z', ch >= '0' && ch <= '9':
		case ch == '-', ch == '/' && allowSlash:
		default:
			if allowSlash {
				return fmt.Errorf("%s can only contain letters, numbers, hyphens and slashes", field)
			}
			return fmt.Errorf("%s can only contain letters, numbers and hyphens", field)
		}
	}
	if strings.ContainsAny(cs[:1], "-/") || strings.ContainsAny(cs[len(cs)-1:], "-/") {
		return fmt.Errorf("%s cannot start or end with a hyphen or slash", field)
	}
	return nil
}

// validateMainConfigCallsigns checks the callsign fields of a main config map
// as submitted to PUT /admin/config. A missing admin.callsign key is left to
// the existing type checks; an empty DX cluster callsign is allowed because the
// wizard clears it when the cluster is disabled.
func validateMainConfigCallsigns(cfg map[string]interface{}) error {
	if admin, ok := cfg["admin"].(map[string]interface{}); ok {
		if cs, ok := admin["callsign"].(string); ok {
			if err := validateConfigCallsign("Callsign", cs, false); err != nil {
				return err
			}
		}
	}
	if dx, ok := cfg["dxcluster"].(map[string]interface{}); ok {
		if cs, ok := dx["callsign"].(string); ok && strings.TrimSpace(cs) != "" {
			if err := validateConfigCallsign("DX cluster callsign", cs, true); err != nil {
				return err
			}
		}
	}
	return nil
}
