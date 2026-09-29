package hpsdr

import (
	"fmt"
	"net"
	"sort"
	"strings"
)

// Iface is a network interface the bridge can report itself on.
//
// The C bridge found its interface with `ip route`, /sys/class/net and ioctl,
// none of which exist on Windows or macOS. The interface supplies the MAC for
// the discovery reply and, when the operator chooses one, the subnet whose
// clients are answered. Every socket still binds the wildcard address, which is
// what receives a broadcast discovery on all three platforms.
type Iface struct {
	Name string
	IP   net.IP
	Net  *net.IPNet
	MAC  net.HardwareAddr
}

// Admits reports whether a client address may use a bridge serving this
// interface: one on its subnet, or loopback for a client on the same machine.
// A zero Iface admits everyone.
func (i Iface) Admits(ip net.IP) bool {
	if i.Net == nil || ip.IsLoopback() {
		return true
	}
	return i.Net.Contains(ip)
}

func (i Iface) String() string {
	if i.IP == nil {
		return i.Name
	}
	return fmt.Sprintf("%s (%s)", i.Name, i.IP)
}

// Interfaces lists the interfaces that are up, not loopback, and have an IPv4
// address, sorted by name.
func Interfaces() ([]Iface, error) {
	ifs, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	var out []Iface
	for _, ifc := range ifs {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		n := ipv4Of(ifc)
		if n == nil {
			continue
		}
		out = append(out, Iface{Name: ifc.Name, IP: n.IP, Net: n, MAC: ifc.HardwareAddr})
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Name < out[b].Name })
	return out, nil
}

func ipv4Of(ifc net.Interface) *net.IPNet {
	addrs, err := ifc.Addrs()
	if err != nil {
		return nil
	}
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok {
			if v4 := n.IP.To4(); v4 != nil {
				return &net.IPNet{IP: v4, Mask: n.Mask[len(n.Mask)-4:]}
			}
		}
	}
	return nil
}

// FindInterface returns the named interface.
func FindInterface(name string) (Iface, error) {
	ifs, err := Interfaces()
	if err != nil {
		return Iface{}, err
	}
	for _, i := range ifs {
		if i.Name == name {
			return i, nil
		}
	}
	names := make([]string, len(ifs))
	for n, i := range ifs {
		names[n] = i.Name
	}
	return Iface{}, fmt.Errorf("interface %q not found (have %v)", name, names)
}

// DefaultInterface is the interface the default route leaves by.
//
// Found by "connecting" a UDP socket to a public address, which sends nothing
// but makes the OS choose a source address, and matching that address to an
// interface. Portable where `ip route get` is not. With no route at all it
// falls back to the first interface that is up.
func DefaultInterface() (Iface, error) {
	ifs, err := Interfaces()
	if err != nil {
		return Iface{}, err
	}
	var local net.IP
	if c, err := net.Dial("udp4", "1.1.1.1:53"); err == nil {
		local = c.LocalAddr().(*net.UDPAddr).IP
		c.Close()
	}
	return chooseDefault(ifs, local)
}

// chooseDefault picks the interface with the route's source address, or, when
// that is unknown, the first one that does not look virtual: a container
// bridge or a VPN tunnel is rarely where an SDR client is.
func chooseDefault(ifs []Iface, local net.IP) (Iface, error) {
	if len(ifs) == 0 {
		return Iface{}, fmt.Errorf("no network interface is up")
	}
	for _, i := range ifs {
		if local != nil && i.IP.Equal(local) {
			return i, nil
		}
	}
	for _, i := range ifs {
		if !looksVirtual(i.Name) {
			return i, nil
		}
	}
	return ifs[0], nil
}

func looksVirtual(name string) bool {
	n := strings.ToLower(name)
	for _, p := range []string{"docker", "br-", "veth", "virbr", "vmnet", "vboxnet", "tun", "tap", "utun",
		"wg", "zt", "tailscale", "lxc", "lxd", "cni", "flannel", "vethernet", "bridge"} {
		if strings.HasPrefix(n, p) {
			return true
		}
	}
	return false
}

// MACFor is the MAC to put in discovery replies. An interface without one (a
// VPN tunnel, say) gets a fixed locally administered address rather than zeros,
// which some clients treat as no radio at all.
func MACFor(i Iface) [6]byte {
	var m [6]byte
	if len(i.MAC) >= 6 {
		copy(m[:], i.MAC[:6])
		return m
	}
	return [6]byte{0x02, 0x55, 0x42, 0x53, 0x44, 0x52} // 02 "UBSDR"
}
