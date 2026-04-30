# KiwiSDR Emulation Bug Analysis: Third-Party Clients Get No Audio

## Problem Statement

Third-party programs that work correctly with an official KiwiSDR can connect to ubersdr's KiwiSDR emulation but **do not stream any audio**. The built-in web interface works fine.

## Root Cause: `SET AR OK` Command Mishandled

The primary issue is that ubersdr's command parser misinterprets the `SET AR OK in=X out=Y` command that KiwiSDR clients send as part of the audio initialization handshake. This causes ubersdr to send a **malformed `audio_init` response** that corrupts the client's audio state.

---

## Detailed Analysis

### How the Real KiwiSDR Audio Handshake Works

The official KiwiSDR server gates audio streaming behind a bitmask of required commands. From `rx_sound_cmd.h` lines 32–37:

```c
#define CMD_FREQ        0x01
#define CMD_MODE        0x02
#define CMD_PASSBAND    0x04
#define CMD_AGC         0x08
#define CMD_AR_OK       0x10
#define CMD_SND_ALL     (CMD_FREQ | CMD_MODE | CMD_PASSBAND | CMD_AGC | CMD_AR_OK)
```

The server **refuses to send any audio data** until all five bits are set. From `rx_sound.cpp` lines 418–422:

```c
// don't process any audio data until we've received all necessary commands
if (s->cmd_recv != CMD_SND_ALL) {
    conn->snd_cmd_recv = s->cmd_recv;
    TaskSleepMsec(100);
    continue;
}
```

The `CMD_AR_OK` bit (0x10) is set when the client sends `SET AR OK in=X out=Y`. From `rx_sound_cmd.cpp` lines 660–666:

```c
case CMD_AR_OKAY:
    n = sscanf(cmd, "SET AR OK in=%d out=%d", &arate_in, &arate_out);
    if (n == 2) {
        did_cmd = true;
        if (arate_out) s->cmd_recv |= CMD_AR_OK;
    }
    break;
```

### The Client-Side Flow

1. **Server sends `audio_init`** — From `rx_sound.cpp` line 161, the server sends:
   ```
   MSG audio_init=<is_local> audio_rate=<snd_rate>
   ```
   For example: `MSG audio_init=0 audio_rate=12000`

2. **Client parses `audio_init`** — From `openwebrx.js` lines 13612–13614, the client receives the `audio_init` key and calls:
   ```javascript
   case "audio_init":
       audio_init(+param[1], btn_less_buffering, ...);
       break;
   ```
   Here `+param[1]` converts the value (e.g. `"0"`) to a number. This is the `is_local` flag.

3. **Server sends `sample_rate`** — From `rx_sound.cpp` line 244:
   ```c
   send_msg(conn, SM_SND_DEBUG, "MSG sample_rate=%.6f", frate_wb);
   ```
   Note: sent as a **float with 6 decimal places**, e.g. `MSG sample_rate=12000.000000`.

4. **Client receives `sample_rate` and calls `audio_rate()`** — From `openwebrx.js` lines 13622–13623:
   ```javascript
   case "audio_rate":
       audio_rate(parseFloat(param[1]));
       break;
   ```

5. **Client sends `SET AR OK`** — From `audio.js` lines 459–462, after computing resampling parameters:
   ```javascript
   if (audio_interpolation != 0) {
       audio_transition_bw = 0.001;
       audio_resample_ratio = audio_output_rate / audio_input_rate;
       snd_send("SET AR OK in="+ input_rate +" out="+ audio_output_rate);
   }
   ```

6. **Server receives `SET AR OK`, sets `CMD_AR_OK` bit, audio starts flowing.**

### What Goes Wrong in UberSDR

#### Step 1: The Parser Misinterprets `SET AR OK`

When the client sends `SET AR OK in=12000 out=48000`, ubersdr's command parser at `kiwi_websocket.go` lines 580–594 splits on spaces and `=`:

```go
func (kc *kiwiConn) handleSetCommand(command string) {
    params := make(map[string]string)
    parts := strings.Fields(command)
    for _, part := range parts {
        if idx := strings.Index(part, "="); idx > 0 {
            key := part[:idx]
            value := part[idx+1:]
            params[key] = value
        } else {
            params[part] = ""
        }
    }
```

For the input `AR OK in=12000 out=48000` (after stripping the `SET ` prefix at line 574), this produces:

```
params = {
    "AR":  "",        // standalone key, no value
    "OK":  "",        // standalone key, no value
    "in":  "12000",   // key=value pair
    "out": "48000",   // key=value pair
}
```

#### Step 2: The `in`/`out` Handler Fires Incorrectly

Because `params["in"]` exists, the handler at `kiwi_websocket.go` lines 802–813 matches:

```go
// Handle AR (Audio Rate) command - client sends "SET in=12000 out=48000"
if inRate, hasIn := params["in"]; hasIn {
    if _, hasOut := params["out"]; hasOut {
        kc.sendMsg("audio_init", fmt.Sprintf("audio_rate=%s audio_rate_true=%s.000", inRate, inRate))
        kc.mu.Lock()
        kc.audioInitSent = true
        kc.mu.Unlock()
        return
    }
}
```

This sends back:
```
MSG audio_init=audio_rate=12000 audio_rate_true=12000.000
```

#### Step 3: The Client Receives a Malformed `audio_init`

The client's message parser splits `audio_init=audio_rate=12000` on the first `=`, giving:
- key: `audio_init`
- value: `audio_rate=12000`

Then in `openwebrx.js` line 13614:
```javascript
audio_init(+param[1], ...)
```

`+param[1]` tries to convert `"audio_rate=12000"` to a number, which yields `NaN`.

The `audio_init()` function at `audio.js` line 238 receives `NaN` as the `is_local` parameter. This corrupts the audio initialization state. The function may still proceed (since `NaN` is falsy in some comparisons), but the audio pipeline is now in an inconsistent state.

**Critically**, this second `audio_init` message arrives AFTER the client has already received the correct initial `audio_init` from `kiwi_websocket.go` line 1338 and has already called `audio_init()` once. The second malformed call **re-initializes the audio system with corrupt parameters**, destroying the working state.

### The Comment at Line 802 Reveals the Misunderstanding

The comment says:
```go
// Handle AR (Audio Rate) command - client sends "SET in=12000 out=48000"
```

This is wrong. The client sends **two different commands**:
- `SET UAR in=12000 out=48000` — sent when resampling fails (error case), handled by `CMD_UAR` in the real KiwiSDR at `rx_sound_cmd.cpp` line 653
- `SET AR OK in=12000 out=48000` — sent when resampling succeeds (normal case), handled by `CMD_AR_OKAY` at `rx_sound_cmd.cpp` line 661

Neither command expects an `audio_init` response from the server. The real KiwiSDR simply records the information and sets the `CMD_AR_OK` bit.

---

## Secondary Issues

### Issue 2: `sample_rate` Sent as Integer Instead of Float

**Real KiwiSDR** at `rx_sound.cpp` line 244:
```c
send_msg(conn, SM_SND_DEBUG, "MSG sample_rate=%.6f", frate_wb);
// Produces: MSG sample_rate=12000.000000
```

**UberSDR** at `kiwi_websocket.go` line 1319:
```go
kc.sendMsg("sample_rate", fmt.Sprintf("%d", sampleRate))
// Produces: MSG sample_rate=12000
```

Third-party clients that use strict float parsing may not handle the integer format. The `audio_rate()` function in `audio.js` line 417 uses `parseFloat()` which handles both, but other clients may differ.

### Issue 3: Initial `audio_init` Message Has Wrong Format

**Real KiwiSDR** at `rx_sound.cpp` line 161:
```c
send_msg(conn, SM_SND_DEBUG, "MSG audio_init=%d audio_rate=%d", conn->isLocal, snd_rate);
// Produces: MSG audio_init=0 audio_rate=12000
```

This is a **single MSG** containing two key=value pairs: `audio_init=0` and `audio_rate=12000`. The client's message dispatcher processes both pairs from the same message.

**UberSDR** at `kiwi_websocket.go` line 1338:
```go
kc.sendMsg("audio_init", fmt.Sprintf("0 audio_rate=%d", sampleRate))
```

Looking at `sendMsg()` at lines 529–557:
```go
func (kc *kiwiConn) sendMsg(name, value string) {
    var msg string
    if value != "" {
        msg = fmt.Sprintf("%s=%s", name, value)
    } else {
        msg = name
    }
    packet := append([]byte("MSG "), []byte(msg)...)
```

This produces: `MSG audio_init=0 audio_rate=12000` — which is actually correct! The format matches the real KiwiSDR.

However, the `audio_rate` key=value pair embedded in this message depends on the client's MSG parser splitting on spaces and processing each `key=value` pair independently. If a third-party client only extracts the first key=value pair from a MSG, it would get `audio_init=0` but miss `audio_rate=12000`.

The real KiwiSDR also sends `sample_rate` separately (line 244), which is the primary way the client gets the rate. The `audio_rate` in the `audio_init` MSG is a secondary/redundant path.

---

## Recommended Fixes

### Fix 1 (Critical): Handle `SET AR OK` Properly

Add explicit recognition of `SET AR OK` before the generic `in`/`out` handler. The command should be silently acknowledged without sending any response:

In `kiwi_websocket.go`, before the `in`/`out` handler at line 802, add:

```go
// Handle SET AR OK command (audio resampling confirmation)
// Client sends this after successfully computing resampling parameters.
// Real KiwiSDR just records this; no response is sent.
if _, hasAR := params["AR"]; hasAR {
    if _, hasOK := params["OK"]; hasOK {
        // Silently acknowledge - no response needed
        return
    }
}
```

### Fix 2 (Critical): Remove the Malformed `audio_init` Response

The `in`/`out` handler at lines 802–813 should NOT send an `audio_init` message. Either remove the response entirely or change it to match what the real KiwiSDR does (which is nothing — `CMD_UAR` at `rx_sound_cmd.cpp` line 653 just records the values).

### Fix 3 (Minor): Send `sample_rate` as Float

Change line 1319 from:
```go
kc.sendMsg("sample_rate", fmt.Sprintf("%d", sampleRate))
```
to:
```go
kc.sendMsg("sample_rate", fmt.Sprintf("%.6f", float64(sampleRate)))
```

---

## Verification

To verify this is the issue, add logging to `handleSetCommand()` to print the raw command and parsed params when `AR` or `OK` appear in the params map. Connect a third-party client and confirm that:

1. The client sends `SET AR OK in=12000 out=48000`
2. UberSDR currently responds with a malformed `MSG audio_init=audio_rate=12000 ...`
3. After the fix, UberSDR silently acknowledges the command and audio flows correctly
