package main

import (
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// WSPRNet constants
const (
	WSPRServerHostname = "wsprnet.org"
	WSPRServerPort     = 80
	WSPRMaxQueueSize   = 10000
	WSPRMaxRetries     = 3
	WSPRWorkerThreads  = 5
)

// WSPR mode codes from http://www.wsprnet.org/drupal/node/8983
const (
	WSPRModeWSPR      = 2
	WSPRModeFST4W120  = 3
	WSPRModeFST4W300  = 5
	WSPRModeFST4W900  = 16
	WSPRModeFST4W1800 = 30
)

// WSPRReport represents a single WSPR spot report
type WSPRReport struct {
	Callsign      string
	Locator       string
	SNR           int
	Frequency     uint64 // Transmitter frequency in Hz
	ReceiverFreq  uint64 // Receiver frequency in Hz
	DT            float32
	Drift         int
	DBm           int
	EpochTime     time.Time
	Mode          string
	RetryCount    int
	NextRetryTime time.Time
}

// WSPRNet handles WSPRNet spot reporting
type WSPRNet struct {
	// Configuration
	receiverCallsign string
	receiverLocator  string
	programName      string
	programVersion   string

	// HTTP client for connection reuse
	httpClient *http.Client

	// Report queues
	reportQueue []WSPRReport
	queueMutex  sync.Mutex

	retryQueue []WSPRReport
	retryMutex sync.Mutex

	// Statistics
	countSendsOK      int
	countSendsErrored int
	countRetries      int
	statsMutex        sync.Mutex

	// Threading
	running bool
	stopCh  chan struct{}
	wg      sync.WaitGroup
}

// NewWSPRNet creates a new WSPRNet instance
func NewWSPRNet(callsign, locator, programName, programVersion string) (*WSPRNet, error) {
	if callsign == "" || locator == "" || programName == "" {
		return nil, fmt.Errorf("callsign, locator, and program name are required")
	}

	// Create HTTP transport with connection pooling and compression
	transport := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 10,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  false, // Enable compression
	}

	wspr := &WSPRNet{
		receiverCallsign: callsign,
		receiverLocator:  locator,
		programName:      programName,
		programVersion:   programVersion,
		httpClient: &http.Client{
			Timeout:   3 * time.Second,
			Transport: transport,
		},
		reportQueue: make([]WSPRReport, 0, WSPRMaxQueueSize),
		retryQueue:  make([]WSPRReport, 0, WSPRMaxQueueSize),
		stopCh:      make(chan struct{}),
	}

	return wspr, nil
}

// Connect starts the WSPRNet processing threads
func (w *WSPRNet) Connect() error {
	w.running = true

	// Start worker threads for parallel HTTP requests
	for i := 0; i < WSPRWorkerThreads; i++ {
		w.wg.Add(1)
		go w.workerThread()
	}

	log.Printf("WSPRNet: Started %d worker threads for parallel uploads", WSPRWorkerThreads)

	return nil
}

// Submit adds a WSPR report to the queue
func (w *WSPRNet) Submit(decode *DecodeInfo) error {
	if !w.running {
		return fmt.Errorf("WSPRNet not running")
	}

	// Only accept WSPR reports
	if decode.Mode != "WSPR" {
		return nil
	}

	if !decode.HasCallsign || !decode.HasLocator {
		return nil
	}

	// Filter out hashed callsigns
	if decode.Callsign == "<...>" {
		return nil
	}

	report := WSPRReport{
		Callsign:     decode.Callsign,
		Locator:      decode.Locator,
		SNR:          decode.SNR,
		Frequency:    decode.TxFrequency,
		ReceiverFreq: decode.Frequency,
		DT:           decode.DT,
		Drift:        decode.Drift,
		DBm:          decode.DBm,
		EpochTime:    decode.Timestamp,
		Mode:         decode.Mode,
	}

	w.queueMutex.Lock()
	defer w.queueMutex.Unlock()

	if len(w.reportQueue) >= WSPRMaxQueueSize {
		return fmt.Errorf("WSPRNet queue full")
	}

	w.reportQueue = append(w.reportQueue, report)

	return nil
}

// workerThread processes reports from queue in parallel
func (w *WSPRNet) workerThread() {
	defer w.wg.Done()

	for w.running {
		var report WSPRReport
		haveReport := false

		// Try to get a report from the main queue
		w.queueMutex.Lock()
		if len(w.reportQueue) > 0 {
			report = w.reportQueue[0]
			w.reportQueue = w.reportQueue[1:]
			haveReport = true
		}
		w.queueMutex.Unlock()

		// If no new report, check retry queue
		if !haveReport {
			currentTime := time.Now()
			w.retryMutex.Lock()
			if len(w.retryQueue) > 0 && w.retryQueue[0].NextRetryTime.Before(currentTime) {
				report = w.retryQueue[0]
				w.retryQueue = w.retryQueue[1:]
				haveReport = true
			}
			w.retryMutex.Unlock()
		}

		// If we have a report, send it
		if haveReport {
			success := w.sendReport(&report)

			w.statsMutex.Lock()
			if success {
				w.countSendsOK++

				// Record that we sent data to WSPRNet
				RecordWSPRNetSend()
			} else {
				// Check if we should retry
				if report.RetryCount < WSPRMaxRetries {
					retryDelays := []int{5, 15, 60}
					delayIndex := report.RetryCount
					if delayIndex >= len(retryDelays) {
						delayIndex = len(retryDelays) - 1
					}
					delay := retryDelays[delayIndex]
					report.RetryCount++
					report.NextRetryTime = time.Now().Add(time.Duration(delay) * time.Second)

					w.retryMutex.Lock()
					if len(w.retryQueue) < WSPRMaxQueueSize {
						w.retryQueue = append(w.retryQueue, report)
						w.countRetries++
					}
					w.retryMutex.Unlock()

					log.Printf("WSPRNet: Failed to send report for %s, will retry in %ds (attempt %d/%d)",
						report.Callsign, delay, report.RetryCount, WSPRMaxRetries)
				} else {
					w.countSendsErrored++
					log.Printf("WSPRNet: Failed to send report for %s after %d retries, giving up",
						report.Callsign, WSPRMaxRetries)
				}
			}
			w.statsMutex.Unlock()
		} else {
			// No reports available, sleep briefly
			select {
			case <-time.After(100 * time.Millisecond):
			case <-w.stopCh:
				return
			}
		}
	}
}

// sendReport sends a single report to WSPRNet
func (w *WSPRNet) sendReport(report *WSPRReport) bool {
	// Build POST data
	postData := w.buildPostData(report)

	// Build request using shared HTTP client
	req, err := http.NewRequest("POST", fmt.Sprintf("http://%s/post?", WSPRServerHostname), strings.NewReader(postData))
	if err != nil {
		log.Printf("WSPRNet: Failed to create request: %v", err)
		return false
	}

	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Connection", "Keep-Alive")
	req.Header.Set("Accept-Encoding", "gzip, deflate")
	req.Header.Set("Host", WSPRServerHostname)
	req.Header.Set("Accept-Language", "en-US,*")
	req.Header.Set("User-Agent", "Mozilla/5.0")

	// Send request using shared client for connection reuse
	resp, err := w.httpClient.Do(req)
	if err != nil {
		log.Printf("WSPRNet: Failed to send request: %v", err)
		return false
	}
	defer resp.Body.Close()

	// Check response
	if resp.StatusCode == 200 {
		return true
	}

	log.Printf("WSPRNet: Unexpected response: %d %s", resp.StatusCode, resp.Status)
	return false
}

// buildPostData builds the POST data for WSPRNet submission
func (w *WSPRNet) buildPostData(report *WSPRReport) string {
	// Convert epoch time to UTC datetime
	tm := report.EpochTime.UTC()
	date := tm.Format("060102")
	timeStr := tm.Format("1504")

	// Get mode code
	modeCode := w.getModeCode(report.Mode)

	// Build parameters
	params := url.Values{}
	params.Set("function", "wspr")
	params.Set("rcall", w.receiverCallsign)
	params.Set("rgrid", w.receiverLocator)
	params.Set("rqrg", fmt.Sprintf("%.6f", float64(report.ReceiverFreq)/1000000.0))
	params.Set("date", date)
	params.Set("time", timeStr)
	params.Set("sig", fmt.Sprintf("%d", report.SNR))
	params.Set("dt", fmt.Sprintf("%.2f", report.DT))
	params.Set("drift", fmt.Sprintf("%d", report.Drift))
	params.Set("tcall", report.Callsign)
	params.Set("tgrid", report.Locator)
	params.Set("tqrg", fmt.Sprintf("%.6f", float64(report.Frequency)/1000000.0))
	params.Set("dbm", fmt.Sprintf("%d", report.DBm))
	// Only include version if it's not empty
	if w.programVersion != "" {
		params.Set("version", fmt.Sprintf("%s %s", w.programName, w.programVersion))
	} else {
		params.Set("version", w.programName)
	}
	params.Set("mode", fmt.Sprintf("%d", modeCode))

	return params.Encode()
}

// getModeCode returns the mode code for a given mode name
func (w *WSPRNet) getModeCode(mode string) int {
	switch mode {
	case "WSPR":
		return WSPRModeWSPR
	case "FST4W-120":
		return WSPRModeFST4W120
	case "FST4W-300":
		return WSPRModeFST4W300
	case "FST4W-900":
		return WSPRModeFST4W900
	case "FST4W-1800":
		return WSPRModeFST4W1800
	default:
		return WSPRModeWSPR
	}
}

// Stop stops the WSPRNet processing
func (w *WSPRNet) Stop() {
	if !w.running {
		return
	}

	log.Println("WSPRNet: Stopping...")

	w.running = false
	close(w.stopCh)

	// Wait for all worker threads to finish
	w.wg.Wait()

	// Close idle connections in the HTTP client pool
	w.httpClient.CloseIdleConnections()

	// Print statistics
	w.statsMutex.Lock()
	log.Printf("WSPRNet: Successful reports: %d, Failed reports: %d, Retries: %d",
		w.countSendsOK, w.countSendsErrored, w.countRetries)
	w.statsMutex.Unlock()

	log.Println("WSPRNet: Stopped")
}
