# Live Chat System for DX Cluster WebSocket

This document explains the live chat system that has been added to the DX cluster websocket infrastructure.

## Overview

The chat system allows users connected to the DX cluster websocket to communicate with each other in real-time. It uses the same websocket connection that handles DX spots, digital spots, and CW spots, eliminating the need for additional connections.

## Architecture

### Backend Components

1. **`chat_websocket.go`** - Core chat functionality
   - `ChatManager` - Manages chat users, messages, and broadcasting
   - `ChatMessage` - Message structure with username, text, and timestamp
   - `ChatUser` - User information with session ID and username
   - Message buffering for new connections (last 50 messages)
   - Automatic cleanup of inactive users (30 minutes)

2. **`dxcluster_websocket.go`** - Integration with existing websocket
   - Chat manager initialization
   - Session ID to connection mapping
   - Message routing to chat handler
   - User cleanup on disconnect

### Key Features

- **Session-based usernames**: Each username is associated with a session UUID
- **Username validation**: Alphanumeric only, maximum 15 characters
- **Message validation**: Maximum 250 characters per message
- **Message sanitization**: Control characters removed, quotes properly encoded
- **Rate limiting**: 1 message per second, maximum 25 messages per minute per user
- **Message history**: New users receive the last 50 chat messages
- **Active user tracking**: Real-time list of active chat users
- **User join/leave notifications**: Broadcasts when users join or leave
- **Automatic cleanup**: Removes inactive users after 30 minutes

## Message Types

### Client → Server

#### 1. Set Username
```json
{
  "type": "chat_set_username",
  "username": "W1ABC"
}
```
Associates a username with the current session. Must be alphanumeric, 1-15 characters.

#### 2. Send Chat Message
```json
{
  "type": "chat_message",
  "message": "Hello everyone!"
}
```
Sends a chat message to all connected users. Maximum 250 characters.

#### 3. Request Active Users
```json
{
  "type": "chat_request_users"
}
```
Requests the list of currently active chat users.

### Server → Client

#### 1. Chat Message
```json
{
  "type": "chat_message",
  "data": {
    "username": "W1ABC",
    "message": "Hello everyone!",
    "timestamp": "2026-01-06T19:30:00Z"
  }
}
```
Broadcasts a chat message to all connected clients.

#### 2. User Joined
```json
{
  "type": "chat_user_joined",
  "data": {
    "username": "W1ABC",
    "timestamp": "2026-01-06T19:30:00Z"
  }
}
```
Notifies all clients when a user joins the chat.

#### 3. User Left
```json
{
  "type": "chat_user_left",
  "data": {
    "username": "W1ABC",
    "timestamp": "2026-01-06T19:30:00Z"
  }
}
```
Notifies all clients when a user leaves the chat.

#### 4. Active Users List
```json
{
  "type": "chat_active_users",
  "data": {
    "users": [
      {"username": "W1ABC"},
      {"username": "K2XYZ"}
    ],
    "count": 2
  }
}
```
Provides the list of currently active chat users.

#### 5. Chat Error
```json
{
  "type": "chat_error",
  "error": "invalid username"
}
```
Sent when a chat operation fails (e.g., invalid username or message).

## Client Implementation

### Basic Example

```javascript
// Connect to websocket
const ws = new WebSocket(`ws://localhost:8080/ws/dxcluster?user_session_id=${sessionId}`);

// Set username
ws.send(JSON.stringify({
  type: 'chat_set_username',
  username: 'W1ABC'
}));

// Send a message
ws.send(JSON.stringify({
  type: 'chat_message',
  message: 'Hello everyone!'
}));

// Handle incoming messages
ws.onmessage = function(event) {
  const msg = JSON.parse(event.data);
  
  switch(msg.type) {
    case 'chat_message':
      console.log(`${msg.data.username}: ${msg.data.message}`);
      break;
    case 'chat_user_joined':
      console.log(`${msg.data.username} joined`);
      break;
    case 'chat_user_left':
      console.log(`${msg.data.username} left`);
      break;
    case 'chat_active_users':
      console.log(`Active users: ${msg.data.count}`);
      break;
    case 'chat_error':
      console.error(`Error: ${msg.error}`);
      break;
    // Handle other message types (dx_spot, digital_spot, cw_spot, etc.)
  }
};
```

### HTML Example

A complete HTML example is provided in [`static/chat_example.html`](static/chat_example.html). This demonstrates:
- WebSocket connection with session ID
- Username setup with validation
- Sending and receiving messages
- Displaying active users
- User join/leave notifications
- Message history for new users

## Integration with Existing Code

The chat system integrates seamlessly with the existing DX cluster websocket:

1. **Shared Connection**: Uses the same websocket connection as DX spots
2. **Shared Client Pool**: All message types use the same broadcast infrastructure
3. **Session Management**: Leverages existing session UUID system
4. **No Breaking Changes**: Existing clients continue to work without modification

## Usage Flow

1. Client generates a UUID for `user_session_id`
2. Client calls `/connection` endpoint with the UUID (required for session validation)
3. Client connects to websocket with `user_session_id` parameter
4. Client sets username via `chat_set_username` message
5. Server associates username with session UUID
6. Server broadcasts user join notification
7. Server sends buffered chat messages to new client
8. Client can send messages via `chat_message` type
9. Server broadcasts messages to all connected clients
10. On disconnect, server removes user and broadcasts leave notification

### Session Registration

Before connecting to the websocket, clients must register their session:

```javascript
// Register session first
await fetch('/connection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_session_id: sessionId })
});

// Then connect to websocket
const ws = new WebSocket(`ws://host/ws/dxcluster?user_session_id=${sessionId}`);
```

This is required because the websocket handler validates that the session has a User-Agent mapping (see [`HandleWebSocket`](dxcluster_websocket.go:159)).

## Configuration

The chat system is configured in [`NewChatManager()`](chat_websocket.go:54):
- **Message buffer size**: 50 messages (configurable)
- **Inactive user timeout**: 30 minutes
- **Username max length**: 15 characters (alphanumeric only)
- **Message max length**: 250 characters
- **Rate limits**: 1 message per second, 25 messages per minute

## Security Considerations

1. **Username validation**: Only alphanumeric characters allowed
2. **Message sanitization**: Control characters removed, proper encoding for quotes
3. **Length limits**: Prevents abuse via oversized messages (250 chars max)
4. **Rate limiting**: Prevents spam (1 msg/sec, 25 msgs/min per user)
5. **Session-based**: Usernames tied to validated session UUIDs
6. **XSS prevention**: Client must escape HTML when displaying messages

## Client-Side Muting

Users can mute other users on the client side. This is implemented in the example HTML:

### How It Works

1. **Click to mute**: Click on any username in the chat to mute/unmute them
2. **Local storage**: Mute list is saved in browser localStorage
3. **Persistent**: Mute preferences persist across page reloads
4. **Client-side only**: Messages are still sent to the client but filtered before display
5. **Privacy-friendly**: No server-side tracking of who mutes whom

### Implementation

```javascript
// Mute list stored in Set
let mutedUsers = new Set();

// Toggle mute
function toggleMute(username) {
    if (mutedUsers.has(username)) {
        mutedUsers.delete(username);
    } else {
        mutedUsers.add(username);
    }
    localStorage.setItem('mutedUsers', JSON.stringify([...mutedUsers]));
}

// Filter messages
function displayChatMessage(data) {
    if (mutedUsers.has(data.username)) {
        return; // Don't display
    }
    // ... display message
}
```

### Advantages

- **No server load**: Filtering happens on client
- **Privacy**: Server doesn't know who mutes whom
- **Instant**: No network round-trip needed
- **Persistent**: Saved in localStorage
- **Simple**: Easy to implement and maintain

## Future Enhancements

Potential improvements:
- Private messaging between users
- Message persistence/logging
- Profanity filtering
- User roles/moderation
- Typing indicators
- Read receipts
- Message reactions
- Server-side blocking (admin feature)

## Testing

To test the chat system:

1. Start the server
2. Open [`static/chat_example.html`](static/chat_example.html) in multiple browser windows
3. Set different usernames in each window
4. Send messages and observe real-time updates
5. Close a window and observe leave notification
6. Open a new window and observe message history

## Code Structure

```
chat_websocket.go           - Chat manager and message handling
dxcluster_websocket.go      - Integration with websocket handler
static/chat_example.html    - Client-side example implementation
CHAT_SYSTEM.md             - This documentation
```

## API Reference

### ChatManager Methods

- `SetUsername(sessionID, username)` - Associate username with session
- `GetUsername(sessionID)` - Retrieve username for session
- `RemoveUser(sessionID)` - Remove user from chat
- `SendMessage(sessionID, message)` - Send chat message
- `GetActiveUsers()` - Get list of active users
- `BroadcastActiveUsers()` - Broadcast active users to all clients
- `SendBufferedMessages(conn)` - Send message history to new client
- `HandleChatMessage(sessionID, msg)` - Route incoming chat messages

### Error Types

- `ErrInvalidUsername` - Username validation failed
- `ErrInvalidMessage` - Message validation failed
- `ErrUsernameNotSet` - User tried to send message without setting username
- `ErrInvalidMessageType` - Unknown message type
- `ErrUnknownMessageType` - Unhandled message type

## Troubleshooting

**Problem**: Messages not appearing
- Check that username is set before sending messages
- Verify websocket connection is open
- Check browser console for errors

**Problem**: Username rejected
- Ensure username is alphanumeric only
- Check length is between 1-15 characters
- Verify no special characters or spaces

**Problem**: User not appearing in active list
- Ensure `chat_set_username` was sent successfully
- Check that user hasn't been inactive for >30 minutes
- Request active users list explicitly

## License

Same as the main project.
