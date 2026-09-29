package hpsdr

import (
	"net"
	"testing"
)

func TestChooseDefault(t *testing.T) {
	ifs := []Iface{
		{Name: "br-0d37", IP: net.IPv4(172, 23, 0, 1)},
		{Name: "docker0", IP: net.IPv4(172, 17, 0, 1)},
		{Name: "enp2s0", IP: net.IPv4(192, 168, 9, 108)},
		{Name: "wlan0", IP: net.IPv4(10, 0, 0, 5)},
	}
	if i, _ := chooseDefault(ifs, net.IPv4(10, 0, 0, 5)); i.Name != "wlan0" {
		t.Fatalf("route source ignored: %s", i.Name)
	}
	if i, _ := chooseDefault(ifs, nil); i.Name != "enp2s0" {
		t.Fatalf("fallback chose %s", i.Name)
	}
	if i, _ := chooseDefault(ifs[:2], nil); i.Name != "br-0d37" {
		t.Fatalf("all-virtual fallback chose %s", i.Name)
	}
	if _, err := chooseDefault(nil, nil); err == nil {
		t.Fatal("no interfaces, no error")
	}
}

func TestMACFor(t *testing.T) {
	if m := MACFor(Iface{MAC: net.HardwareAddr{1, 2, 3, 4, 5, 6}}); m != [6]byte{1, 2, 3, 4, 5, 6} {
		t.Fatal(m)
	}
	if m := MACFor(Iface{}); m[0]&2 == 0 {
		t.Fatal("fallback MAC is not locally administered")
	}
}

// The real interface list is whatever this machine has; it must at least not
// fail and not list loopback.
func TestInterfacesListable(t *testing.T) {
	ifs, err := Interfaces()
	if err != nil {
		t.Fatal(err)
	}
	for _, i := range ifs {
		if i.IP.IsLoopback() || i.Net == nil {
			t.Fatalf("%+v", i)
		}
	}
}
