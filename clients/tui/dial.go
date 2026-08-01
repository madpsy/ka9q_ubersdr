package main

import (
	"context"
	"net"
	"time"
)

// forceIPv4 makes every outbound connection dial over IPv4 only. It is set by
// the -4 flag. LAN discovery is IPv4-only regardless of this (see discovery.go),
// because an mDNS link-local IPv6 literal is rarely what the user wants and is
// often unroutable from the machine that heard the advertisement.
var forceIPv4 bool

// ipv4Dialer mirrors the stdlib transport defaults, so forcing IPv4 changes the
// address family and nothing else.
var ipv4Dialer = &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}

// dialIPv4 dials addr over IPv4 only. The unspecified networks are rewritten to
// their v4 forms so a host with both A and AAAA records never falls back to
// IPv6 during Happy Eyeballs.
func dialIPv4(ctx context.Context, network, addr string) (net.Conn, error) {
	switch network {
	case "tcp":
		network = "tcp4"
	case "udp":
		network = "udp4"
	}
	return ipv4Dialer.DialContext(ctx, network, addr)
}

// dialFunc returns the dial function to install on an http.Transport or a
// websocket.Dialer: nil — meaning the stdlib's own dual-stack dialer — unless
// IPv4 is being forced.
func dialFunc() func(context.Context, string, string) (net.Conn, error) {
	if !forceIPv4 {
		return nil
	}
	return dialIPv4
}
