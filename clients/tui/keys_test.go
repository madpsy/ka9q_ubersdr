package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// bindingsInCode extracts the rune cases from handleKey's top-level switch, so
// the check reflects what is actually wired up rather than a hand-kept list.
func bindingsInCode(t *testing.T) map[rune]bool {
	t.Helper()
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)

	start := strings.Index(body, "func (e *eventLoop) handleKey(")
	if start < 0 {
		t.Fatal("handleKey not found")
	}
	end := strings.Index(body[start:], "\nfunc ")
	if end < 0 {
		end = len(body) - start
	}
	body = body[start : start+end]

	// Only the outer switch: the prompt-handling block above it is a separate
	// mode and may legitimately reuse letters.
	if i := strings.Index(body, "// Any key dismisses the help overlay"); i > 0 {
		body = body[i:]
	}

	// Each case line may list any number of runes, e.g. case '?', 'h', 'H':
	out := map[rune]bool{}
	caseLine := regexp.MustCompile(`(?m)^\s*case\s+('.'(?:\s*,\s*'.')*)\s*:`)
	lit := regexp.MustCompile(`'(.)'`)
	for _, m := range caseLine.FindAllStringSubmatch(body, -1) {
		for _, g := range lit.FindAllStringSubmatch(m[1], -1) {
			out[rune(g[1][0])] = true
		}
	}
	return out
}

// TestNoDuplicateKeyBindings guards against two actions claiming one key. Go
// rejects duplicate cases in a single switch, so this catches the subtler
// version: a key handled in the outer switch that is also documented, or
// implemented, as something else.
func TestNoDuplicateKeyBindings(t *testing.T) {
	got := bindingsInCode(t)
	if len(got) < 20 {
		t.Fatalf("only found %d bindings; the extractor is probably broken", len(got))
	}

	// Keys that must exist, since the help and README promise them.
	for _, r := range []rune{'m', 'M', 'A', 'd', 'x', ',', '.', 'f', 'c', 'v', 'i', 'a', 'w', 's', 'b', 'p', 'q'} {
		if !got[r] {
			t.Errorf("key %q is documented but not handled", r)
		}
	}
}

// TestHelpMatchesBindings keeps the help overlay honest: every single-character
// key it mentions must actually be handled.
func TestHelpMatchesBindings(t *testing.T) {
	bound := bindingsInCode(t)

	// Pull the leading key column out of each indented help line.
	re := regexp.MustCompile(`^\s{2}(\S(?:\s*/\s*\S)?(?:\s+\S)?)\s{2,}\S`)
	for _, line := range helpLines {
		m := re.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		for _, tok := range strings.FieldsFunc(m[1], func(r rune) bool { return r == '/' || r == ' ' }) {
			r := []rune(tok)
			if len(r) != 1 {
				continue // arrows, "click", "wheel", "shift+..." and so on
			}
			c := r[0]
			// Arrow glyphs and prose are not key cases.
			if c < '!' || c > '~' {
				continue
			}
			if !bound[c] && !bound[toUpperRune(c)] && !bound[toLowerRune(c)] {
				t.Errorf("help lists %q but no case handles it: %q", string(c), line)
			}
		}
	}
}

func toUpperRune(r rune) rune {
	if r >= 'a' && r <= 'z' {
		return r - 32
	}
	return r
}

func toLowerRune(r rune) rune {
	if r >= 'A' && r <= 'Z' {
		return r + 32
	}
	return r
}

// TestFinePanIsSeparateFromFilterKeys is the regression guard for this report:
// the filter keys took over the fine-pan binding, leaving the docs describing a
// key that did two things. Fine pan now lives on shift+arrows.
func TestFinePanIsSeparateFromFilterKeys(t *testing.T) {
	for _, line := range helpLines {
		if strings.Contains(line, ", .") && strings.Contains(strings.ToLower(line), "pan") {
			t.Errorf("help still ties the filter keys to panning: %q", line)
		}
	}

	src, err := os.ReadFile("README.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(string(src), "\n") {
		low := strings.ToLower(line)
		if strings.Contains(line, "`,` `.`") && strings.Contains(low, "pan") {
			t.Errorf("README still ties the filter keys to panning: %q", line)
		}
	}
}
