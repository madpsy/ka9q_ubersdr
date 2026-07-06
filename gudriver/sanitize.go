package gudriver

// sanitize.go — text sanitisation for the bitmap6 font on PicoGraphics.
//
// The Pimoroni MicroPython firmware renders text with PicoGraphics' built-in
// bitmap6 font, which only covers printable ASCII (U+0020 – U+007E).
// Any character outside that range is either silently dropped or rendered as
// a garbage glyph.
//
// SanitizeText converts a UTF-8 string to a safe ASCII string by:
//  1. Replacing common Unicode punctuation and symbols with ASCII equivalents.
//  2. Stripping any remaining non-ASCII characters (codepoint > 0x7E or < 0x20).
//  3. Collapsing runs of spaces to a single space and trimming leading/trailing
//     whitespace.
//
// The function is exported so callers can pre-process text before building a
// DisplayCommand, and it is also applied automatically inside Client.Display().

import (
	"strings"
	"unicode"
)

// unicodeReplacements maps Unicode runes that have a natural ASCII equivalent
// to their replacement string.  Ordered from most-specific to least-specific
// so that multi-character replacements are applied correctly by strings.Replacer.
var unicodeReplacer = strings.NewReplacer(
	// ── Dashes & hyphens ──────────────────────────────────────────────────────
	"\u2014", "--", // EM DASH          —
	"\u2013", "-", // EN DASH          –
	"\u2012", "-", // FIGURE DASH      ‒
	"\u2011", "-", // NON-BREAKING HYPHEN ‑
	"\u2010", "-", // HYPHEN           ‐
	"\u2015", "--", // HORIZONTAL BAR   ―
	"\uFE58", "-", // SMALL EM DASH    ﹘
	"\uFE63", "-", // SMALL HYPHEN-MINUS ﹣
	"\uFF0D", "-", // FULLWIDTH HYPHEN-MINUS －

	// ── Quotation marks ───────────────────────────────────────────────────────
	"\u2018", "'", // LEFT SINGLE QUOTATION MARK   '
	"\u2019", "'", // RIGHT SINGLE QUOTATION MARK  '
	"\u201A", ",", // SINGLE LOW-9 QUOTATION MARK  ‚
	"\u201B", "'", // SINGLE HIGH-REVERSED-9 MARK  ‛
	"\u201C", "\"", // LEFT DOUBLE QUOTATION MARK   "
	"\u201D", "\"", // RIGHT DOUBLE QUOTATION MARK  "
	"\u201E", "\"", // DOUBLE LOW-9 QUOTATION MARK  „
	"\u201F", "\"", // DOUBLE HIGH-REVERSED-9 MARK  ‟
	"\u2039", "<", // SINGLE LEFT-POINTING ANGLE QUOTATION MARK ‹
	"\u203A", ">", // SINGLE RIGHT-POINTING ANGLE QUOTATION MARK ›
	"\u00AB", "<<", // LEFT-POINTING DOUBLE ANGLE QUOTATION MARK «
	"\u00BB", ">>", // RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK »

	// ── Ellipsis ──────────────────────────────────────────────────────────────
	"\u2026", "...", // HORIZONTAL ELLIPSIS …
	"\u22EF", "...", // MIDLINE HORIZONTAL ELLIPSIS ⋯

	// ── Spaces & non-breaking whitespace ─────────────────────────────────────
	"\u00A0", " ", // NO-BREAK SPACE
	"\u202F", " ", // NARROW NO-BREAK SPACE
	"\u2009", " ", // THIN SPACE
	"\u2008", " ", // PUNCTUATION SPACE
	"\u2007", " ", // FIGURE SPACE
	"\u2006", " ", // SIX-PER-EM SPACE
	"\u2005", " ", // FOUR-PER-EM SPACE
	"\u2004", " ", // THREE-PER-EM SPACE
	"\u2003", " ", // EM SPACE
	"\u2002", " ", // EN SPACE
	"\u200B", "", // ZERO WIDTH SPACE (drop entirely)
	"\uFEFF", "", // ZERO WIDTH NO-BREAK SPACE / BOM (drop)

	// ── Bullets & list markers ────────────────────────────────────────────────
	"\u2022", "*", // BULLET •
	"\u2023", ">", // TRIANGULAR BULLET ‣
	"\u25CF", "*", // BLACK CIRCLE ●
	"\u25CB", "o", // WHITE CIRCLE ○
	"\u25A0", "#", // BLACK SQUARE ■
	"\u25A1", "#", // WHITE SQUARE □

	// ── Mathematical / currency ───────────────────────────────────────────────
	"\u00D7", "x", // MULTIPLICATION SIGN ×
	"\u00F7", "/", // DIVISION SIGN ÷
	"\u00B1", "+/-", // PLUS-MINUS SIGN ±
	"\u2212", "-", // MINUS SIGN −
	"\u2215", "/", // DIVISION SLASH ∕
	"\u00B0", "deg", // DEGREE SIGN °
	"\u2103", "C", // DEGREE CELSIUS ℃
	"\u2109", "F", // DEGREE FAHRENHEIT ℉
	"\u00A3", "GBP", // POUND SIGN £
	"\u20AC", "EUR", // EURO SIGN €
	"\u00A5", "JPY", // YEN SIGN ¥
	"\u00A2", "c", // CENT SIGN ¢

	// ── Arrows ────────────────────────────────────────────────────────────────
	"\u2190", "<-", // LEFTWARDS ARROW ←
	"\u2192", "->", // RIGHTWARDS ARROW →
	"\u2191", "^", // UPWARDS ARROW ↑
	"\u2193", "v", // DOWNWARDS ARROW ↓
	"\u21D2", "=>", // RIGHTWARDS DOUBLE ARROW ⇒
	"\u21D0", "<=", // LEFTWARDS DOUBLE ARROW ⇐

	// ── Miscellaneous symbols commonly found in notification text ─────────────
	"\u2713", "OK", // CHECK MARK ✓
	"\u2714", "OK", // HEAVY CHECK MARK ✔
	"\u2717", "X", // BALLOT X ✗
	"\u2718", "X", // HEAVY BALLOT X ✘
	"\u26A0", "!", // WARNING SIGN ⚠
	"\u2139", "i", // INFORMATION SOURCE ℹ
	"\u2764", "<3", // HEAVY BLACK HEART ❤
	"\u2665", "<3", // BLACK HEART SUIT ♥
	"\u2605", "*", // BLACK STAR ★
	"\u2606", "*", // WHITE STAR ☆
	"\u260E", "TEL", // BLACK TELEPHONE ☎
	"\u2709", "MAIL", // ENVELOPE ✉
	"\u1F514", "", // BELL emoji 🔔 (multi-byte; drop — no ASCII equivalent)

	// ── Accented Latin characters (common in callsigns / names) ──────────────
	"\u00C0", "A", "\u00C1", "A", "\u00C2", "A", "\u00C3", "A",
	"\u00C4", "A", "\u00C5", "A", "\u00C6", "AE",
	"\u00C7", "C",
	"\u00C8", "E", "\u00C9", "E", "\u00CA", "E", "\u00CB", "E",
	"\u00CC", "I", "\u00CD", "I", "\u00CE", "I", "\u00CF", "I",
	"\u00D0", "D", "\u00D1", "N",
	"\u00D2", "O", "\u00D3", "O", "\u00D4", "O", "\u00D5", "O",
	"\u00D6", "O", "\u00D8", "O",
	"\u00D9", "U", "\u00DA", "U", "\u00DB", "U", "\u00DC", "U",
	"\u00DD", "Y", "\u00DE", "TH", "\u00DF", "ss",
	"\u00E0", "a", "\u00E1", "a", "\u00E2", "a", "\u00E3", "a",
	"\u00E4", "a", "\u00E5", "a", "\u00E6", "ae",
	"\u00E7", "c",
	"\u00E8", "e", "\u00E9", "e", "\u00EA", "e", "\u00EB", "e",
	"\u00EC", "i", "\u00ED", "i", "\u00EE", "i", "\u00EF", "i",
	"\u00F0", "d", "\u00F1", "n",
	"\u00F2", "o", "\u00F3", "o", "\u00F4", "o", "\u00F5", "o",
	"\u00F6", "o", "\u00F8", "o",
	"\u00F9", "u", "\u00FA", "u", "\u00FB", "u", "\u00FC", "u",
	"\u00FD", "y", "\u00FE", "th", "\u00FF", "y",
)

// SanitizeText converts s to a string safe for display on the bitmap6 font.
//
// Steps:
//  1. Apply Unicode → ASCII substitution table (dashes, quotes, symbols, etc.)
//  2. Strip any remaining rune with codepoint outside printable ASCII (0x20–0x7E).
//  3. Collapse runs of two or more spaces to a single space.
//  4. Trim leading and trailing whitespace.
//
// The result is guaranteed to contain only bytes in the range 0x20–0x7E.
func SanitizeText(s string) string {
	// Step 1: known substitutions
	s = unicodeReplacer.Replace(s)

	// Step 2: strip remaining non-ASCII / non-printable runes
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r >= 0x20 && r <= 0x7E {
			b.WriteRune(r)
		} else if unicode.IsSpace(r) {
			// Catch any remaining Unicode space categories not in the table
			b.WriteByte(' ')
		}
		// else: silently drop
	}
	s = b.String()

	// Step 3: collapse runs of spaces
	for strings.Contains(s, "  ") {
		s = strings.ReplaceAll(s, "  ", " ")
	}

	// Step 4: trim
	return strings.TrimSpace(s)
}
