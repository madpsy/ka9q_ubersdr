# MCP Server Implementation

## Overview

The MCP (Model Context Protocol) endpoint has been completely rewritten to use the official `github.com/mark3labs/mcp-go` SDK, making it fully compatible with ChatGPT and other MCP clients.

## What Changed

### Before (Custom Implementation)
- Custom JSON-RPC-like format that didn't follow MCP specification
- Missing required MCP protocol methods (`initialize`, `tools/list`, `tools/call`)
- No `jsonrpc` field in requests/responses
- Incorrect response format
- Direct method routing instead of standard MCP tool calling

### After (Official SDK)
- ✅ Full MCP protocol compliance using official SDK
- ✅ Proper protocol initialization and handshake
- ✅ Standard tool discovery via `tools/list`
- ✅ Correct tool execution via `tools/call`
- ✅ Proper JSON-RPC 2.0 format with `jsonrpc` field
- ✅ StreamableHTTP transport for compatibility

## Architecture

```
┌─────────────┐
│   ChatGPT   │
│  (MCP Client)│
└──────┬──────┘
       │ HTTP POST /api/mcp
       │ (MCP Protocol)
       ▼
┌──────────────────────────────────┐
│  StreamableHTTPServer            │
│  (github.com/mark3labs/mcp-go)   │
│  - Handles protocol negotiation  │
│  - Routes tool calls             │
│  - Formats responses             │
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│  MCPServer (mcp_server.go)       │
│  - Registers 7 tools             │
│  - Implements tool handlers      │
│  - Accesses UberSDR data         │
└──────────────────────────────────┘
```

## Available Tools

The MCP server exposes 7 tools for radio monitoring and analysis:

### 1. `get_space_weather`
Get current space weather conditions (SFI, A-index, K-index) that affect HF radio propagation.

**Parameters:**
- `format` (string, optional): "json" or "text" (default: "json")

### 2. `get_noise_floor`
Get noise floor measurements for amateur radio bands.

**Parameters:**
- `band` (string, optional): Specific band (e.g., "20m", "40m") or empty for all
- `format` (string, optional): "json" or "text" (default: "json")

### 3. `get_decoder_spots`
Get recent digital mode spots (FT8, FT4, WSPR).

**Parameters:**
- `mode` (string, optional): Mode filter or empty for all
- `hours` (number, optional): Hours of history (default: 1, max: 48)
- `format` (string, optional): "json" or "text" (default: "json")

### 4. `get_decoder_analytics`
Get aggregated analytics about decoder spots by country/continent.

**Parameters:**
- `country` (string, optional): Country name filter
- `continent` (string, optional): Continent code (AF, AS, EU, NA, OC, SA, AN)
- `mode` (string, optional): Mode filter
- `band` (string, optional): Band filter
- `min_snr` (number, optional): Minimum SNR in dB (default: -999)
- `hours` (number, optional): Hours of history (default: 24, max: 48)
- `format` (string, optional): "json" or "text" (default: "json")

### 5. `get_decoder_analytics_hourly`
Get hourly aggregated analytics broken down by hour for trend analysis.

**Parameters:** Same as `get_decoder_analytics`

### 6. `get_active_sessions`
Get list of active radio listening sessions.

**Parameters:**
- `format` (string, optional): "json" or "text" (default: "json")

### 7. `get_band_conditions`
Get comprehensive band conditions analysis (space weather + noise floor + activity).

**Parameters:**
- `format` (string, optional): "json" or "text" (default: "json")

## Key Implementation Details

### Tool Registration
Tools are registered using the SDK's builder pattern:

```go
m.mcpServer.AddTool(
    mcp.NewTool("get_space_weather",
        mcp.WithDescription("Get current space weather conditions..."),
        mcp.WithString("format",
            mcp.Description("Output format..."),
            mcp.DefaultString("json"),
        ),
    ),
    m.handleGetSpaceWeather,
)
```

### Tool Handlers
Handlers use the SDK's helper methods to extract parameters:

```go
func (m *MCPServer) handleGetSpaceWeather(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
    format := request.GetString("format", "json")
    // ... implementation
    return mcp.NewToolResultText(jsonData), nil
}
```

### HTTP Transport
The StreamableHTTPServer handles all protocol details:

```go
m.httpServer = server.NewStreamableHTTPServer(m.mcpServer)

func (m *MCPServer) HandleMCP(w http.ResponseWriter, r *http.Request) {
    if checkIPBan(w, r, m.ipBanManager) {
        return
    }
    m.httpServer.ServeHTTP(w, r)
}
```

## Testing with ChatGPT

To test the MCP endpoint with ChatGPT:

1. Ensure the server is running
2. In ChatGPT, configure the MCP server URL: `http://your-server:port/api/mcp`
3. ChatGPT will automatically:
   - Initialize the connection
   - Discover available tools
   - Call tools as needed during conversation

Example conversation:
```
User: "What are the current band conditions?"
ChatGPT: [Calls get_band_conditions tool]
ChatGPT: "The current band conditions show..."
```

## Benefits of Using the Official SDK

1. **Protocol Compliance**: Automatically handles all MCP specification requirements
2. **Reduced Code**: ~500 lines reduced to ~470 lines with better functionality
3. **Future-Proof**: Updates automatically when MCP spec changes
4. **Better Error Handling**: Built-in validation and error responses
5. **Maintainability**: Clear separation between protocol and business logic
6. **Extensibility**: Easy to add new tools

## Dependencies Added

```go
require (
    github.com/mark3labs/mcp-go v0.43.2
)
```

The SDK automatically pulls in required dependencies:
- `github.com/invopop/jsonschema` - JSON Schema generation
- `github.com/spf13/cast` - Type casting utilities
- `github.com/yosida95/uritemplate/v3` - URI template support

## Migration Notes

- The endpoint URL remains the same: `/api/mcp`
- All existing tool functionality is preserved
- Response formats are now MCP-compliant
- IP ban checking is still enforced before MCP processing
- All tool handlers maintain the same business logic

## Troubleshooting

If ChatGPT reports "failed":

1. **Check server logs** for initialization errors
2. **Verify endpoint** is accessible: `curl -X POST http://server/api/mcp`
3. **Test tool discovery**: The server should respond to `tools/list` method
4. **Check firewall**: Ensure port is accessible from ChatGPT's servers

## Future Enhancements

Potential improvements using the SDK:

1. **Server-Sent Events (SSE)**: Real-time updates for active spots
2. **Prompts**: Pre-defined queries for common use cases
3. **Resources**: Expose historical data as MCP resources
4. **Sampling**: Allow ChatGPT to request additional context
5. **Logging**: Built-in MCP logging capabilities
