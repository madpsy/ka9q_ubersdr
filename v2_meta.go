package main

import (
	"encoding/json"
	"fmt"
	"html"
	"html/template"
	"log"
	"net"
	"net/http"
	"regexp"
	"strings"
)

// Page metadata for the v2 shell.
//
// v1 hardcodes its <head> — the same title and the same paragraph of UberSDR
// marketing copy on every receiver in existence. For a fleet of instances that
// is the worst case for search: hundreds of pages competing on identical text,
// none of them saying which receiver it is or where it lives. v2's shell is a
// Go template, so the metadata is built per-receiver from what the operator has
// already configured (callsign, name, location, coordinates) and rendered into
// the HTML the crawler is handed.
//
// This is the server's only chance to say it. Both frontends overwrite
// document.title from JS once tuned (App.jsx:61), and a crawler that does not
// run the page sees whatever came down the wire.

// v2MaxDescription is the meta description budget in characters. Search engines
// truncate display around 155-160; going far past it wastes the tail.
const v2MaxDescription = 160

// V2PageMeta is what the v2 shell's <head> renders. Every field is a plain
// string interpolated into an attribute, so html/template escapes it — except
// JSONLD, which is pre-marshalled JSON (see buildV2JSONLD).
type V2PageMeta struct {
	Title        string
	ShortName    string // apple-mobile-web-app-title, og:site_name
	Description  string
	CanonicalURL string
	ImageURL     string
	JSONLD       template.JS
}

var (
	// Tag stripper for admin.description, which is HTML by design — the
	// config example ships `<a href="...">UberSDR</a>` in it.
	htmlTagRE = regexp.MustCompile(`<[^>]*>`)
	// Runs of whitespace (including newlines from a YAML block scalar).
	whitespaceRE = regexp.MustCompile(`\s+`)
)

// buildV2PageMeta assembles the metadata for one request.
func buildV2PageMeta(config *Config, r *http.Request) V2PageMeta {
	callsign := strings.ToUpper(strings.TrimSpace(config.Admin.Callsign))
	location := strings.TrimSpace(config.Admin.Location)
	base := pageBaseURL(r)

	// Which URL this content should be indexed under. When v2 is the enabled
	// interface, / redirects here and the root is the address people share and
	// link to, so that is the canonical one; when v2 is opt-in, / is a different
	// page and /v2/ is its own address.
	canonicalPath := "/v2/"
	if config.UI.V2Interface {
		canonicalPath = "/"
	}

	meta := V2PageMeta{
		Title:        v2Title(callsign, location, strings.TrimSpace(config.Admin.Name)),
		ShortName:    "UberSDR",
		Description:  v2Description(callsign, location, config),
		CanonicalURL: base + canonicalPath,
		ImageURL:     base + "/images/android-chrome-512x512.png",
	}
	if callsign != "" {
		meta.ShortName = callsign
	}
	meta.JSONLD = buildV2JSONLD(config, meta, location)
	return meta
}

// v2Title names the receiver rather than the software. Callsign first: it is
// what somebody searching for a specific receiver types, and what distinguishes
// this instance from every other one.
func v2Title(callsign, location, name string) string {
	switch {
	case callsign != "" && location != "":
		return fmt.Sprintf("%s WebSDR – %s | UberSDR", callsign, location)
	case callsign != "":
		return callsign + " WebSDR | UberSDR"
	case name != "":
		return name + " | UberSDR"
	default:
		// Nothing configured — v1's title, which at least names the software.
		return "UberSDR – Web SDR Receiver"
	}
}

// v2Description builds the meta description: a factual lead saying which
// receiver this is and where, then the operator's own words if they have set
// any, truncated to the display budget.
//
// admin.name is preferred over admin.description because the config documents
// it as "similar to description without any HTML" — it is the plain-text one.
func v2Description(callsign, location string, config *Config) string {
	var lead string
	switch {
	case callsign != "" && location != "":
		lead = fmt.Sprintf("%s WebSDR in %s", callsign, location)
	case callsign != "":
		lead = callsign + " WebSDR"
	case location != "":
		lead = "UberSDR web SDR receiver in " + location
	default:
		lead = "UberSDR web SDR receiver"
	}

	operator := strings.TrimSpace(config.Admin.Name)
	if operator == "" {
		operator = stripHTMLText(config.Admin.Description)
	}
	if operator == "" {
		operator = "Live HF spectrum, waterfall and audio in your browser. Powered by ka9q-radio."
	}
	if !strings.HasSuffix(operator, ".") && !strings.HasSuffix(operator, "!") && !strings.HasSuffix(operator, "?") {
		operator += "."
	}

	return truncateWords(lead+". "+operator, v2MaxDescription)
}

// buildV2JSONLD emits schema.org structured data. Coordinates are included only
// when the operator has actually set them — 0,0 is the Atlantic, not a receiver.
func buildV2JSONLD(config *Config, meta V2PageMeta, location string) template.JS {
	doc := map[string]any{
		"@context":            "https://schema.org",
		"@type":               "WebApplication",
		"name":                meta.Title,
		"url":                 meta.CanonicalURL,
		"description":         meta.Description,
		"applicationCategory": "MultimediaApplication",
		"operatingSystem":     "Any",
		"browserRequirements": "Requires JavaScript and WebSockets",
		"isAccessibleForFree": true,
	}

	lat, lon := config.Admin.GPS.Lat, config.Admin.GPS.Lon
	if location != "" || lat != 0 || lon != 0 {
		place := map[string]any{"@type": "Place"}
		if location != "" {
			place["name"] = location
		}
		if lat != 0 || lon != 0 {
			place["geo"] = map[string]any{
				"@type":     "GeoCoordinates",
				"latitude":  lat,
				"longitude": lon,
			}
		}
		doc["contentLocation"] = place
	}

	// json.Marshal escapes <, > and & to <, > and &, so no value
	// from the config can close the <script> element it is written into.
	encoded, err := json.Marshal(doc)
	if err != nil {
		log.Printf("Error encoding v2 JSON-LD: %v", err)
		return ""
	}
	return template.JS(encoded)
}

// pageBaseURL returns the scheme://host the visitor actually used, for absolute
// canonical, og:url and og:image values.
//
// Deliberately not admin.public_url: that field defaults to "https://example.com"
// when unset (LoadConfig) and is absent from config.yaml.example, so most
// receivers carry the placeholder. A canonical tag pointing at example.com would
// ask search engines to drop the real page.
//
// X-Forwarded-* is honoured only from a tunnel server or a configured trusted
// proxy, the same rule getClientIP applies: an arbitrary client that could set
// X-Forwarded-Host would otherwise dictate the canonical URL of the page.
func pageBaseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host

	if requestFromTrustedProxy(r) {
		if p := strings.TrimSpace(firstHeaderValue(r.Header.Get("X-Forwarded-Proto"))); p == "http" || p == "https" {
			scheme = p
		}
		if h := strings.TrimSpace(firstHeaderValue(r.Header.Get("X-Forwarded-Host"))); h != "" {
			host = h
		}
	}

	// A Host of "example.com/evil" or with whitespace would break out of the
	// attribute's URL; drop anything that is not a plain host[:port].
	if host == "" || strings.ContainsAny(host, "/\\ \t\"'<>") {
		return ""
	}
	return scheme + "://" + host
}

// requestFromTrustedProxy reports whether the immediate peer is one whose
// X-Forwarded-* headers may be believed.
func requestFromTrustedProxy(r *http.Request) bool {
	if globalConfig == nil {
		return false
	}
	sourceIP := r.RemoteAddr
	if h, _, err := net.SplitHostPort(sourceIP); err == nil {
		sourceIP = h
	}
	return globalConfig.InstanceReporting.IsTunnelServer(sourceIP) ||
		globalConfig.Server.IsTrustedProxy(sourceIP)
}

// firstHeaderValue takes the first entry of a comma-separated header, which is
// the original client-facing value in an X-Forwarded-* chain.
func firstHeaderValue(v string) string {
	if i := strings.IndexByte(v, ','); i >= 0 {
		return v[:i]
	}
	return v
}

// stripHTMLText flattens an HTML fragment to plain text: tags removed, entities
// decoded, whitespace collapsed. For admin.description, which is markup.
func stripHTMLText(s string) string {
	s = htmlTagRE.ReplaceAllString(s, " ")
	s = html.UnescapeString(s)
	return strings.TrimSpace(whitespaceRE.ReplaceAllString(s, " "))
}

// truncateWords shortens s to at most max characters, cutting at a word
// boundary and appending an ellipsis. Counts runes, so a description in a
// non-Latin script is not cut mid-character.
func truncateWords(s string, max int) string {
	runes := []rune(s)
	if len(runes) <= max {
		return s
	}
	// Leave room for the ellipsis.
	cut := string(runes[:max-1])
	if i := strings.LastIndexByte(cut, ' '); i > 0 {
		cut = cut[:i]
	}
	return strings.TrimRight(cut, " ,;:.-") + "…"
}
