package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
)

// Trusted containers are named in the config (tunnel-client, caddy,
// ubersdr-claude, ...) and looked up in DNS, so a DNS answer is what grants
// trust. Inside Docker the lookup goes to the embedded resolver at 127.0.0.11,
// which answers names it knows and forwards every other one upstream -- with
// the host's search domain appended. A container that isn't running is
// therefore answered by whatever the host's DNS says, and a wildcard record
// there (*.home.lan pointing at a LAN reverse proxy, a CDN edge, ...) used to
// be trusted as that container.
//
// So a forward answer is only accepted once Docker itself vouches for it:
//
//   - ubersdr must be using Docker's embedded DNS, or container names mean
//     nothing and are not resolved at all;
//   - the address must be on one of this process's own (non-loopback)
//     interface networks -- a Docker network ubersdr is attached to -- and not
//     a gateway, which is where port-published traffic appears to come from;
//   - a reverse lookup of the address must name that container. Docker answers
//     PTR queries for its own containers itself ("caddy.<network>."), so this
//     is Docker's record of which container holds the address, not something
//     upstream DNS can supply. Upstream only sees PTR queries for addresses
//     Docker has not assigned, and nothing can send from those.
//
// A literal IP in a trusted-host list is explicit configuration, involves no
// DNS, and is kept as configured.

// lookupAddr, interfaceAddrs, resolvConfPath and routeTablePath are variables
// so tests can supply fixed answers.
var (
	lookupAddr     = net.DefaultResolver.LookupAddr
	interfaceAddrs = net.InterfaceAddrs
	resolvConfPath = "/etc/resolv.conf"
	routeTablePath = "/proc/net/route"
)

// dockerEmbeddedDNS is the resolver Docker writes into a container's
// resolv.conf on a user-defined network.
const dockerEmbeddedDNS = "127.0.0.11"

var (
	errContainerDNSUnavailable = errors.New("not using Docker's embedded DNS")
	errContainerNotConfirmed   = errors.New("no resolved address confirmed by Docker")
)

// containerNetEnv is what an answer is checked against, gathered once per
// refresh. err is set when container names cannot be verified at all.
type containerNetEnv struct {
	nets     []*net.IPNet
	excluded map[string]bool // gateways and this process's own addresses
	err      error
}

func loadContainerNetEnv() containerNetEnv {
	if err := checkDockerEmbeddedDNS(); err != nil {
		return containerNetEnv{err: err}
	}
	addrs, err := interfaceAddrs()
	if err != nil {
		return containerNetEnv{err: fmt.Errorf("cannot list network interfaces: %w", err)}
	}
	env := containerNetEnv{excluded: make(map[string]bool)}
	for _, a := range addrs {
		n, ok := a.(*net.IPNet)
		if !ok || n.IP.IsLoopback() || n.IP.IsLinkLocalUnicast() {
			continue
		}
		env.nets = append(env.nets, n)
		env.excluded[n.IP.String()] = true
		// Docker gives a network's gateway the first address in the subnet
		// unless told otherwise. The default route below covers the primary
		// network's gateway whatever it is; this covers the others.
		if first := firstHost(n); first != nil {
			env.excluded[first.String()] = true
		}
	}
	for _, gw := range routeGateways() {
		env.excluded[gw] = true
	}
	return env
}

// checkDockerEmbeddedDNS reports why container names can't be verified, or
// nil if every nameserver in resolv.conf is Docker's embedded resolver.
func checkDockerEmbeddedDNS() error {
	f, err := os.Open(resolvConfPath)
	if err != nil {
		return fmt.Errorf("%w: %v", errContainerDNSUnavailable, err)
	}
	defer f.Close()
	var servers []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) >= 2 && fields[0] == "nameserver" {
			servers = append(servers, fields[1])
		}
	}
	if len(servers) == 0 {
		return fmt.Errorf("%w: no nameserver in %s", errContainerDNSUnavailable, resolvConfPath)
	}
	for _, s := range servers {
		if s != dockerEmbeddedDNS {
			return fmt.Errorf("%w: %s lists nameserver %s", errContainerDNSUnavailable, resolvConfPath, s)
		}
	}
	return nil
}

// firstHost returns the first usable address of n (the network address + 1).
func firstHost(n *net.IPNet) net.IP {
	ip := n.IP.Mask(n.Mask)
	if ip == nil {
		return nil
	}
	ip = append(net.IP(nil), ip...)
	for i := len(ip) - 1; i >= 0; i-- {
		ip[i]++
		if ip[i] != 0 {
			break
		}
	}
	if !n.Contains(ip) {
		return nil
	}
	return ip
}

// routeGateways returns the IPv4 gateways in the kernel routing table. Inside
// a container that is the default gateway of its primary network.
func routeGateways() []string {
	f, err := os.Open(routeTablePath)
	if err != nil {
		return nil
	}
	defer f.Close()
	var gws []string
	sc := bufio.NewScanner(f)
	sc.Scan() // header
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 3 {
			continue
		}
		b, err := hex.DecodeString(fields[2])
		if err != nil || len(b) != 4 {
			continue
		}
		v := binary.LittleEndian.Uint32(b)
		if v == 0 {
			continue
		}
		gws = append(gws, net.IPv4(byte(v), byte(v>>8), byte(v>>16), byte(v>>24)).String())
	}
	return gws
}

// confirm splits a container name's DNS answer into the addresses Docker
// vouches for and the rest, each rejection with its reason.
func (env containerNetEnv) confirm(ctx context.Context, name string, ips []string) (kept, rejected []string) {
	for _, s := range ips {
		if reason := env.check(ctx, name, s); reason != "" {
			rejected = append(rejected, s+" ("+reason+")")
		} else {
			kept = append(kept, s)
		}
	}
	sort.Strings(rejected)
	return kept, rejected
}

// check returns "" if ip really is the container called name, or why not.
func (env containerNetEnv) check(ctx context.Context, name, s string) string {
	ip := net.ParseIP(s)
	if ip == nil {
		return "not an IP address"
	}
	if env.excluded[ip.String()] {
		return "a gateway or this host's own address"
	}
	onNet := false
	for _, n := range env.nets {
		if n.Contains(ip) {
			onNet = true
			break
		}
	}
	if !onNet {
		return "not on a Docker network shared with ubersdr"
	}
	ptrs, err := lookupAddr(ctx, ip.String())
	if err != nil {
		return "Docker has no container at this address"
	}
	for _, p := range ptrs {
		if ptrNamesContainer(p, name) {
			return ""
		}
	}
	return fmt.Sprintf("Docker names it %s", strings.Join(ptrs, ", "))
}

// ptrNamesContainer reports whether a PTR answer from Docker's embedded DNS
// ("<container>.<network>.") is for the named container.
func ptrNamesContainer(ptr, name string) bool {
	label, rest, ok := strings.Cut(strings.TrimSuffix(ptr, "."), ".")
	return ok && rest != "" && strings.EqualFold(label, name)
}
