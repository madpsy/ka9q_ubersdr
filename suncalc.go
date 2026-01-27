package main

import (
	"math"
	"time"
)

/*
 (c) 2011-2015, Vladimir Agafonkin
 SunCalc is a JavaScript library for calculating sun/moon position and light phases.
 https://github.com/mourner/suncalc

 Go port for ka9q_ubersdr
*/

// Constants
const (
	rad   = math.Pi / 180
	dayMs = 1000 * 60 * 60 * 24
	J1970 = 2440588
	J2000 = 2451545
	e     = rad * 23.4397 // obliquity of the Earth
	J0    = 0.0009
)

// SunTime represents a sun time configuration
type SunTime struct {
	Angle    float64
	RiseName string
	SetName  string
}

// Default sun times configuration
var sunTimes = []SunTime{
	{-0.833, "sunrise", "sunset"},
	{-0.3, "sunriseEnd", "sunsetStart"},
	{-6, "dawn", "dusk"},
	{-12, "nauticalDawn", "nauticalDusk"},
	{-18, "nightEnd", "night"},
	{6, "goldenHourEnd", "goldenHour"},
}

// SunPosition represents the sun's position
type SunPosition struct {
	Azimuth  float64
	Altitude float64
}

// SunTimes represents calculated sun times for a day
type SunTimes struct {
	SolarNoon     time.Time
	Nadir         time.Time
	Sunrise       time.Time
	Sunset        time.Time
	SunriseEnd    time.Time
	SunsetStart   time.Time
	Dawn          time.Time
	Dusk          time.Time
	NauticalDawn  time.Time
	NauticalDusk  time.Time
	NightEnd      time.Time
	Night         time.Time
	GoldenHourEnd time.Time
	GoldenHour    time.Time
}

// MoonPosition represents the moon's position
type MoonPosition struct {
	Azimuth          float64
	Altitude         float64
	Distance         float64
	ParallacticAngle float64
}

// MoonIllumination represents the moon's illumination
type MoonIllumination struct {
	Fraction float64
	Phase    float64
	Angle    float64
}

// MoonTimes represents moon rise/set times
type MoonTimes struct {
	Rise       *time.Time
	Set        *time.Time
	AlwaysUp   bool
	AlwaysDown bool
}

// Date/time conversions
func toJulian(date time.Time) float64 {
	return float64(date.UnixMilli())/dayMs - 0.5 + J1970
}

func fromJulian(j float64) time.Time {
	ms := int64((j + 0.5 - J1970) * dayMs)
	return time.UnixMilli(ms)
}

func toDays(date time.Time) float64 {
	return toJulian(date) - J2000
}

// General calculations for position
func rightAscension(l, b float64) float64 {
	return math.Atan2(math.Sin(l)*math.Cos(e)-math.Tan(b)*math.Sin(e), math.Cos(l))
}

func declination(l, b float64) float64 {
	return math.Asin(math.Sin(b)*math.Cos(e) + math.Cos(b)*math.Sin(e)*math.Sin(l))
}

func azimuth(H, phi, dec float64) float64 {
	return math.Atan2(math.Sin(H), math.Cos(H)*math.Sin(phi)-math.Tan(dec)*math.Cos(phi))
}

func altitude(H, phi, dec float64) float64 {
	return math.Asin(math.Sin(phi)*math.Sin(dec) + math.Cos(phi)*math.Cos(dec)*math.Cos(H))
}

func siderealTime(d, lw float64) float64 {
	return rad*(280.16+360.9856235*d) - lw
}

func astroRefraction(h float64) float64 {
	if h < 0 {
		h = 0
	}
	// formula 16.4 of "Astronomical Algorithms" 2nd edition by Jean Meeus
	return 0.0002967 / math.Tan(h+0.00312536/(h+0.08901179))
}

// General sun calculations
func solarMeanAnomaly(d float64) float64 {
	return rad * (357.5291 + 0.98560028*d)
}

func eclipticLongitude(M float64) float64 {
	C := rad * (1.9148*math.Sin(M) + 0.02*math.Sin(2*M) + 0.0003*math.Sin(3*M))
	P := rad * 102.9372
	return M + C + P + math.Pi
}

type sunCoords struct {
	dec float64
	ra  float64
}

func getSunCoords(d float64) sunCoords {
	M := solarMeanAnomaly(d)
	L := eclipticLongitude(M)
	return sunCoords{
		dec: declination(L, 0),
		ra:  rightAscension(L, 0),
	}
}

// GetPosition calculates sun position for a given date and latitude/longitude
func GetPosition(date time.Time, lat, lng float64) SunPosition {
	lw := rad * -lng
	phi := rad * lat
	d := toDays(date)

	c := getSunCoords(d)
	H := siderealTime(d, lw) - c.ra

	return SunPosition{
		Azimuth:  azimuth(H, phi, c.dec),
		Altitude: altitude(H, phi, c.dec),
	}
}

// Calculations for sun times
func julianCycle(d, lw float64) float64 {
	return math.Round(d - J0 - lw/(2*math.Pi))
}

func approxTransit(Ht, lw, n float64) float64 {
	return J0 + (Ht+lw)/(2*math.Pi) + n
}

func solarTransitJ(ds, M, L float64) float64 {
	return J2000 + ds + 0.0053*math.Sin(M) - 0.0069*math.Sin(2*L)
}

func hourAngle(h, phi, d float64) float64 {
	return math.Acos((math.Sin(h) - math.Sin(phi)*math.Sin(d)) / (math.Cos(phi) * math.Cos(d)))
}

func observerAngle(height float64) float64 {
	return -2.076 * math.Sqrt(height) / 60
}

func getSetJ(h, lw, phi, dec, n, M, L float64) float64 {
	w := hourAngle(h, phi, dec)
	a := approxTransit(w, lw, n)
	return solarTransitJ(a, M, L)
}

// GetTimes calculates sun times for a given date, latitude/longitude, and observer height
func GetTimes(date time.Time, lat, lng float64, height ...float64) SunTimes {
	h := 0.0
	if len(height) > 0 {
		h = height[0]
	}

	lw := rad * -lng
	phi := rad * lat
	dh := observerAngle(h)

	d := toDays(date)
	n := julianCycle(d, lw)
	ds := approxTransit(0, lw, n)

	M := solarMeanAnomaly(ds)
	L := eclipticLongitude(M)
	dec := declination(L, 0)

	Jnoon := solarTransitJ(ds, M, L)

	result := SunTimes{
		SolarNoon: fromJulian(Jnoon),
		Nadir:     fromJulian(Jnoon - 0.5),
	}

	for _, t := range sunTimes {
		h0 := (t.Angle + dh) * rad
		Jset := getSetJ(h0, lw, phi, dec, n, M, L)
		Jrise := Jnoon - (Jset - Jnoon)

		riseTime := fromJulian(Jrise)
		setTime := fromJulian(Jset)

		switch t.RiseName {
		case "sunrise":
			result.Sunrise = riseTime
		case "sunriseEnd":
			result.SunriseEnd = riseTime
		case "dawn":
			result.Dawn = riseTime
		case "nauticalDawn":
			result.NauticalDawn = riseTime
		case "nightEnd":
			result.NightEnd = riseTime
		case "goldenHourEnd":
			result.GoldenHourEnd = riseTime
		}

		switch t.SetName {
		case "sunset":
			result.Sunset = setTime
		case "sunsetStart":
			result.SunsetStart = setTime
		case "dusk":
			result.Dusk = setTime
		case "nauticalDusk":
			result.NauticalDusk = setTime
		case "night":
			result.Night = setTime
		case "goldenHour":
			result.GoldenHour = setTime
		}
	}

	return result
}

// AddTime adds a custom time to the times config
func AddTime(angle float64, riseName, setName string) {
	sunTimes = append(sunTimes, SunTime{angle, riseName, setName})
}

// Moon calculations
type moonCoords struct {
	ra   float64
	dec  float64
	dist float64
}

func getMoonCoords(d float64) moonCoords {
	L := rad * (218.316 + 13.176396*d)
	M := rad * (134.963 + 13.064993*d)
	F := rad * (93.272 + 13.229350*d)

	l := L + rad*6.289*math.Sin(M)
	b := rad * 5.128 * math.Sin(F)
	dt := 385001 - 20905*math.Cos(M)

	return moonCoords{
		ra:   rightAscension(l, b),
		dec:  declination(l, b),
		dist: dt,
	}
}

// GetMoonPosition calculates moon position for a given date and latitude/longitude
func GetMoonPosition(date time.Time, lat, lng float64) MoonPosition {
	lw := rad * -lng
	phi := rad * lat
	d := toDays(date)

	c := getMoonCoords(d)
	H := siderealTime(d, lw) - c.ra
	h := altitude(H, phi, c.dec)
	pa := math.Atan2(math.Sin(H), math.Tan(phi)*math.Cos(c.dec)-math.Sin(c.dec)*math.Cos(H))

	h = h + astroRefraction(h)

	return MoonPosition{
		Azimuth:          azimuth(H, phi, c.dec),
		Altitude:         h,
		Distance:         c.dist,
		ParallacticAngle: pa,
	}
}

// GetMoonIllumination calculates illumination parameters of the moon
func GetMoonIllumination(date time.Time) MoonIllumination {
	d := toDays(date)
	s := getSunCoords(d)
	m := getMoonCoords(d)

	sdist := 149598000.0 // distance from Earth to Sun in km

	phi := math.Acos(math.Sin(s.dec)*math.Sin(m.dec) + math.Cos(s.dec)*math.Cos(m.dec)*math.Cos(s.ra-m.ra))
	inc := math.Atan2(sdist*math.Sin(phi), m.dist-sdist*math.Cos(phi))
	angle := math.Atan2(math.Cos(s.dec)*math.Sin(s.ra-m.ra), math.Sin(s.dec)*math.Cos(m.dec)-
		math.Cos(s.dec)*math.Sin(m.dec)*math.Cos(s.ra-m.ra))

	return MoonIllumination{
		Fraction: (1 + math.Cos(inc)) / 2,
		Phase:    0.5 + 0.5*inc*math.Copysign(1, angle)/math.Pi,
		Angle:    angle,
	}
}

func hoursLater(date time.Time, h float64) time.Time {
	return date.Add(time.Duration(h * float64(time.Hour)))
}

// GetMoonTimes calculates moon rise/set times
func GetMoonTimes(date time.Time, lat, lng float64, inUTC bool) MoonTimes {
	t := date
	if inUTC {
		t = time.Date(date.Year(), date.Month(), date.Day(), 0, 0, 0, 0, time.UTC)
	} else {
		t = time.Date(date.Year(), date.Month(), date.Day(), 0, 0, 0, 0, date.Location())
	}

	hc := 0.133 * rad
	h0 := GetMoonPosition(t, lat, lng).Altitude - hc
	var h1, h2, rise, set, a, b, xe, ye, d, dx, x1, x2 float64
	var roots int
	var hasRise, hasSet bool

	for i := 1; i <= 24; i += 2 {
		h1 = GetMoonPosition(hoursLater(t, float64(i)), lat, lng).Altitude - hc
		h2 = GetMoonPosition(hoursLater(t, float64(i+1)), lat, lng).Altitude - hc

		a = (h0+h2)/2 - h1
		b = (h2 - h0) / 2
		xe = -b / (2 * a)
		ye = (a*xe+b)*xe + h1
		d = b*b - 4*a*h1
		roots = 0

		if d >= 0 {
			dx = math.Sqrt(d) / (math.Abs(a) * 2)
			x1 = xe - dx
			x2 = xe + dx
			if math.Abs(x1) <= 1 {
				roots++
			}
			if math.Abs(x2) <= 1 {
				roots++
			}
			if x1 < -1 {
				x1 = x2
			}
		}

		if roots == 1 {
			if h0 < 0 {
				rise = float64(i) + x1
				hasRise = true
			} else {
				set = float64(i) + x1
				hasSet = true
			}
		} else if roots == 2 {
			if ye < 0 {
				rise = float64(i) + x2
				set = float64(i) + x1
			} else {
				rise = float64(i) + x1
				set = float64(i) + x2
			}
			hasRise = true
			hasSet = true
		}

		if hasRise && hasSet {
			break
		}

		h0 = h2
	}

	result := MoonTimes{}

	if hasRise {
		riseTime := hoursLater(t, rise)
		result.Rise = &riseTime
	}
	if hasSet {
		setTime := hoursLater(t, set)
		result.Set = &setTime
	}

	if !hasRise && !hasSet {
		if ye > 0 {
			result.AlwaysUp = true
		} else {
			result.AlwaysDown = true
		}
	}

	return result
}
