package main

import (
	"encoding/binary"
	"fmt"
	"log"
	"math/rand"
	"net"
	"sync"
	"time"
)

// PSKReporter constants
const (
	PSKServerHostname           = "report.pskreporter.info"
	PSKServerPort               = 4739
	PSKMinSecondsBetweenReports = 120
	PSKMaxUDPPayloadSize        = 1342
	PSKMaxQueueSize             = 10000
)

// PSKReport represents a single spot report for PSKReporter
type PSKReport struct {
	Callsign  string
	Locator   string
	SNR       int
	Frequency uint64
	EpochTime time.Time
	Mode      string
}

// PSKReporter handles PSKReporter spot reporting
type PSKReporter struct {
	// Configuration
	receiverCallsign string
	receiverLocator  string
	programName      string
	antenna          string

	// Socket
	conn net.Conn

	// Packet tracking
	packetID                   uint32
	sequenceNumber             uint32
	packetsSentWithDescriptors int
	timeDescriptorsSent        time.Time

	// Report queue
	reportQueue []PSKReport
	queueMutex  sync.Mutex
	queueCond   *sync.Cond

	// Sent reports tracking (for duplicate prevention)
	sentReports []PSKReport
	sentMutex   sync.Mutex

	// Threading
	running bool
	stopCh  chan struct{}
	wg      sync.WaitGroup
}

// NewPSKReporter creates a new PSKReporter instance
func NewPSKReporter(callsign, locator, programName, antenna string) (*PSKReporter, error) {
	if callsign == "" || locator == "" || programName == "" {
		return nil, fmt.Errorf("callsign, locator, and program name are required")
	}

	psk := &PSKReporter{
		receiverCallsign:    callsign,
		receiverLocator:     locator,
		programName:         programName,
		antenna:             antenna,
		packetID:            rand.Uint32(),
		sequenceNumber:      0,
		timeDescriptorsSent: time.Now().Add(-24 * time.Hour),
		reportQueue:         make([]PSKReport, 0, PSKMaxQueueSize),
		sentReports:         make([]PSKReport, 0, 1000),
		stopCh:              make(chan struct{}),
	}

	psk.queueCond = sync.NewCond(&psk.queueMutex)

	return psk, nil
}

// Connect establishes connection to PSKReporter server
func (psk *PSKReporter) Connect() error {
	// Resolve hostname
	addr, err := net.ResolveUDPAddr("udp", fmt.Sprintf("%s:%d", PSKServerHostname, PSKServerPort))
	if err != nil {
		return fmt.Errorf("failed to resolve PSKReporter server: %w", err)
	}

	// Create UDP connection
	conn, err := net.DialUDP("udp", nil, addr)
	if err != nil {
		return fmt.Errorf("failed to connect to PSKReporter: %w", err)
	}

	psk.conn = conn
	psk.running = true

	// Start sending thread
	psk.wg.Add(1)
	go psk.sendThread()

	log.Printf("PSKReporter: Connected to %s:%d", PSKServerHostname, PSKServerPort)

	return nil
}

// Submit adds a report to the queue
func (psk *PSKReporter) Submit(decode *DecodeInfo) error {
	if !psk.running {
		return fmt.Errorf("PSKReporter not running")
	}

	if decode.Callsign == "" {
		return nil // Skip reports without callsign
	}

	report := PSKReport{
		Callsign:  decode.Callsign,
		Locator:   decode.Locator,
		SNR:       decode.SNR,
		Frequency: decode.Frequency,
		EpochTime: decode.Timestamp,
		Mode:      decode.Mode,
	}

	psk.queueMutex.Lock()
	defer psk.queueMutex.Unlock()

	if len(psk.reportQueue) >= PSKMaxQueueSize {
		return fmt.Errorf("PSKReporter queue full")
	}

	psk.reportQueue = append(psk.reportQueue, report)
	psk.queueCond.Signal()

	return nil
}

// sendThread processes the report queue
func (psk *PSKReporter) sendThread() {
	defer psk.wg.Done()

	for psk.running {
		// Random sleep between 18-38 seconds
		sleepTime := 18 + rand.Intn(21)

		select {
		case <-time.After(time.Duration(sleepTime) * time.Second):
		case <-psk.stopCh:
			return
		}

		if !psk.running {
			break
		}

		// Clean up old sent reports
		psk.cleanupSentReports()
	
		// Make packets from queued reports
		reportCount := 0
		for psk.running {
			count := psk.makePackets()
			reportCount += count
			if count == 0 {
				break
			}
		}
	}
}

// cleanupSentReports removes old sent reports
func (psk *PSKReporter) cleanupSentReports() {
	psk.sentMutex.Lock()
	defer psk.sentMutex.Unlock()

	currentTime := time.Now()
	newReports := make([]PSKReport, 0, len(psk.sentReports))

	for _, report := range psk.sentReports {
		age := currentTime.Sub(report.EpochTime)
		// Keep reports for 2x the duplicate window
		if age >= 0 && age <= (PSKMinSecondsBetweenReports*2)*time.Second {
			newReports = append(newReports, report)
		}
	}

	psk.sentReports = newReports
}

// shouldSkipReport checks if a report is a duplicate
func (psk *PSKReporter) shouldSkipReport(report *PSKReport) (bool, time.Duration) {
	psk.sentMutex.Lock()
	defer psk.sentMutex.Unlock()

	currentTime := time.Now()

	for _, sent := range psk.sentReports {
		if sent.Callsign == report.Callsign &&
			isSameBand(sent.Frequency, report.Frequency) &&
			sent.Mode == report.Mode {
			timeSinceLastSent := currentTime.Sub(sent.EpochTime)
			if timeSinceLastSent <= PSKMinSecondsBetweenReports*time.Second {
				return true, timeSinceLastSent
			}
		}
	}

	return false, 0
}

// isSameBand checks if two frequencies are on the same band
func isSameBand(freq1, freq2 uint64) bool {
	divisor := uint64(1000000) // 1 MHz for HF and above
	// Use 100 kHz divisor for LF/MF bands
	if freq1 <= 1000000 || freq2 <= 1000000 {
		divisor = 100000
	}
	return (freq1 / divisor) == (freq2 / divisor)
}

// makePackets creates and sends packets from queued reports
func (psk *PSKReporter) makePackets() int {
	psk.queueMutex.Lock()
	if len(psk.reportQueue) == 0 {
		psk.queueMutex.Unlock()
		return 0
	}
	psk.queueMutex.Unlock()

	// Build packet
	packet := make([]byte, PSKMaxUDPPayloadSize)
	offset := 0

	// Add header (16 bytes)
	psk.buildHeader(packet, time.Now())
	offset = 16

	// Check if we need descriptors
	timeSinceDescriptors := time.Since(psk.timeDescriptorsSent)
	hasDescriptors := false

	if timeSinceDescriptors >= 500*time.Second || psk.packetsSentWithDescriptors <= 3 {
		descLen := psk.buildDescriptors(packet[offset:])
		offset += descLen
		hasDescriptors = true
	}

	// Add receiver information
	recvLen := psk.buildReceiverInfo(packet[offset:])
	offset += recvLen

	// Add sender records
	reportCount := 0

	for offset < PSKMaxUDPPayloadSize-100 {
		psk.queueMutex.Lock()
		if len(psk.reportQueue) == 0 {
			psk.queueMutex.Unlock()
			break
		}

		report := psk.reportQueue[0]
		psk.reportQueue = psk.reportQueue[1:]
		psk.queueMutex.Unlock()

		// Skip duplicates
		if skip, _ := psk.shouldSkipReport(&report); skip {
			continue
		}

		// Add sender record
		hasLocator := report.Locator != "" && isValidGridLocator(report.Locator)
		recordLen := psk.buildSenderRecord(packet[offset:], &report, hasLocator)
		offset += recordLen
	
		// Track sent report with current timestamp
		psk.sentMutex.Lock()
		report.EpochTime = time.Now() // Update to send time
		psk.sentReports = append(psk.sentReports, report)
		psk.sentMutex.Unlock()

		// Record that we sent data to PSKReporter
		RecordPSKReporterSend()

		reportCount++
	}

	if reportCount == 0 {
		return 0
	}

	// Update packet length in header
	binary.BigEndian.PutUint16(packet[2:4], uint16(offset))

	// Send packet
	psk.sendPacket(packet[:offset])

	// Update tracking
	if hasDescriptors {
		psk.timeDescriptorsSent = time.Now()
		psk.packetsSentWithDescriptors++
	}

	psk.sequenceNumber++

	// Wait 180ms before next packet
	time.Sleep(180 * time.Millisecond)

	return reportCount
}

// buildHeader builds the packet header
func (psk *PSKReporter) buildHeader(buf []byte, timestamp time.Time) {
	// Version (0x000A)
	binary.BigEndian.PutUint16(buf[0:2], 0x000A)

	// Length (filled in later)
	binary.BigEndian.PutUint16(buf[2:4], 0)

	// Timestamp
	binary.BigEndian.PutUint32(buf[4:8], uint32(timestamp.Unix()))

	// Sequence number
	binary.BigEndian.PutUint32(buf[8:12], psk.sequenceNumber)

	// Random ID
	binary.BigEndian.PutUint32(buf[12:16], psk.packetID)
}

// buildReceiverInfo builds the receiver information record
func (psk *PSKReporter) buildReceiverInfo(buf []byte) int {
	payload := make([]byte, 256)
	payloadLen := 0

	// Callsign
	payload[payloadLen] = byte(len(psk.receiverCallsign))
	payloadLen++
	copy(payload[payloadLen:], psk.receiverCallsign)
	payloadLen += len(psk.receiverCallsign)

	// Locator
	payload[payloadLen] = byte(len(psk.receiverLocator))
	payloadLen++
	copy(payload[payloadLen:], psk.receiverLocator)
	payloadLen += len(psk.receiverLocator)

	// Program name
	payload[payloadLen] = byte(len(psk.programName))
	payloadLen++
	copy(payload[payloadLen:], psk.programName)
	payloadLen += len(psk.programName)

	// Antenna information
	if psk.antenna != "" {
		payload[payloadLen] = byte(len(psk.antenna))
		payloadLen++
		copy(payload[payloadLen:], psk.antenna)
		payloadLen += len(psk.antenna)
	} else {
		payload[payloadLen] = 0
		payloadLen++
	}

	// Pad to 4-byte boundary
	for payloadLen%4 != 0 {
		payload[payloadLen] = 0
		payloadLen++
	}

	// Build record
	offset := 0
	buf[offset] = 0x99
	offset++
	buf[offset] = 0x92
	offset++

	totalSize := uint16(payloadLen + 4)
	binary.BigEndian.PutUint16(buf[offset:offset+2], totalSize)
	offset += 2

	copy(buf[offset:], payload[:payloadLen])
	offset += payloadLen

	return offset
}

// buildSenderRecord builds a sender record
func (psk *PSKReporter) buildSenderRecord(buf []byte, report *PSKReport, hasLocator bool) int {
	payload := make([]byte, 256)
	payloadLen := 0

	// Record type
	if hasLocator {
		payload[payloadLen] = 0x64
		payloadLen++
		payload[payloadLen] = 0xAF
		payloadLen++
	} else {
		payload[payloadLen] = 0x62
		payloadLen++
		payload[payloadLen] = 0xA7
		payloadLen++
	}
	payload[payloadLen] = 0x00
	payloadLen++
	payload[payloadLen] = 0x00
	payloadLen++

	// Callsign
	payload[payloadLen] = byte(len(report.Callsign))
	payloadLen++
	copy(payload[payloadLen:], report.Callsign)
	payloadLen += len(report.Callsign)

	// Frequency (Hz)
	binary.BigEndian.PutUint32(payload[payloadLen:payloadLen+4], uint32(report.Frequency))
	payloadLen += 4

	// SNR (preserve sign bit for negative values)
	payload[payloadLen] = byte(report.SNR & 0xFF)
	payloadLen++

	// Mode
	payload[payloadLen] = byte(len(report.Mode))
	payloadLen++
	copy(payload[payloadLen:], report.Mode)
	payloadLen += len(report.Mode)

	// Locator (if present)
	if hasLocator {
		payload[payloadLen] = byte(len(report.Locator))
		payloadLen++
		copy(payload[payloadLen:], report.Locator)
		payloadLen += len(report.Locator)
	}

	// Info source (always 1)
	payload[payloadLen] = 0x01
	payloadLen++

	// Timestamp
	binary.BigEndian.PutUint32(payload[payloadLen:payloadLen+4], uint32(report.EpochTime.Unix()))
	payloadLen += 4

	// Pad to 4-byte boundary
	for payloadLen%4 != 0 {
		payload[payloadLen] = 0
		payloadLen++
	}

	// Update length field
	binary.BigEndian.PutUint16(payload[2:4], uint16(payloadLen))

	copy(buf, payload[:payloadLen])
	return payloadLen
}

// buildDescriptors builds descriptor records
func (psk *PSKReporter) buildDescriptors(buf []byte) int {
	offset := 0

	// Receiver descriptor (includes antenna field)
	recvDesc := []byte{
		0x00, 0x03, // Descriptor type
		0x00, 0x2C, // Length: 44 bytes
		0x99, 0x92, // Receiver record type
		0x00, 0x04, // Field count: 4 fields
		0x00, 0x00, // Padding
		// Field 1: receiverCallsign (0x8002)
		0x80, 0x02, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
		// Field 2: receiverLocator (0x8004)
		0x80, 0x04, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
		// Field 3: decoderSoftware (0x8008)
		0x80, 0x08, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
		// Field 4: antennaInformation (0x8009)
		0x80, 0x09, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
		0x00, 0x00, // Padding
	}
	copy(buf[offset:], recvDesc)
	offset += len(recvDesc)

	// Sender descriptor (with locator)
	sendDescLoc := []byte{
		0x00, 0x02, 0x00, 0x3C, 0x64, 0xAF, 0x00, 0x07,
		0x80, 0x01, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
		0x80, 0x05, 0x00, 0x04, 0x00, 0x00, 0x76, 0x8F,
		0x80, 0x06, 0x00, 0x01, 0x00, 0x00, 0x76, 0x8F,
		0x80, 0x0A, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
		0x80, 0x03, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
		0x80, 0x0B, 0x00, 0x01, 0x00, 0x00, 0x76, 0x8F,
		0x00, 0x96, 0x00, 0x04,
	}
	copy(buf[offset:], sendDescLoc)
	offset += len(sendDescLoc)

	// Sender descriptor (without locator)
	sendDescNoLoc := []byte{
		0x00, 0x02, 0x00, 0x2E, 0x62, 0xA7, 0x00, 0x06,
		0x80, 0x01, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
		0x80, 0x05, 0x00, 0x04, 0x00, 0x00, 0x76, 0x8F,
		0x80, 0x06, 0x00, 0x01, 0x00, 0x00, 0x76, 0x8F,
		0x80, 0x0A, 0xFF, 0xFF, 0x00, 0x00, 0x76, 0x8F,
		0x80, 0x0B, 0x00, 0x01, 0x00, 0x00, 0x76, 0x8F,
		0x00, 0x96, 0x00, 0x04,
	}
	copy(buf[offset:], sendDescNoLoc)
	offset += len(sendDescNoLoc)

	return offset
}

// sendPacket sends a packet to PSKReporter
func (psk *PSKReporter) sendPacket(packet []byte) error {
	if psk.conn == nil {
		return fmt.Errorf("not connected")
	}

	_, err := psk.conn.Write(packet)
	if err != nil {
		log.Printf("PSKReporter: Failed to send packet: %v", err)
		return err
	}

	return nil
}

// Stop stops the PSKReporter
func (psk *PSKReporter) Stop() {
	if !psk.running {
		return
	}

	log.Println("PSKReporter: Stopping...")

	psk.running = false
	close(psk.stopCh)

	// Wake up thread
	psk.queueCond.Broadcast()

	// Wait for thread to finish
	psk.wg.Wait()

	if psk.conn != nil {
		psk.conn.Close()
		psk.conn = nil
	}

	log.Println("PSKReporter: Stopped")
}
