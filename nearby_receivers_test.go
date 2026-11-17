package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func nearbyDoc(entries ...string) string {
	return `{"count":` + fmt.Sprint(len(entries)) + `,"instances":[` + strings.Join(entries, ",") + `]}`
}

func nearbyEntry(id string, lat, lon float64, url string) string {
	return fmt.Sprintf(`{"id":%q,"callsign":"CALL-%s","name":"Name %s","location":"Somewhere","latitude":%v,"longitude":%v,"country_code":"GB","public_url":%q,"max_clients":10,"available_clients":4}`,
		id, id, id, lat, lon, url)
}

// testNearby points a fetcher at srv with a short client timeout.
func testNearby(srv *httptest.Server, selfID func() string, origin func() (float64, float64, bool)) *NearbyReceivers {
	n := NewNearbyReceivers("unused", 443, selfID, origin)
	n.url = srv.URL
	n.client = srv.Client()
	n.client.Timeout = 300 * time.Millisecond
	return n
}

func TestParseNearbyReceiversFiltersBadEntries(t *testing.T) {
	doc := nearbyDoc(
		nearbyEntry("a", 51.5, -0.1, "https://a.example/"),
		nearbyEntry("zero", 0, 0, "https://z.example/"),
		nearbyEntry("lat", 95, 0, "https://l.example/"),
		nearbyEntry("js", 10, 10, "javascript:alert(1)"),
		nearbyEntry("rel", 10, 10, "/relative"),
		nearbyEntry("cred", 10, 10, "https://u:p@c.example/"),
		nearbyEntry("", 10, 10, "https://noid.example/"),
		nearbyEntry("a", 52, 1, "https://dup.example/"),
		nearbyEntry("b", -33.9, 151.2, "http://b.example:8080/"),
	)
	got, err := parseNearbyReceivers(strings.NewReader(doc))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != "a" || got[1].ID != "b" {
		t.Fatalf("got %+v", got)
	}
	if got[0].CountryCode != "gb" || got[0].PublicURL != "https://a.example/" {
		t.Fatalf("not normalised: %+v", got[0])
	}
}

func TestParseNearbyReceiversSizeCap(t *testing.T) {
	big := `{"instances":[],"pad":"` + strings.Repeat("x", nearbyMaxBytes) + `"}`
	if _, err := parseNearbyReceivers(strings.NewReader(big)); err != errNearbyTooLarge {
		t.Fatalf("want size error, got %v", err)
	}
	// Just under the cap is fine.
	ok := `{"instances":[],"pad":"` + strings.Repeat("x", nearbyMaxBytes-40) + `"}`
	if _, err := parseNearbyReceivers(strings.NewReader(ok)); err != nil {
		t.Fatalf("under cap: %v", err)
	}
}

func TestParseNearbyReceiversRejectsGarbage(t *testing.T) {
	for _, body := range []string{"", "not json", `{"count":0}`, `<html>`} {
		if _, err := parseNearbyReceivers(strings.NewReader(body)); err == nil {
			t.Errorf("%q: want error", body)
		}
	}
}

func TestParseNearbyReceiversTruncatesText(t *testing.T) {
	long := strings.Repeat("é", 300)
	doc := `{"instances":[{"id":"a","callsign":"` + long + `","name":"` + long + `","latitude":1,"longitude":1,"public_url":"https://a.example/"}]}`
	got, err := parseNearbyReceivers(strings.NewReader(doc))
	if err != nil || len(got) != 1 {
		t.Fatal(err, got)
	}
	if n := len([]rune(got[0].Callsign)); n != 24 {
		t.Errorf("callsign %d runes", n)
	}
	if n := len([]rune(got[0].Name)); n != 100 {
		t.Errorf("name %d runes", n)
	}
}

// A failed or oversized fetch keeps the last good list.
func TestNearbyKeepsPreviousOnFailure(t *testing.T) {
	var mode atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch mode.Load() {
		case 0:
			fmt.Fprint(w, nearbyDoc(nearbyEntry("a", 51, 0, "https://a.example/")))
		case 1:
			http.Error(w, "down", http.StatusBadGateway)
		case 2:
			fmt.Fprint(w, `{"instances":[],"pad":"`+strings.Repeat("x", nearbyMaxBytes)+`"}`)
		case 3:
			time.Sleep(2 * time.Second) // longer than the client timeout
		}
	}))
	defer srv.Close()
	n := testNearby(srv, nil, nil)

	if err := n.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	for m := int32(1); m <= 3; m++ {
		mode.Store(m)
		start := time.Now()
		if err := n.refresh(context.Background()); err == nil {
			t.Fatalf("mode %d: want error", m)
		}
		if m == 3 && time.Since(start) > time.Second {
			t.Fatalf("hung fetch took %v", time.Since(start))
		}
		list, _ := n.Snapshot()
		if len(list) != 1 || list[0].ID != "a" {
			t.Fatalf("mode %d: previous list lost: %+v", m, list)
		}
	}
}

func TestNearbySnapshotExcludesSelfAndExpires(t *testing.T) {
	self := ""
	n := NewNearbyReceivers("unused", 443, func() string { return self }, nil)

	if list, at := n.Snapshot(); len(list) != 0 || !at.IsZero() || list == nil {
		t.Fatalf("before first fetch: %v %v", list, at)
	}

	n.list = []NearbyReceiver{{ID: "me"}, {ID: "other"}}
	n.fetchedAt = time.Now()
	if list, _ := n.Snapshot(); len(list) != 2 {
		t.Fatalf("self unknown: %v", list)
	}
	self = "me"
	if list, _ := n.Snapshot(); len(list) != 1 || list[0].ID != "other" {
		t.Fatalf("self known: %v", list)
	}

	n.fetchedAt = time.Now().Add(-nearbyMaxAge - time.Minute)
	if list, _ := n.Snapshot(); len(list) != 0 {
		t.Fatalf("stale list served: %v", list)
	}
}

func TestNearbySortsByDistance(t *testing.T) {
	var ua atomic.Value
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ua.Store(r.Header.Get("User-Agent"))
		fmt.Fprint(w, nearbyDoc(
			nearbyEntry("sydney", -33.87, 151.21, "https://s.example/"),
			nearbyEntry("paris", 48.86, 2.35, "https://p.example/"),
			nearbyEntry("nyc", 40.71, -74.0, "https://n.example/"),
		))
	}))
	defer srv.Close()

	// London.
	n := testNearby(srv, nil, func() (float64, float64, bool) { return 51.5, -0.12, true })
	if err := n.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	list, _ := n.Snapshot()
	var ids []string
	for _, r := range list {
		ids = append(ids, r.ID)
	}
	if strings.Join(ids, ",") != "paris,nyc,sydney" {
		t.Fatalf("order %v", ids)
	}
	if got, _ := ua.Load().(string); !strings.HasPrefix(got, "UberSDR/"+Version+" ") {
		t.Fatalf("User-Agent %q", got)
	}
	if d := *list[0].DistanceKm; d < 330 || d > 360 {
		t.Fatalf("London-Paris %v km", d)
	}

	// No position: collector order, no distances.
	n2 := testNearby(srv, nil, func() (float64, float64, bool) { return 0, 0, false })
	if err := n2.refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	list, _ = n2.Snapshot()
	if list[0].ID != "sydney" || list[0].DistanceKm != nil {
		t.Fatalf("unsorted case: %+v", list[0])
	}
}

func TestNearbyServeHTTP(t *testing.T) {
	n := NewNearbyReceivers("unused", 443, nil, nil)

	rec := httptest.NewRecorder()
	n.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/nearby-receivers", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"receivers":[]`) {
		t.Fatalf("empty: %d %s", rec.Code, rec.Body.String())
	}

	n.list = []NearbyReceiver{{ID: "x", Lat: 1, Lon: 2, PublicURL: "https://x.example/"}}
	n.fetchedAt = time.Now()
	rec = httptest.NewRecorder()
	n.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/nearby-receivers", nil))
	var body struct {
		Receivers []NearbyReceiver `json:"receivers"`
		FetchedAt string           `json:"fetched_at"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Receivers) != 1 || body.FetchedAt == "" {
		t.Fatalf("%+v", body)
	}

	rec = httptest.NewRecorder()
	n.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/nearby-receivers", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST: %d", rec.Code)
	}
}

// Run against a collector that never answers returns promptly on cancel.
func TestNearbyRunStopsOnCancel(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer srv.Close()
	n := testNearby(srv, nil, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { n.Run(ctx); close(done) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not stop")
	}
}
