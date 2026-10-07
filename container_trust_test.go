package main

import (
	"bytes"
	"context"
	"errors"
	"log"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

// sdrNetwork is the compose file's sdr-network as seen from inside ubersdr.
var sdrNetwork = &net.IPNet{IP: net.ParseIP("172.20.0.5"), Mask: net.CIDRMask(16, 32)}

// fakeDocker stands in for Docker's embedded DNS. fwd answers forward lookups
// (a missing name is NXDOMAIN); ptr answers reverse lookups the way Docker
// does for its own containers ("<name>.<network>."), and a missing address is
// one Docker has not assigned.
type fakeDocker struct {
	fwd     map[string][]string
	ptr     map[string]string
	lookups atomic.Int32
}

// stubContainerEnv installs d as the resolver, sdrNetwork as the only
// interface, nameserver as resolv.conf's only server and 172.20.0.1 as the
// default gateway, restoring everything when the test ends.
func stubContainerEnv(t *testing.T, d *fakeDocker, nameserver string) {
	t.Helper()
	dir := t.TempDir()
	resolv := filepath.Join(dir, "resolv.conf")
	if err := os.WriteFile(resolv, []byte("search example.lan\nnameserver "+nameserver+"\noptions ndots:0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	route := filepath.Join(dir, "route")
	// 172.20.0.1 little-endian, as /proc/net/route prints it.
	table := "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n" +
		"eth0\t00000000\t010014AC\t0003\t0\t0\t0\t00000000\t0\t0\t0\n" +
		"eth0\t000014AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0\n"
	if err := os.WriteFile(route, []byte(table), 0o644); err != nil {
		t.Fatal(err)
	}

	origHost, origAddr, origIfaces, origResolv, origRoute := lookupHost, lookupAddr, interfaceAddrs, resolvConfPath, routeTablePath
	t.Cleanup(func() {
		lookupHost, lookupAddr, interfaceAddrs, resolvConfPath, routeTablePath = origHost, origAddr, origIfaces, origResolv, origRoute
	})
	resolvConfPath, routeTablePath = resolv, route
	interfaceAddrs = func() ([]net.Addr, error) {
		return []net.Addr{&net.IPNet{IP: net.ParseIP("127.0.0.1"), Mask: net.CIDRMask(8, 32)}, sdrNetwork}, nil
	}
	lookupHost = func(ctx context.Context, host string) ([]string, error) {
		d.lookups.Add(1)
		if ips, ok := d.fwd[host]; ok {
			return ips, nil
		}
		return nil, errors.New("no such host")
	}
	lookupAddr = func(ctx context.Context, addr string) ([]string, error) {
		if name, ok := d.ptr[addr]; ok {
			return []string{name}, nil
		}
		return nil, errors.New("server misbehaving")
	}
}

// captureLog sends the standard logger to a buffer for the rest of the test.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	orig := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(orig) })
	return &buf
}

func TestPtrNamesContainer(t *testing.T) {
	tests := []struct {
		ptr, name string
		want      bool
	}{
		{"caddy.ubersdr_sdr-network.", "caddy", true},
		{"Caddy.ubersdr_sdr-network.", "caddy", true},
		{"caddy.my.dotted.net.", "caddy", true},
		{"caddy.", "caddy", false}, // no network label: not Docker's form
		{"caddy-forged.ubersdr_sdr-network.", "caddy", false},
		{"ubersdr-gotty.ubersdr_sdr-network.", "caddy", false},
		{"", "caddy", false},
	}
	for _, tt := range tests {
		if got := ptrNamesContainer(tt.ptr, tt.name); got != tt.want {
			t.Errorf("ptrNamesContainer(%q, %q) = %v, want %v", tt.ptr, tt.name, got, tt.want)
		}
	}
}

func TestFirstHost(t *testing.T) {
	if got := firstHost(sdrNetwork); !got.Equal(net.ParseIP("172.20.0.1")) {
		t.Errorf("firstHost(%v) = %v, want 172.20.0.1", sdrNetwork, got)
	}
	v6 := &net.IPNet{IP: net.ParseIP("fd00:20::5"), Mask: net.CIDRMask(64, 128)}
	if got := firstHost(v6); !got.Equal(net.ParseIP("fd00:20::1")) {
		t.Errorf("firstHost(%v) = %v, want fd00:20::1", v6, got)
	}
}

// Each way a DNS answer can claim to be a container without being one. The
// answers are the ones a wildcard upstream resolver gave behind Docker's
// embedded DNS in a live test; the PTR forms are what Docker returned.
func TestResolveContainerIPsTrustsOnlyDockerConfirmedAnswers(t *testing.T) {
	d := &fakeDocker{
		fwd: map[string][]string{
			"caddy":                 {"172.20.0.12"},
			"tunnel-client":         {"104.21.12.92", "172.67.194.5"}, // public CDN edge
			"tunnel-support-client": {"192.168.1.10"},                 // LAN reverse proxy
			"ubersdr-claude":        {"172.20.0.13"},                  // a different, real container
			"dxcluster":             {"172.20.0.1"},                   // the gateway: port-published traffic
			"voiceskimmer":          {"172.20.0.77"},                  // unassigned: PTR forwarded upstream
			"skimmer":               {"127.0.0.1"},
		},
		ptr: map[string]string{
			"172.20.0.12":  "caddy.ubersdr_sdr-network.",
			"172.20.0.13":  "ubersdr-gotty.ubersdr_sdr-network.",
			"192.168.1.10": "tunnel-support-client.example.lan.", // forged upstream; off-network anyway
		},
	}
	stubContainerEnv(t, d, dockerEmbeddedDNS)
	buf := captureLog(t)

	sc := &ServerConfig{
		widgetResolveNames:  []string{"ubersdr-claude"},
		injectResolveNames:  []string{"dxcluster"},
		whisperResolveNames: []string{"voiceskimmer"},
		lookupResolveNames:  []string{"skimmer"},
	}
	sc.resolveContainerIPs()

	if want := []string{"172.20.0.12"}; !reflect.DeepEqual(sc.containerProxyIPs, want) {
		t.Errorf("containerProxyIPs = %v, want %v", sc.containerProxyIPs, want)
	}
	if want := map[string]string{"172.20.0.12": "caddy"}; !reflect.DeepEqual(sc.containerNameByIP, want) {
		t.Errorf("containerNameByIP = %v, want %v", sc.containerNameByIP, want)
	}
	for _, name := range []string{"tunnel-client", "tunnel-support-client", "ubersdr-claude", "dxcluster", "voiceskimmer", "skimmer"} {
		if !strings.Contains(buf.String(), "trusted container '"+name+"' resolved to ") {
			t.Errorf("no rejection warning for %s:\n%s", name, buf)
		}
	}
	if !strings.Contains(buf.String(), "Docker names it ubersdr-gotty.ubersdr_sdr-network.") {
		t.Errorf("warning does not say which container Docker reports:\n%s", buf)
	}
}

// A container that stops keeps its last address only while Docker still says
// the address is that container's -- a wildcard answer must not replace it,
// and a different container given the address must not inherit its trust.
func TestResolveContainerIPsFallbackNeedsDockerConfirmation(t *testing.T) {
	d := &fakeDocker{
		fwd: map[string][]string{"tunnel-client": {"104.21.12.92"}},
		ptr: map[string]string{"172.20.0.13": "tunnel-client.ubersdr_sdr-network."},
	}
	stubContainerEnv(t, d, dockerEmbeddedDNS)
	captureLog(t)

	sc := &ServerConfig{containerNameByIP: map[string]string{"172.20.0.13": "tunnel-client"}}
	sc.resolveContainerIPs()
	if got := sc.GetContainerName("172.20.0.13"); got != "tunnel-client" {
		t.Fatalf("still-confirmed address dropped: GetContainerName = %q", got)
	}

	// Docker now gives the address to another container.
	d.ptr["172.20.0.13"] = "ubersdr-gotty.ubersdr_sdr-network."
	sc.resolveContainerIPs()
	if got := sc.GetContainerName("172.20.0.13"); got != "" {
		t.Errorf("reassigned address still trusted as %q", got)
	}
	if len(sc.containerProxyIPs) != 0 {
		t.Errorf("containerProxyIPs = %v, want empty", sc.containerProxyIPs)
	}
}

// The refresh runs every 5 seconds, so a warning must only appear when the
// rejected answer for a name changes, and answer order must not count.
func TestResolveContainerIPsWarnsOncePerChange(t *testing.T) {
	d := &fakeDocker{fwd: map[string][]string{"caddy": {"104.21.12.92", "172.67.194.5"}}}
	stubContainerEnv(t, d, dockerEmbeddedDNS)
	buf := captureLog(t)
	warnings := func() int { return strings.Count(buf.String(), "trusted container 'caddy' resolved to ") }

	sc := &ServerConfig{}
	sc.resolveContainerIPs()
	d.fwd["caddy"] = []string{"172.67.194.5", "104.21.12.92"}
	sc.resolveContainerIPs()
	sc.resolveContainerIPs()
	if n := warnings(); n != 1 {
		t.Fatalf("same answer three times, reordered once: %d warnings, want 1\n%s", n, buf)
	}

	d.fwd["caddy"] = []string{"192.168.1.10"}
	sc.resolveContainerIPs()
	if n := warnings(); n != 2 {
		t.Fatalf("after the answer changed: %d warnings, want 2\n%s", n, buf)
	}
}

// Outside Docker's embedded DNS a container name is just a hostname for
// whatever the LAN's DNS says, so names are not resolved at all; that is logged
// once, and literal IP entries still apply.
func TestResolveContainerIPsNeedsDockerEmbeddedDNS(t *testing.T) {
	d := &fakeDocker{
		fwd: map[string][]string{"caddy": {"172.20.0.12"}},
		ptr: map[string]string{"172.20.0.12": "caddy.lan."},
	}
	stubContainerEnv(t, d, "192.168.1.1")
	buf := captureLog(t)

	sc := &ServerConfig{widgetResolveNames: []string{"192.168.1.50"}}
	sc.resolveContainerIPs()
	sc.resolveContainerIPs()
	sc.resolveContainerIPs()

	if n := d.lookups.Load(); n != 0 {
		t.Errorf("%d DNS lookups made without Docker's embedded DNS, want 0", n)
	}
	if want := map[string]string{"192.168.1.50": "192.168.1.50"}; !reflect.DeepEqual(sc.containerNameByIP, want) {
		t.Errorf("containerNameByIP = %v, want %v", sc.containerNameByIP, want)
	}
	if n := strings.Count(buf.String(), "Trusted container names are not being resolved"); n != 1 {
		t.Errorf("after 3 refreshes: %d notices, want 1\n%s", n, buf)
	}
}

// inject_trusted_hosts and widget_trusted_hosts are documented as accepting
// IPs. Such an entry is explicit configuration, not a DNS answer, so it is
// kept wherever it points and never looked up.
func TestResolveContainerIPsKeepsLiteralIPEntries(t *testing.T) {
	d := &fakeDocker{}
	stubContainerEnv(t, d, dockerEmbeddedDNS)
	buf := captureLog(t)

	sc := &ServerConfig{
		widgetResolveNames: []string{"192.168.1.50"},
		injectResolveNames: []string{"2001:db8::5"},
	}
	sc.resolveContainerIPs()

	if !sc.IsContainerIP("192.168.1.50", "192.168.1.50") {
		t.Error("literal IPv4 entry 192.168.1.50 was dropped")
	}
	if !sc.IsContainerIP("2001:db8::5", "2001:db8::5") {
		t.Error("literal IPv6 entry 2001:db8::5 was dropped")
	}
	if strings.Contains(buf.String(), "192.168.1.50 (") || strings.Contains(buf.String(), "2001:db8::5 (") {
		t.Errorf("literal entries produced a rejection warning:\n%s", buf)
	}
}
