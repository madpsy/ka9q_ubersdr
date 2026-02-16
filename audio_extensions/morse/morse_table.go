package morse

// morseTable maps Morse code patterns to characters
var morseTable = map[string]string{
	// Letters
	".-":   "A",
	"-...": "B",
	"-.-.": "C",
	"-..":  "D",
	".":    "E",
	"..-.": "F",
	"--.":  "G",
	"....": "H",
	"..":   "I",
	".---": "J",
	"-.-":  "K",
	".-..": "L",
	"--":   "M",
	"-.":   "N",
	"---":  "O",
	".--.": "P",
	"--.-": "Q",
	".-.":  "R",
	"...":  "S",
	"-":    "T",
	"..-":  "U",
	"...-": "V",
	".--":  "W",
	"-..-": "X",
	"-.--": "Y",
	"--..": "Z",

	// Numbers
	"-----": "0",
	".----": "1",
	"..---": "2",
	"...--": "3",
	"....-": "4",
	".....": "5",
	"-....": "6",
	"--...": "7",
	"---..": "8",
	"----.": "9",

	// Punctuation
	".-.-.-":  ".",  // Period
	"--..--":  ",",  // Comma
	"..--..":  "?",  // Question mark
	".----.":  "'",  // Apostrophe
	"-.-.--":  "!",  // Exclamation mark
	"-..-.":   "/",  // Slash
	"-.--.":   "(",  // Left parenthesis
	"-.--.-":  ")",  // Right parenthesis
	".-...":   "&",  // Ampersand
	"---...":  ":",  // Colon
	"-.-.-.":  ";",  // Semicolon
	"-...-":   "=",  // Equal sign
	".-.-.":   "+",  // Plus sign
	"-....-":  "-",  // Hyphen/minus
	"..--.-":  "_",  // Underscore
	".-..-.":  "\"", // Quotation mark
	"...-..-": "$",  // Dollar sign
	".--.-.":  "@",  // At sign

	// Special characters (prosigns)
	"..--":   "Ü",  // German umlaut
	".-.-":   "AR", // End of message (prosign)
	"...-.-": "SK", // End of contact (prosign)
	"..-.-.": "UR", // You are (prosign)
	"...-.":  "SN", // Understood (prosign)
}

// morseToChar converts a Morse code pattern to a character
func morseToChar(morse string) string {
	if char, ok := morseTable[morse]; ok {
		return char
	}
	// Return the pattern itself if not found (for debugging)
	return "[" + morse + "]"
}
