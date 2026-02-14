package ft8

import (
	"strings"
)

/*
 * Text Utilities for FT8/FT4 Message Processing
 * Ported from text.c.ref (KiwiSDR implementation)
 * Character tables, string manipulation, and encoding/decoding helpers
 */

// CharTable represents different character encoding tables used in FT8
type CharTable int

const (
	CharTableFull               CharTable = iota // 0-9 A-Z space + - . / ?
	CharTableAlphanumSpace                       // space 0-9 A-Z
	CharTableAlphanum                            // 0-9 A-Z
	CharTableLettersSpace                        // space A-Z
	CharTableNumeric                             // 0-9
	CharTableAlphanumSpaceSlash                  // 0-9 A-Z space /
)

// TrimFront removes leading whitespace from a string
func TrimFront(s string) string {
	return strings.TrimLeft(s, " ")
}

// TrimBack removes trailing whitespace from a string
func TrimBack(s string) string {
	return strings.TrimRight(s, " ")
}

// Trim removes leading and trailing whitespace
func Trim(s string) string {
	return strings.Trim(s, " ")
}

// ToUpper converts a character to uppercase
func ToUpper(c byte) byte {
	if c >= 'a' && c <= 'z' {
		return c - 'a' + 'A'
	}
	return c
}

// IsDigit checks if a character is a digit
func IsDigit(c byte) bool {
	return c >= '0' && c <= '9'
}

// IsLetter checks if a character is a letter
func IsLetter(c byte) bool {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
}

// IsSpace checks if a character is a space
func IsSpace(c byte) bool {
	return c == ' '
}

// InRange checks if a character is within a range
func InRange(c, min, max byte) bool {
	return c >= min && c <= max
}

// StartsWith checks if a string starts with a prefix
func StartsWith(s, prefix string) bool {
	return strings.HasPrefix(s, prefix)
}

// EndsWith checks if a string ends with a suffix
func EndsWith(s, suffix string) bool {
	return strings.HasSuffix(s, suffix)
}

// Equals checks if two strings are equal
func Equals(s1, s2 string) bool {
	return s1 == s2
}

// FmtMsg formats a message by converting to uppercase and merging consecutive spaces
func FmtMsg(msg string) string {
	var result strings.Builder
	lastWasSpace := false

	for i := 0; i < len(msg); i++ {
		c := msg[i]
		if c == ' ' {
			if !lastWasSpace {
				result.WriteByte(' ')
				lastWasSpace = true
			}
		} else {
			result.WriteByte(ToUpper(c))
			lastWasSpace = false
		}
	}

	return result.String()
}

// AppendString appends a string to another (helper for building messages)
func AppendString(dst, src string) string {
	return dst + src
}

// CopyToken extracts the next whitespace-delimited token from a string
// Returns the token and the remaining string
func CopyToken(s string, maxLength int) (token string, remaining string) {
	s = TrimFront(s)
	if s == "" {
		return "", ""
	}

	// Find the next space or end of string
	idx := strings.IndexByte(s, ' ')
	if idx == -1 {
		// No space found, entire string is the token
		if len(s) <= maxLength {
			return s, ""
		}
		return s[:maxLength], s[maxLength:]
	}

	// Extract token up to space
	if idx <= maxLength {
		return s[:idx], TrimFront(s[idx:])
	}
	return s[:maxLength], TrimFront(s[maxLength:])
}

// DDToInt parses a decimal integer from a string (supports +/- prefix)
func DDToInt(s string, length int) int {
	if s == "" || length == 0 {
		return 0
	}

	negative := false
	i := 0

	if s[0] == '-' {
		negative = true
		i = 1
	} else if s[0] == '+' {
		i = 1
	}

	result := 0
	for i < length && i < len(s) {
		if s[i] == 0 || !IsDigit(s[i]) {
			break
		}
		result = result*10 + int(s[i]-'0')
		i++
	}

	if negative {
		return -result
	}
	return result
}

// IntToDD converts an integer to a decimal string with specified width
func IntToDD(value, width int, fullSign bool) string {
	var result strings.Builder

	if value < 0 {
		result.WriteByte('-')
		value = -value
	} else if fullSign {
		result.WriteByte('+')
	}

	// Calculate divisor for the specified width
	divisor := 1
	for i := 0; i < width-1; i++ {
		divisor *= 10
	}

	// Build the number string
	for divisor >= 1 {
		digit := value / divisor
		result.WriteByte('0' + byte(digit))
		value -= digit * divisor
		divisor /= 10
	}

	return result.String()
}

// Charn converts an index to a character according to the specified table
// This is the inverse of Nchar
func Charn(c int, table CharTable) byte {
	// Handle space prefix for certain tables
	if table != CharTableAlphanum && table != CharTableNumeric {
		if c == 0 {
			return ' '
		}
		c--
	}

	// Handle digits (0-9)
	if table != CharTableLettersSpace {
		if c < 10 {
			return '0' + byte(c)
		}
		c -= 10
	}

	// Handle letters (A-Z)
	if table != CharTableNumeric {
		if c < 26 {
			return 'A' + byte(c)
		}
		c -= 26
	}

	// Handle special characters for FULL table
	if table == CharTableFull {
		if c < 5 {
			return "+-./?"[c]
		}
	} else if table == CharTableAlphanumSpaceSlash {
		if c == 0 {
			return '/'
		}
	}

	return '_' // Unknown character
}

// Nchar converts a character to its index according to the specified table
// This is the inverse of Charn
func Nchar(c byte, table CharTable) int {
	n := 0

	// Handle space prefix for certain tables
	if table != CharTableAlphanum && table != CharTableNumeric {
		if c == ' ' {
			return 0
		}
		n++
	}

	// Handle digits (0-9)
	if table != CharTableLettersSpace {
		if c >= '0' && c <= '9' {
			return n + int(c-'0')
		}
		n += 10
	}

	// Handle letters (A-Z)
	if table != CharTableNumeric {
		if c >= 'A' && c <= 'Z' {
			return n + int(c-'A')
		}
		n += 26
	}

	// Handle special characters for FULL table
	if table == CharTableFull {
		switch c {
		case '+':
			return n + 0
		case '-':
			return n + 1
		case '.':
			return n + 2
		case '/':
			return n + 3
		case '?':
			return n + 4
		}
	} else if table == CharTableAlphanumSpaceSlash {
		if c == '/' {
			return n + 0
		}
	}

	// Character not found
	return -1
}
