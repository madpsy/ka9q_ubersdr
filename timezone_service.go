package main

import (
	"fmt"
	"log"
	"os"

	"github.com/paulmach/orb"
	"github.com/paulmach/orb/geojson"
)

// TimezoneService resolves a coordinate to an IANA timezone name (e.g.
// "Europe/London") by point-in-polygon test against the timezone-boundary-builder
// dataset.
//
// The name is all the caller needs: the browser's Intl.DateTimeFormat and Go's
// time.LoadLocation both hold the tz database, so DST and historical rule changes
// are handled for free.  Storing a UTC offset here instead would throw that away.
//
// Only land is covered — see natural_earth/timezones.geojson.  A point at sea has
// no timezone and the lookup returns "".
type TimezoneService struct {
	zones []*TimezoneZone

	// cellIndex[y*neCellsX+x] lists the indices into zones of every zone with a
	// polygon overlapping that 1°×1° cell.  Same geometry as the Natural Earth
	// index; built once at load time and never mutated, so it needs no locking.
	cellIndex [][]int32

	loaded bool
}

// TimezoneZone is one zone's geometry plus its IANA identifier.
type TimezoneZone struct {
	TZID     string
	prepared preparedGeometry
}

var globalTimezones *TimezoneService

// InitTimezoneService loads the timezone boundary GeoJSON.  The shipped file is a
// simplified build — see tools/simplify_timezones.py for how it is produced and
// what accuracy it gives.
func InitTimezoneService(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("timezones: cannot read %s: %w", path, err)
	}

	fc, err := geojson.UnmarshalFeatureCollection(data)
	if err != nil {
		return fmt.Errorf("timezones: cannot parse GeoJSON: %w", err)
	}

	svc := &TimezoneService{}
	for _, feat := range fc.Features {
		if feat.Geometry == nil {
			continue
		}
		tzid := propString(feat.Properties, "tzid")
		if tzid == "" {
			continue
		}
		svc.zones = append(svc.zones, &TimezoneZone{
			TZID:     tzid,
			prepared: prepareGeometry(feat.Geometry),
		})
	}

	svc.buildCellIndex()
	svc.loaded = true
	globalTimezones = svc
	log.Printf("Timezones: loaded %d zones from %s", len(svc.zones), path)
	return nil
}

// buildCellIndex mirrors NaturalEarthService.buildCellIndex — same cell grid, so
// the two indexes are directly comparable.
func (svc *TimezoneService) buildCellIndex() {
	svc.cellIndex = make([][]int32, neCellsX*neCellsY)

	for zi, z := range svc.zones {
		seen := make(map[int]struct{})
		for _, pp := range z.prepared.polys {
			x0, y0, x1, y1 := cellRange(pp.bound)
			for y := y0; y <= y1; y++ {
				for x := x0; x <= x1; x++ {
					idx := y*neCellsX + x
					if _, dup := seen[idx]; dup {
						continue
					}
					seen[idx] = struct{}{}
					svc.cellIndex[idx] = append(svc.cellIndex[idx], int32(zi))
				}
			}
		}
	}
}

// lookup returns the IANA timezone name containing the point, or "" if the point
// is at sea or outside every zone.
func (svc *TimezoneService) lookup(lat, lon float64) string {
	if !svc.loaded || lat < -90 || lat > 90 || lon < -180 || lon > 180 {
		return ""
	}

	pt := orb.Point{lon, lat}
	ptBound := orb.Bound{Min: pt, Max: pt}

	x0, y0, x1, y1 := cellRange(ptBound)
	for y := y0; y <= y1; y++ {
		row := y * neCellsX
		for x := x0; x <= x1; x++ {
			for _, zi := range svc.cellIndex[row+x] {
				z := svc.zones[zi]
				if !boundingBoxOverlaps(z.prepared.bound, ptBound) {
					continue
				}
				if pointInGeometry(&z.prepared, pt) {
					return z.TZID
				}
			}
		}
	}
	return ""
}

// TimezoneForLatLon resolves a coordinate to an IANA timezone name using the
// global service, or "" when the dataset is not loaded or the point is at sea.
func TimezoneForLatLon(lat, lon float64) string {
	if globalTimezones == nil {
		return ""
	}
	return globalTimezones.lookup(lat, lon)
}

