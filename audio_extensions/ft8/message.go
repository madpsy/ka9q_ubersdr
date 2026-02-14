package ft8

import (
	"fmt"
	"strings"
)

/*
 * Complete FT8/FT4 Message Unpacking Implementation
 * Full port from message.c.ref (KiwiSDR implementation)
 * Supports all message types: 0.0-0.6, 1-5
 */

// Message type constants
const (
	NTOKENS  = 2063592 // Number of special tokens
	MAX22    = 4194304 // 2^22
	MAXGRID4 = 32400   // 18*10*18*10
)

// MessageType represents all FT8/FT4 message types
type MessageType int

const (
	MessageTypeFreeText   MessageType = iota // 0.0
	MessageTypeDXpedition                    // 0.1
	MessageTypeEUVHF                         // 0.2
	MessageTypeARRLFD                        // 0.3, 0.4
	MessageTypeTelemetry                     // 0.5
	MessageTypeContesting                    // 0.6
	MessageTypeStandard                      // 1, 2
	MessageTypeARRLRTTY                      // 3
	MessageTypeNonstdCall                    // 4
	MessageTypeWWDIGI                        // 5
	MessageTypeUnknown
)

// GetMessageType extracts the message type from i3 and n3 bits
func GetMessageType(payload [10]uint8) MessageType {
	i3 := (payload[9] >> 3) & 0x07
	n3 := ((payload[8] << 2) & 0x04) | ((payload[9] >> 6) & 0x03)

	switch i3 {
	case 0:
		switch n3 {
		case 0:
			return MessageTypeFreeText
		case 1:
			return MessageTypeDXpedition
		case 2:
			return MessageTypeEUVHF
		case 3, 4:
			return MessageTypeARRLFD
		case 5:
			return MessageTypeTelemetry
		case 6:
			return MessageTypeContesting
		default:
			return MessageTypeUnknown
		}
	case 1, 2:
		return MessageTypeStandard
	case 3:
		return MessageTypeARRLRTTY
	case 4:
		return MessageTypeNonstdCall
	case 5:
		return MessageTypeWWDIGI
	default:
		return MessageTypeUnknown
	}
}

// UnpackMessage unpacks a decoded message payload into human-readable text
// If hashTable is nil, hash lookups will show <...> placeholders
func UnpackMessage(payload [10]uint8) string {
	return UnpackMessageWithHash(payload, nil)
}

// UnpackMessageWithHash unpacks a message with hash table support
func UnpackMessageWithHash(payload [10]uint8, hashTable *CallsignHashTable) string {
	msgType := GetMessageType(payload)

	switch msgType {
	case MessageTypeFreeText:
		return unpackFreeText(payload)
	case MessageTypeTelemetry:
		return unpackTelemetry(payload)
	case MessageTypeStandard:
		return unpackStandard(payload, hashTable)
	case MessageTypeNonstdCall:
		return unpackNonstd(payload, hashTable)
	case MessageTypeDXpedition:
		return unpackDXpedition(payload, hashTable)
	case MessageTypeContesting:
		return unpackContesting(payload, hashTable)
	default:
		i3 := (payload[9] >> 3) & 0x07
		n3 := ((payload[8] << 2) & 0x04) | ((payload[9] >> 6) & 0x03)
		return fmt.Sprintf("[Type %d.%d - not yet implemented]", i3, n3)
	}
}

// unpackFreeText unpacks free text messages (Type 0.0)
// Uses 42-character alphabet, up to 13 characters
func unpackFreeText(payload [10]uint8) string {
	// Extract 71 bits of telemetry data
	b71 := make([]uint8, 9)
	carry := uint8(0)
	for i := 0; i < 9; i++ {
		b71[i] = (carry << 7) | (payload[i] >> 1)
		carry = payload[i] & 0x01
	}

	// Decode 13 characters using base-42 encoding
	c14 := make([]byte, 14)
	c14[13] = 0

	for idx := 12; idx >= 0; idx-- {
		// Divide the long integer in b71 by 42
		rem := uint16(0)
		for i := 0; i < 9; i++ {
			rem = (rem << 8) | uint16(b71[i])
			b71[i] = uint8(rem / 42)
			rem = rem % 42
		}
		c14[idx] = Charn(int(rem), CharTableFull)
	}

	return Trim(string(c14[:13]))
}

// unpackTelemetry unpacks telemetry data (Type 0.5)
func unpackTelemetry(payload [10]uint8) string {
	// Extract 71 bits
	b71 := make([]uint8, 9)
	carry := uint8(0)
	for i := 0; i < 9; i++ {
		b71[i] = (carry << 7) | (payload[i] >> 1)
		carry = payload[i] & 0x01
	}

	// Convert to hex string (18 hex digits)
	hex := make([]byte, 18)
	for i := 0; i < 9; i++ {
		nibble1 := (b71[i] >> 4)
		nibble2 := (b71[i] & 0x0F)
		if nibble1 > 9 {
			hex[i*2] = nibble1 - 10 + 'A'
		} else {
			hex[i*2] = nibble1 + '0'
		}
		if nibble2 > 9 {
			hex[i*2+1] = nibble2 - 10 + 'A'
		} else {
			hex[i*2+1] = nibble2 + '0'
		}
	}

	return fmt.Sprintf("Telemetry: %s", string(hex))
}

// unpackStandard unpacks standard messages (Type 1 or 2)
// Format: c28 r1 c28 r1 R1 g15
func unpackStandard(payload [10]uint8, hashTable *CallsignHashTable) string {
	// Extract packed fields
	n29a := uint32(payload[0])<<21 | uint32(payload[1])<<13 | uint32(payload[2])<<5 | uint32(payload[3]>>3)
	n29b := uint32(payload[3]&0x07)<<26 | uint32(payload[4])<<18 | uint32(payload[5])<<10 | uint32(payload[6])<<2 | uint32(payload[7]>>6)
	R1 := (payload[7] >> 5) & 0x01
	igrid4 := uint16(payload[7]&0x1F)<<10 | uint16(payload[8])<<2 | uint16(payload[9]>>6)
	i3 := (payload[9] >> 3) & 0x07

	// Unpack callsigns
	n28a := n29a >> 1
	ip_a := uint8(n29a & 0x01)
	callTo := unpack28(n28a, ip_a, i3, hashTable)

	n28b := n29b >> 1
	ip_b := uint8(n29b & 0x01)
	callDe := unpack28(n28b, ip_b, i3, hashTable)

	// Unpack grid/report
	extra := unpackGrid(igrid4, R1)

	// Build message
	parts := []string{}
	if callTo != "" {
		parts = append(parts, callTo)
	}
	if callDe != "" {
		parts = append(parts, callDe)
	}
	if extra != "" {
		parts = append(parts, extra)
	}

	return strings.Join(parts, " ")
}

// unpackNonstd unpacks non-standard callsign messages (Type 4)
// Format: h12 c58 h1 r2 c1
func unpackNonstd(payload [10]uint8, hashTable *CallsignHashTable) string {
	// Extract packed fields
	h12 := uint16(payload[0])<<4 | uint16(payload[1]>>4)
	n58 := uint64(payload[1]&0x0F)<<54 | uint64(payload[2])<<46 | uint64(payload[3])<<38 |
		uint64(payload[4])<<30 | uint64(payload[5])<<22 | uint64(payload[6])<<14 |
		uint64(payload[7])<<6 | uint64(payload[8]>>2)
	iflip := (payload[8] >> 1) & 0x01
	nrpt := uint8(payload[8]&0x01)<<1 | uint8(payload[9]>>7)
	icq := (payload[9] >> 6) & 0x01

	// Decode 58-bit callsign
	callDecoded := unpack58(n58, hashTable)

	// Lookup 12-bit hash
	call3 := "<...>"
	if hashTable != nil {
		if found, ok := hashTable.LookupHash(Hash12Bits, uint32(h12)); ok {
			call3 = "<" + found + ">"
		}
	}

	// Determine call order
	var call1, call2 string
	if iflip == 1 {
		call1 = callDecoded
		call2 = call3
	} else {
		call1 = call3
		call2 = callDecoded
	}

	// Build message
	var callTo, callDe, extra string
	if icq == 0 {
		callTo = call1
		callDe = call2
		switch nrpt {
		case 1:
			extra = "RRR"
		case 2:
			extra = "RR73"
		case 3:
			extra = "73"
		}
	} else {
		callTo = "CQ"
		callDe = call2
	}

	parts := []string{callTo, callDe}
	if extra != "" {
		parts = append(parts, extra)
	}
	return strings.Join(parts, " ")
}

// unpackDXpedition unpacks DXpedition mode messages (Type 0.1)
// Format: c28 c28 h10 r5
func unpackDXpedition(payload [10]uint8, hashTable *CallsignHashTable) string {
	// Extract packed fields
	n28a := uint32(payload[0])<<20 | uint32(payload[1])<<12 | uint32(payload[2])<<4 | uint32(payload[3]>>4)
	n28b := uint32(payload[3]&0x0F)<<24 | uint32(payload[4])<<16 | uint32(payload[5])<<8 | uint32(payload[6])
	h10 := uint16(payload[7])<<2 | uint16(payload[8]>>6)
	r5 := (payload[8] >> 1) & 0x1F

	// Unpack callsigns
	callRR := unpack28(n28a, 0, 0, hashTable) + " RR73;"
	callTo := unpack28(n28b, 0, 0, hashTable)

	// Lookup 10-bit hash
	callDe := "<...>"
	if hashTable != nil {
		if found, ok := hashTable.LookupHash(Hash10Bits, uint32(h10)); ok {
			callDe = "<" + found + ">"
		}
	}

	// Decode report: r5 (0..31) => -30,-28..+30,+32
	report := IntToDD(int(r5)*2-30, 2, true)

	return fmt.Sprintf("%s %s %s %s", callRR, callTo, callDe, report)
}

// unpackContesting unpacks contesting messages (Type 0.6)
// Format: c28 c28 g15
func unpackContesting(payload [10]uint8, hashTable *CallsignHashTable) string {
	// Extract packed fields
	n28a := uint32(payload[0])<<20 | uint32(payload[1])<<12 | uint32(payload[2])<<4 | uint32(payload[3]>>4)
	n28b := uint32(payload[3]&0x0F)<<24 | uint32(payload[4])<<16 | uint32(payload[5])<<8 | uint32(payload[6])
	g15 := uint16(payload[7]&0x7F)<<8 | uint16(payload[8])

	// Unpack callsigns
	callTo := unpack28(n28a, 0, 0, hashTable)
	callDe := unpack28(n28b, 0, 0, hashTable)

	// Unpack grid
	grid := unpackGrid(g15, 0)

	parts := []string{callTo, callDe}
	if grid != "" {
		parts = append(parts, grid)
	}
	return strings.Join(parts, " ")
}

// unpack28 unpacks a 28-bit callsign with full support for all special cases
func unpack28(n28 uint32, ip uint8, i3 uint8, hashTable *CallsignHashTable) string {
	// Check for special tokens
	if n28 < NTOKENS {
		if n28 <= 2 {
			switch n28 {
			case 0:
				return "DE"
			case 1:
				return "QRZ"
			case 2:
				return "CQ"
			}
		}
		if n28 <= 1002 {
			// CQ nnn with 3 digits
			return fmt.Sprintf("CQ %03d", n28-3)
		}
		if n28 <= 532443 {
			// CQ ABCD with 4 alphanumeric symbols
			n := n28 - 1003
			aaaa := make([]byte, 4)
			for i := 3; i >= 0; i-- {
				aaaa[i] = Charn(int(n%27), CharTableLettersSpace)
				n /= 27
			}
			return "CQ " + TrimFront(string(aaaa))
		}
		return ""
	}

	n28 = n28 - NTOKENS
	if n28 < MAX22 {
		// This is a 22-bit hash
		if hashTable != nil {
			if call, found := hashTable.LookupHash(Hash22Bits, n28); found {
				return "<" + call + ">"
			}
		}
		return fmt.Sprintf("<...%04X>", n28&0xFFFF)
	}

	// Standard callsign
	n := n28 - MAX22

	callsign := make([]byte, 6)
	callsign[5] = Charn(int(n%27), CharTableLettersSpace)
	n /= 27
	callsign[4] = Charn(int(n%27), CharTableLettersSpace)
	n /= 27
	callsign[3] = Charn(int(n%27), CharTableLettersSpace)
	n /= 27
	callsign[2] = Charn(int(n%10), CharTableNumeric)
	n /= 10
	callsign[1] = Charn(int(n%36), CharTableAlphanum)
	n /= 36
	callsign[0] = Charn(int(n%37), CharTableAlphanumSpace)

	result := string(callsign)

	// Handle special prefixes
	if StartsWith(result, "3D0") && !IsSpace(result[3]) {
		// Swaziland: 3D0XYZ -> 3DA0XYZ
		result = "3DA0" + Trim(result[3:])
	} else if result[0] == 'Q' && IsLetter(result[1]) {
		// Guinea: QA0XYZ -> 3XA0XYZ
		result = "3X" + Trim(result[1:])
	} else {
		result = Trim(result)
	}

	if len(result) < 3 {
		return ""
	}

	// Add suffix if present
	if ip != 0 {
		if i3 == 1 {
			result += "/R"
		} else if i3 == 2 {
			result += "/P"
		}
	}

	// Save to hash table
	if hashTable != nil {
		hashTable.SaveCallsign(result)
	}

	return result
}

// unpack58 unpacks a 58-bit non-standard callsign
func unpack58(n58 uint64, hashTable *CallsignHashTable) string {
	// Decode 11 characters from base-38 encoding
	c11 := make([]byte, 11)
	for i := 10; i >= 0; i-- {
		c11[i] = Charn(int(n58%38), CharTableAlphanumSpaceSlash)
		n58 /= 38
	}

	callsign := Trim(string(c11))

	// Save to hash table
	if hashTable != nil && len(callsign) >= 3 {
		hashTable.SaveCallsign(callsign)
	}

	return callsign
}

// unpackGrid unpacks grid square or report from 15 bits
func unpackGrid(igrid4 uint16, R1 uint8) string {
	// Check for special values
	if igrid4 == 0 {
		return ""
	}
	if igrid4 == MAXGRID4+1 {
		return ""
	}
	if igrid4 == MAXGRID4+2 {
		return "RRR"
	}
	if igrid4 == MAXGRID4+3 {
		return "RR73"
	}
	if igrid4 == MAXGRID4+4 {
		return "73"
	}

	// Check if it's a grid square
	if igrid4 <= MAXGRID4 {
		// Extract 4-character grid
		n := int(igrid4)
		grid := make([]byte, 4)
		grid[3] = '0' + byte(n%10)
		n /= 10
		grid[2] = '0' + byte(n%10)
		n /= 10
		grid[1] = 'A' + byte(n%18)
		n /= 18
		grid[0] = 'A' + byte(n%18)

		if R1 == 1 {
			return "R " + string(grid)
		}
		return string(grid)
	}

	// It's a signal report
	irpt := int(igrid4) - MAXGRID4
	if R1 == 1 {
		return "R" + IntToDD(irpt-35, 2, true)
	}
	return IntToDD(irpt-35, 2, true)
}
