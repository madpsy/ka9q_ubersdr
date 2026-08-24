package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"strings"
)

// The operator's page-load notices for the v2 interface — "antenna maintenance
// this afternoon", and a donate button.
//
// One thing the shape of a notice decides that is not about its wording: a
// notice carrying a link is not drawn in the iOS or Android clients, because a
// donate button inside an app is a payment link the stores require to go through
// their own billing. The words alone are shown everywhere. That rule is the
// client's — see noticeLinksAllowedByHost in static/v2/src/lib/hostPanels.js —
// and is named here because it is the reason an operator's donate button may not
// appear where they expect it to.
//
// A short list rather than one, because those two are the cases this exists for
// and they are not the same kind of thing. A donate button is permanent, quiet
// and worth showing a listener once; an outage warning is temporary, amber, and
// wants to be seen on every load until the antenna is back. One card holding
// both reads as "donate towards the outage". They stack instead, in the order
// the list is written.
//
// ── Why this carries no HTML ─────────────────────────────────────────────────
//
// The obvious shape for this is a box the operator types markup into, and the
// receiver already has two of those: admin.description is rendered with
// dangerouslySetInnerHTML in v2's start overlay and status panel, and
// server.custom_body_html is injected into both interfaces' shells. So HTML here
// would not be a new privilege — an admin who can set this can already run
// script on the page.
//
// It would be a new *route*, and that is the part that matters. ui.yaml travels:
// /admin/ui-config-export packs it into a ZIP and /admin/ui-config-import
// unpacks somebody else's. A notice made of markup turns "import a colour
// scheme I liked" into "import a script I did not read", which is a thing
// neither description nor custom_body_html can do. Fields the client renders as
// text cannot carry that, however they arrive.
//
// It also costs nothing: both of the cases this was asked for are a sentence and
// at most one link. A PayPal donate button is a link to paypal.com/donate with a
// hosted button id, which is exactly what LinkURL holds — PayPal's own markup is
// a form that posts to the same place.
//
// ── Everything is checked twice ──────────────────────────────────────────────
//
// validateUINotice runs on PUT, so the admin gets told what is wrong. sanitise
// runs on every serve, because the PUT handler is not the only way into
// ui.yaml — the import endpoint is another, and an operator with an editor is a
// third. What the public endpoint sends is therefore clamped and re-checked
// rather than trusted, and a field that fails is dropped rather than the whole
// notice refused: a mistyped link should not silence a maintenance warning.
type UINotice struct {
	Enabled bool `yaml:"enabled" json:"enabled"`
	// "info", "warning" or "good" — which of the interface's three notice
	// colours it is drawn in. Empty means info.
	Severity string `yaml:"severity,omitempty" json:"severity,omitempty"`
	// The heading, and the body under it. Either may be empty; both empty means
	// there is nothing to show and the notice is not sent at all.
	Title string `yaml:"title,omitempty" json:"title,omitempty"`
	Text  string `yaml:"text,omitempty"  json:"text,omitempty"`
	// One call to action. http, https or mailto only — see noticeLinkOK.
	LinkURL   string `yaml:"link_url,omitempty"   json:"link_url,omitempty"`
	LinkLabel string `yaml:"link_label,omitempty" json:"link_label,omitempty"`
	// Seconds on screen before it fades. nil means the default (3), and 0 means
	// it stays until dismissed — which is why this is a pointer and not a plain
	// number: those two are different answers and zero cannot be both.
	TimeoutSeconds *float64 `yaml:"timeout_seconds,omitempty" json:"timeout_seconds,omitempty"`
	// Whether it can be closed early. nil means yes.
	Dismissible *bool `yaml:"dismissible,omitempty" json:"dismissible,omitempty"`
	// "every-load" (the default) or "once" — the latter meaning once per
	// browser, until the wording changes. See NoticeID.
	Repeat string `yaml:"repeat,omitempty" json:"repeat,omitempty"`
}

// The caps. Generous for anything anybody would actually write, and small
// enough that a hand-edited ui.yaml cannot make every visitor download a novel.
const (
	noticeMaxTitle = 120
	noticeMaxText  = 500
	noticeMaxLabel = 40
	noticeMaxURL   = 500
	// The most a notice may sit on screen. Longer than this is what
	// timeout_seconds: 0 is for.
	noticeMaxTimeout = 60
	// How many may be shown at once. Three is the front door still being a
	// front door: past that it is a billboard, and the fourth thing an operator
	// has to say is one the first three have already stopped anybody reading.
	noticeMaxCount    = 3
	noticeDefTimeout  = 3
	noticeDefSeverity = "info"
	noticeDefRepeat   = "every-load"
)

var noticeSeverities = []string{"info", "warning", "good"}
var noticeRepeats = []string{"every-load", "once"}

func inList(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// truncRunes cuts s to at most n runes, counting characters rather than bytes so
// a cap does not land in the middle of one.
func truncRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return strings.TrimSpace(string(r[:n]))
}

// noticeLinkOK reports whether u is a link this is willing to hand a visitor.
//
// A scheme allowlist rather than a blocklist: javascript: and data: are the two
// everybody thinks of, but the set of URL schemes a browser knows is open-ended
// and only three of them make sense on a notice.
func noticeLinkOK(u string) bool {
	if u == "" || len(u) > noticeMaxURL {
		return false
	}
	// Protocol-relative ("//evil.example") parses as a valid URL with no scheme,
	// and a browser would follow it. Named rather than left to the scheme test,
	// because it is the one that looks harmless.
	if strings.HasPrefix(u, "//") {
		return false
	}
	parsed, err := url.Parse(u)
	if err != nil {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
		return parsed.Host != ""
	case "mailto":
		return parsed.Opaque != ""
	default:
		return false
	}
}

// validateUINotice checks a notice on its way in. Messages name the field and
// nothing more — validateUINotices puts the position in front of them, and the
// pair reaches the operator as the reason their save failed.
func validateUINotice(n *UINotice) error {
	if n == nil {
		return nil
	}
	if n.Severity != "" && !inList(noticeSeverities, n.Severity) {
		return fmt.Errorf("severity: %q is not one of %s", n.Severity, strings.Join(noticeSeverities, ", "))
	}
	if n.Repeat != "" && !inList(noticeRepeats, n.Repeat) {
		return fmt.Errorf("repeat: %q is not one of %s", n.Repeat, strings.Join(noticeRepeats, ", "))
	}
	if n.TimeoutSeconds != nil && (*n.TimeoutSeconds < 0 || *n.TimeoutSeconds > noticeMaxTimeout) {
		return fmt.Errorf("timeout_seconds: %g is outside 0-%d (0 means it stays until dismissed)", *n.TimeoutSeconds, noticeMaxTimeout)
	}
	if u := strings.TrimSpace(n.LinkURL); u != "" && !noticeLinkOK(u) {
		return fmt.Errorf("link_url: %q must be an http://, https:// or mailto: address", u)
	}
	// Only when it is actually going to be shown: an operator drafting a notice
	// with the switch off should be able to save a half-written one.
	if n.Enabled && strings.TrimSpace(n.Title) == "" && strings.TrimSpace(n.Text) == "" {
		return fmt.Errorf("enabled with no title and no text — there would be nothing to show")
	}
	if len([]rune(n.Title)) > noticeMaxTitle {
		return fmt.Errorf("title: longer than %d characters", noticeMaxTitle)
	}
	if len([]rune(n.Text)) > noticeMaxText {
		return fmt.Errorf("text: longer than %d characters", noticeMaxText)
	}
	if len([]rune(n.LinkLabel)) > noticeMaxLabel {
		return fmt.Errorf("link_label: longer than %d characters", noticeMaxLabel)
	}
	return nil
}

// validateUINotices checks the list as a whole, and each notice in it. The index
// is in every message because the admin form has three identical-looking cards
// and "the second one" is the only useful way to say which.
func validateUINotices(list []UINotice) error {
	if len(list) > noticeMaxCount {
		return fmt.Errorf("ui.v2.notices: %d messages, but at most %d are shown", len(list), noticeMaxCount)
	}
	for i := range list {
		if err := validateUINotice(&list[i]); err != nil {
			return fmt.Errorf("ui.v2.notices: message %d: %w", i+1, err)
		}
	}
	return nil
}

// noticeID is a short digest of what the notice says, sent with it so a browser
// that has dismissed one can tell whether the next is the same notice or a new
// one. Editing a word gives a new id and the notice is shown again, which is
// what an operator changing "16:00" to "18:00" means by it.
func noticeID(severity, title, text, linkURL, linkLabel string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{severity, title, text, linkURL, linkLabel}, "\x00")))
	return hex.EncodeToString(sum[:])[:12]
}

// noticeForWire builds what /api/ui-config sends, or nil when there is nothing
// to show. Every value is clamped here rather than assumed, for the reason on
// the type: this is the boundary the import endpoint and a text editor do not
// pass through.
func noticeForWire(n *UINotice) map[string]interface{} {
	if n == nil || !n.Enabled {
		return nil
	}

	title := truncRunes(strings.TrimSpace(n.Title), noticeMaxTitle)
	text := truncRunes(strings.TrimSpace(n.Text), noticeMaxText)
	if title == "" && text == "" {
		return nil
	}

	severity := strings.TrimSpace(n.Severity)
	if !inList(noticeSeverities, severity) {
		severity = noticeDefSeverity
	}
	repeat := strings.TrimSpace(n.Repeat)
	if !inList(noticeRepeats, repeat) {
		repeat = noticeDefRepeat
	}

	timeout := float64(noticeDefTimeout)
	if n.TimeoutSeconds != nil {
		timeout = *n.TimeoutSeconds
		if timeout < 0 {
			timeout = 0
		}
		if timeout > noticeMaxTimeout {
			timeout = noticeMaxTimeout
		}
	}

	dismissible := true
	if n.Dismissible != nil {
		dismissible = *n.Dismissible
	}

	linkURL := strings.TrimSpace(n.LinkURL)
	linkLabel := truncRunes(strings.TrimSpace(n.LinkLabel), noticeMaxLabel)
	if !noticeLinkOK(linkURL) {
		// Dropped, not fatal: a broken link is no reason to withhold the words.
		linkURL, linkLabel = "", ""
	} else if linkLabel == "" {
		linkLabel = "Open"
	}

	out := map[string]interface{}{
		"id":              noticeID(severity, title, text, linkURL, linkLabel),
		"severity":        severity,
		"title":           title,
		"text":            text,
		"timeout_seconds": timeout,
		"dismissible":     dismissible,
		"repeat":          repeat,
	}
	if linkURL != "" {
		out["link_url"] = linkURL
		out["link_label"] = linkLabel
	}
	return out
}

// noticesForWire builds what /api/ui-config sends: the notices that have
// something to show, in the order the operator wrote them, and nil when none of
// them do.
//
// A notice that produces nothing is dropped rather than sent as an empty card
// or taken as the end of the list — the second of three switched off must not
// silence the third.
func noticesForWire(list []UINotice) []map[string]interface{} {
	out := make([]map[string]interface{}, 0, len(list))
	for i := range list {
		if len(out) >= noticeMaxCount {
			break
		}
		if n := noticeForWire(&list[i]); n != nil {
			out = append(out, n)
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
