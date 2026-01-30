package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// GoTTYClient provides methods to interact with the GoTTY API
type GoTTYClient struct {
	baseURL    string
	httpClient *http.Client
}

// GoTTYExecRequest represents the JSON request body for command execution
type GoTTYExecRequest struct {
	Command string `json:"command"`
	Timeout int    `json:"timeout,omitempty"` // timeout in seconds, default 30
}

// GoTTYExecResponse represents the JSON response for command execution
type GoTTYExecResponse struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exit_code"`
	Error    string `json:"error,omitempty"`
	Duration string `json:"duration"`
}

// NewGoTTYClient creates a new GoTTY API client using the provided config
// Returns nil if SSH proxy is not enabled in the configuration
func NewGoTTYClient(config *SSHProxyConfig) *GoTTYClient {
	if config == nil || !config.Enabled {
		return nil
	}

	baseURL := fmt.Sprintf("http://%s:%d", config.Host, config.Port)

	return &GoTTYClient{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 60 * time.Second, // Overall HTTP timeout
		},
	}
}

// ExecCommand executes a command on the host via the GoTTY SSH service
// Returns stdout, stderr, exit code, and any error
func (c *GoTTYClient) ExecCommand(command string, timeout int) (*GoTTYExecResponse, error) {
	if c == nil {
		return nil, fmt.Errorf("GoTTY client is nil (SSH proxy may not be enabled)")
	}

	// Set default timeout if not specified
	if timeout == 0 {
		timeout = 30
	}

	// Prepare request body
	reqBody := GoTTYExecRequest{
		Command: command,
		Timeout: timeout,
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request: %w", err)
	}

	// Create HTTP request
	url := fmt.Sprintf("%s/api/exec", c.baseURL)
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	// Execute request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to execute request: %w", err)
	}
	defer resp.Body.Close()

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	// Check HTTP status
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API returned status %d: %s", resp.StatusCode, string(body))
	}

	// Parse response
	var execResp GoTTYExecResponse
	if err := json.Unmarshal(body, &execResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	return &execResp, nil
}

// ExecCommandSimple executes a command and returns just stdout and error
// This is a convenience wrapper around ExecCommand for simple use cases
func (c *GoTTYClient) ExecCommandSimple(command string) (string, error) {
	resp, err := c.ExecCommand(command, 30)
	if err != nil {
		return "", err
	}

	// Check for command execution errors
	if resp.Error != "" {
		return "", fmt.Errorf("command error: %s", resp.Error)
	}

	// Check for non-zero exit code
	if resp.ExitCode != 0 {
		if resp.Stderr != "" {
			return resp.Stdout, fmt.Errorf("command failed with exit code %d: %s", resp.ExitCode, resp.Stderr)
		}
		return resp.Stdout, fmt.Errorf("command failed with exit code %d", resp.ExitCode)
	}

	return resp.Stdout, nil
}

// ExecCommandWithTimeout executes a command with a custom timeout
// Returns the full response for detailed error handling
func (c *GoTTYClient) ExecCommandWithTimeout(command string, timeoutSeconds int) (*GoTTYExecResponse, error) {
	return c.ExecCommand(command, timeoutSeconds)
}

// Ping checks if the GoTTY service is reachable by executing a simple command
func (c *GoTTYClient) Ping() error {
	_, err := c.ExecCommandSimple("echo ping")
	return err
}

// GetHostname retrieves the hostname of the host system
func (c *GoTTYClient) GetHostname() (string, error) {
	output, err := c.ExecCommandSimple("hostname")
	if err != nil {
		return "", err
	}
	// Trim any trailing newline
	return string(bytes.TrimSpace([]byte(output))), nil
}

// GetUptime retrieves the system uptime
func (c *GoTTYClient) GetUptime() (string, error) {
	return c.ExecCommandSimple("uptime")
}

// GetDiskUsage retrieves disk usage information
func (c *GoTTYClient) GetDiskUsage() (string, error) {
	return c.ExecCommandSimple("df -h")
}

// GetMemoryInfo retrieves memory usage information
func (c *GoTTYClient) GetMemoryInfo() (string, error) {
	return c.ExecCommandSimple("free -h")
}

// RestartService restarts a systemd service on the host
func (c *GoTTYClient) RestartService(serviceName string) error {
	cmd := fmt.Sprintf("sudo systemctl restart %s", serviceName)
	resp, err := c.ExecCommand(cmd, 60) // 60 second timeout for service restart
	if err != nil {
		return err
	}

	if resp.ExitCode != 0 {
		return fmt.Errorf("failed to restart service %s: %s", serviceName, resp.Stderr)
	}

	return nil
}

// GetServiceStatus retrieves the status of a systemd service
func (c *GoTTYClient) GetServiceStatus(serviceName string) (string, error) {
	cmd := fmt.Sprintf("systemctl status %s", serviceName)
	// Note: systemctl status returns non-zero for inactive services, so we use ExecCommand
	// instead of ExecCommandSimple to get the full response
	resp, err := c.ExecCommand(cmd, 10)
	if err != nil {
		return "", err
	}

	// Return stdout regardless of exit code (status command returns non-zero for stopped services)
	return resp.Stdout, nil
}

// RunScript executes a shell script on the host
// The script parameter should be the full script content
func (c *GoTTYClient) RunScript(script string, timeoutSeconds int) (*GoTTYExecResponse, error) {
	// Escape single quotes in the script
	escapedScript := bytes.ReplaceAll([]byte(script), []byte("'"), []byte("'\\''"))

	// Wrap the script in a bash -c command
	cmd := fmt.Sprintf("bash -c '%s'", string(escapedScript))

	return c.ExecCommand(cmd, timeoutSeconds)
}

// ListDirectory lists the contents of a directory on the host
func (c *GoTTYClient) ListDirectory(path string) (string, error) {
	cmd := fmt.Sprintf("ls -la %s", path)
	return c.ExecCommandSimple(cmd)
}

// ReadFile reads the contents of a file on the host
func (c *GoTTYClient) ReadFile(path string) (string, error) {
	cmd := fmt.Sprintf("cat %s", path)
	return c.ExecCommandSimple(cmd)
}

// WriteFile writes content to a file on the host
// Note: This requires appropriate permissions on the host
func (c *GoTTYClient) WriteFile(path string, content string) error {
	// Escape single quotes in the content
	escapedContent := bytes.ReplaceAll([]byte(content), []byte("'"), []byte("'\\''"))

	cmd := fmt.Sprintf("echo '%s' > %s", string(escapedContent), path)
	_, err := c.ExecCommandSimple(cmd)
	return err
}

// CheckFileExists checks if a file exists on the host
func (c *GoTTYClient) CheckFileExists(path string) (bool, error) {
	cmd := fmt.Sprintf("test -f %s", path)
	resp, err := c.ExecCommand(cmd, 5)
	if err != nil {
		return false, err
	}

	// test command returns 0 if file exists, 1 if not
	return resp.ExitCode == 0, nil
}

// GetDockerContainers retrieves a list of Docker containers on the host
func (c *GoTTYClient) GetDockerContainers() (string, error) {
	return c.ExecCommandSimple("docker ps -a")
}

// RestartDockerContainer restarts a Docker container on the host
func (c *GoTTYClient) RestartDockerContainer(containerName string) error {
	cmd := fmt.Sprintf("docker restart %s", containerName)
	resp, err := c.ExecCommand(cmd, 60)
	if err != nil {
		return err
	}

	if resp.ExitCode != 0 {
		return fmt.Errorf("failed to restart container %s: %s", containerName, resp.Stderr)
	}

	return nil
}

// GetDockerLogs retrieves logs from a Docker container
func (c *GoTTYClient) GetDockerLogs(containerName string, lines int) (string, error) {
	cmd := fmt.Sprintf("docker logs --tail %d %s", lines, containerName)
	return c.ExecCommandSimple(cmd)
}
