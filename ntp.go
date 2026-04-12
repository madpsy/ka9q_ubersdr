// Copyright © 2015-2023 Brett Vickers.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.
//
// Adapted from github.com/beevik/ntp for use in package main.
// Authentication and extension support removed; core SNTP query retained.

package main

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/ipv4"
)

var (
	ntpErrInvalidDispersion      = errors.New("ntp: invalid dispersion in response")
	ntpErrInvalidLeapSecond      = errors.New("ntp: invalid leap second in response")
	ntpErrInvalidMode            = errors.New("ntp: invalid mode in response")
	ntpErrInvalidProtocolVersion = errors.New("ntp: invalid protocol version requested")
	ntpErrInvalidStratum         = errors.New("ntp: invalid stratum in response")
	ntpErrInvalidTime            = errors.New("ntp: invalid time reported")
	ntpErrInvalidTransmitTime    = errors.New("ntp: invalid transmit time in response")
	ntpErrKissOfDeath            = errors.New("ntp: kiss of death received")
	ntpErrServerClockFreshness   = errors.New("ntp: server clock not fresh")
	ntpErrServerResponseMismatch = errors.New("ntp: server response didn't match request")
	ntpErrServerTickedBackwards  = errors.New("ntp: server clock ticked backwards")
)

// NtpLeapIndicator is used to warn if a leap second should be inserted
// or deleted in the last minute of the current month.
type NtpLeapIndicator uint8

const (
	NtpLeapNoWarning NtpLeapIndicator = 0
	NtpLeapAddSecond                  = 1
	NtpLeapDelSecond                  = 2
	NtpLeapNotInSync                  = 3
)

const (
	ntpDefaultVersion  = 4
	ntpDefaultPort     = 123
	ntpNanoPerSec      = 1000000000
	ntpMaxStratum      = 16
	ntpDefaultTimeout  = 5 * time.Second
	ntpMaxPollInterval = (1 << 17) * time.Second
	ntpMaxDispersion   = 16 * time.Second
)

var (
	ntpEra0 = time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC)
	ntpEra1 = time.Date(2036, 2, 7, 6, 28, 16, 0, time.UTC)
)

type ntpMode uint8

const (
	ntpModeReserved ntpMode = 0 + iota
	ntpModeSymmetricActive
	ntpModeSymmetricPassive
	ntpModeClient
	ntpModeServer
	ntpModeBroadcast
	ntpModeControlMessage
	ntpModeReservedPrivate
)

type ntpTime uint64

func (t ntpTime) Duration() time.Duration {
	sec := (t >> 32) * ntpNanoPerSec
	frac := (t & 0xffffffff) * ntpNanoPerSec
	nsec := frac >> 32
	if uint32(frac) >= 0x80000000 {
		nsec++
	}
	return time.Duration(sec + nsec)
}

func (t ntpTime) Time() time.Time {
	const t1970 = 0x83aa7e8000000000
	if uint64(t) < t1970 {
		return ntpEra1.Add(t.Duration())
	}
	return ntpEra0.Add(t.Duration())
}

func toNtpTime(t time.Time) ntpTime {
	nsec := uint64(t.Sub(ntpEra0))
	sec := nsec / ntpNanoPerSec
	nsec = uint64(nsec-sec*ntpNanoPerSec) << 32
	frac := uint64(nsec / ntpNanoPerSec)
	if nsec%ntpNanoPerSec >= ntpNanoPerSec/2 {
		frac++
	}
	return ntpTime(sec<<32 | frac)
}

type ntpTimeShort uint32

func (t ntpTimeShort) Duration() time.Duration {
	sec := uint64(t>>16) * ntpNanoPerSec
	frac := uint64(t&0xffff) * ntpNanoPerSec
	nsec := frac >> 16
	if uint16(frac) >= 0x8000 {
		nsec++
	}
	return time.Duration(sec + nsec)
}

type ntpHeader struct {
	LiVnMode       uint8
	Stratum        uint8
	Poll           int8
	Precision      int8
	RootDelay      ntpTimeShort
	RootDispersion ntpTimeShort
	ReferenceID    uint32
	ReferenceTime  ntpTime
	OriginTime     ntpTime
	ReceiveTime    ntpTime
	TransmitTime   ntpTime
}

func (h *ntpHeader) setVersion(v int) {
	h.LiVnMode = (h.LiVnMode & 0xc7) | uint8(v)<<3
}

func (h *ntpHeader) setMode(md ntpMode) {
	h.LiVnMode = (h.LiVnMode & 0xf8) | uint8(md)
}

func (h *ntpHeader) setLeap(li NtpLeapIndicator) {
	h.LiVnMode = (h.LiVnMode & 0x3f) | uint8(li)<<6
}

func (h *ntpHeader) getVersion() int {
	return int((h.LiVnMode >> 3) & 0x7)
}

func (h *ntpHeader) getMode() ntpMode {
	return ntpMode(h.LiVnMode & 0x07)
}

func (h *ntpHeader) getLeap() NtpLeapIndicator {
	return NtpLeapIndicator((h.LiVnMode >> 6) & 0x03)
}

// NtpQueryOptions contains configurable options for NtpQuery.
type NtpQueryOptions struct {
	Timeout       time.Duration
	Version       int
	LocalAddress  string
	TTL           int
	GetSystemTime func() time.Time
	Dialer        func(localAddress, remoteAddress string) (net.Conn, error)
}

// NtpResponse contains time data returned by an NTP server query.
type NtpResponse struct {
	ClockOffset    time.Duration
	Time           time.Time
	RTT            time.Duration
	Precision      time.Duration
	Version        int
	Stratum        uint8
	ReferenceID    uint32
	ReferenceTime  time.Time
	RootDelay      time.Duration
	RootDispersion time.Duration
	RootDistance   time.Duration
	Leap           NtpLeapIndicator
	MinError       time.Duration
	KissCode       string
	Poll           time.Duration
}

// IsKissOfDeath returns true if the response is a "kiss of death".
func (r *NtpResponse) IsKissOfDeath() bool {
	return r.Stratum == 0
}

// ReferenceString returns the ReferenceID formatted as a string.
func (r *NtpResponse) ReferenceString() string {
	if r.Stratum == 0 {
		return ntpKissCode(r.ReferenceID)
	}
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], r.ReferenceID)
	if r.Stratum == 1 {
		const dot = rune(0x22c5)
		var rs []rune
		for i := range b {
			if b[i] == 0 {
				break
			}
			if b[i] >= 32 && b[i] <= 126 {
				rs = append(rs, rune(b[i]))
			} else {
				rs = append(rs, dot)
			}
		}
		return fmt.Sprintf(".%s.", string(rs))
	}
	return fmt.Sprintf("%d.%d.%d.%d", b[0], b[1], b[2], b[3])
}

// Validate checks if the response is valid for time synchronization.
func (r *NtpResponse) Validate() error {
	if r.Stratum == 0 {
		return ntpErrKissOfDeath
	}
	if r.Stratum >= ntpMaxStratum {
		return ntpErrInvalidStratum
	}
	freshness := r.Time.Sub(r.ReferenceTime)
	if freshness > ntpMaxPollInterval {
		return ntpErrServerClockFreshness
	}
	lambda := r.RootDelay/2 + r.RootDispersion
	if lambda > ntpMaxDispersion {
		return ntpErrInvalidDispersion
	}
	if r.Time.Before(r.ReferenceTime) {
		return ntpErrInvalidTime
	}
	if r.Leap == NtpLeapNotInSync {
		return ntpErrInvalidLeapSecond
	}
	return nil
}

// NtpQuery requests time data from a remote NTP server.
// The address is of the form "host", "host:port", etc.
func NtpQuery(address string) (*NtpResponse, error) {
	return NtpQueryWithOptions(address, NtpQueryOptions{})
}

// NtpQueryWithOptions performs the same function as NtpQuery with custom options.
func NtpQueryWithOptions(address string, opt NtpQueryOptions) (*NtpResponse, error) {
	h, now, err := ntpGetTime(address, &opt)
	if err != nil {
		return nil, err
	}
	return ntpGenerateResponse(h, now), nil
}

func ntpGetTime(address string, opt *NtpQueryOptions) (*ntpHeader, ntpTime, error) {
	if opt.Timeout == 0 {
		opt.Timeout = ntpDefaultTimeout
	}
	if opt.Version == 0 {
		opt.Version = ntpDefaultVersion
	}
	if opt.Version < 2 || opt.Version > 4 {
		return nil, 0, ntpErrInvalidProtocolVersion
	}
	if opt.Dialer == nil {
		opt.Dialer = ntpDefaultDialer
	}
	if opt.GetSystemTime == nil {
		opt.GetSystemTime = time.Now
	}

	remoteAddress, err := ntpFixHostPort(address, ntpDefaultPort)
	if err != nil {
		return nil, 0, err
	}

	con, err := opt.Dialer(opt.LocalAddress, remoteAddress)
	if err != nil {
		return nil, 0, err
	}
	defer con.Close()

	if opt.TTL != 0 {
		ipcon := ipv4.NewConn(con)
		if err = ipcon.SetTTL(opt.TTL); err != nil {
			return nil, 0, err
		}
	}

	con.SetDeadline(time.Now().Add(opt.Timeout))

	recvBuf := make([]byte, 8192)
	recvHdr := new(ntpHeader)

	xmitHdr := new(ntpHeader)
	xmitHdr.setMode(ntpModeClient)
	xmitHdr.setVersion(opt.Version)
	xmitHdr.setLeap(NtpLeapNoWarning)
	xmitHdr.Precision = 0x20

	bits := make([]byte, 8)
	if _, err = rand.Read(bits); err != nil {
		return nil, 0, err
	}
	xmitHdr.TransmitTime = ntpTime(binary.BigEndian.Uint64(bits))

	var xmitBuf bytes.Buffer
	binary.Write(&xmitBuf, binary.BigEndian, xmitHdr)

	xmitTime := opt.GetSystemTime()
	if _, err = con.Write(xmitBuf.Bytes()); err != nil {
		return nil, 0, err
	}

	recvBytes, err := con.Read(recvBuf)
	if err != nil {
		return nil, 0, err
	}

	recvTime := opt.GetSystemTime()
	if recvTime.Sub(xmitTime) < 0 {
		recvTime = xmitTime
	}

	recvBuf = recvBuf[:recvBytes]
	recvReader := bytes.NewReader(recvBuf)
	if err = binary.Read(recvReader, binary.BigEndian, recvHdr); err != nil {
		return nil, 0, err
	}

	if recvHdr.getMode() != ntpModeServer {
		return nil, 0, ntpErrInvalidMode
	}
	if recvHdr.TransmitTime == ntpTime(0) {
		return nil, 0, ntpErrInvalidTransmitTime
	}
	if recvHdr.OriginTime != xmitHdr.TransmitTime {
		return nil, 0, ntpErrServerResponseMismatch
	}
	if recvHdr.ReceiveTime > recvHdr.TransmitTime {
		return nil, 0, ntpErrServerTickedBackwards
	}

	recvHdr.OriginTime = toNtpTime(xmitTime)

	return recvHdr, toNtpTime(recvTime), nil
}

func ntpDefaultDialer(localAddress, remoteAddress string) (net.Conn, error) {
	var laddr *net.UDPAddr
	if localAddress != "" {
		var err error
		laddr, err = net.ResolveUDPAddr("udp", net.JoinHostPort(localAddress, "0"))
		if err != nil {
			return nil, err
		}
	}
	raddr, err := net.ResolveUDPAddr("udp", remoteAddress)
	if err != nil {
		return nil, err
	}
	return net.DialUDP("udp", laddr, raddr)
}

func ntpFixHostPort(address string, defaultPort int) (string, error) {
	if len(address) == 0 {
		return "", errors.New("ntp: address string is empty")
	}
	if address[0] == '[' {
		end := strings.IndexByte(address, ']')
		switch {
		case end < 0:
			return "", errors.New("ntp: missing ']' in address")
		case end+1 == len(address):
			return fmt.Sprintf("%s:%d", address, defaultPort), nil
		case address[end+1] == ':':
			return address, nil
		default:
			return "", errors.New("ntp: unexpected character following ']' in address")
		}
	}
	last := strings.LastIndexByte(address, ':')
	if last < 0 {
		return fmt.Sprintf("%s:%d", address, defaultPort), nil
	}
	prev := strings.LastIndexByte(address[:last], ':')
	if prev < 0 {
		return address, nil
	}
	return fmt.Sprintf("[%s]:%d", address, defaultPort), nil
}

func ntpGenerateResponse(h *ntpHeader, recvTime ntpTime) *NtpResponse {
	r := &NtpResponse{
		Time:           h.TransmitTime.Time(),
		ClockOffset:    ntpOffset(h.OriginTime, h.ReceiveTime, h.TransmitTime, recvTime),
		RTT:            ntpRTT(h.OriginTime, h.ReceiveTime, h.TransmitTime, recvTime),
		Precision:      ntpToInterval(h.Precision),
		Version:        h.getVersion(),
		Stratum:        h.Stratum,
		ReferenceID:    h.ReferenceID,
		ReferenceTime:  h.ReferenceTime.Time(),
		RootDelay:      h.RootDelay.Duration(),
		RootDispersion: h.RootDispersion.Duration(),
		Leap:           h.getLeap(),
		MinError:       ntpMinError(h.OriginTime, h.ReceiveTime, h.TransmitTime, recvTime),
		Poll:           ntpToInterval(h.Poll),
	}
	r.RootDistance = ntpRootDistance(r.RTT, r.RootDelay, r.RootDispersion)
	if r.Stratum == 0 {
		r.KissCode = ntpKissCode(r.ReferenceID)
	}
	return r
}

func ntpRTT(org, rec, xmt, dst ntpTime) time.Duration {
	a := int64(dst - org)
	b := int64(xmt - rec)
	rtt := a - b
	if rtt < 0 {
		rtt = 0
	}
	return ntpTime(rtt).Duration()
}

func ntpOffset(org, rec, xmt, dst ntpTime) time.Duration {
	a := int64(rec - org)
	b := int64(xmt - dst)
	offset := a + (b-a)/2
	if offset < 0 {
		return -ntpTime(-offset).Duration()
	}
	return ntpTime(offset).Duration()
}

func ntpMinError(org, rec, xmt, dst ntpTime) time.Duration {
	var error0, error1 ntpTime
	if org >= rec {
		error0 = org - rec
	}
	if xmt >= dst {
		error1 = xmt - dst
	}
	if error0 > error1 {
		return error0.Duration()
	}
	return error1.Duration()
}

func ntpRootDistance(rtt, rootDelay, rootDisp time.Duration) time.Duration {
	totalDelay := rtt + rootDelay
	return totalDelay/2 + rootDisp
}

func ntpToInterval(t int8) time.Duration {
	switch {
	case t > 0:
		return time.Duration(uint64(time.Second) << uint(t))
	case t < 0:
		return time.Duration(uint64(time.Second) >> uint(-t))
	default:
		return time.Second
	}
}

func ntpKissCode(id uint32) string {
	isPrintable := func(ch byte) bool { return ch >= 32 && ch <= 126 }
	b := [4]byte{
		byte(id >> 24),
		byte(id >> 16),
		byte(id >> 8),
		byte(id),
	}
	for _, ch := range b {
		if !isPrintable(ch) {
			return ""
		}
	}
	return string(b[:])
}

// ntpDialWrapper wraps a legacy dial callback — kept for completeness but unused.
func ntpDialWrapper(la, ra string,
	dial func(la string, lp int, ra string, rp int) (net.Conn, error)) (net.Conn, error) {
	rhost, rport, err := net.SplitHostPort(ra)
	if err != nil {
		return nil, err
	}
	rportValue, err := strconv.Atoi(rport)
	if err != nil {
		return nil, err
	}
	return dial(la, 0, rhost, rportValue)
}
