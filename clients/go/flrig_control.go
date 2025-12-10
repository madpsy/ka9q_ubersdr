package main

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// FlrigClient represents an XML-RPC client for flrig radio control
type FlrigClient struct {
	host      string
	port      int
	vfo       string // "A" or "B"
	client    *http.Client
	connected bool
	mu        sync.RWMutex

	// Cached values for quick access (updated by polling)
	cachedFrequency int
	cachedMode      string
	cachedPTT       bool
	cacheMu         sync.RWMutex
	firstPoll       bool // Track if this is the first poll after connection

	// Callbacks
	frequencyCallback func(int)
	modeCallback      func(string)
	pttCallback       func(bool)
	errorCallback     func(string)

	// Debug
	pollCount int
}

// NewFlrigClient creates a new flrig XML-RPC client
func NewFlrigClient(host string, port int, vfo string) *FlrigClient {
	return &FlrigClient{
		host: host,
		port: port,
		vfo:  vfo,
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
		connected: false,
		firstPoll: true, // Mark that we haven't polled yet
	}
}

// Connect establishes connection to flrig server
func (f *FlrigClient) Connect() error {
	f.mu.Lock()
	defer f.mu.Unlock()

	// Test connection by listing methods
	_, err := f.callMethod("system.listMethods", []interface{}{})
	if err != nil {
		return fmt.Errorf("failed to connect to flrig at %s:%d: %w", f.host, f.port, err)
	}

	f.connected = true
	return nil
}

// Disconnect closes the connection
func (f *FlrigClient) Disconnect() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.connected = false
}

// IsConnected returns connection status
func (f *FlrigClient) IsConnected() bool {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.connected
}

// GetFrequency returns the current frequency in Hz
func (f *FlrigClient) GetFrequency() (int, error) {
	f.mu.RLock()
	if !f.connected {
		f.mu.RUnlock()
		return 0, fmt.Errorf("not connected to flrig")
	}
	f.mu.RUnlock()

	result, err := f.callMethod("rig.get_vfo", []interface{}{})
	if err != nil {
		// Don't mark as disconnected - let connection errors be handled elsewhere
		return 0, err
	}

	// Handle different response types - flrig can return string or number
	var freq float64
	switch v := result.(type) {
	case string:
		freq, err = strconv.ParseFloat(v, 64)
		if err != nil {
			return 0, fmt.Errorf("failed to parse frequency string: %w", err)
		}
	case float64:
		freq = v
	case int:
		freq = float64(v)
	case int64:
		freq = float64(v)
	default:
		return 0, fmt.Errorf("unexpected response type for frequency: %T", result)
	}

	return int(freq), nil
}

// SetFrequency sets the frequency in Hz
func (f *FlrigClient) SetFrequency(freqHz int) error {
	f.mu.RLock()
	if !f.connected {
		f.mu.RUnlock()
		return fmt.Errorf("not connected to flrig")
	}
	f.mu.RUnlock()

	_, err := f.callMethod("rig.set_vfo", []interface{}{float64(freqHz)})
	if err != nil {
		// Don't mark as disconnected - let connection errors be handled elsewhere
		return err
	}

	return nil
}

// GetMode returns the current mode
func (f *FlrigClient) GetMode() (string, error) {
	f.mu.RLock()
	if !f.connected {
		f.mu.RUnlock()
		return "", fmt.Errorf("not connected to flrig")
	}
	f.mu.RUnlock()

	result, err := f.callMethod("rig.get_mode", []interface{}{})
	if err != nil {
		// Don't mark as disconnected - let connection errors be handled elsewhere
		return "", err
	}

	mode, ok := result.(string)
	if !ok {
		return "", fmt.Errorf("unexpected response type for mode")
	}

	if mode == "" {
		return "Unknown", nil
	}

	return mode, nil
}

// SetMode sets the mode (USB, LSB, CW, AM, FM, etc.)
func (f *FlrigClient) SetMode(mode string) error {
	f.mu.RLock()
	if !f.connected {
		f.mu.RUnlock()
		return fmt.Errorf("not connected to flrig")
	}
	f.mu.RUnlock()

	_, err := f.callMethod("rig.set_mode", []interface{}{mode})
	if err != nil {
		// Don't mark as disconnected - let connection errors be handled elsewhere
		return err
	}

	return nil
}

// GetPTT returns the PTT (Push-To-Talk) status
func (f *FlrigClient) GetPTT() (bool, error) {
	f.mu.RLock()
	if !f.connected {
		f.mu.RUnlock()
		return false, fmt.Errorf("not connected to flrig")
	}
	f.mu.RUnlock()

	result, err := f.callMethod("rig.get_ptt", []interface{}{})
	if err != nil {
		// Don't mark as disconnected - let connection errors be handled elsewhere
		return false, err
	}

	// Result can be bool or string from our parser
	switch v := result.(type) {
	case bool:
		return v, nil
	case string:
		// Parse string representation - can be "0"/"1" or "true"/"false"
		return v == "1" || v == "true", nil
	default:
		return false, fmt.Errorf("unexpected response type for PTT: %T", result)
	}
}

// SetPTT sets the PTT state
func (f *FlrigClient) SetPTT(state bool) error {
	f.mu.RLock()
	if !f.connected {
		f.mu.RUnlock()
		return fmt.Errorf("not connected to flrig")
	}
	f.mu.RUnlock()

	pttValue := 0
	if state {
		pttValue = 1
	}

	_, err := f.callMethod("rig.set_ptt", []interface{}{pttValue})
	if err != nil {
		// Don't mark as disconnected - let connection errors be handled elsewhere
		return err
	}

	return nil
}

// SetVFO switches to the specified VFO (A or B)
func (f *FlrigClient) SetVFO(vfo string) error {
	f.mu.RLock()
	if !f.connected {
		f.mu.RUnlock()
		return fmt.Errorf("not connected to flrig")
	}
	f.mu.RUnlock()

	_, err := f.callMethod("rig.set_AB", []interface{}{vfo})
	if err != nil {
		// Don't mark as disconnected - let connection errors be handled elsewhere
		return err
	}

	f.mu.Lock()
	f.vfo = vfo
	f.mu.Unlock()

	return nil
}

// GetVFO returns the current VFO
func (f *FlrigClient) GetVFO() string {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.vfo
}

// Poll updates all cached values and triggers callbacks
func (f *FlrigClient) Poll() {
	// Get frequency
	freq, err := f.GetFrequency()
	if err != nil {
		log.Printf("flrig: Poll() GetFrequency error: %v", err)
		if f.errorCallback != nil {
			f.errorCallback(err.Error())
		}
		return
	}

	// Get mode
	mode, err := f.GetMode()
	if err != nil {
		log.Printf("flrig: Poll() GetMode error: %v", err)
		if f.errorCallback != nil {
			f.errorCallback(err.Error())
		}
		return
	}

	// Get PTT
	ptt, err := f.GetPTT()
	if err != nil {
		log.Printf("flrig: Poll() GetPTT error: %v", err)
		if f.errorCallback != nil {
			f.errorCallback(err.Error())
		}
		return
	}

	// Update cache and trigger callbacks
	f.cacheMu.Lock()
	oldFreq := f.cachedFrequency
	oldMode := f.cachedMode
	oldPTT := f.cachedPTT

	f.cachedFrequency = freq
	f.cachedMode = mode
	f.cachedPTT = ptt
	f.cacheMu.Unlock()

	// Debug: log current values every 10 seconds (20 polls at 500ms)
	f.pollCount++
	if f.pollCount%20 == 0 {
		log.Printf("flrig: Poll #%d - freq=%d, mode=%s, ptt=%v", f.pollCount, freq, mode, ptt)
	}

	// On first poll, always trigger callbacks to sync initial state
	// On subsequent polls, only trigger if values changed
	isFirstPoll := f.firstPoll
	if isFirstPoll {
		f.firstPoll = false
		log.Printf("flrig: First poll - initializing with freq=%d, mode=%s, ptt=%v", freq, mode, ptt)
	}

	// Trigger callbacks if values changed OR if this is the first poll
	if freq != oldFreq || isFirstPoll {
		if freq != oldFreq {
			log.Printf("flrig: frequency changed from %d to %d Hz", oldFreq, freq)
		}
		if f.frequencyCallback != nil {
			f.frequencyCallback(freq)
		} else {
			log.Printf("flrig: frequency callback is nil!")
		}
	}
	if mode != oldMode || isFirstPoll {
		if mode != oldMode {
			log.Printf("flrig: mode changed from %s to %s", oldMode, mode)
		}
		if f.modeCallback != nil {
			f.modeCallback(mode)
		} else {
			log.Printf("flrig: mode callback is nil!")
		}
	}
	if ptt != oldPTT || isFirstPoll {
		if ptt != oldPTT {
			log.Printf("flrig: PTT changed from %v to %v", oldPTT, ptt)
		}
		if f.pttCallback != nil {
			f.pttCallback(ptt)
		} else {
			log.Printf("flrig: PTT callback is nil!")
		}
	}
}

// GetCachedFrequency returns the cached frequency
func (f *FlrigClient) GetCachedFrequency() int {
	f.cacheMu.RLock()
	defer f.cacheMu.RUnlock()
	return f.cachedFrequency
}

// GetCachedMode returns the cached mode
func (f *FlrigClient) GetCachedMode() string {
	f.cacheMu.RLock()
	defer f.cacheMu.RUnlock()
	return f.cachedMode
}

// GetCachedPTT returns the cached PTT state
func (f *FlrigClient) GetCachedPTT() bool {
	f.cacheMu.RLock()
	defer f.cacheMu.RUnlock()
	return f.cachedPTT
}

// SetCallbacks sets the callback functions
func (f *FlrigClient) SetCallbacks(
	frequencyCallback func(int),
	modeCallback func(string),
	pttCallback func(bool),
	errorCallback func(string),
) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.frequencyCallback = frequencyCallback
	f.modeCallback = modeCallback
	f.pttCallback = pttCallback
	f.errorCallback = errorCallback
}

// callMethod makes an XML-RPC method call
func (f *FlrigClient) callMethod(method string, params []interface{}) (interface{}, error) {
	// Build XML-RPC request manually to ensure proper formatting
	var xmlRequest bytes.Buffer
	xmlRequest.WriteString(xml.Header)
	xmlRequest.WriteString("<methodCall>")
	xmlRequest.WriteString("<methodName>")
	xmlRequest.WriteString(method)
	xmlRequest.WriteString("</methodName>")

	if len(params) > 0 {
		xmlRequest.WriteString("<params>")
		for _, param := range params {
			xmlRequest.WriteString("<param><value>")
			switch v := param.(type) {
			case string:
				xmlRequest.WriteString("<string>")
				xml.EscapeText(&xmlRequest, []byte(v))
				xmlRequest.WriteString("</string>")
			case int:
				xmlRequest.WriteString(fmt.Sprintf("<int>%d</int>", v))
			case float64:
				xmlRequest.WriteString(fmt.Sprintf("<double>%f</double>", v))
			case bool:
				if v {
					xmlRequest.WriteString("<boolean>1</boolean>")
				} else {
					xmlRequest.WriteString("<boolean>0</boolean>")
				}
			default:
				xmlRequest.WriteString(fmt.Sprintf("<string>%v</string>", v))
			}
			xmlRequest.WriteString("</value></param>")
		}
		xmlRequest.WriteString("</params>")
	}

	xmlRequest.WriteString("</methodCall>")

	// Make HTTP POST request
	url := fmt.Sprintf("http://%s:%d", f.host, f.port)
	resp, err := f.client.Post(url, "text/xml", &xmlRequest)
	if err != nil {
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP error: %s", resp.Status)
	}

	// Read response
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	// Parse the response manually to extract the value
	return parseXMLRPCResponse(body)
}

// parseXMLRPCResponse parses an XML-RPC response and extracts the value
func parseXMLRPCResponse(data []byte) (interface{}, error) {
	// Simple XML parsing to extract the value
	// Look for <value>...</value> in the response

	// Check for fault first
	if bytes.Contains(data, []byte("<fault>")) {
		return nil, fmt.Errorf("XML-RPC fault in response")
	}

	// Find the value content
	valueStart := bytes.Index(data, []byte("<value>"))
	if valueStart == -1 {
		return nil, fmt.Errorf("no value found in response")
	}
	valueStart += len("<value>")

	valueEnd := bytes.Index(data[valueStart:], []byte("</value>"))
	if valueEnd == -1 {
		return nil, fmt.Errorf("malformed value in response")
	}

	valueContent := data[valueStart : valueStart+valueEnd]

	// Check for different value types
	if bytes.Contains(valueContent, []byte("<string>")) {
		start := bytes.Index(valueContent, []byte("<string>")) + len("<string>")
		end := bytes.Index(valueContent, []byte("</string>"))
		if end > start {
			return string(valueContent[start:end]), nil
		}
	}

	if bytes.Contains(valueContent, []byte("<double>")) {
		start := bytes.Index(valueContent, []byte("<double>")) + len("<double>")
		end := bytes.Index(valueContent, []byte("</double>"))
		if end > start {
			return string(valueContent[start:end]), nil
		}
	}

	if bytes.Contains(valueContent, []byte("<int>")) || bytes.Contains(valueContent, []byte("<i4>")) {
		var start, end int
		if bytes.Contains(valueContent, []byte("<int>")) {
			start = bytes.Index(valueContent, []byte("<int>")) + len("<int>")
			end = bytes.Index(valueContent, []byte("</int>"))
		} else {
			start = bytes.Index(valueContent, []byte("<i4>")) + len("<i4>")
			end = bytes.Index(valueContent, []byte("</i4>"))
		}
		if end > start {
			return string(valueContent[start:end]), nil
		}
	}

	if bytes.Contains(valueContent, []byte("<boolean>")) {
		start := bytes.Index(valueContent, []byte("<boolean>")) + len("<boolean>")
		end := bytes.Index(valueContent, []byte("</boolean>"))
		if end > start {
			val := string(valueContent[start:end])
			return val == "1" || val == "true", nil
		}
	}

	// If no type tag, treat as string
	return string(bytes.TrimSpace(valueContent)), nil
}

// XML-RPC structures for marshaling/unmarshaling

type xmlrpcMethodCall struct {
	XMLName    xml.Name     `xml:"methodCall"`
	MethodName string       `xml:"methodName"`
	Params     xmlrpcParams `xml:"params"`
}

type xmlrpcParams struct {
	Params []xmlrpcParam `xml:"param"`
}

type xmlrpcParam struct {
	Value xmlrpcValue `xml:"value"`
}

type xmlrpcValue struct {
	Data interface{} `xml:",any"`
}

type xmlrpcMethodResponse struct {
	XMLName xml.Name     `xml:"methodResponse"`
	Params  xmlrpcParams `xml:"params"`
	Fault   xmlrpcFault  `xml:"fault"`
}

type xmlrpcFault struct {
	Value xmlrpcFaultValue `xml:"value"`
}

type xmlrpcFaultValue struct {
	Struct xmlrpcStruct `xml:"struct"`
}

type xmlrpcStruct struct {
	Members []xmlrpcMember `xml:"member"`
}

type xmlrpcMember struct {
	Name  string      `xml:"name"`
	Value xmlrpcValue `xml:"value"`
}
