# HTTP Request Logs API

## Overview

The HTTP Request Logs API provides admin-only access to an in-memory buffer of HTTP requests. This feature maintains a rolling window of the last 1000 HTTP requests in memory, regardless of whether file-based logging is enabled.

## Key Features

- **Always Active**: Works independently of the `config.server.logfile_enabled` setting
- **In-Memory Storage**: No disk I/O, fast access
- **Rolling Window**: Automatically maintains the most recent 1000 requests
- **Admin-Only Access**: Protected by authentication middleware
- **Rich Filtering**: Filter by IP, path, method, and status code
- **Thread-Safe**: Concurrent access is handled safely

## Architecture

```
HTTP Request → httpLogger Middleware
                    ↓
        ┌───────────┴───────────┐
        ↓                       ↓
  File Logging            In-Memory Buffer
  (if enabled)            (always enabled)
        ↓                       ↓
  web.log file          Rolling Window (1000)
                              ↓
                    /admin/http-logs endpoint
```

## API Endpoint

### GET `/admin/http-logs`

**Authentication**: Requires admin session (protected by `AuthMiddleware`)

**Query Parameters**:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | 100 | Number of recent logs to return (max: 1000) |
| `filter_ip` | string | - | Filter by client IP (partial match) |
| `filter_path` | string | - | Filter by URI path (partial match) |
| `filter_method` | string | - | Filter by HTTP method (exact match: GET, POST, etc.) |
| `min_status` | integer | 0 | Minimum status code (inclusive) |
| `max_status` | integer | 999 | Maximum status code (inclusive) |

**Response Format**:

```json
{
  "success": true,
  "count": 100,
  "total": 1000,
  "max_size": 1000,
  "logs": [
    {
      "timestamp": "2026-02-02T11:30:15.123Z",
      "client_ip": "192.168.1.100",
      "method": "GET",
      "uri": "/api/description",
      "protocol": "HTTP/1.1",
      "status_code": 200,
      "bytes_written": 1234,
      "duration_ms": 5.234,
      "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)...",
      "referer": "https://example.com"
    }
  ]
}
```

## Usage Examples

### Get the last 100 requests (default)
```bash
curl -H "Cookie: admin_session=..." \
  http://localhost:8080/admin/http-logs
```

### Get the last 500 requests
```bash
curl -H "Cookie: admin_session=..." \
  "http://localhost:8080/admin/http-logs?limit=500"
```

### Filter by IP address
```bash
curl -H "Cookie: admin_session=..." \
  "http://localhost:8080/admin/http-logs?filter_ip=192.168.1"
```

### Filter by path (e.g., all API requests)
```bash
curl -H "Cookie: admin_session=..." \
  "http://localhost:8080/admin/http-logs?filter_path=/api/"
```

### Filter by HTTP method
```bash
curl -H "Cookie: admin_session=..." \
  "http://localhost:8080/admin/http-logs?filter_method=POST"
```

### Filter by status code range (e.g., errors only)
```bash
curl -H "Cookie: admin_session=..." \
  "http://localhost:8080/admin/http-logs?min_status=400&max_status=599"
```

### Combine multiple filters
```bash
curl -H "Cookie: admin_session=..." \
  "http://localhost:8080/admin/http-logs?filter_path=/admin/&min_status=200&max_status=299&limit=50"
```

## Implementation Details

### Files Created/Modified

1. **`http_log_buffer.go`** (new)
   - Defines `HTTPLogEntry` structure
   - Implements `HTTPLogBuffer` with thread-safe operations
   - Provides global buffer instance

2. **`http_logs_api.go`** (new)
   - Implements `handleHTTPLogsAPI` endpoint handler
   - Provides filtering and pagination logic

3. **`main.go`** (modified)
   - Modified `httpLogger` middleware to write to both file and memory
   - Added buffer initialization in `main()` function
   - Registered `/admin/http-logs` endpoint
   - Updated middleware wrapper to always enable logging

### Memory Usage

- **Maximum entries**: 1000 requests
- **Approximate size per entry**: ~500 bytes
- **Total memory usage**: ~500 KB (negligible)

### Thread Safety

All operations on the HTTP log buffer are protected by `sync.RWMutex`:
- Write operations (AddLog) use exclusive locks
- Read operations (GetLogs, GetRecentLogs) use shared locks

## Configuration

No configuration changes are required. The feature is always enabled and maintains a fixed buffer size of 1000 entries.

### Relationship to File Logging

The in-memory buffer is **independent** of file-based logging:

| Setting | File Logging | In-Memory Buffer |
|---------|--------------|------------------|
| `logfile_enabled: true` | ✅ Enabled | ✅ Enabled |
| `logfile_enabled: false` | ❌ Disabled | ✅ Enabled |

## Performance Impact

- **Minimal overhead**: Simple append operation to slice
- **No disk I/O**: Pure in-memory operations
- **Bounded memory**: Fixed 1000-entry limit prevents unbounded growth
- **Efficient filtering**: In-memory filtering is very fast

## Security Considerations

- **Admin-only access**: Endpoint is protected by authentication middleware
- **No sensitive data exposure**: Logs contain the same information as standard web server logs
- **IP privacy**: Consider privacy implications when sharing logs
- **Session tokens**: User session tokens are not logged

## Comparison with Container Logs

The system has two separate log systems:

| Feature | HTTP Request Logs | Container Logs |
|---------|------------------|----------------|
| Endpoint | `/admin/http-logs` | `/admin/logs` |
| Source | HTTP middleware | Fluent Bit (TCP port 6925) |
| Content | HTTP requests | Container stdout/stderr |
| Buffer | 1000 entries total | 1000 entries per container |
| Filters | IP, path, method, status | Container name |

## Future Enhancements

Possible future improvements:
- Export logs as CSV
- Real-time streaming via WebSocket
- Configurable buffer size
- Persistent storage option
- Advanced analytics (request rate, error rate, etc.)

## Troubleshooting

### No logs appearing

1. Check that the server has started successfully
2. Verify the buffer is initialized (check startup logs for "HTTP request log buffer initialized")
3. Make some HTTP requests to populate the buffer
4. Ensure you're authenticated as admin

### Logs are truncated

The buffer maintains only the most recent 1000 requests. Older requests are automatically removed. If you need historical data, enable file-based logging with `logfile_enabled: true`.

### Performance issues

The in-memory buffer has minimal performance impact. If you experience issues:
1. Check overall system memory usage
2. Verify the buffer size hasn't been modified
3. Consider reducing the frequency of log queries

## Related Documentation

- [Log Receiver API](log_receiver.go) - Container logs from Fluent Bit
- [Admin API](admin.go) - Admin authentication and endpoints
- [Configuration](config/config.yaml.example) - Server configuration options
