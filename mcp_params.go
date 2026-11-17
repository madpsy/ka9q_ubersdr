package main

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// mcpArgs reads a tool call's arguments strictly. mcp-go's GetFloat accepts the
// strings "NaN" and "Inf" and quietly falls back to the default for a value of
// the wrong type, so a bad argument either poisons arithmetic (int(NaN) is
// undefined) or is silently ignored. Here every argument is checked for type,
// finiteness, range and allowed values, and the first problem is kept so the
// tool can refuse the call with a message the client can act on.
type mcpArgs struct {
	args map[string]interface{}
	err  error
}

func newMCPArgs(request mcp.CallToolRequest) *mcpArgs {
	args := request.GetArguments()
	if args == nil {
		args = map[string]interface{}{}
	}
	return &mcpArgs{args: args}
}

// Err is the first validation failure, or nil.
func (a *mcpArgs) Err() error { return a.err }

func (a *mcpArgs) fail(format string, v ...interface{}) {
	if a.err == nil {
		a.err = fmt.Errorf(format, v...)
	}
}

// has reports whether the argument was given (a JSON null counts as absent).
func (a *mcpArgs) has(key string) bool {
	v, ok := a.args[key]
	return ok && v != nil
}

// only refuses any argument not in the allowed list, so a misspelt name is an
// error rather than a silently ignored filter.
func (a *mcpArgs) only(allowed ...string) {
	for key := range a.args {
		if !containsString(allowed, key) {
			sort.Strings(allowed)
			a.fail("unknown argument %q; this tool takes: %s", mcpSafeEcho(key), strings.Join(allowed, ", "))
			return
		}
	}
}

// rawNumber converts a JSON number, or a string holding one, to a finite float.
func (a *mcpArgs) rawNumber(key string) (float64, bool) {
	var f float64
	switch v := a.args[key].(type) {
	case float64:
		f = v
	case float32:
		f = float64(v)
	case int:
		f = float64(v)
	case int64:
		f = float64(v)
	case string:
		s := strings.TrimSpace(v)
		if len(s) > 32 {
			a.fail("%s must be a number", key)
			return 0, false
		}
		p, err := strconv.ParseFloat(s, 64)
		if err != nil {
			a.fail("%s must be a number, got %q", key, mcpSafeEcho(s))
			return 0, false
		}
		f = p
	default:
		a.fail("%s must be a number", key)
		return 0, false
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		a.fail("%s must be a finite number", key)
		return 0, false
	}
	return f, true
}

// optNumber returns the argument and true if it was given and lies in
// [min, max]; false (recording an error if it was given but invalid) otherwise.
func (a *mcpArgs) optNumber(key string, min, max float64) (float64, bool) {
	if !a.has(key) {
		return 0, false
	}
	f, ok := a.rawNumber(key)
	if !ok {
		return 0, false
	}
	if f < min || f > max {
		a.fail("%s must be between %s and %s, got %s", key, fmtNum(min), fmtNum(max), fmtNum(f))
		return 0, false
	}
	return f, true
}

// number is optNumber with a default for an absent argument.
func (a *mcpArgs) number(key string, def, min, max float64) float64 {
	if f, ok := a.optNumber(key, min, max); ok {
		return f
	}
	return def
}

// optInt is optNumber for whole numbers.
func (a *mcpArgs) optInt(key string, min, max int) (int, bool) {
	f, ok := a.optNumber(key, float64(min), float64(max))
	if !ok {
		return 0, false
	}
	if f != math.Trunc(f) {
		a.fail("%s must be a whole number, got %s", key, fmtNum(f))
		return 0, false
	}
	return int(f), true
}

// integer is optInt with a default for an absent argument.
func (a *mcpArgs) integer(key string, def, min, max int) int {
	if n, ok := a.optInt(key, min, max); ok {
		return n
	}
	return def
}

// str returns a trimmed string argument of at most maxLen characters with no
// control characters, or def when absent.
func (a *mcpArgs) str(key, def string, maxLen int) string {
	if !a.has(key) {
		return def
	}
	s, ok := a.args[key].(string)
	if !ok {
		a.fail("%s must be a string", key)
		return def
	}
	s = strings.TrimSpace(s)
	if len(s) > maxLen {
		a.fail("%s is too long (at most %d characters)", key, maxLen)
		return def
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			a.fail("%s contains control characters", key)
			return def
		}
	}
	return s
}

// enum returns one of the allowed values (matched case-insensitively), or def
// when absent.
func (a *mcpArgs) enum(key, def string, allowed ...string) string {
	s := a.str(key, "", 64)
	if s == "" {
		return def
	}
	for _, v := range allowed {
		if strings.EqualFold(s, v) {
			return v
		}
	}
	a.fail("%s must be one of %s, got %q", key, strings.Join(allowed, ", "), mcpSafeEcho(s))
	return def
}

// date returns a strict YYYY-MM-DD argument as UTC midnight. Parsing it is
// also what keeps it safe to build a file name from.
func (a *mcpArgs) date(key string) (time.Time, bool) {
	s := a.str(key, "", 10)
	if s == "" {
		return time.Time{}, false
	}
	d, err := time.Parse("2006-01-02", s)
	if err != nil || d.Format("2006-01-02") != s {
		a.fail("%s must be a date as YYYY-MM-DD, got %q", key, mcpSafeEcho(s))
		return time.Time{}, false
	}
	return d, true
}

// numberList reads up to max numbers in [min, max], given either as a JSON
// array or as a comma-separated string.
func (a *mcpArgs) numberList(key string, maxItems int, min, max float64) []float64 {
	if !a.has(key) {
		return nil
	}
	var items []interface{}
	switch v := a.args[key].(type) {
	case []interface{}:
		items = v
	case string:
		if len(v) > 32*maxItems {
			a.fail("%s is too long", key)
			return nil
		}
		for _, p := range strings.Split(v, ",") {
			if p = strings.TrimSpace(p); p != "" {
				items = append(items, p)
			}
		}
	case float64, int:
		items = []interface{}{v}
	default:
		a.fail("%s must be a list of numbers", key)
		return nil
	}
	if len(items) == 0 {
		a.fail("%s is empty", key)
		return nil
	}
	if len(items) > maxItems {
		a.fail("%s has %d entries, at most %d allowed", key, len(items), maxItems)
		return nil
	}
	out := make([]float64, 0, len(items))
	for i, it := range items {
		sub := &mcpArgs{args: map[string]interface{}{key: it}}
		f, ok := sub.optNumber(key, min, max)
		if !ok {
			if sub.err == nil {
				sub.err = fmt.Errorf("%s must be a number", key)
			}
			a.fail("%s entry %d: %v", key, i+1, sub.err)
			return nil
		}
		out = append(out, f)
	}
	return out
}

// mcpSafeEcho trims a client-supplied value for quoting back in an error, so
// a long or odd argument cannot flood the response or the logs.
func mcpSafeEcho(s string) string {
	const max = 40
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	if len([]rune(s)) > max {
		s = string([]rune(s)[:max]) + "…"
	}
	return s
}

func fmtNum(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// ── Schema validation for every tool call ────────────────────────────────────

// mcpDefaultMaxString bounds any string argument whose schema sets no
// maxLength, and mcpDefaultMaxItems any array without maxItems.
const (
	mcpDefaultMaxString = 256
	mcpDefaultMaxItems  = 32
)

var mcpPatternCache sync.Map // pattern string -> *regexp.Regexp

// mcpPatternHints describe the tools' argument patterns in words, for the
// error a client sees when a value does not match.
var mcpPatternHints = map[string]string{
	`^\d{4}-\d{2}-\d{2}$`: "a date as YYYY-MM-DD",
	`^[A-Za-z]{2}$`:       "a two-letter code",
	`^[A-Ra-r]{2}([0-9]{2}([A-Xa-x]{2}([0-9]{2})?)?)?$`: "a Maidenhead locator such as IO86 or IO86ha",
	`^[A-Za-z0-9_+\-/]+$`:                               "an IANA timezone name such as Europe/London",
	`^[A-Za-z0-9/, ]+$`:                                 "callsigns (letters, digits and /), comma-separated",
	`^[A-Za-z0-9.\-]+$`:                                 "a name such as 20m or wideband-hf (letters, digits, '.' and '-')",
	`^[A-Za-z0-9]+$`:                                    "a mode name such as FT8 (letters and digits)",
}

// validateToolArgs is tool-handler middleware that checks every call against
// the input schema its tool declares, before the handler sees it: unknown
// arguments, missing required ones, wrong types, non-finite or out-of-range
// numbers, over-long strings, control characters, values outside an enum and
// strings that miss a pattern are all refused with a message naming the
// argument. What passes is normalised (numbers given as strings become
// numbers, strings are trimmed, enum values take their declared case), so a
// handler's GetFloat or GetString only ever sees clean values.
func (m *MCPServer) validateToolArgs(next server.ToolHandlerFunc) server.ToolHandlerFunc {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		st := m.mcpServer.GetTool(request.Params.Name)
		if st == nil {
			return next(ctx, request)
		}
		args, err := mcpValidateArgs(st.Tool.InputSchema, request.Params.Arguments)
		if err != nil {
			return mcp.NewToolResultError(fmt.Sprintf("Invalid arguments for %s: %v", request.Params.Name, err)), nil
		}
		request.Params.Arguments = args
		return next(ctx, request)
	}
}

// mcpValidateArgs checks raw arguments against a tool's schema and returns a
// normalised copy.
func mcpValidateArgs(schema mcp.ToolInputSchema, raw interface{}) (map[string]interface{}, error) {
	in := map[string]interface{}{}
	switch v := raw.(type) {
	case nil:
	case map[string]interface{}:
		in = v
	default:
		return nil, fmt.Errorf("arguments must be a JSON object")
	}

	names := make([]string, 0, len(schema.Properties))
	for name := range schema.Properties {
		names = append(names, name)
	}
	sort.Strings(names)

	out := make(map[string]interface{}, len(in))
	for key, val := range in {
		prop, ok := schema.Properties[key].(map[string]interface{})
		if !ok {
			if len(names) == 0 {
				return nil, fmt.Errorf("unknown argument %q; this tool takes no arguments", mcpSafeEcho(key))
			}
			return nil, fmt.Errorf("unknown argument %q; this tool takes: %s", mcpSafeEcho(key), strings.Join(names, ", "))
		}
		if val == nil {
			continue // a JSON null is the same as leaving it out
		}
		clean, err := mcpValidateValue(key, prop, val)
		if err != nil {
			return nil, err
		}
		out[key] = clean
	}
	for _, req := range schema.Required {
		if _, ok := out[req]; !ok {
			return nil, fmt.Errorf("%s is required", req)
		}
	}
	return out, nil
}

func mcpValidateValue(key string, prop map[string]interface{}, val interface{}) (interface{}, error) {
	typ, _ := prop["type"].(string)
	switch typ {
	case "number", "integer":
		a := &mcpArgs{args: map[string]interface{}{key: val}}
		f, ok := a.rawNumber(key)
		if !ok {
			return nil, a.Err()
		}
		if typ == "integer" && f != math.Trunc(f) {
			return nil, fmt.Errorf("%s must be a whole number, got %s", key, fmtNum(f))
		}
		lo, hasLo := mcpSchemaNum(prop["minimum"])
		hi, hasHi := mcpSchemaNum(prop["maximum"])
		if (hasLo && f < lo) || (hasHi && f > hi) {
			switch {
			case hasLo && hasHi:
				return nil, fmt.Errorf("%s must be between %s and %s, got %s", key, fmtNum(lo), fmtNum(hi), fmtNum(f))
			case hasLo:
				return nil, fmt.Errorf("%s must be at least %s, got %s", key, fmtNum(lo), fmtNum(f))
			default:
				return nil, fmt.Errorf("%s must be at most %s, got %s", key, fmtNum(hi), fmtNum(f))
			}
		}
		return f, nil

	case "boolean":
		switch v := val.(type) {
		case bool:
			return v, nil
		case string:
			switch strings.ToLower(strings.TrimSpace(v)) {
			case "true":
				return true, nil
			case "false":
				return false, nil
			}
		}
		return nil, fmt.Errorf("%s must be true or false", key)

	case "string":
		s, ok := val.(string)
		if !ok {
			return nil, fmt.Errorf("%s must be a string", key)
		}
		return mcpValidateString(key, prop, s)

	case "array":
		// A list may also arrive as one comma-separated string; the tool
		// splits and checks it.
		if s, ok := val.(string); ok {
			return mcpValidateString(key, map[string]interface{}{"maxLength": 1024}, s)
		}
		if f, ok := val.(float64); ok {
			val = []interface{}{f}
		}
		items, ok := val.([]interface{})
		if !ok {
			return nil, fmt.Errorf("%s must be a list", key)
		}
		maxItems := mcpDefaultMaxItems
		if n, ok := mcpSchemaNum(prop["maxItems"]); ok {
			maxItems = int(n)
		}
		if len(items) > maxItems {
			return nil, fmt.Errorf("%s has %d entries, at most %d allowed", key, len(items), maxItems)
		}
		itemSchema, _ := prop["items"].(map[string]interface{})
		clean := make([]interface{}, len(items))
		for i, it := range items {
			if it == nil {
				return nil, fmt.Errorf("%s entry %d is null", key, i+1)
			}
			if itemSchema == nil {
				return nil, fmt.Errorf("%s entries are not described by the tool", key)
			}
			c, err := mcpValidateValue(fmt.Sprintf("%s entry %d", key, i+1), itemSchema, it)
			if err != nil {
				return nil, err
			}
			clean[i] = c
		}
		return clean, nil
	}
	// No tool declares objects or untyped arguments; refuse rather than pass
	// through something nobody checked.
	return nil, fmt.Errorf("%s has a type this server does not accept", key)
}

func mcpValidateString(key string, prop map[string]interface{}, s string) (interface{}, error) {
	s = strings.TrimSpace(s)
	maxLen := mcpDefaultMaxString
	if n, ok := mcpSchemaNum(prop["maxLength"]); ok {
		maxLen = int(n)
	}
	if len(s) > maxLen {
		return nil, fmt.Errorf("%s is too long (at most %d characters)", key, maxLen)
	}
	if !utf8.ValidString(s) {
		return nil, fmt.Errorf("%s is not valid UTF-8", key)
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return nil, fmt.Errorf("%s contains control characters", key)
		}
	}
	if n, ok := mcpSchemaNum(prop["minLength"]); ok && len(s) < int(n) {
		return nil, fmt.Errorf("%s is too short (at least %d characters)", key, int(n))
	}
	if enum := mcpSchemaStrings(prop["enum"]); len(enum) > 0 {
		for _, e := range enum {
			if strings.EqualFold(s, e) {
				return e, nil
			}
		}
		return nil, fmt.Errorf("%s must be one of %s, got %q", key, strings.Join(enum, ", "), mcpSafeEcho(s))
	}
	if pat, ok := prop["pattern"].(string); ok && pat != "" && s != "" {
		re, _ := mcpPatternCache.Load(pat)
		if re == nil {
			compiled, err := regexp.Compile(pat)
			if err != nil {
				return nil, fmt.Errorf("%s cannot be checked (bad pattern in the tool)", key)
			}
			re, _ = mcpPatternCache.LoadOrStore(pat, compiled)
		}
		if !re.(*regexp.Regexp).MatchString(s) {
			if hint, ok := mcpPatternHints[pat]; ok {
				return nil, fmt.Errorf("%s must be %s, got %q", key, hint, mcpSafeEcho(s))
			}
			return nil, fmt.Errorf("%s has the wrong format, got %q", key, mcpSafeEcho(s))
		}
	}
	return s, nil
}

func mcpSchemaNum(v interface{}) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	}
	return 0, false
}

func mcpSchemaStrings(v interface{}) []string {
	switch e := v.(type) {
	case []string:
		return e
	case []interface{}:
		out := make([]string, 0, len(e))
		for _, x := range e {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}
