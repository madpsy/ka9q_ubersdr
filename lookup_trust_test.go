package main

import "testing"

func TestTrustedLookupContainer(t *testing.T) {
	newCfg := func() *Config {
		cfg := &Config{}
		cfg.LookupServices.TrustedContainers = []string{"dxcluster"}
		cfg.Server.containerNameByIP = map[string]string{
			"172.20.0.10": "dxcluster",
			"172.20.0.11": "wefax",
			"172.20.0.12": "caddy",
			"172.20.0.13": "myproxy",
			"172.20.0.14": "removed",
		}
		cfg.Server.TrustedContainers = []string{"myproxy"}
		return cfg
	}
	addons := func() []AddonProxyEntry {
		// Proxy names as addon hosts must still be refused.
		return []AddonProxyEntry{{Name: "wefax", Host: "wefax"}, {Name: "bad", Host: "caddy"}, {Name: "bad2", Host: "myproxy"}}
	}
	off := false

	tests := []struct {
		name    string
		ip      string
		noTrust bool
		want    string
	}{
		{"explicit list", "172.20.0.10", false, "dxcluster"},
		{"addon by default", "172.20.0.11", false, "wefax"},
		{"addon with trust_all_addons off", "172.20.0.11", true, ""},
		{"built-in proxy as addon host", "172.20.0.12", false, ""},
		{"server.trusted_containers proxy as addon host", "172.20.0.13", false, ""},
		{"container no longer an addon", "172.20.0.14", false, ""},
		{"unknown ip", "10.0.0.1", false, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := newCfg()
			if tc.noTrust {
				cfg.LookupServices.TrustAllAddons = &off
			}
			if got := trustedLookupContainer(cfg, tc.ip, addons); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}

	// An explicitly listed proxy is refused too.
	cfg := newCfg()
	cfg.LookupServices.TrustedContainers = []string{"caddy"}
	if got := trustedLookupContainer(cfg, "172.20.0.12", nil); got != "" {
		t.Errorf("explicit proxy: got %q, want \"\"", got)
	}
}
