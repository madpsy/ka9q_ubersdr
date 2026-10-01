package main

import (
	"strings"
	"sync"
)

// ubersdrNTPSource is the address install-hub.sh points the host's chrony at
// for the ubersdr-ntp addon, which publishes 123/udp on the host.
const ubersdrNTPSource = "127.0.0.1"

// hostTimeSourceCmd lists the host time daemon's sources. chrony is what
// install-hub.sh installs; ntpq covers hosts installed before the switch.
const hostTimeSourceCmd = "chronyc -n -c sources 2>/dev/null || ntpq -pn 2>/dev/null"

// hostTimeSource is the source the host's own time daemon currently has
// selected. It is information only and never affects NTP health.
type hostTimeSource struct {
	mu      sync.RWMutex
	checked bool   // the host was reached and its daemon answered
	source  string // selected source address, "" when none is selected
}

var globalHostTimeSource = &hostTimeSource{}

// pollHostTimeSource asks the host, through GoTTY, which source its time
// daemon has selected. Leaves the result unchecked when GoTTY is disabled or
// the host cannot be reached, or when neither chronyc nor ntpq answers.
func pollHostTimeSource(cfg *Config) {
	checked, source := false, ""
	if client := NewGoTTYClient(&cfg.SSHProxy); client != nil {
		if resp, err := client.ExecCommand(hostTimeSourceCmd, 10); err == nil && resp.ExitCode == 0 {
			source, checked = parseHostTimeSource(resp.Stdout)
		}
	}

	globalHostTimeSource.mu.Lock()
	globalHostTimeSource.checked = checked
	globalHostTimeSource.source = source
	globalHostTimeSource.mu.Unlock()
}

// parseHostTimeSource returns the selected source from `chronyc -n -c sources`
// (CSV, state "*" in the second field) or `ntpq -pn` (row prefixed "*"), and
// whether the output came from either at all.
func parseHostTimeSource(out string) (source string, ok bool) {
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if f := strings.Split(line, ","); len(f) >= 3 {
			ok = true
			if f[1] == "*" {
				return f[2], true
			}
			continue
		}
		if strings.Contains(line, "refid") || strings.HasPrefix(line, "==") {
			ok = true
			continue
		}
		if strings.HasPrefix(line, "*") {
			if f := strings.Fields(line[1:]); len(f) > 0 {
				return f[0], true
			}
		}
	}
	return "", ok
}
