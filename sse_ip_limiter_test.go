package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// The accounting has to hold under the one thing that motivated displacement: a
// client reconnecting faster than the server learns its previous stream is gone.
// Each connection's slot has to be attributable to *that* connection, so a
// displaced handler unwinding later cannot free the slot its replacement took.

func TestSSEIPLimiterDisplacesOldest(t *testing.T) {
	l := NewSSEIPLimiter(2)

	evicted := make([]int, 0, 2)
	releases := make([]func(), 0, 3)
	for i := 0; i < 2; i++ {
		n := i
		release, ok := l.Acquire("1.2.3.4", func() { evicted = append(evicted, n) })
		if !ok {
			t.Fatalf("connection %d refused below the cap", n)
		}
		releases = append(releases, release)
	}

	if got := l.Count("1.2.3.4"); got != 2 {
		t.Fatalf("count = %d, want 2", got)
	}

	// The third displaces the first, and does not push the count over the cap.
	release3, ok := l.Acquire("1.2.3.4", func() {})
	if !ok {
		t.Fatal("third connection refused; it should have displaced the oldest")
	}
	releases = append(releases, release3)

	if len(evicted) != 1 || evicted[0] != 0 {
		t.Fatalf("evicted = %v, want [0] (the oldest)", evicted)
	}
	if got := l.Count("1.2.3.4"); got != 2 {
		t.Fatalf("count after displacement = %d, want 2", got)
	}

	// The displaced handler unwinds afterwards. Its slot is already gone, so
	// releasing must not free one of the two live connections' slots.
	releases[0]()
	if got := l.Count("1.2.3.4"); got != 2 {
		t.Fatalf("count after the displaced handler released = %d, want 2", got)
	}

	releases[1]()
	releases[2]()
	if got := l.Count("1.2.3.4"); got != 0 {
		t.Fatalf("count after everything released = %d, want 0", got)
	}
}

func TestSSEIPLimiterRejects(t *testing.T) {
	// A caller that opts out of displacement is refused at the cap...
	l := NewSSEIPLimiter(1)
	if _, ok := l.Acquire("1.2.3.4", nil); !ok {
		t.Fatal("first connection refused")
	}
	if _, ok := l.Acquire("1.2.3.4", func() {}); ok {
		t.Fatal("accepted a connection that would have to displace one that opted out")
	}
	if _, ok := l.Acquire("1.2.3.4", nil); ok {
		t.Fatal("accepted a second connection over a cap of 1")
	}

	// ...as is everyone when the cap is zero, with nothing to displace.
	zero := NewSSEIPLimiter(0)
	if _, ok := zero.Acquire("1.2.3.4", func() {}); ok {
		t.Fatal("accepted a connection against a cap of zero")
	}

	// Other IPs are unaffected by a full one.
	if _, ok := l.Acquire("5.6.7.8", nil); !ok {
		t.Fatal("a second IP was refused because the first was full")
	}
}

func TestSSEIPLimiterReleaseIsIdempotent(t *testing.T) {
	l := NewSSEIPLimiter(2)
	release, _ := l.Acquire("1.2.3.4", nil)
	l.Acquire("1.2.3.4", nil) //nolint:errcheck // second slot, held for the duration

	// Handlers call release from both a context watcher and a defer.
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); release() }()
	}
	wg.Wait()

	if got := l.Count("1.2.3.4"); got != 1 {
		t.Fatalf("count = %d after four calls to one release, want 1", got)
	}
}

// End to end through a real handler: the reconnect that used to be answered
// with 429 now succeeds, and the stream it replaced is the one that ends.
// Any of the public feeds would do — DX cluster has the cheapest hub to build.
func TestPublicSSEStreamDisplacesOnReconnect(t *testing.T) {
	hub := NewDXClusterSSEHub()
	hub.SetEnabled(true)

	srv := httptest.NewServer(HandlePublicDXClusterStream(hub, NewSSEIPLimiter(1), &ServerConfig{}))
	defer srv.Close()

	open := func() *http.Response {
		t.Helper()
		resp, err := http.Get(srv.URL)
		if err != nil {
			t.Fatalf("GET: %v", err)
		}
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			t.Fatalf("status = %d (%s), want 200", resp.StatusCode, body)
		}
		// The handler's opening comment — proof the stream is live and its slot
		// taken before the next connection asks for one.
		buf := make([]byte, 1)
		if _, err := resp.Body.Read(buf); err != nil {
			t.Fatalf("reading the stream's first byte: %v", err)
		}
		return resp
	}

	first := open()
	defer first.Body.Close()

	// Same IP, cap of one: this is the reconnect, and it must be admitted.
	second := open()
	defer second.Body.Close()

	// The first stream must now end on its own — the handler returning is what
	// frees the slot the second one is already holding.
	ended := make(chan error, 1)
	go func() {
		_, err := io.Copy(io.Discard, first.Body)
		ended <- err
	}()

	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("the displaced stream was still running 5s after being replaced")
	}
}

// The write deadline the spectrum stream depends on has to survive the logging
// middleware. http.ResponseController reaches the connection by unwrapping, so
// a wrapper without Unwrap turns SetWriteDeadline into a silent no-op — no
// error at the call site, just no deadline, and the leak it guards against
// comes back.
func TestResponseWriterWrapperSupportsWriteDeadline(t *testing.T) {
	result := make(chan error, 1)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wrapped := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
		result <- http.NewResponseController(wrapped).SetWriteDeadline(time.Now().Add(time.Minute))
	}))
	defer srv.Close()

	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	resp.Body.Close()

	if err := <-result; err != nil {
		t.Fatalf("SetWriteDeadline through the logging wrapper: %v", err)
	}
}
