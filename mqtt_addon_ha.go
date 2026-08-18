package main

// mqtt_addon_ha.go — Home Assistant discovery for addon-declared entities.
//
// Addons never write to the Home Assistant discovery tree. They POST a
// *declaration* describing an entity (display name, unit, device class, value
// template) to the ingest listener; UberSDR validates every field against an
// allowlist, computes the state topic itself from the addon's authenticated
// identity, and publishes the discovery config on the addon's behalf.
//
// That inversion is the whole security model:
//
//   - The discovery prefix ({haPrefix}/...) is shared with every other MQTT
//     integration in the operator's Home Assistant. Direct write access there
//     would let a buggy addon overwrite — or, with an empty retained payload,
//     delete — entities belonging to unrelated devices. Addons never touch it.
//   - state_topic is derived, never supplied, so a declaration cannot point an
//     entity at UberSDR's own topics or at another addon's namespace.
//   - The declaration is decoded into a typed struct, so unknown JSON fields are
//     dropped rather than passed through into the discovery payload.
//
// Each addon gets its own Home Assistant *child device* linked to the receiver
// via via_device, so its entities group under their own card (with a
// configuration_url pointing at the addon's own web UI) while still nesting
// under the parent receiver.
//
// Declarations are persisted to {configDir}/addon_ha_entities.yaml because
// discovery configs are retained and must be republished on every MQTT
// reconnect — which may happen while the addon container is down.

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

// ── Declaration ───────────────────────────────────────────────────────────────

// AddonHADeclaration is the entity description an addon may submit. Every field
// is presentation metadata: nothing here can name a topic, an entity id, or a
// device. Fields absent from this struct are silently dropped at decode time.
type AddonHADeclaration struct {
	// SubTopic identifies which of the addon's data topics backs this entity.
	// The full state topic is derived from it; the addon never sees or sets it.
	SubTopic string `json:"sub_topic" yaml:"sub_topic"`

	// EntityKey distinguishes multiple entities backed by the SAME sub_topic,
	// which is the normal shape for MQTT: one retained JSON payload, several
	// entities each pulling a different field out of it with a value_template.
	// Optional — when empty the sub_topic itself identifies the entity, so a
	// one-entity-per-topic addon never needs to think about this.
	EntityKey string `json:"entity_key,omitempty" yaml:"entity_key,omitempty"`

	// Component is the Home Assistant platform: "sensor" or "binary_sensor".
	// Writeable platforms are deliberately not offered — they imply a command
	// topic, i.e. Home Assistant publishing back, which needs subscribe support
	// that does not exist.
	Component string `json:"component" yaml:"component"`

	// Name is the entity's display name within the addon's device card.
	Name string `json:"name" yaml:"name"`

	ValueTemplate          string `json:"value_template,omitempty" yaml:"value_template,omitempty"`
	UnitOfMeasurement      string `json:"unit_of_measurement,omitempty" yaml:"unit_of_measurement,omitempty"`
	DeviceClass            string `json:"device_class,omitempty" yaml:"device_class,omitempty"`
	StateClass             string `json:"state_class,omitempty" yaml:"state_class,omitempty"`
	Icon                   string `json:"icon,omitempty" yaml:"icon,omitempty"`
	EntityCategory         string `json:"entity_category,omitempty" yaml:"entity_category,omitempty"`
	PayloadOn              string `json:"payload_on,omitempty" yaml:"payload_on,omitempty"`
	PayloadOff             string `json:"payload_off,omitempty" yaml:"payload_off,omitempty"`
	JSONAttributesTemplate string `json:"json_attributes_template,omitempty" yaml:"json_attributes_template,omitempty"`

	// AddonVersion and AddonModel describe the addon itself and populate its
	// Home Assistant child device card. Optional.
	AddonVersion string `json:"addon_version,omitempty" yaml:"addon_version,omitempty"`
	AddonModel   string `json:"addon_model,omitempty" yaml:"addon_model,omitempty"`
}

// addonHAEntry is a persisted declaration plus the identity UberSDR assigned it.
type addonHAEntry struct {
	// Addon is the authenticated addon name. It comes from the source IP, never
	// from the request body.
	Addon string `yaml:"addon"`

	AddonHADeclaration `yaml:",inline"`

	FirstSeen    time.Time `yaml:"first_seen"`
	LastDeclared time.Time `yaml:"last_declared"`

	// PendingDelete marks an entity whose teardown could not be delivered
	// because the broker was unreachable. The entry is kept (and persisted) so
	// the clear is retried on the next reconnect. Dropping it immediately would
	// orphan a retained discovery config with nothing left to clean it up — a
	// permanent ghost device in Home Assistant.
	PendingDelete bool `yaml:"pending_delete,omitempty"`
}

// addonHAFile is the on-disk registry format.
type addonHAFile struct {
	Entities []addonHAEntry `yaml:"entities"`
}

// ── Validation allowlists ─────────────────────────────────────────────────────

var addonHAComponents = map[string]bool{
	"sensor":        true,
	"binary_sensor": true,
}

var addonHAStateClasses = map[string]bool{
	"measurement":      true,
	"total":            true,
	"total_increasing": true,
}

// addonHAEntityCategories: only "diagnostic" is meaningful for a read-only
// entity. "config" implies a user-settable control, which addons cannot offer.
var addonHAEntityCategories = map[string]bool{
	"diagnostic": true,
}

// addonHADeviceClasses is the union of the Home Assistant sensor and
// binary_sensor device classes. Allowlisting these is a usability win as much
// as a safety one: Home Assistant silently discards an entire discovery config
// carrying an unrecognised device_class, so rejecting it at declare time gives
// the addon author an error instead of a mystery.
var addonHADeviceClasses = map[string]bool{
	// sensor
	"apparent_power": true, "aqi": true, "atmospheric_pressure": true,
	"battery": true, "carbon_dioxide": true, "carbon_monoxide": true,
	"current": true, "data_rate": true, "data_size": true, "date": true,
	"distance": true, "duration": true, "energy": true, "energy_storage": true,
	"enum": true, "frequency": true, "gas": true, "humidity": true,
	"illuminance": true, "irradiance": true, "moisture": true, "monetary": true,
	"nitrogen_dioxide": true, "nitrogen_monoxide": true, "nitrous_oxide": true,
	"ozone": true, "ph": true, "pm1": true, "pm10": true, "pm25": true,
	"power": true, "power_factor": true, "precipitation": true,
	"precipitation_intensity": true, "pressure": true, "reactive_power": true,
	"signal_strength": true, "sound_pressure": true, "speed": true,
	"sulphur_dioxide": true, "temperature": true, "timestamp": true,
	"volatile_organic_compounds": true, "voltage": true, "volume": true,
	"volume_flow_rate": true, "volume_storage": true, "water": true,
	"weight": true, "wind_speed": true,
	// binary_sensor
	"battery_charging": true, "cold": true, "connectivity": true, "door": true,
	"garage_door": true, "heat": true, "light": true, "lock": true,
	"motion": true, "moving": true, "occupancy": true, "opening": true,
	"plug": true, "presence": true, "problem": true, "running": true,
	"safety": true, "smoke": true, "sound": true, "tamper": true,
	"update": true, "vibration": true, "window": true,
}

var addonHAIconRe = regexp.MustCompile(`^mdi:[a-z0-9-]{1,40}$`)

// addonHAEntityKeyRe matches a single topic-safe segment — no slashes, so an
// entity_key can never widen the object id into another namespace.
var addonHAEntityKeyRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

const (
	addonHAEntityKeyMaxLen = 32
	addonHANameMaxLen      = 64
	addonHATemplateMaxLen  = 256
	addonHAUnitMaxLen      = 16
	addonHAPayloadMaxLen   = 32
	addonHAVersionMaxLen   = 32
	addonHAModelMaxLen     = 64
)

// hasControlChars reports whether s contains control characters. Used to keep
// newlines and terminal escapes out of anything that ends up in a discovery
// payload or a log line.
func hasControlChars(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// checkText validates a free-text field: length-bounded and control-char free.
func checkText(field, val string, maxLen int) error {
	if len(val) > maxLen {
		return fmt.Errorf("%s must be %d characters or fewer", field, maxLen)
	}
	if hasControlChars(val) {
		return fmt.Errorf("%s must not contain control characters", field)
	}
	return nil
}

// Validate checks and normalises a declaration. It returns an error describing
// the first problem found, phrased for an addon author reading an HTTP response.
func (d *AddonHADeclaration) Validate() error {
	// sub_topic uses the same validator as the data path, so an entity can never
	// reference a topic the addon is not allowed to publish to.
	if err := validateAddonSubTopic(d.SubTopic); err != nil {
		return fmt.Errorf("sub_topic: %w", err)
	}

	if d.EntityKey != "" {
		d.EntityKey = strings.ToLower(strings.TrimSpace(d.EntityKey))
		if !addonHAEntityKeyRe.MatchString(d.EntityKey) {
			return fmt.Errorf("entity_key must be a single lowercase alphanumeric segment (a-z, 0-9, _, -) of at most %d characters", addonHAEntityKeyMaxLen)
		}
	}

	d.Component = strings.ToLower(strings.TrimSpace(d.Component))
	if d.Component == "" {
		d.Component = "sensor"
	}
	if !addonHAComponents[d.Component] {
		return fmt.Errorf("component must be one of: binary_sensor, sensor (got %q)", d.Component)
	}

	d.Name = strings.TrimSpace(d.Name)
	if d.Name == "" {
		return fmt.Errorf("name is required")
	}
	if err := checkText("name", d.Name, addonHANameMaxLen); err != nil {
		return err
	}

	if err := checkText("value_template", d.ValueTemplate, addonHATemplateMaxLen); err != nil {
		return err
	}
	if err := checkText("json_attributes_template", d.JSONAttributesTemplate, addonHATemplateMaxLen); err != nil {
		return err
	}
	if err := checkText("unit_of_measurement", d.UnitOfMeasurement, addonHAUnitMaxLen); err != nil {
		return err
	}
	if err := checkText("payload_on", d.PayloadOn, addonHAPayloadMaxLen); err != nil {
		return err
	}
	if err := checkText("payload_off", d.PayloadOff, addonHAPayloadMaxLen); err != nil {
		return err
	}
	if err := checkText("addon_version", d.AddonVersion, addonHAVersionMaxLen); err != nil {
		return err
	}
	if err := checkText("addon_model", d.AddonModel, addonHAModelMaxLen); err != nil {
		return err
	}

	if d.DeviceClass != "" {
		d.DeviceClass = strings.ToLower(strings.TrimSpace(d.DeviceClass))
		if !addonHADeviceClasses[d.DeviceClass] {
			return fmt.Errorf("device_class %q is not a recognised Home Assistant device class", d.DeviceClass)
		}
	}
	if d.StateClass != "" {
		d.StateClass = strings.ToLower(strings.TrimSpace(d.StateClass))
		if !addonHAStateClasses[d.StateClass] {
			return fmt.Errorf("state_class must be one of: measurement, total, total_increasing (got %q)", d.StateClass)
		}
		if d.Component != "sensor" {
			return fmt.Errorf("state_class is only valid for component \"sensor\"")
		}
	}
	if d.EntityCategory != "" {
		d.EntityCategory = strings.ToLower(strings.TrimSpace(d.EntityCategory))
		if !addonHAEntityCategories[d.EntityCategory] {
			return fmt.Errorf("entity_category must be \"diagnostic\" (got %q)", d.EntityCategory)
		}
	}
	if d.Icon != "" {
		d.Icon = strings.ToLower(strings.TrimSpace(d.Icon))
		if !addonHAIconRe.MatchString(d.Icon) {
			return fmt.Errorf("icon must look like \"mdi:flash\" (got %q)", d.Icon)
		}
	}

	// binary_sensor needs an on/off vocabulary; default to the same one the
	// built-in problem sensors use.
	if d.Component == "binary_sensor" {
		if d.PayloadOn == "" {
			d.PayloadOn = "ON"
		}
		if d.PayloadOff == "" {
			d.PayloadOff = "OFF"
		}
	} else if d.PayloadOn != "" || d.PayloadOff != "" {
		return fmt.Errorf("payload_on/payload_off are only valid for component \"binary_sensor\"")
	}

	return nil
}

// ── Registry ──────────────────────────────────────────────────────────────────

// AddonHARegistry stores addon entity declarations and publishes/clears the
// corresponding Home Assistant discovery configs.
type AddonHARegistry struct {
	mu      sync.RWMutex
	path    string
	entries map[string]addonHAEntry // key: addon + "\x00" + sub_topic

	publisher *MQTTPublisher
	appConfig *Config
	maxPer    int
}

// NewAddonHARegistry loads the persisted declarations from path (a missing file
// is not an error) and returns a registry ready to publish.
func NewAddonHARegistry(path string, publisher *MQTTPublisher, appConfig *Config, maxPerAddon int) *AddonHARegistry {
	r := &AddonHARegistry{
		path:      path,
		entries:   make(map[string]addonHAEntry),
		publisher: publisher,
		appConfig: appConfig,
		maxPer:    maxPerAddon,
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("AddonHA: could not read %s: %v (starting with an empty registry)", path, err)
		}
		return r
	}

	var file addonHAFile
	if err := yaml.Unmarshal(data, &file); err != nil {
		log.Printf("AddonHA: could not parse %s: %v (starting with an empty registry)", path, err)
		return r
	}
	for _, e := range file.Entities {
		// Re-validate on load: the file may have been hand-edited, and a stale
		// entry written by an older build must not bypass current rules.
		if e.Addon == "" {
			continue
		}
		if err := e.AddonHADeclaration.Validate(); err != nil {
			log.Printf("AddonHA: dropping invalid persisted entity %s/%s: %v", e.Addon, e.SubTopic, err)
			continue
		}
		r.entries[addonHAKey(e.Addon, e.SubTopic, e.EntityKey)] = e
	}
	log.Printf("AddonHA: loaded %d persisted Home Assistant entity declaration(s) from %s", len(r.entries), path)
	return r
}

func addonHAKey(addon, subTopic, entityKey string) string {
	return addon + "\x00" + subTopic + "\x00" + entityKey
}

// addonHAObjectID returns the addon-namespaced object id an entity will get.
// haFinalize prefixes it with "ubersdr_", producing e.g.
// "ubersdr_addon_lightning_strikes". Both the entity builder and the collision
// check call this, so the id they reason about is always the same one.
//
// entityKey, when set, names the entity instead of the sub-topic — that is what
// lets several entities share one state topic.
func addonHAObjectID(addon, subTopic, entityKey string) string {
	suffix := subTopic
	if entityKey != "" {
		suffix = entityKey
	}
	return "addon_" + haSlug(addon) + "_" + haSlug(suffix)
}

// save writes the registry atomically. Caller must hold the write lock.
func (r *AddonHARegistry) save() error {
	file := addonHAFile{Entities: make([]addonHAEntry, 0, len(r.entries))}
	for _, e := range r.entries {
		file.Entities = append(file.Entities, e)
	}
	// Stable order so the file does not churn between writes.
	sort.Slice(file.Entities, func(i, j int) bool {
		if file.Entities[i].Addon != file.Entities[j].Addon {
			return file.Entities[i].Addon < file.Entities[j].Addon
		}
		return file.Entities[i].SubTopic < file.Entities[j].SubTopic
	})

	data, err := yaml.Marshal(&file)
	if err != nil {
		return fmt.Errorf("marshal addon HA registry: %w", err)
	}
	tmp := r.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return fmt.Errorf("write addon HA registry: %w", err)
	}
	if err := os.Rename(tmp, r.path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename addon HA registry: %w", err)
	}
	return nil
}

// CountFor returns how many live entities the named addon has declared.
func (r *AddonHARegistry) CountFor(addon string) int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	n := 0
	for _, e := range r.entries {
		if e.Addon == addon && !e.PendingDelete {
			n++
		}
	}
	return n
}

// Declare validates and stores a declaration, then publishes its discovery
// config. Re-declaring the same (addon, sub_topic) is an idempotent update, so
// an addon can safely POST its declarations on every startup.
func (r *AddonHARegistry) Declare(addon string, d AddonHADeclaration) error {
	if err := d.Validate(); err != nil {
		return err
	}

	// Two different (addon, sub_topic) pairs can slug to the same object_id —
	// haSlug maps "-" and "/" both to "_", so addon "a-b"/"c" and addon "a"/"b/c"
	// would collide, as would sub-topics "x-y" and "x_y". Left undetected the
	// second declaration would silently overwrite the first's Home Assistant
	// entity, so reject it with an explanation instead.
	objectID := addonHAObjectID(addon, d.SubTopic, d.EntityKey)

	key := addonHAKey(addon, d.SubTopic, d.EntityKey)
	now := time.Now().UTC()

	r.mu.Lock()
	for k, e := range r.entries {
		if k == key || e.PendingDelete {
			continue
		}
		if addonHAObjectID(e.Addon, e.SubTopic, e.EntityKey) == objectID {
			r.mu.Unlock()
			return fmt.Errorf("entity id %q is already used by %s/%s — choose a different sub_topic",
				objectID, e.Addon, e.SubTopic)
		}
	}

	// prev/existed record the raw previous state, used only to roll back a failed
	// save. found is the logical view: an entry awaiting teardown counts as
	// absent, because re-declaring resurrects it.
	prev, existed := r.entries[key]
	existing, found := prev, existed
	if found && existing.PendingDelete {
		found = false
	}
	if !found {
		// Cap only new entities so an addon at its limit can still update the
		// ones it already has.
		n := 0
		for _, e := range r.entries {
			if e.Addon == addon && !e.PendingDelete {
				n++
			}
		}
		if n >= r.maxPer {
			r.mu.Unlock()
			return fmt.Errorf("addon %q already has %d Home Assistant entities (limit %d)", addon, n, r.maxPer)
		}
	}

	entry := addonHAEntry{
		Addon:              addon,
		AddonHADeclaration: d,
		FirstSeen:          now,
		LastDeclared:       now,
	}
	if found {
		entry.FirstSeen = existing.FirstSeen
	}
	r.entries[key] = entry
	if err := r.save(); err != nil {
		// Roll back so the in-memory registry never claims something the file
		// does not, which would silently vanish on the next restart. Restores the
		// raw previous state, so a pending teardown is not lost either.
		if existed {
			r.entries[key] = prev
		} else {
			delete(r.entries, key)
		}
		r.mu.Unlock()
		return err
	}
	r.mu.Unlock()

	r.publishEntry(entry)
	if found {
		log.Printf("AddonHA: addon %q updated entity %q (%s)", addon, d.SubTopic, d.Component)
	} else {
		log.Printf("AddonHA: addon %q declared entity %q (%s, name=%q)", addon, d.SubTopic, d.Component, d.Name)
	}
	return nil
}

// Delete removes declarations and clears their retained discovery configs.
//
// entityKey selects a single entity. When it is empty, EVERY entity backed by
// subTopic is removed — otherwise an addon that split one topic across several
// entities would have to remember each key to clean up after itself.
func (r *AddonHARegistry) Delete(addon, subTopic, entityKey string) error {
	r.mu.RLock()
	var doomed []addonHAEntry
	for _, e := range r.entries {
		if e.Addon != addon || e.SubTopic != subTopic || e.PendingDelete {
			continue
		}
		if entityKey != "" && e.EntityKey != entityKey {
			continue
		}
		doomed = append(doomed, e)
	}
	r.mu.RUnlock()

	if len(doomed) == 0 {
		if entityKey != "" {
			return fmt.Errorf("addon %q has no entity %q on sub_topic %q", addon, entityKey, subTopic)
		}
		return fmt.Errorf("addon %q has no entities on sub_topic %q", addon, subTopic)
	}

	r.teardown(doomed)
	log.Printf("AddonHA: addon %q deleted %d entity/entities on %q", addon, len(doomed), subTopic)
	return nil
}

// PurgeAddon removes every declaration belonging to an addon and clears the
// retained discovery configs, state topics and status topic it left behind.
// Called when an addon is uninstalled or disabled — without it, Home Assistant
// would keep showing a ghost device forever, since discovery configs are
// retained and nothing else ever deletes them.
func (r *AddonHARegistry) PurgeAddon(addon string) int {
	r.mu.RLock()
	var doomed []addonHAEntry
	for _, e := range r.entries {
		if e.Addon == addon && !e.PendingDelete {
			doomed = append(doomed, e)
		}
	}
	r.mu.RUnlock()

	r.teardown(doomed)

	if r.publisher != nil {
		// Clear the retained per-addon status topic too, so nothing lingers on
		// the broker describing an addon that no longer exists. Best-effort: if
		// it fails, the entity clears above are what actually matter, and they
		// are retried.
		r.publisher.clearRetained(r.publisher.config.AddonStatusTopic(addon))
	}
	if len(doomed) > 0 {
		log.Printf("AddonHA: purged %d Home Assistant entity declaration(s) for removed addon %q", len(doomed), addon)
	}
	return len(doomed)
}

// teardown clears the retained topics for each entry and drops it from the
// registry. An entry whose clear could not be delivered is kept and flagged
// PendingDelete so RepublishAll retries it on the next reconnect.
func (r *AddonHARegistry) teardown(entries []addonHAEntry) {
	if len(entries) == 0 {
		return
	}

	cleared := make(map[string]bool, len(entries))
	for _, e := range entries {
		cleared[addonHAKey(e.Addon, e.SubTopic, e.EntityKey)] = r.clearEntry(e)
	}

	r.mu.Lock()
	for key, ok := range cleared {
		entry, found := r.entries[key]
		if !found {
			continue
		}
		if ok {
			delete(r.entries, key)
			continue
		}
		// Broker unreachable — keep the entry so the clear is retried, and
		// persist the flag so a restart does not lose track of it either.
		entry.PendingDelete = true
		r.entries[key] = entry
		log.Printf("AddonHA: could not clear %s/%s (broker unreachable) — will retry on reconnect", entry.Addon, entry.SubTopic)
	}
	err := r.save()
	r.mu.Unlock()

	if err != nil {
		log.Printf("AddonHA: failed to persist registry after teardown: %v", err)
	}
}

// Reconcile purges declarations belonging to addons that are no longer
// installed. Runs at startup, catching addons removed while UberSDR was down
// (or removed by hand rather than through the admin API).
func (r *AddonHARegistry) Reconcile(knownAddons map[string]bool) {
	r.mu.RLock()
	stale := make(map[string]bool)
	for _, e := range r.entries {
		if !knownAddons[e.Addon] {
			stale[e.Addon] = true
		}
	}
	r.mu.RUnlock()

	for addon := range stale {
		log.Printf("AddonHA: addon %q is no longer installed — clearing its Home Assistant entities", addon)
		r.PurgeAddon(addon)
	}
}

// Addons returns the names of addons with at least one live declared entity.
func (r *AddonHARegistry) Addons() []string {
	seen := make(map[string]bool)
	var out []string
	for _, e := range r.Snapshot() {
		if !seen[e.Addon] {
			seen[e.Addon] = true
			out = append(out, e.Addon)
		}
	}
	sort.Strings(out)
	return out
}

// Snapshot returns a copy of every live declaration, for admin/diagnostic
// display. Entries awaiting teardown are excluded — they are no longer part of
// the receiver's advertised state.
func (r *AddonHARegistry) Snapshot() []addonHAEntry {
	out := make([]addonHAEntry, 0)
	for _, e := range r.snapshotAll() {
		if !e.PendingDelete {
			out = append(out, e)
		}
	}
	return out
}

// snapshotAll returns every entry, including those awaiting teardown.
func (r *AddonHARegistry) snapshotAll() []addonHAEntry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]addonHAEntry, 0, len(r.entries))
	for _, e := range r.entries {
		out = append(out, e)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Addon != out[j].Addon {
			return out[i].Addon < out[j].Addon
		}
		return out[i].SubTopic < out[j].SubTopic
	})
	return out
}

// EntityIDFor returns the Home Assistant entity_id a declaration maps to, so
// the ingest listener can echo it back to the addon that declared it.
func (r *AddonHARegistry) EntityIDFor(addon string, d AddonHADeclaration) string {
	if r.publisher == nil || r.appConfig == nil {
		return ""
	}
	entry := addonHAEntry{Addon: addon, AddonHADeclaration: d}
	return r.publisher.buildAddonEntity(r.appConfig, entry).DefaultEntityID
}

// RepublishAll re-publishes every declaration's discovery config, and retries
// any teardown that a previous disconnect prevented.
//
// Called on each MQTT (re)connect: discovery configs are retained, but a broker
// restart or a cleared session loses them, and the addon that declared them may
// well be down at that moment. Persisting the registry is what makes this
// possible.
func (r *AddonHARegistry) RepublishAll() {
	var retry []addonHAEntry
	for _, e := range r.snapshotAll() {
		if e.PendingDelete {
			retry = append(retry, e)
			continue
		}
		r.publishEntry(e)
	}
	if len(retry) > 0 {
		log.Printf("AddonHA: retrying teardown of %d entity/entities deferred while the broker was unreachable", len(retry))
		r.teardown(retry)
	}
}

// ── Discovery publishing ──────────────────────────────────────────────────────

// buildAddonDevice returns the Home Assistant child device for an addon. It
// carries the addon's own identity (version, model, and a configuration_url
// pointing at the addon's web UI) and links to the receiver through via_device
// so Home Assistant nests it under the parent.
func (mp *MQTTPublisher) buildAddonDevice(appConfig *Config, addon string, d AddonHADeclaration) haDevice {
	nodeID := mp.haNodeID(appConfig)

	call := appConfig.Admin.Callsign
	if call == "" {
		call = "UberSDR"
	}

	display := addon
	if len(display) > 0 {
		display = strings.ToUpper(display[:1]) + display[1:]
	}

	model := d.AddonModel
	if model == "" {
		model = "UberSDR addon"
	}

	dev := haDevice{
		Identifiers:   []string{nodeID + "_addon_" + haSlug(addon)},
		Name:          fmt.Sprintf("UberSDR %s %s", call, display),
		Manufacturer:  "UberSDR",
		Model:         model,
		SwVersion:     d.AddonVersion,
		SuggestedArea: appConfig.Admin.Location,
		ViaDevice:     nodeID,
	}

	// configuration_url points at the addon's own reverse-proxied UI, so the
	// Home Assistant device card links straight through to it.
	if base := strings.TrimRight(appConfig.Admin.PublicURL, "/"); base != "" {
		dev.ConfigURL = fmt.Sprintf("%s/addon/%s/", base, addon)
	}

	return dev
}

// buildAddonEntity turns a stored declaration into a discovery entity.
//
// The addon supplies presentation metadata only. state_topic, unique_id,
// object_id, entity_id and the device block are all computed here from the
// authenticated addon name, and the entity is finalised by the same haFinalize
// used for built-in entities so the two identity schemes cannot diverge.
func (mp *MQTTPublisher) buildAddonEntity(appConfig *Config, e addonHAEntry) haEntity {
	nodeID := mp.haNodeID(appConfig)
	statusTopic := mp.config.TopicPrefix + "/status"
	addonStatus := mp.config.AddonStatusTopic(e.Addon)

	entity := haEntity{
		component:              e.Component,
		Name:                   e.Name,
		ObjectID:               addonHAObjectID(e.Addon, e.SubTopic, e.EntityKey),
		StateTopic:             mp.config.AddonDataTopic(e.Addon, e.SubTopic),
		ValueTemplate:          e.ValueTemplate,
		UnitOfMeasurement:      e.UnitOfMeasurement,
		DeviceClass:            e.DeviceClass,
		StateClass:             e.StateClass,
		Icon:                   e.Icon,
		EntityCategory:         e.EntityCategory,
		PayloadOn:              e.PayloadOn,
		PayloadOff:             e.PayloadOff,
		JSONAttributesTemplate: e.JSONAttributesTemplate,

		// Available only when BOTH UberSDR and the addon are up. The first topic
		// is driven by UberSDR's Last Will, the second by the ingest listener's
		// staleness timer — so an addon that dies while UberSDR keeps running
		// greys out its own entities instead of leaving stale values looking live.
		Availability: []haAvailability{
			{Topic: statusTopic, PayloadAvailable: "online", PayloadNotAvailable: "offline"},
			{Topic: addonStatus, PayloadAvailable: "online", PayloadNotAvailable: "offline"},
		},
		AvailabilityMode: "all",
	}
	if e.JSONAttributesTemplate != "" {
		entity.JSONAttributesTopic = entity.StateTopic
	}

	return haFinalize(entity, nodeID, statusTopic, mp.buildAddonDevice(appConfig, e.Addon, e.AddonHADeclaration))
}

// publishEntry publishes one addon entity's retained discovery config.
func (r *AddonHARegistry) publishEntry(e addonHAEntry) {
	mp := r.publisher
	if mp == nil || r.appConfig == nil || !mp.isConnected() {
		return
	}

	entity := mp.buildAddonEntity(r.appConfig, e)
	topic := mp.haConfigTopic(mp.haNodeID(r.appConfig), entity)

	data, err := json.Marshal(entity)
	if err != nil {
		log.Printf("AddonHA ERROR: failed to marshal discovery for %s/%s: %v", e.Addon, e.SubTopic, err)
		return
	}
	token := mp.client.Publish(topic, 1, true, data)
	if !token.WaitTimeout(addonPublishTimeout) {
		mp.logPublishError("AddonHA ERROR: timed out publishing discovery to %s", topic)
		return
	}
	if err := token.Error(); err != nil {
		mp.logPublishError("AddonHA ERROR: failed to publish discovery to %s: %v", topic, err)
		return
	}
	log.Printf("AddonHA: published discovery for %s/%s → %s", e.Addon, e.SubTopic, entity.DefaultEntityID)
}

// clearEntry removes an addon entity from Home Assistant by publishing an empty
// retained payload to its discovery config topic, and clears the retained state
// topic behind it so no orphaned data is left on the broker.
//
// Returns false if the discovery config could not be cleared, in which case the
// caller must keep the entry and retry — see teardown.
func (r *AddonHARegistry) clearEntry(e addonHAEntry) bool {
	mp := r.publisher
	if mp == nil || r.appConfig == nil || !mp.isConnected() {
		return false
	}

	entity := mp.buildAddonEntity(r.appConfig, e)
	ok := mp.clearRetained(mp.haConfigTopic(mp.haNodeID(r.appConfig), entity))
	// Best-effort for the data topic: the discovery clear is what removes the
	// entity from Home Assistant, and it is the one worth retrying.
	mp.clearRetained(mp.config.AddonDataTopic(e.Addon, e.SubTopic))
	return ok
}
