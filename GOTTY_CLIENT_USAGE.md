# GoTTY Client Usage Guide

This document describes how to use the GoTTY client to execute commands on the host system via the GoTTY SSH service.

## Overview

The GoTTY client provides a Go interface to execute commands on the host system through the GoTTY container's REST API. It uses the existing `SSHProxyConfig` settings from your configuration file.

## Configuration

The client uses the existing SSH proxy configuration from `config.yaml`:

```yaml
ssh_proxy:
  enabled: true
  host: "ubersdr-gotty"  # GoTTY container hostname
  port: 9980              # GoTTY container port
  path: "/terminal"       # Proxy path prefix
```

## Creating a Client

```go
// Load your config
config, err := LoadConfig("config.yaml")
if err != nil {
    log.Fatal(err)
}

// Create a GoTTY client
// Returns nil if SSH proxy is not enabled in config
client := NewGoTTYClient(&config.SSHProxy)
if client == nil {
    log.Fatal("SSH proxy is not enabled in configuration")
}
```

**Note:** The client will return `nil` if the SSH proxy is disabled in the configuration (`enabled: false`) or if the config is nil. Always check for nil before using the client.

## Basic Usage

### Simple Command Execution

Execute a command and get stdout:

```go
output, err := client.ExecCommandSimple("ls -la /tmp")
if err != nil {
    log.Printf("Command failed: %v", err)
    return
}
fmt.Println(output)
```

### Detailed Command Execution

Get full response including stderr, exit code, and duration:

```go
resp, err := client.ExecCommand("df -h", 30) // 30 second timeout
if err != nil {
    log.Printf("Request failed: %v", err)
    return
}

fmt.Printf("Exit Code: %d\n", resp.ExitCode)
fmt.Printf("Duration: %s\n", resp.Duration)
fmt.Printf("Stdout:\n%s\n", resp.Stdout)
if resp.Stderr != "" {
    fmt.Printf("Stderr:\n%s\n", resp.Stderr)
}
```

### Custom Timeout

Execute a command with a custom timeout:

```go
resp, err := client.ExecCommandWithTimeout("long-running-command", 120) // 120 seconds
if err != nil {
    log.Printf("Command failed: %v", err)
    return
}
```

## Convenience Methods

The client provides several convenience methods for common operations:

### System Information

```go
// Check if GoTTY service is reachable
err := client.Ping()

// Get hostname
hostname, err := client.GetHostname()

// Get system uptime
uptime, err := client.GetUptime()

// Get disk usage
diskUsage, err := client.GetDiskUsage()

// Get memory information
memInfo, err := client.GetMemoryInfo()
```

### Service Management

```go
// Get service status
status, err := client.GetServiceStatus("radiod")
fmt.Println(status)

// Restart a service
err := client.RestartService("radiod")
if err != nil {
    log.Printf("Failed to restart service: %v", err)
}
```

### Docker Operations

```go
// List Docker containers
containers, err := client.GetDockerContainers()
fmt.Println(containers)

// Restart a Docker container
err := client.RestartDockerContainer("ubersdr-gotty")

// Get container logs (last 100 lines)
logs, err := client.GetDockerLogs("ubersdr-gotty", 100)
fmt.Println(logs)
```

### File Operations

```go
// Check if file exists
exists, err := client.CheckFileExists("/etc/radiod.conf")

// Read file contents
content, err := client.ReadFile("/etc/radiod.conf")

// Write to file (requires appropriate permissions)
err := client.WriteFile("/tmp/test.txt", "Hello, World!")

// List directory contents
listing, err := client.ListDirectory("/var/log")
```

### Script Execution

Execute a multi-line shell script:

```go
script := `
#!/bin/bash
echo "Starting backup..."
tar -czf /tmp/backup.tar.gz /etc/radiod.conf
echo "Backup complete"
ls -lh /tmp/backup.tar.gz
`

resp, err := client.RunScript(script, 60) // 60 second timeout
if err != nil {
    log.Printf("Script failed: %v", err)
    return
}
fmt.Println(resp.Stdout)
```

## Integration Example

Here's a complete example of integrating the GoTTY client into your application:

```go
package main

import (
    "log"
    "time"
)

func monitorSystemHealth(config *Config) {
    client := NewGoTTYClient(&config.SSHProxy)
    if client == nil {
        log.Printf("SSH proxy is not enabled")
        return
    }
    
    // Check if GoTTY is reachable
    if err := client.Ping(); err != nil {
        log.Printf("GoTTY service not reachable: %v", err)
        return
    }
    
    ticker := time.NewTicker(5 * time.Minute)
    defer ticker.Stop()
    
    for range ticker.C {
        // Get system metrics
        diskUsage, err := client.GetDiskUsage()
        if err != nil {
            log.Printf("Failed to get disk usage: %v", err)
            continue
        }
        
        memInfo, err := client.GetMemoryInfo()
        if err != nil {
            log.Printf("Failed to get memory info: %v", err)
            continue
        }
        
        // Log or process the metrics
        log.Printf("Disk Usage:\n%s", diskUsage)
        log.Printf("Memory Info:\n%s", memInfo)
        
        // Check if radiod service is running
        status, err := client.GetServiceStatus("radiod")
        if err != nil {
            log.Printf("Failed to get radiod status: %v", err)
            continue
        }
        
        log.Printf("Radiod Status:\n%s", status)
    }
}
```

## Error Handling

The client provides detailed error information and safe nil handling:

```go
// The client will return a clear error if it's nil (SSH proxy disabled)
resp, err := client.ExecCommand("invalid-command", 10)
if err != nil {
    // This will catch:
    // - "GoTTY client is nil (SSH proxy may not be enabled)"
    // - Network errors
    // - API errors
    log.Printf("Request error: %v", err)
    return
}

// Check for command execution errors
if resp.Error != "" {
    log.Printf("Execution error: %s", resp.Error)
}

// Check exit code
if resp.ExitCode != 0 {
    log.Printf("Command failed with exit code %d", resp.ExitCode)
    log.Printf("Stderr: %s", resp.Stderr)
}
```

### Safe Usage Pattern

The client is designed to be safe even if SSH proxy is disabled:

```go
// Option 1: Check for nil after creation (recommended)
client := NewGoTTYClient(&config.SSHProxy)
if client == nil {
    log.Println("SSH proxy is disabled, skipping host commands")
    return
}

// Option 2: Let the methods handle nil gracefully
client := NewGoTTYClient(&config.SSHProxy)
output, err := client.ExecCommandSimple("uptime")
if err != nil {
    // Will return "GoTTY client is nil (SSH proxy may not be enabled)" if disabled
    log.Printf("Command failed: %v", err)
    return
}
```

## Security Considerations

1. **Authentication**: The GoTTY API endpoint should be protected by the same authentication mechanism as the web interface (Basic Auth if enabled).

2. **Command Injection**: Be careful when constructing commands with user input. Always validate and sanitize input.

3. **Permissions**: Commands are executed via SSH with the configured user's permissions. Ensure the SSH user has appropriate sudo access if needed.

4. **Network Access**: The GoTTY container must be accessible from the main application container on the configured host and port.

## API Endpoint

The client communicates with the GoTTY API at:
```
POST http://{host}:{port}/api/exec
```

Request body:
```json
{
  "command": "ls -la",
  "timeout": 30
}
```

Response body:
```json
{
  "stdout": "...",
  "stderr": "...",
  "exit_code": 0,
  "error": "",
  "duration": "123ms"
}
```

## Troubleshooting

### Connection Refused
- Verify the GoTTY container is running
- Check the host and port in your configuration
- Ensure network connectivity between containers

### Command Timeout
- Increase the timeout parameter for long-running commands
- Check if the command is hanging or waiting for input

### Permission Denied
- Verify the SSH user has appropriate permissions
- Check if sudo is required and properly configured
- Review the command being executed

### Authentication Failed
- Ensure Basic Auth credentials are correct if enabled
- Check the GoTTY configuration for authentication settings
