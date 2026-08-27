// config_schema.go — the declared Go types are the single source of truth for
// config value types.
//
// Historically nothing in the config write path knew what type a field was
// *declared* as. The admin UI inferred it from whatever happened to already be
// in config.yaml (typeof oldValue), and so did the server's PATCH handler. That
// makes the file its own schema: once one value lands as a string — a hand edit
// with quotes, a field that was null when it was first edited, a YAML 1.1-style
// `yes` — it is sticky. Every subsequent save writes it back as a string, and
// the next boot dies with
//
//	failed to parse config file: yaml: unmarshal errors:
//	  line 69: cannot unmarshal !!str `8036` into int
//
// This file derives a schema by reflecting over the config structs, so it can
// never drift from the code, and provides two consumers of it:
//
//	coerceToSchema  — for the admin write path, which works on the generic
//	                  map[string]interface{} decoded from the UI's JSON.
//	repairConfigYAML — for LoadConfig's self-repair, which uses a yaml.Node tree
//	                   only to locate mistyped values, then patches the
//	                   original bytes so the rest of the file is untouched.
package main

import (
	"fmt"
	"log"
	"math"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

// configNode describes the YAML shape of one node of a Go config struct.
//
// kind is the declared Go kind of the value at this position: a scalar kind for
// leaves, or Struct/Slice/Map for containers. Pointers are dereferenced during
// construction, so a *bool field is a Bool node — nil stays nil either way, and
// the coercion only ever has to think about the pointed-to type.
type configNode struct {
	kind   reflect.Kind
	fields map[string]*configNode // Struct: yaml key -> child
	elem   *configNode            // Slice element / Map value
	opaque bool                   // custom YAML unmarshaler: leave values alone
}

// legacyYAMLUnmarshaler is the yaml.v2-style unmarshaler. yaml.v3 still honours
// it (DecoderMode uses it) but keeps the interface unexported, so we redeclare
// it here to spot such types and mark them opaque.
type legacyYAMLUnmarshaler interface {
	UnmarshalYAML(unmarshal func(interface{}) error) error
}

var (
	yamlUnmarshalerType   = reflect.TypeOf((*yaml.Unmarshaler)(nil)).Elem()
	legacyUnmarshalerType = reflect.TypeOf((*legacyYAMLUnmarshaler)(nil)).Elem()
)

// configSchema returns the schema for a config struct type. It is safe to call
// on any struct — the walker is deliberately generic so the other config files
// (decoder.yaml, cwskimmer.yaml, …) can adopt the same protection.
func configSchema(t reflect.Type) *configNode {
	return buildConfigNode(t, map[reflect.Type]*configNode{})
}

var (
	schemaCacheMu sync.RWMutex
	schemaCache   = map[reflect.Type]*configNode{}
)

// configSchemaFor returns the cached schema for a config root type. Admin
// handlers run concurrently, so the cache is guarded.
func configSchemaFor(t reflect.Type) *configNode {
	schemaCacheMu.RLock()
	node, ok := schemaCache[t]
	schemaCacheMu.RUnlock()
	if ok {
		return node
	}

	node = configSchema(t)

	schemaCacheMu.Lock()
	schemaCache[t] = node
	schemaCacheMu.Unlock()
	return node
}

// Root types of the YAML files this package reads and writes. bands.yaml,
// bookmarks.yaml, extensions.yaml and decoder.yaml are each a partial Config
// document — main.go loads them with LoadConfig and copies the one section it
// wants — so they share Config's schema.
var (
	configRootType            = reflect.TypeOf(Config{})
	cwSkimmerRootType         = reflect.TypeOf(CWSkimmerConfig{})
	rotatorScheduleRootType   = reflect.TypeOf(RotatorScheduleConfig{})
	antSwitchScheduleRootType = reflect.TypeOf(AntSwitchScheduleConfig{})
	addonProxiesRootType      = reflect.TypeOf(AddonProxiesConfig{})
)

// mainConfigSchema is the schema for config.yaml and its satellite files.
func mainConfigSchema() *configNode { return configSchemaFor(configRootType) }

func buildConfigNode(t reflect.Type, seen map[reflect.Type]*configNode) *configNode {
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}

	// A type with its own unmarshaler decides its own representation; coercing
	// underneath it would be guessing.
	if implementsYAMLUnmarshaler(t) {
		return &configNode{kind: t.Kind(), opaque: true}
	}

	if n, ok := seen[t]; ok {
		return n
	}

	switch t.Kind() {
	case reflect.Struct:
		node := &configNode{kind: reflect.Struct, fields: map[string]*configNode{}}
		seen[t] = node // placeholder first, so recursive types terminate
		addStructFields(node, t, seen)
		return node

	case reflect.Slice, reflect.Array:
		node := &configNode{kind: reflect.Slice}
		seen[t] = node
		node.elem = buildConfigNode(t.Elem(), seen)
		return node

	case reflect.Map:
		node := &configNode{kind: reflect.Map}
		seen[t] = node
		node.elem = buildConfigNode(t.Elem(), seen)
		return node

	case reflect.Interface:
		return &configNode{kind: reflect.Interface, opaque: true}

	default:
		return &configNode{kind: t.Kind()}
	}
}

func implementsYAMLUnmarshaler(t reflect.Type) bool {
	pt := reflect.PointerTo(t)
	return t.Implements(yamlUnmarshalerType) || pt.Implements(yamlUnmarshalerType) ||
		t.Implements(legacyUnmarshalerType) || pt.Implements(legacyUnmarshalerType)
}

func addStructFields(node *configNode, t reflect.Type, seen map[reflect.Type]*configNode) {
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if f.PkgPath != "" && !f.Anonymous {
			continue // unexported
		}

		name, inline, skip := yamlFieldName(f)
		if skip {
			continue
		}

		if inline {
			// Inlined struct: its keys live in the parent mapping.
			ft := f.Type
			for ft.Kind() == reflect.Ptr {
				ft = ft.Elem()
			}
			if ft.Kind() == reflect.Struct {
				addStructFields(node, ft, seen)
			}
			continue
		}

		node.fields[name] = buildConfigNode(f.Type, seen)
	}
}

// yamlFieldName resolves a struct field to the key yaml.v3 would use for it.
func yamlFieldName(f reflect.StructField) (name string, inline bool, skip bool) {
	tag := f.Tag.Get("yaml")
	if tag == "-" {
		return "", false, true
	}

	parts := strings.Split(tag, ",")
	name = parts[0]
	for _, opt := range parts[1:] {
		if opt == "inline" {
			inline = true
		}
	}

	if inline && name == "" {
		return "", true, false
	}

	if name == "" {
		if f.Anonymous {
			// An untagged embedded struct is inlined by yaml.v3.
			ft := f.Type
			for ft.Kind() == reflect.Ptr {
				ft = ft.Elem()
			}
			if ft.Kind() == reflect.Struct {
				return "", true, false
			}
		}
		name = strings.ToLower(f.Name)
	}

	return name, inline, false
}

// lookup walks a dotted path (as used by the PATCH handler) and returns the
// node at that position, or nil if the path is not part of the schema.
func (n *configNode) lookup(path string) *configNode {
	cur := n
	for _, key := range strings.Split(path, ".") {
		if cur == nil {
			return nil
		}
		switch cur.kind {
		case reflect.Struct:
			cur = cur.fields[key]
		case reflect.Map:
			cur = cur.elem
		case reflect.Slice:
			// Numeric index into a sequence.
			if _, err := strconv.Atoi(key); err != nil {
				return nil
			}
			cur = cur.elem
		default:
			return nil
		}
	}
	return cur
}

// ─────────────────────────────────────────────────────────────────────────────
// The two entry points every config file should go through
// ─────────────────────────────────────────────────────────────────────────────

// marshalCheckedYAML is the write gate. It coerces a config value — in practice
// the map[string]interface{} an admin handler decoded from JSON — to the types
// rootType declares, marshals it, and proves the result unmarshals back into
// rootType before any of it reaches the disk.
//
// Without this, a JSON number (always a float64) or a value the UI rendered as a
// text box (always a string) is written out with the wrong YAML type, and the
// file only fails on the *next* boot, far from the save that caused it.
func marshalCheckedYAML(config interface{}, rootType reflect.Type) ([]byte, []ConfigRepair, error) {
	repairs, err := coerceToSchema(config, configSchemaFor(rootType))
	if err != nil {
		return nil, nil, err
	}

	yamlData, err := yaml.Marshal(config)
	if err != nil {
		return nil, repairs, fmt.Errorf("failed to marshal config: %w", err)
	}

	if err := yaml.Unmarshal(yamlData, reflect.New(rootType).Interface()); err != nil {
		return nil, repairs, fmt.Errorf("refusing to write a config the server cannot load: %w", err)
	}

	return yamlData, repairs, nil
}

// loadYAMLWithRepair is the read gate. It decodes filename into `into`, and if
// that fails on a value type, retypes the offending scalars and tries once more
// rather than taking the whole subsystem down. A successful repair is persisted
// (previous contents to .bak) so the admin UI and the next boot both see clean
// values; only the mistyped values themselves are rewritten, leaving comments,
// blank lines and layout byte-for-byte intact.
//
// `into` must be a non-nil pointer to the file's root struct.
func loadYAMLWithRepair(filename string, data []byte, into interface{}) ([]ConfigRepair, error) {
	err := yaml.Unmarshal(data, into)
	if err == nil {
		return nil, nil
	}

	rootType := reflect.TypeOf(into).Elem()
	fresh := reflect.New(rootType).Interface()
	repaired, repairs, rerr := repairConfigYAML(data, configSchemaFor(rootType), fresh)
	if rerr != nil {
		return nil, err // the original parse error is the useful one
	}

	// Copy the repaired value into the caller's target. reflect.Set rather than
	// a plain assignment because some config structs embed a mutex.
	reflect.ValueOf(into).Elem().Set(reflect.ValueOf(fresh).Elem())

	for _, r := range repairs {
		log.Printf("Config repair: %s in %s had the wrong type (%s), corrected to %s", r.Path, filename, r.From, r.To)
	}

	// A config that cannot be written (read-only bind mount, root-owned file) is
	// not an error — the in-memory config is already correct.
	if werr := writeConfigAtomic(filename, repaired); werr != nil {
		log.Printf("Warning: config repaired in memory but %s could not be rewritten: %v", filename, werr)
	} else {
		log.Printf("Config repaired: %d value(s) retyped in %s (previous contents saved as %s.bak)", len(repairs), filename, filename)
	}

	return repairs, nil
}

// writeConfigAtomic replaces path with data, keeping the previous contents as
// path.bak. The write goes to a temp file in the same directory and is renamed
// into place, so an interrupted write cannot leave a half-written config.yaml.
func writeConfigAtomic(path string, data []byte) error {
	if existing, err := os.ReadFile(path); err == nil {
		if err := os.WriteFile(path+".bak", existing, 0644); err != nil {
			log.Printf("Warning: failed to back up %s: %v", path, err)
		}
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Coercion over generic maps (the admin write path)
// ─────────────────────────────────────────────────────────────────────────────

// ConfigRepair records one value whose type was corrected.
type ConfigRepair struct {
	Path string
	From string
	To   string
}

func (r ConfigRepair) String() string {
	return fmt.Sprintf("%s: %s -> %s", r.Path, r.From, r.To)
}

// coerceToSchema walks a decoded config map alongside the schema and converts
// every scalar to its declared Go type: "8036" becomes 8036 for an int field,
// float64(14074000) becomes an integer (rather than YAML's 1.4074e+07), "yes"
// becomes true for a bool field.
//
// It only ever *improves* types. Structural mismatches (a scalar where a
// mapping is declared) are left alone for the round-trip validation to report
// with yaml's own line numbers. The one thing it does reject is a scalar it
// tried and failed to convert — "abc" into an int field — because naming the
// path beats a line number in a file the user never edited.
func coerceToSchema(value interface{}, schema *configNode) ([]ConfigRepair, error) {
	var repairs []ConfigRepair
	_, err := coerceValue(value, schema, "", &repairs)
	if err != nil {
		return nil, err
	}
	return repairs, nil
}

// coerceValue returns the coerced value. Containers are edited in place, so the
// return value only matters for scalars.
func coerceValue(value interface{}, node *configNode, path string, repairs *[]ConfigRepair) (interface{}, error) {
	if node == nil || node.opaque || value == nil {
		return value, nil
	}

	switch node.kind {
	case reflect.Struct:
		m, ok := value.(map[string]interface{})
		if !ok {
			return value, nil // structural mismatch: leave it for validation
		}
		for key, child := range m {
			field := node.fields[key]
			if field == nil {
				continue // unknown key: yaml.Unmarshal ignores it, so do we
			}
			nv, err := coerceValue(child, field, joinConfigPath(path, key), repairs)
			if err != nil {
				return nil, err
			}
			m[key] = nv
		}
		return m, nil

	case reflect.Map:
		m, ok := value.(map[string]interface{})
		if !ok {
			return value, nil
		}
		for key, child := range m {
			nv, err := coerceValue(child, node.elem, joinConfigPath(path, key), repairs)
			if err != nil {
				return nil, err
			}
			m[key] = nv
		}
		return m, nil

	case reflect.Slice:
		s, ok := value.([]interface{})
		if !ok {
			return value, nil
		}
		for i, child := range s {
			nv, err := coerceValue(child, node.elem, fmt.Sprintf("%s[%d]", path, i), repairs)
			if err != nil {
				return nil, err
			}
			s[i] = nv
		}
		return s, nil

	default:
		coerced, err := coerceScalar(value, node.kind)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		// Only a change of scalar class is a repair worth telling anyone about.
		// int -> uint64, or JSON's float64 -> int64, are representation details
		// of how the value was decoded, not something the operator mistyped.
		if valueClass(value) != kindClass(node.kind) {
			*repairs = append(*repairs, ConfigRepair{
				Path: path,
				From: describeValue(value),
				To:   describeValue(coerced),
			})
		}
		return coerced, nil
	}
}

func joinConfigPath(base, key string) string {
	if base == "" {
		return key
	}
	return base + "." + key
}

func describeValue(v interface{}) string {
	switch t := v.(type) {
	case string:
		return strconv.Quote(t)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		return fmt.Sprintf("%v", v)
	}
}

// scalarClass groups scalar kinds the way YAML does. Conversions within a class
// are representation changes; conversions across one are what we call a repair.
type scalarClass int

const (
	classOther scalarClass = iota
	classString
	classBool
	classNumber
)

func kindClass(kind reflect.Kind) scalarClass {
	switch kind {
	case reflect.Bool:
		return classBool
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
		reflect.Float32, reflect.Float64:
		return classNumber
	case reflect.String:
		return classString
	default:
		return classOther
	}
}

func valueClass(v interface{}) scalarClass {
	switch v.(type) {
	case bool:
		return classBool
	case int, int64, uint64, float64:
		return classNumber
	case string:
		return classString
	default:
		return classOther
	}
}

// coerceScalar converts a decoded scalar to the declared kind, erroring only
// when a conversion was clearly intended but is impossible.
func coerceScalar(v interface{}, kind reflect.Kind) (interface{}, error) {
	switch kind {
	case reflect.Bool:
		return coerceBool(v)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return coerceInt(v)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return coerceUint(v)
	case reflect.Float32, reflect.Float64:
		return coerceFloat(v)
	case reflect.String:
		return coerceString(v)
	default:
		return v, nil
	}
}

func coerceBool(v interface{}) (interface{}, error) {
	switch t := v.(type) {
	case bool:
		return t, nil
	case string:
		// strconv.ParseBool plus the YAML 1.1 spellings people still write.
		switch strings.ToLower(strings.TrimSpace(t)) {
		case "yes", "on", "y":
			return true, nil
		case "no", "off", "n":
			return false, nil
		}
		b, err := strconv.ParseBool(strings.TrimSpace(t))
		if err != nil {
			return nil, fmt.Errorf("cannot convert %q to a true/false value", t)
		}
		return b, nil
	case int:
		return t != 0, nil
	case int64:
		return t != 0, nil
	case float64:
		return t != 0, nil
	default:
		return v, nil
	}
}

func coerceInt(v interface{}) (interface{}, error) {
	switch t := v.(type) {
	case int:
		return int64(t), nil
	case int64:
		return t, nil
	case uint64:
		if t > math.MaxInt64 {
			return nil, fmt.Errorf("value %d is too large for a whole number field", t)
		}
		return int64(t), nil
	case float64:
		// JSON has no integers, so every number from the admin UI arrives here.
		// Only a genuinely fractional value is an error.
		if t != math.Trunc(t) || math.IsInf(t, 0) || math.IsNaN(t) {
			return nil, fmt.Errorf("value %v is not a whole number", t)
		}
		if t > math.MaxInt64 || t < math.MinInt64 {
			return nil, fmt.Errorf("value %v is out of range for a whole number field", t)
		}
		return int64(t), nil
	case bool:
		return v, nil // leave it; validation will report the mismatch
	case string:
		s := strings.TrimSpace(t)
		if i, err := strconv.ParseInt(s, 10, 64); err == nil {
			return i, nil
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil && f == math.Trunc(f) {
			return int64(f), nil
		}
		return nil, fmt.Errorf("cannot convert %q to a whole number", t)
	default:
		return v, nil
	}
}

func coerceUint(v interface{}) (interface{}, error) {
	switch t := v.(type) {
	case uint64:
		return t, nil
	case int:
		if t < 0 {
			return nil, fmt.Errorf("value %d cannot be negative", t)
		}
		return uint64(t), nil
	case int64:
		if t < 0 {
			return nil, fmt.Errorf("value %d cannot be negative", t)
		}
		return uint64(t), nil
	case float64:
		if t != math.Trunc(t) || math.IsInf(t, 0) || math.IsNaN(t) {
			return nil, fmt.Errorf("value %v is not a whole number", t)
		}
		if t < 0 {
			return nil, fmt.Errorf("value %v cannot be negative", t)
		}
		if t > math.MaxUint64 {
			return nil, fmt.Errorf("value %v is out of range", t)
		}
		return uint64(t), nil
	case bool:
		return v, nil
	case string:
		s := strings.TrimSpace(t)
		if u, err := strconv.ParseUint(s, 10, 64); err == nil {
			return u, nil
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil && f == math.Trunc(f) && f >= 0 {
			return uint64(f), nil
		}
		return nil, fmt.Errorf("cannot convert %q to a whole number", t)
	default:
		return v, nil
	}
}

func coerceFloat(v interface{}) (interface{}, error) {
	switch t := v.(type) {
	case float64:
		return t, nil
	case int:
		return float64(t), nil
	case int64:
		return float64(t), nil
	case uint64:
		return float64(t), nil
	case bool:
		return v, nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		if err != nil {
			return nil, fmt.Errorf("cannot convert %q to a number", t)
		}
		return f, nil
	default:
		return v, nil
	}
}

func coerceString(v interface{}) (interface{}, error) {
	switch t := v.(type) {
	case string:
		return t, nil
	case bool:
		return strconv.FormatBool(t), nil
	case int:
		return strconv.FormatInt(int64(t), 10), nil
	case int64:
		return strconv.FormatInt(t, 10), nil
	case uint64:
		return strconv.FormatUint(t, 10), nil
	case float64:
		// 'f' with precision -1 keeps 14074000 as "14074000" rather than "1.4074e+07".
		return strconv.FormatFloat(t, 'f', -1, 64), nil
	default:
		return v, nil
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Repair of a config file on disk (the LoadConfig self-repair path)
// ─────────────────────────────────────────────────────────────────────────────

// config.yaml is mostly documentation — config.yaml.example ships more comment
// lines than settings — and LoadConfig rewrites it unattended, at boot, without
// anyone to eyeball the result. So the repair does not re-encode the document:
// re-encoding a yaml.Node tree keeps the comments but drops every blank line
// between them and renormalises inline spacing, which on the shipped example
// rewrites most of the file to fix one port number.
//
// Instead the node tree is used only to *locate* the mistyped scalars, and the
// original bytes are patched in place. Every byte outside a repaired value is
// left exactly as the operator wrote it.

// scalarFix is one located value to rewrite, with the position yaml reported.
type scalarFix struct {
	line, col int // 1-based, as yaml.Node reports them
	style     yaml.Style
	value     string // the decoded scalar, used to verify we found the right text
	newText   string // the source text to put in its place
	repair    ConfigRepair
}

// findScalarFixes walks the node tree alongside the schema and collects every
// scalar whose YAML type does not match the declared Go type.
func findScalarFixes(n *yaml.Node, schema *configNode, path string, fixes *[]scalarFix) {
	if n == nil || schema == nil || schema.opaque {
		return
	}

	switch n.Kind {
	case yaml.DocumentNode:
		for _, child := range n.Content {
			findScalarFixes(child, schema, path, fixes)
		}

	case yaml.AliasNode:
		// The anchor itself is visited where it is defined.

	case yaml.MappingNode:
		for i := 0; i+1 < len(n.Content); i += 2 {
			key, val := n.Content[i], n.Content[i+1]
			var child *configNode
			switch schema.kind {
			case reflect.Struct:
				child = schema.fields[key.Value]
			case reflect.Map:
				child = schema.elem
			}
			findScalarFixes(val, child, joinConfigPath(path, key.Value), fixes)
		}

	case yaml.SequenceNode:
		if schema.kind != reflect.Slice {
			return
		}
		for i, item := range n.Content {
			findScalarFixes(item, schema.elem, fmt.Sprintf("%s[%d]", path, i), fixes)
		}

	case yaml.ScalarNode:
		if fix, ok := scalarFixFor(n, schema.kind, path); ok {
			*fixes = append(*fixes, fix)
		}
	}
}

func scalarFixFor(n *yaml.Node, kind reflect.Kind, path string) (scalarFix, bool) {
	if n.Tag == "!!null" || n.Tag == "" {
		return scalarFix{}, false
	}
	// Block scalars are multi-line prose; nothing we repair can live in one.
	if n.Style == yaml.LiteralStyle || n.Style == yaml.FoldedStyle {
		return scalarFix{}, false
	}

	want := yamlTagForKind(kind)
	if want == "" || n.Tag == want {
		return scalarFix{}, false
	}

	// yaml.v3 decodes !!int into a float field happily, so int/float is not a
	// mismatch and rewriting it would churn the file for nothing. The one
	// exception is a float in a whole-number field, which really does fail to
	// load — and only when dropping to an integer is lossless.
	if tagClass(n.Tag) == tagClass(want) {
		if !(want == "!!int" && n.Tag == "!!float" && isIntegralYAMLScalar(n.Value)) {
			return scalarFix{}, false
		}
	}

	// A quoted empty string in a scalar field is a deliberate "unset"; leave it.
	if n.Tag == "!!str" && strings.TrimSpace(n.Value) == "" {
		return scalarFix{}, false
	}

	var newText string
	switch want {
	case "!!bool":
		b, ok := parseYAMLBool(n.Value)
		if !ok {
			return scalarFix{}, false
		}
		newText = strconv.FormatBool(b)

	case "!!int":
		s := strings.TrimSpace(n.Value)
		i, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			f, ferr := strconv.ParseFloat(s, 64)
			if ferr != nil || f != math.Trunc(f) {
				return scalarFix{}, false
			}
			i = int64(f)
		}
		newText = strconv.FormatInt(i, 10)

	case "!!float":
		f, err := strconv.ParseFloat(strings.TrimSpace(n.Value), 64)
		if err != nil {
			return scalarFix{}, false
		}
		newText = strconv.FormatFloat(f, 'f', -1, 64)

	case "!!str":
		// Quote it, or re-reading the file would just parse the bare value as a
		// number again.
		newText = strconv.Quote(n.Value)

	default:
		return scalarFix{}, false
	}

	return scalarFix{
		line:  n.Line,
		col:   n.Column,
		style: n.Style,
		value: n.Value,
		repair: ConfigRepair{
			Path: path,
			From: n.Tag + " " + strconv.Quote(n.Value),
			To:   want + " " + newText,
		},
		newText: newText,
	}, true
}

// applyScalarFixes rewrites just the located values in the original bytes.
// It fails rather than guessing: if the text at a reported position is not the
// scalar we expected to find there, no repair is applied at all.
func applyScalarFixes(data []byte, fixes []scalarFix) ([]byte, error) {
	lines := strings.SplitAfter(string(data), "\n")

	// Later fixes on the same line would shift earlier ones, so apply each line
	// right-to-left.
	sort.SliceStable(fixes, func(i, j int) bool {
		if fixes[i].line != fixes[j].line {
			return fixes[i].line > fixes[j].line
		}
		return fixes[i].col > fixes[j].col
	})

	for _, fix := range fixes {
		if fix.line < 1 || fix.line > len(lines) {
			return nil, fmt.Errorf("%s: reported line %d is outside the file", fix.repair.Path, fix.line)
		}
		line := lines[fix.line-1]

		start, err := runeColumnToByteOffset(line, fix.col)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", fix.repair.Path, err)
		}
		end, err := scalarSourceEnd(line, start, fix)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", fix.repair.Path, err)
		}

		lines[fix.line-1] = line[:start] + fix.newText + line[end:]
	}

	return []byte(strings.Join(lines, "")), nil
}

// runeColumnToByteOffset converts yaml's 1-based rune column to a byte index.
func runeColumnToByteOffset(line string, col int) (int, error) {
	if col < 1 {
		return 0, fmt.Errorf("reported column %d is not valid", col)
	}
	offset := 0
	for i := 1; i < col; i++ {
		if offset >= len(line) {
			return 0, fmt.Errorf("reported column %d is past the end of the line", col)
		}
		_, size := utf8.DecodeRuneInString(line[offset:])
		offset += size
	}
	return offset, nil
}

// scalarSourceEnd returns the byte index just past the scalar that starts at
// start, verifying that what is there really is the value yaml reported.
func scalarSourceEnd(line string, start int, fix scalarFix) (int, error) {
	if start >= len(line) {
		return 0, fmt.Errorf("nothing at the reported position")
	}

	switch fix.style {
	case yaml.DoubleQuotedStyle, yaml.SingleQuotedStyle:
		quote := line[start]
		if (fix.style == yaml.DoubleQuotedStyle && quote != '"') ||
			(fix.style == yaml.SingleQuotedStyle && quote != '\'') {
			return 0, fmt.Errorf("expected a quoted value at the reported position")
		}
		for i := start + 1; i < len(line); i++ {
			switch line[i] {
			case '\\':
				if fix.style == yaml.DoubleQuotedStyle {
					// An escape means the source text is not the plain value;
					// bail out rather than mis-measure it.
					return 0, fmt.Errorf("escaped characters in the value")
				}
			case quote:
				if fix.style == yaml.SingleQuotedStyle && i+1 < len(line) && line[i+1] == '\'' {
					i++ // '' is an escaped quote, not the end
					continue
				}
				inner := line[start+1 : i]
				if fix.style == yaml.SingleQuotedStyle {
					inner = strings.ReplaceAll(inner, "''", "'")
				}
				if inner != fix.value {
					return 0, fmt.Errorf("value at the reported position is %q, expected %q", inner, fix.value)
				}
				return i + 1, nil
			}
		}
		return 0, fmt.Errorf("unterminated quoted value")

	default: // plain
		end := len(line)
		// A '#' only starts a comment when preceded by whitespace.
		for i := start; i < len(line); i++ {
			if line[i] == '#' && i > start && isYAMLSpace(line[i-1]) {
				end = i
				break
			}
		}
		for end > start && (isYAMLSpace(line[end-1]) || line[end-1] == '\n' || line[end-1] == '\r') {
			end--
		}
		if got := line[start:end]; got != fix.value {
			return 0, fmt.Errorf("value at the reported position is %q, expected %q", got, fix.value)
		}
		return end, nil
	}
}

func isYAMLSpace(b byte) bool { return b == ' ' || b == '\t' }

func yamlTagForKind(kind reflect.Kind) string {
	switch kind {
	case reflect.Bool:
		return "!!bool"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return "!!int"
	case reflect.Float32, reflect.Float64:
		return "!!float"
	case reflect.String:
		return "!!str"
	default:
		return ""
	}
}

func tagClass(tag string) scalarClass {
	switch tag {
	case "!!bool":
		return classBool
	case "!!int", "!!float":
		return classNumber
	case "!!str":
		return classString
	default:
		return classOther
	}
}

func isIntegralYAMLScalar(s string) bool {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	return err == nil && f == math.Trunc(f)
}

func parseYAMLBool(s string) (bool, bool) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "true", "t", "y", "yes", "on", "1":
		return true, true
	case "false", "f", "n", "no", "off", "0":
		return false, true
	}
	return false, false
}

// repairConfigYAML takes raw config bytes that failed to unmarshal and rewrites
// the value types that made it fail, leaving every other byte of the file —
// comments, blank lines, key order, indentation, quoting style — untouched.
// It returns the repaired bytes and the list of corrections. An error means the
// file is broken in a way retyping cannot fix.
func repairConfigYAML(data []byte, schema *configNode, into interface{}) ([]byte, []ConfigRepair, error) {
	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return nil, nil, fmt.Errorf("config is not valid YAML: %w", err)
	}

	var fixes []scalarFix
	findScalarFixes(&root, schema, "", &fixes)
	if len(fixes) == 0 {
		return nil, nil, fmt.Errorf("no mistyped values found")
	}

	repaired, err := applyScalarFixes(data, fixes)
	if err != nil {
		return nil, nil, err
	}

	if err := yaml.Unmarshal(repaired, into); err != nil {
		return nil, nil, fmt.Errorf("config still invalid after retyping values: %w", err)
	}

	// Report in the order they appear in the file, not the order they were applied.
	repairs := make([]ConfigRepair, 0, len(fixes))
	for i := len(fixes) - 1; i >= 0; i-- {
		repairs = append(repairs, fixes[i].repair)
	}
	return repaired, repairs, nil
}
