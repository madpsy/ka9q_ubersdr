package main

import (
	"sync"
	"testing"
	"time"
)

// Exercises the cache under concurrent readers, mirroring hundreds of viewers
// polling the same small set of spotted callsigns. globalQRZService is nil here,
// so Get short-circuits and no fills are scheduled; this validates the read path
// and the store/evict path independently.
func TestDXLocCacheConcurrentReaders(t *testing.T) {
	c := newDXLocationCache()

	calls := []string{"G4ABC", "W1AW", "VK3XYZ", "JA1ZZZ", "EA5AAA"}
	for i, call := range calls {
		c.store(call, dxLocEntry{lat: float64(i), lon: float64(i), have: true, expires: time.Now().Add(time.Hour)})
	}

	var wg sync.WaitGroup
	for i := 0; i < 300; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for n := 0; n < 200; n++ {
				for _, call := range calls {
					c.Get(call)
				}
			}
		}()
	}
	// Concurrent writers, as background fills would do.
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for n := 0; n < 500; n++ {
				c.store(calls[n%len(calls)], dxLocEntry{have: false, expires: time.Now().Add(time.Minute)})
			}
		}(i)
	}
	wg.Wait()
}

// Verifies the map stays bounded when far more callsigns are resolved than the cap.
func TestDXLocCacheEviction(t *testing.T) {
	c := newDXLocationCache()
	for i := 0; i < dxLocMaxEntries*3; i++ {
		c.store(string(rune('A'+i%26))+string(rune('0'+i/26%10))+"-"+time.Duration(i).String(),
			dxLocEntry{have: true, expires: time.Now().Add(time.Hour)})
	}
	if got := c.Size(); got > dxLocMaxEntries {
		t.Fatalf("cache exceeded cap: got %d, want <= %d", got, dxLocMaxEntries)
	}
}

// Verifies expired entries are not served.
func TestDXLocCacheExpiry(t *testing.T) {
	c := newDXLocationCache()
	c.store("G4ABC", dxLocEntry{lat: 51, lon: -1, have: true, expires: time.Now().Add(-time.Second)})
	if _, _, ok := c.Get("G4ABC"); ok {
		t.Fatal("expired entry was served")
	}
}
