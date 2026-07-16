# OpenHPSDR Protocol Reference — Server (Radio) Perspective

> **Scope & source.** This document describes the OpenHPSDR **Protocol 1** ("Original"
> / Metis / "old protocol") and **Protocol 2** ("new protocol") *as spoken on the wire*,
> written from the point of view of a **server** — i.e. the SDR hardware / gateware, or a
> software emulation of it — that must interoperate with a client such as deskHPSDR.
>
> It was reconstructed from the deskHPSDR client implementation
> (`src/old_protocol.c`, `src/new_protocol.c`, `src/old_discovery.c`,
> `src/new_discovery.c`) and cross-checked against the bundled server simulators
> (`src/hpsdrsim.c`, `src/newhpsdrsim.c`). Byte offsets and bit masks below are exactly
> those the client emits and expects; a conforming server must produce/consume the same.
>
> deskHPSDR is a **client only**. Where the client "sends", the server **receives**, and
> vice-versa. This document flips that framing: **"Host → Radio"** = data your server
> receives; **"Radio → Host"** = data your server must produce.

---

## Table of Contents

1. [Common concepts](#1-common-concepts)
2. [Protocol 1 — Original / Metis](#2-protocol-1--original--metis)
   - [2.1 Discovery](#21-protocol-1-discovery)
   - [2.2 Metis UDP framing](#22-metis-udp-framing)
   - [2.3 Start / Stop](#23-start--stop-command)
   - [2.4 Host → Radio: the USB/C&C frame](#24-host--radio-the-usbcc-frame)
   - [2.5 Command & Control registers (C0 addresses)](#25-command--control-registers-c0-address-map)
   - [2.6 Radio → Host: the EP6 frame](#26-radio--host-the-ep6-frame)
   - [2.7 Radio → Host status banks](#27-radio--host-status-banks-c0--0)
   - [2.8 HermesLite-2 extensions (I2C / ACK)](#28-hermeslite-2-extensions)
3. [Protocol 2 — New Protocol](#3-protocol-2--new-protocol)
   - [3.1 Discovery](#31-protocol-2-discovery)
   - [3.2 Port map](#32-port-map)
   - [3.3 Sequence numbers & framing](#33-sequence-numbers--framing)
   - [3.4 Host → Radio: General registers](#34-host--radio-general-registers-port-1024)
   - [3.5 Host → Radio: RX-specific (DDC) registers](#35-host--radio-receiver-specific-ddc-registers-port-1025)
   - [3.6 Host → Radio: TX-specific (DUC) registers](#36-host--radio-transmitter-specific-duc-registers-port-1026)
   - [3.7 Host → Radio: High Priority](#37-host--radio-high-priority-port-1027)
   - [3.8 Host → Radio: TX audio](#38-host--radio-tx-speaker-audio-port-1028)
   - [3.9 Host → Radio: TX IQ (DUC)](#39-host--radio-tx-iq-duc-port-1029)
   - [3.10 Radio → Host: High Priority status](#310-radio--host-high-priority-status-port-1025)
   - [3.11 Radio → Host: Mic / Line samples](#311-radio--host-mic--line-samples-port-1026)
   - [3.12 Radio → Host: RX IQ (DDC streams)](#312-radio--host-rx-iq-ddc-streams-ports-10351042)
   - [3.13 Radio → Host: Wideband / Command response](#313-radio--host-wideband--command-response)
4. [Frequency / phase word arithmetic](#4-frequency--phase-word-arithmetic)
5. [Device IDs](#5-device-id-tables)
6. [Minimal server checklist](#6-minimal-server-implementation-checklist)

---

## 1. Common concepts

| Concept | Protocol 1 | Protocol 2 |
|---|---|---|
| Transport | UDP (default) or TCP; both on port **1024** | UDP only, **ports 1024–1042** |
| Discovery port | 1024 (broadcast + directed) | 1024 (broadcast + directed) |
| Endianness | **Big-endian** on the wire (MSB first) | **Big-endian** on the wire |
| Sample format | 24-bit signed, big-endian (I then Q) | 24-bit signed, big-endian (I then Q) |
| Mic samples | 16-bit signed big-endian, radio→host | 16-bit signed big-endian, radio→host |
| Sequence numbers | 32-bit, per-stream | 32-bit, per-stream (per port/DDC) |
| Master clock | frequencies sent in Hz; NCO conversion is in the FPGA | 122.88 MHz (phase-word arithmetic, see §4) |

**24-bit sample decode** (both protocols, identical): three bytes big-endian, sign-extended
from the top byte, then scaled by `1/2^23 = 1.1920928955078125e-7` to get a float in
roughly `[-1, 1)`:

```c
sample  = (int)((signed char) b0) << 16;   // sign-extends
sample |= ((unsigned char) b1) << 8;
sample |= ((unsigned char) b2);
double f = sample * 1.1920928955078125e-7;
```

An I/Q pair is stored **I (left) first, then Q (right)**, each 3 bytes → 6 bytes per complex sample.

---

## 2. Protocol 1 — Original / Metis

The original protocol wraps 512-byte **Ozy/USB frames** inside a small **Metis** UDP header.
Two USB frames are carried per UDP datagram. The USB frame carries a 3-byte sync, 5 control
bytes (C0–C4), and interleaved IQ + microphone samples.

Server endpoints modeled after the original Ozy USB device:

| Endpoint | Direction | Meaning |
|---|---|---|
| **EP2** | Host → Radio | Command & Control + TX IQ + speaker audio |
| **EP4** | Radio → Host | Bandscope / wideband (rarely used; not implemented by deskHPSDR) |
| **EP6** | Radio → Host | RX IQ + mic samples + C&C status |

### 2.1 Protocol 1 discovery

**Host → Radio (discovery request).** UDP to port 1024, broadcast (or directed to the radio IP,
or over TCP). Payload:

| Offset | Value | Meaning |
|---|---|---|
| 0 | `0xEF` | Metis magic |
| 1 | `0xFE` | Metis magic |
| 2 | `0x02` | **Discovery command** |
| 3 … | `0x00` | zero padding |

Length: **63 bytes** over UDP; **1032 bytes** for a TCP discovery probe. The reference server
(`hpsdrsim`) requires *exactly* 63 bytes and silently drops other lengths, so match this precisely.

**Radio → Host (discovery response).** UDP (or TCP) reply, **60 bytes**:

| Offset | Field | Notes |
|---|---|---|
| 0 | `0xEF` | magic |
| 1 | `0xFE` | magic |
| 2 | **status** | `2` = available/idle, `3` = busy (already sending to another host). deskHPSDR only accepts 2 or 3. |
| 3–8 | **MAC address** (6 bytes) | Used as the unique board identity. |
| 9 | **firmware/software version** | For HL2 this is the *major* gateware version (e.g. 73). |
| 10 | **board / device ID** | See [device tables](#5-device-id-tables). |
| 11 | HL2 config flags | Bit patterns (`0x80`/`0xA0` fixed-IP, `0x40` MAC modified) — informational. |
| 13–16 | HL2 fixed IP | Only meaningful when byte 11 flags set. |
| 17–18 | HL2 MAC low bytes | Informational. |
| 19 | number of receivers | (Simulator sets 4 for HL2.) |
| 21 | HL2 **minor** version | Client computes version = `10*byte9 + byte21` (→ 73.2 becomes 732). |

**HermesLite-2 detection quirk:** HL2 boards report `device = DEVICE_HERMES_LITE (6)` in byte 10.
The client distinguishes V1 from V2 by the composed version: `10*byte9 + byte21`. If that value
is **≥ 400**, it is treated as HL2 (`DEVICE_HERMES_LITE2`).

Any datagram whose bytes 0,1 are not `0xEF,0xFE` is ignored. Directed UDP and TCP discoveries
patch the source address into the discovered record and set `use_routing`/`use_tcp`.

### 2.2 Metis UDP framing

Every non-discovery, non-start/stop packet on port 1024 is a **1032-byte** Metis frame:

```
Offset  Size  Field
0       1     0xEF                (magic)
1       1     0xFE                (magic)
2       1     0x01                (Metis "data" type)
3       1     endpoint  (EP)      (0x02 host→radio; 6 in radio→host EP6; 4 = EP4)
4–7     4     sequence number     (32-bit big-endian, per endpoint)
8–519   512   USB frame #1        (first Ozy 512-byte frame)
520–1031 512  USB frame #2        (second Ozy 512-byte frame)
```

- **Host → Radio** always uses `EP = 0x02`. Two 512-byte C&C/TX frames per datagram.
- **Radio → Host** uses `EP = 6` (normal IQ/mic stream) or `EP = 4` (bandscope). The client
  reads `buffer[8..519]` and `buffer[520..1031]` as the two USB frames.
- The **sequence number** increments per datagram per direction. The client warns on any gap
  (`sequence != last+1`) but keeps running. A conforming server should increment monotonically.
- Over **TCP**, only full **1032-byte** payloads may be sent (the client refuses other sizes).

### 2.3 Start / Stop (command)

**Host → Radio.** UDP datagram (or 1032-byte TCP datagram) that turns the EP6/EP4 data flow on/off:

| Offset | Value | Meaning |
|---|---|---|
| 0 | `0xEF` | magic |
| 1 | `0xFE` | magic |
| 2 | `0x04` | **Start/Stop command** |
| 3 | **flags** | Bit 0 = **run** (start EP6). Bit 1 would enable EP4 bandscope. `0x00` = stop. |
| 4 … | `0x00` | padding |

Length is **64 bytes** over UDP, **1032 bytes** over TCP. On receiving `flags & 1`, the server
must begin streaming EP6 frames; on `0x00` it must stop (and, for TCP, the radio closes the
connection — deskHPSDR closes its side too).

**Reply addressing:** the host sends from an *ephemeral* UDP port. The server must record the
source IP:port of the START command and send all EP6/EP4 traffic to that address (the reference
server does exactly this).

> deskHPSDR "primes" the DUC FIFO by sending ~504 audio samples (8 Ozy buffers) *before* the
> start command, then sends `metis_start_stop(1)`. A server should tolerate C&C/TX frames
> arriving slightly before the start command.

**Firmware-maintenance commands** (type byte `0x03`, not used in normal operation): `EF FE 03 01`
= program (264 bytes), `EF FE 03 02` = erase (64 bytes), `EF FE 03` + Set-IP payload (63 bytes).

### 2.4 Host → Radio: the USB/C&C frame

Each 512-byte Ozy frame the server receives on EP2:

```
Offset  Field
0       0x7F   SYNC
1       0x7F   SYNC
2       0x7F   SYNC
3       C0     command/address byte  (see below)
4       C1     command data 1
5       C2     command data 2
6       C3     command data 3
7       C4     command data 4
8..511  payload: TX IQ + speaker-audio samples
```

**C0 semantics (host→radio):**
- **Bit 0 = MOX** (transmit request). Set means "go to TX". deskHPSDR sets it whenever
  transmitting, except pure "CW-in-radio" where the FPGA keys itself.
- **Bits 1–7 = register address** (the C&C "command"). Addresses are **even** (`0x00, 0x02, 0x04 …`);
  the low bit is stolen for MOX. So e.g. `C0 = 0x12` addresses register `0x12` (RX with MOX off),
  and `C0 = 0x13` is the same register with MOX on.

**Payload (bytes 8–511):** exactly **63 frames of 8 bytes** (`504 / 8`), each frame:

```
L_hi L_lo  R_hi R_lo  I_hi I_lo  Q_hi Q_lo
```

- **L/R** = 16-bit signed big-endian speaker (headphone) audio at 48 kHz.
- **I/Q** = 16-bit signed big-endian TX (DUC) samples at 48 kHz.
- During **RX**, the host sends real audio and zeroed I/Q; during **TX**, real I/Q while L/R carry
  the CW sidetone (both channels get the same value).
- **HL2 quirks:** the HL2 firmware repurposes the audio slots for extended addressing, so the host
  sends **zeroed L/R** to an HL2 (unless it has the optional audio codec). Additionally, the LSB of
  each 16-bit I and Q sample is cleared (`& 0xFE` on the low byte) because the HL2 "CWX" gateware
  interprets IQ LSBs as keying bits.

The two C&C frames per datagram **alternate**: one frame carries `C0 = 0x00` (the "settings"
packet) and the next carries a rotating command (`0x02, 0x04, …`). This is the "metis_offset"
round-robin — see below.

### 2.5 Command & Control registers (C0 address map)

The client emits one non-zero command per USB frame, cycling through this list ("round-robin").
A server must decode each. All values are the **register address** (C0 with MOX bit masked off).

| C0 (addr) | Purpose | Key fields |
|---|---|---|
| **0x00** | **Settings / config** (sent every other frame) | C1: bits0-1 sample rate (0=48k,1=96k,2=192k,3=384k), bits2-3 10 MHz ref source (0=Atlas,1=Penelope,2=Mercury), bit4 122.88 MHz source (0=Penelope,1=Mercury), bits5-6 board config (`CONFIG_PENELOPE 0x20`, `CONFIG_MERCURY 0x40`), bit7 mic source (1=Penelope). C2: bit0=Class-E, bits1-7 open-collector (OC) outputs. C3: bits0-1 ALEX attenuator (0/10/20/30 dB), bit2 preamp/`LT2208_GAIN`, bit3 dither, bit4 random, bits5-6 ALEX RX antenna (EXT2/EXT1/XVTR), bit7 ALEX RX_OUT. C4: bits0-1 TX antenna (ANT1/2/3), bit2 duplex (deskHPSDR always sets it), bits3-5 = `num_receivers − 1`, bit6 mic time-stamping, bit7 Common Mercury Frequency (phase-syncs RX1/RX2, forces same freq — used for diversity). |
| **0x02** | **TX (DUC) frequency** | C1..C4 = 32-bit DUC frequency (Hz), big-endian. |
| **0x04** | **RX1 (DDC0) frequency** | C1..C4 = 32-bit frequency (Hz), big-endian. |
| **0x06 – 0x10** | **RX2…RX7 frequency** | General form: `C0 = 0x04 + 2*rx_index`, rx_index 0–6 → **max 7 receivers**. (0x06=RX2, 0x08=RX3, 0x0A=RX4, 0x0C=RX5, 0x0E=RX6, 0x10=RX7.) |
| **0x12** | **Drive level / filters** | C1 = TX drive (0-255, 0 if out-of-band). C2: bit0 mic boost, bit1 line-in, bit2 Apollo filter, bit3 Apollo tuner, bit4 Apollo auto-tune, bit5 select Alex(0)/Apollo(1), bit6 ALEX manual HPF/LPF, bit7 VNA mode. C3: bits0-4 ALEX HPF selection, bit5 bypass HPFs, bit6 6m LNA, bit7 ALEX T/R relay disable. C4: ALEX LPF selection (bit per filter: `0x10`=6m, `0x20`=10/12m, `0x40`=17/15m, `0x01`=30/20m, `0x02`=60/40m, `0x04`=80m, `0x08`=160m). **HL2:** C2 bit2=Q5 ext-PTT switch, bit3=PA enable, bit4=AH-4 tune request; C3/C4 cleared. |
| **0x14** | **Mic / preamp / bias / attenuator** | C1: bits0-3 preamp per ADC1-4, bit4 tip/ring select, bit5 mic bias, bit6 mic-PTT disable. C2: bits0-4 line-in gain (0-31), bit5 Mercury-1 att on TX, bit6 PureSignal, bit7 Penelope select. C3: bits0-3 Metis DB9 outputs, bit4 Mercury-2 att on TX. C4: ADC0 step attenuator — standard: bits0-4 value + bit5 enable (`0x20 + att`); **HL2:** bit6 set = 6-bit gain format, value 0-60 ↦ RX gain −12…+48 dB. |
| **0x16** | **ADC1 attenuator / CW keyer** | C1: bits0-4 ADC1 step att (`0x20 + value` from deskHPSDR). C2: bit6 CW keys reversed. C3: bits0-5 keyer speed (WPM), bits6-7 keyer mode. C4: bits0-6 keyer weight, bit7 keyer spacing. |
| **0x18** | Charly25 extension board | C1:C2 = 16-bit I2C data for the C25 (RedPitaya) extension board. Not sent by deskHPSDR. |
| **0x1C** | **RX ADC assignment / TX attenuation** | C1: 2-bit ADC selector for RX1-4 (bits0-1, 2-3, 4-5, 6-7). C2: 2-bit ADC selector for RX5-7. C3: TX-time ADC0 attenuation — standard: bits0-4 (`0x1F` when PA on; PureSignal uses `transmitter->attenuation`); **HL2:** bit7 enable TX att, bit6 full-range format, value 0-60 ↦ TXATT +31…−29 dB (deskHPSDR sends `0xC0 + rxgain`). |
| **0x1E** | **CW config** | C1 bit0 = CW-internal (keyer in FPGA) enable. C2 = sidetone volume. C3 = RF delay (PTT→key), ms. |
| **0x20** | **CW hang / sidetone freq** | hang time (10-bit) = `(C1<<2) + (C2 & 0x03)`; sidetone frequency (12-bit) = `(C3<<4) + (C4 & 0x0F)`. |
| **0x22** | **PWM (EER)** | PWM min (10-bit) = `(C1<<2) + (C2 & 0x03)`, PWM max (10-bit) = `(C3<<2) + (C4 & 0x03)`. |
| **0x24** | **ALEX2 / Orion-II** | C1: bits0-6 ADC2/Alex2 BPF settings (bit5 `0x20`=bypass), bit7 ground RX2 input on TX. C2: bit1 `0x02`=ANAN-7k/8k XVTR enable, bit6 `0x40`=ANAN-7000 PureSignal flag (sync RX5/TX). C3:C4 = firmware envelope gain (16-bit, EER). |

After `0x24`, standard radios roll back to `0x02`. **HL2** continues into the extended command set
(`0x2E`, plus I2C ops `0x78/0x7A/0xFA`) — see §2.8.

### 2.6 Radio → Host: the EP6 frame

The server must stream EP6 frames (inside Metis type `0x01`, `EP = 6`). Each 512-byte USB frame:

```
Offset  Field
0       0x7F  SYNC
1       0x7F  SYNC
2       0x7F  SYNC
3       C0    status/address byte (see §2.7)
4       C1    status data
5       C2    status data
6       C3    status data
7       C4    status data
8..511  IQ samples for each active RX, then a mic sample, repeated
```

**Payload layout.** After the 5 control bytes, samples repeat. For each "round":
- For each active receiver (`num_hpsdr_receivers`), an I/Q pair: **I (3 bytes) then Q (3 bytes)**.
- Then **one 16-bit mic sample** (big-endian).

The number of complete rounds per frame is:
```
iq_samples = (512 - 8) / (num_receivers * 6 + 2)
```
e.g. 1 RX → `504/8 = 63` samples; 2 RX → `504/14 = 36` samples. The client decodes exactly this
and no more, so a server must pack this precisely. `num_hpsdr_receivers` must match what the host
requested via C4 of the `0x00` settings packet.

Mic samples are decimated to 48 kHz by the client (`mic_sample_divisor`), but the server sends
them at whatever the frame cadence dictates.

**PureSignal feedback channels (P1).** During PureSignal TX the host raises the receiver count
(C4 of the `0x00` packet) because the firmware hard-wires the feedback signals to fixed RX slots.
The server must deliver, on those EP6 channels:

| Device | # RX during PS | RX-feedback channel | TX(DAC)-feedback channel |
|---|---|---|---|
| Metis, HermesLite V1, Ozy | 2 | RX1 (index 0) | RX2 (index 1) |
| Hermes (but Anan-10E/100B behave like Metis) | 4 | RX3 (index 2) | RX4 (index 3) |
| STEMlab, HermesLite 2 | 4 | RX3 (index 2) | RX4 (index 3) |
| Angelia, Orion, Orion2 | 5 | RX4 (index 3) | RX5 (index 4) |

### 2.7 Radio → Host status banks (C0 = 0…)

In the EP6 frame's C0 byte:
- **Bit 0 = PTT** (radio-originated transmit request, e.g. front-panel/foot-switch).
- **Bit 1 = DASH** (CW paddle dash), **Bit 2 = DOT** (CW paddle dot). ⚠ Protocol 2 reports these
  in the opposite order (bit1 = DOT, bit2 = DASH).
- **Bits 3–7 = status bank selector** (`(C0>>3) & 0x1F`). The bank determines what C1–C4 carry:

| Bank `(C0>>3)&0x1F` | C1 | C2 | C3 | C4 |
|---|---|---|---|---|
| **0** | ADC0 overload (bit0); Hermes IO1-4 inputs (TxInhibit/AutoTune, active-low) | Mercury sw version | Penelope sw version; **HL2:** TX-FIFO under/overflow (bits6-7 of C3): `0x80`=underrun, `0xC0`=overrun | Ozy/FPGA firmware version |
| **1** | exciter power hi | exciter power lo (HL2: C1/C2 = temperature) | ALEX forward power hi | ALEX forward power lo |
| **2** | reverse power hi | reverse power lo | ADC0 (AIN) hi | ADC0 lo |
| **3** | ADC1 (AIN) hi | ADC1 lo | — | — |
| **4** | ADC0 overload (bit0); Mercury1 version (`C1>>1`) | ADC1 overload (bit0); Mercury2 version | — | — |

A server should cycle these banks so the host can read power/SWR/overload/version telemetry.
Banks 1–3 carry 16-bit analog readings (the client does a 16-tap moving average).

For **HermesLite-2**, bit 7 of C0 in the EP6 status frame means "this is an **I2C/ACK response**"
rather than a normal status bank — see next section.

### 2.8 HermesLite-2 extensions

HL2 uses the reserved upper command space for I2C access to on-board and IO-board peripherals,
plus an extended C&C command `0x2E`.

**Extended command 0x2E (host→radio):** C3 = PTT hang time (bits 0-4), C4 = TX latency in ms.
Interleaved with the following I2C operations in a round-robin.

**I2C command bytes (host→radio, in C0):**

| C0 | Meaning |
|---|---|
| `0x78` | I2C-1 write, **no ACK** |
| `0x7A` | I2C-2 write, **no ACK** |
| `0xFA` | I2C-2 read/write, **with ACK** (radio replies in an EP6 status frame with C0 bit7 set) |

For an I2C op, C1 = `0x06` (write) or `0x07` (read), C2 = `0x80 | i2c_addr` (e.g. `0x80|0x1D` for
the N2ADR IO board, `0x80|0x41` for the PCA9536 board-detect chip), C3 = register, C4 = data.

**IO-board registers used by deskHPSDR (via I2C addr 0x1D):**

| Reg | Meaning |
|---|---|
| 0 | TX frequency byte 4 (bits 32-39) |
| 1 | TX frequency byte 3 (bits 24-31) |
| 2 | TX frequency byte 2 (bits 16-23) |
| 3 | TX frequency byte 1 (bits 8-15) |
| 4 | TX frequency byte 0 (bits 0-7) — writing this latches the 40-bit value |
| 7 | `REG_ANTENNA_TUNER` — AH-4 tuner control/status (read with `0xFA`) |
| 11 | `REG_RF_INPUTS` — RF input mode (0/1/2) |
| 13 | `REG_FCODE_RX1` — VFO-A frequency code (`round(15.47*ln(f/18748.1))`) |
| 14 | `REG_FCODE_RX2` — VFO-B frequency code |
| 33 | `REG_LPF_DETECT` — used to detect a Pico-based board |
| 34 | `REG_LPF_STATUS` — LPF bitmask (bit per band) |

**ACK / readback (radio→host):** In an EP6 status frame with **C0 bit7 set**, the I2C address is
`(C0 & 0x7E) >> 1`. The client recognizes:
- **Board detect:** addr `0x3D` with C1=C2=C3=C4 = `0xF1` → an IO board (PCA9536) is present.
- **Pico detect:** addr `0x3D`, C4 = `0xEF` in response to a `REG_LPF_DETECT` (33) read.
- **Tuner status readback:** addr `0x3D`, C4 = tuner status (`0x00`=success, `0xEE`="send RF",
  `≥0xF0`=error code).

**CL1/CL2 clock reprogramming:** deskHPSDR can send 24 register/data pairs via `0x78` I2C-1 writes
to reprogram the HL2's CL1 input / CL2 output as a 10 MHz reference (see the `HL2CL1on/off` tables).

---

## 3. Protocol 2 — New Protocol

Protocol 2 replaces the single-port Metis stream with **multiple UDP ports**, one per data type,
and larger (up to 1444-byte) packets. There is no USB framing and no C0/C1-C4 abstraction — instead,
fixed-layout **register packets** at known byte offsets.

### 3.1 Protocol 2 discovery

**Host → Radio (request).** UDP to port 1024 (broadcast or directed), **60 bytes**:

| Offset | Value |
|---|---|
| 0–3 | `0x00 0x00 0x00 0x00` |
| 4 | `0x02` — **discovery command** |
| 5–59 | `0x00` padding |

The reference server requires the request to be *exactly 60 bytes* with bytes 0–3 zero. Byte 4 is
a general command selector on port 1024: `0x02` = discovery, `0x04` = **erase firmware**,
`0x05` = **program firmware** (265-byte packets) — the latter two matter only for flashing tools.

**Radio → Host (response).** **60-byte** UDP reply. The client distinguishes it from a P2 *data* stream by
length: a **1444-byte** packet is treated as a running data stream and skipped during discovery;
the discovery reply is a shorter packet whose bytes 0–3 are all zero:

| Offset | Field | Notes |
|---|---|---|
| 0–3 | `0x00 0x00 0x00 0x00` | fixed |
| 4 | **status** | `2` = available, `3` = busy/sending. |
| 5–10 | **MAC address** (6 bytes) | board identity |
| 11 | **board / device ID** | client adds 1000 → `NEW_DEVICE_*` (e.g. 6 → HermesLite). |
| 12 | supported P2 version | e.g. 39 → v3.9 (informational) |
| 13 | firmware/software version | HL: `<40` = V1, `≥40` = V2 |
| 20 | number of DDCs | informational |
| 23 | beta/patch version | e.g. major 2.1 + byte23=18 → 2.1.18 |

### 3.2 Port map

All host↔radio traffic is UDP. Ports are fixed:

**Host → Radio (radio must listen on):**

| Port | Stream |
|---|---|
| **1024** | General registers (also the firmware-programming port) |
| **1025** | Receiver-specific (DDC) registers |
| **1026** | Transmitter-specific (DUC) registers |
| **1027** | High-Priority (fast) registers |
| **1028** | TX speaker/RX audio to radio |
| **1029** | TX IQ (DUC) samples to radio |

**Radio → Host (radio sends from these source ports):**

| Port | Stream |
|---|---|
| **1024** | Command response (e.g. firmware programming) |
| **1025** | High-Priority status (PTT, power, overload) |
| **1026** | Mic / Line samples |
| **1027** | Wideband / bandscope |
| **1035–1042** | RX IQ for DDC 0–7 (port `1035 + ddc`) |

The client demultiplexes purely by **UDP source port** (`ntohs(addr.sin_port)`), so the radio must
send each stream *from* the correct source port.

**Reply addressing:** the host sends all its packets from a *single ephemeral* UDP port. The
server must record the source IP:port of the received **General packet** and send **every**
radio→host stream to that one destination — streams are distinguished only by the radio's
*source* port, never by destination port.

### 3.3 Sequence numbers & framing

Every host→radio and radio→host packet begins with a **4-byte big-endian sequence number**
(bytes 0–3), independent per stream/port/DDC. The client:
- increments its own outgoing sequence per stream,
- checks incoming sequences and logs `SeqErr` on any mismatch (but keeps running),
- resets expected sequence to whatever it receives after an error.

A conforming server should start each stream's sequence at 0 and increment by 1 per packet.

**Packet lengths are strict.** The reference server rejects register packets of the wrong size:
General = 60, RX-specific = 1444, TX-specific = 60, High-Priority = 1444, Audio = 260,
TX-IQ = 1444 bytes.

**Refresh cadence / keep-alive.** Besides event-driven sends, deskHPSDR re-sends all register
packets periodically: High-Priority every **100 ms**, RX-specific and TX-specific every **200 ms**,
General every **800 ms**. A server can rely on this refresh to recover lost state, and the
reference server runs a watchdog that shuts the radio down when host packets stop arriving.

### 3.4 Host → Radio: General registers (port 1024)

Fixed **60-byte** packet. Sent whenever global config changes. This packet also carries a
**port-assignment table** — every stream's UDP port can be reprogrammed here, and a value of **0
means "use the default port"**. deskHPSDR leaves all of these zero, so the defaults in §3.2 apply,
but a fully conformant server must honor overrides. Full layout (from the `newhpsdrsim` reference):

| Offset | Field | Default if 0 |
|---|---|---|
| 0–3 | sequence number | — |
| 5–6 | RX-specific (DDC) **receive** port | 1025 |
| 7–8 | TX-specific (DUC) **receive** port | 1026 |
| 9–10 | High-Priority **receive** port | 1027 |
| 11–12 | High-Priority **send** port (radio→host) | 1025 |
| 13–14 | Audio **receive** port | 1028 |
| 15–16 | TX-IQ (DUC) **receive** base port | 1029 |
| 17–18 | RX-IQ (DDC) **send** base port | 1035 |
| 19–20 | Mic data **send** port | 1026 |
| 21–22 | Wideband **send** port | 1027 |
| 23 | **Wideband enable** flag | — |
| 24–25 | Wideband packet length (samples) | 512 |
| 26 | Wideband sample size (bits) | 16 |
| 27 | Wideband sample rate | — |
| 28 | Wideband PPF (polyphase-filter taps) | — |
| 29–30 | Memory-mapped registers **receive** port | — |
| 31–32 | Memory-mapped registers **send** port | — |
| 33–34 | PWM min | — |
| 35–36 | PWM max | — |
| 37 | **frequency mode**: `0x08` = phase word (not raw Hz) for DDC/DUC words | — |
| 38 | `0x01` = enable hardware timer | — |
| 58 | **PA / tuner enable**: bit0 `0x01` = enable PA; bit1 `0x02` = enable APOLLO tuner | — |
| 59 | **ALEX enable**: `0x01` = enable Alex 0; `0x03` = enable Alex 0 **and** 1 (Orion2/Saturn) | — |

The `general` packet arms the PA, tuner, and ALEX filter boards, selects phase-word frequency mode,
configures the wideband/bandscope stream, and (optionally) remaps every UDP port. The client only
ever sets bytes 37, 38, 58, 59; everything else stays zero (→ defaults). Note byte 37 is a bit
field: **bit3 (`0x08`)** selects phase-word mode.

**Connection start:** receiving a General packet on port 1024 is what *boots* the P2 engine in the
reference server (it distinguishes it from discovery/erase/program by byte 4 = `0x00` and starts
its high-priority listener). Actual streaming is then gated by the **run bit** (High-Priority
byte 4, bit 0): run=1 starts the DDC/mic/status streams, run=0 stops the radio.

### 3.5 Host → Radio: Receiver-specific (DDC) registers (port 1025)

Fixed **1444-byte** packet describing all DDCs (down-converters). Layout:

| Offset | Field |
|---|---|
| 0–3 | sequence number |
| 4 | **number of ADCs** (`n_adc`) |
| 5 | **dither** enable, one bit per ADC (`bit adc`) |
| 6 | **random** enable, one bit per ADC |
| 7 + ddc/8 | **DDC enable** bitmap: bit `ddc % 8` of byte `7 + ddc/8` (byte 7 covers DDC 0–7, byte 8 covers DDC 8–15) |
| 17 + 6·ddc | ADC number feeding this DDC |
| 18–19 + 6·ddc | sample rate in **kHz**, 16-bit big-endian (e.g. 192 kHz → `0x00 0xC0`) |
| 22 + 6·ddc | bits per sample (always **24**) |
| 1363 + ddc | **per-DDC sync bitmap**: bit *n* set = DDC *ddc* is synchronized with DDC *n*. deskHPSDR sets byte 1363 (DDC0's map) to `0x02` → DDC0 synced with DDC1 (PureSignal & diversity). Real hardware (and the reference server) only supports one synced partner per DDC. |

DDC↔ADC↔receiver mapping depends on device: for HERMES, receiver *i* → DDC *i*; for
ANGELIA/ORION/ORION2/SATURN, receiver *i* → DDC *i+2*. PureSignal uses DDC0 (RX feedback) and DDC1
(TX feedback), both at 192 kHz, synced. Diversity uses DDC0 (ADC0) + DDC1 (ADC1), synced.
The packet must be exactly 1444 bytes.

### 3.6 Host → Radio: Transmitter-specific (DUC) registers (port 1026)

Fixed **60-byte** packet:

| Offset | Field |
|---|---|
| 0–3 | sequence number |
| 4 | number of DACs (`1`) |
| 5 | **CW control**: bit1 `0x02`=CW-in-radio, bit2 `0x04`=keys reversed, `0x08`=Mode A, `0x28`=Mode B, `0x10`=sidetone on, `0x40`=spacing, `0x80`=break-in |
| 6 | CW sidetone volume (0-127) |
| 7–8 | CW sidetone frequency (16-bit) |
| 9 | CW keyer speed (WPM) |
| 10 | CW keyer weight |
| 11–12 | CW keyer hang time (16-bit) |
| 13 | RF delay (PTT→key), ms |
| 14–15 | TX (DUC) sample rate in kHz, 16-bit (should be 192; deskHPSDR sends 0 → firmware default) |
| 16 | TX IQ bit width (should be 24; deskHPSDR sends 0 → default) |
| 17 | CW ramp width, ms |
| 50 | **Mic config**: `0x01`=line-in, `0x02`=boost, `0x04`=mic-PTT disabled, `0x08`=tip/ring bias, `0x10`=mic bias, `0x20`=XLR input (Saturn) |
| 51 | line-in gain (0-31 → −34.0…+12.5 dB in 1.5 dB steps) |
| 57 | ADC2 step attenuator during TX |
| 58 | ADC1 step attenuator during TX (31 when PA on) |
| 59 | ADC0 step attenuator during TX (31 when PA on; PureSignal → `transmitter->attenuation`) |

The packet must be exactly 60 bytes.

### 3.7 Host → Radio: High Priority (port 1027)

Fixed **1444-byte** packet, sent event-driven (immediately on PTT edges, tuning, menu changes)
plus a 100 ms periodic refresh. This is the latency-critical control channel. Key offsets:

| Offset | Field |
|---|---|
| 0–3 | sequence number |
| 4 | **run / PTT**: bit0 = **running** flag (`P2running`), bit1 `0x02` = MOX/TX request |
| 5 | **host CW keying (CWX)**: bit0 = CWX (host-keyed CW active), bit1 = DOT, bit2 = DASH. deskHPSDR leaves this 0, but servers must decode it. |
| 9 + 4·ddc | **DDC phase/frequency word** (32-bit big-endian) for DDC *ddc* |
| 329–332 | **DUC (TX) phase/frequency word** (32-bit) |
| 345 | **TX drive level** (0-255; 0 if out of band) |
| 1398–1399 | RigCtl/CAT TCP port (16-bit; 0 if disabled) |
| 1400 | Orion2/Saturn: XVTR-out relay & speaker-amp mute bits |
| 1401 | **Open-Collector outputs** (`OCtx`/`OCrx` << 1) |
| 1402 | DB9 outputs (not used by deskHPSDR) |
| 1403 | Mercury attenuators (not used by deskHPSDR) |
| 1428–1431 | **ALEX1** control word (32-bit, filters/antenna) |
| 1432–1435 | **ALEX0** control word (32-bit, filters/antenna) |
| 1442 | ADC1 step attenuator (RX); 31 on TX w/ PA; `transmitter->attenuation` w/ PureSignal |
| 1443 | ADC0 step attenuator (RX) |

The packet must be exactly 1444 bytes — the reference server rejects other lengths. Note the
firmware combines the ADC0 step attenuator with the ALEX attenuator bits (ALEX0 bits 13/14 add
20/10 dB) except on Orion2/Saturn, which have no ALEX attenuator.

The **phase word** at offset 9 (and TX at 329) is the frequency expressed as a phase increment —
see §4. Because byte 37 of the *general* packet selected phase mode, these are phase words rather
than raw Hz.

### 3.8 Host → Radio: TX speaker audio (port 1028)

Fixed **260-byte** packet = 4-byte sequence + **256 bytes** payload = **64 stereo samples**, each
sample being L(16-bit) + R(16-bit) big-endian. Ideally one packet every ~1333 µs (64 samples @ 48 kHz).
The client paces sending using an estimated FIFO fill level; the server should tolerate small bursts.

### 3.9 Host → Radio: TX IQ (DUC) (port 1029)

Fixed **1444-byte** packet = 4-byte sequence + **1440 bytes** payload = **240 complex samples**,
each 3-byte I + 3-byte Q big-endian (6 bytes). Ideally one packet every ~1250 µs (240 samples @ 192 kHz).
Sent only while transmitting.

### 3.10 Radio → Host: High Priority status (port 1025)

The server sends this as a **60-byte** packet **from source port 1025**. Cadence: ~every **1 ms
during TX**, ~every **50 ms during RX** — and immediately whenever a digital input (PTT, key, IO
line) changes. Layout:

| Offset | Field |
|---|---|
| 0–3 | sequence number |
| 4 | **status bits**: bit0 = PTT, bit1 = **DOT**, bit2 = **DASH** (⚠ opposite order to Protocol 1!), bit5 `0x20` = TX-FIFO underrun, bit6 `0x40` = TX-FIFO overrun |
| 5 | **ADC overload**: bit0 = ADC0, bit1 = ADC1 |
| 6–7 | exciter power (16-bit) |
| 14–15 | ALEX forward power (16-bit) |
| 22–23 | ALEX reverse power (16-bit) |
| 49–50 | supply voltage (16-bit) |
| 51–52 | AIN ADC3 (16-bit) |
| 53–54 | AIN ADC2 (16-bit) |
| 55–56 | AIN ADC1 (16-bit) |
| 57–58 | AIN ADC0 (16-bit) |
| 59 | **digital user inputs** (active-low lines): bit0 = IO4, bit1 = IO5, bit2 = IO6, bit3 = IO8, bit4 = IO2. Client usage: TxInhibit = IO4 (IO5 on Orion2/Saturn), AutoTune = IO6; Orion2/Saturn report the keyer CW input in bit3 (active-high). |

The client makes a 16-tap moving average of the power/analog fields. A PTT rising edge from the radio
triggers an immediate outgoing High-Priority packet from the host.

### 3.11 Radio → Host: Mic / Line samples (port 1026)

Sent **from source port 1026**. Layout:

| Offset | Field |
|---|---|
| 0–3 | sequence number |
| 4 … | **64 mic samples**, each 16-bit signed big-endian (`MIC_SAMPLES = 64`) |

So the minimum useful packet is `4 + 64*2 = 132` bytes. Ideally one packet every ~1333 µs.

### 3.12 Radio → Host: RX IQ (DDC streams) (ports 1035–1042)

DDC *n* streams from **source port `1035 + n`**. Each packet:

| Offset | Field |
|---|---|
| 0–3 | sequence number |
| 4–11 | 64-bit timestamp (phase/time counter) |
| 12–13 | bits per sample (24) |
| 14–15 | **samples per frame** (16-bit) — the client trusts this count |
| 16 … | IQ samples: for each sample, I(3 bytes) + Q(3 bytes) big-endian |

The client reads exactly `samplesperframe` complex samples starting at offset 16. Packet size is
therefore `16 + 6*samplesperframe` (commonly 1444 bytes → 238 samples).

- **Normal RX:** one DDC per receiver.
- **Diversity / PureSignal (synced DDC pair):** the two synced DDCs are delivered *interleaved in a
  single stream* — the client's `process_div_iq_data`/`process_ps_iq_data` reads `I0 Q0 I1 Q1` per
  step (12 bytes), stepping `i += 2`. So when DDC1 is synced to DDC0, samples for both arrive on the
  DDC0 port, interleaved.

**Software ADC-overload detection:** the client flags overload if any decoded sample exceeds
`P2_SOFT_ADC_OVF_*_THRESHOLD`, independent of the hardware overload bit.

### 3.13 Radio → Host: Wideband / Command response

- **Command response (source port 1024):** used during firmware programming. deskHPSDR silently
  drops these in normal operation.
- **Wideband / bandscope (source port 1027):** defined by the protocol; deskHPSDR routes it through
  its buffer machinery but a standard receive path is not exercised for everyday operation.

---

## 4. Frequency / phase word arithmetic

Both protocols express tuning as a 32-bit phase increment for a DDS/NCO clocked at the master clock.

**Protocol 2 DDC & DUC phase word** (from `p2_write_ddc_frequency_word`):

```
phase = frequency_Hz * 34.952533333333333333...
      = frequency_Hz * (2^32 / 122880000)
```

i.e. `phase = round(freq * 2^32 / 122.88e6)`, written big-endian into 4 bytes. Both RX (DDC) and
TX (DUC) use the same constant. This is why the *general* packet sets byte 37 = `0x08` (phase-word
mode) — the high-priority frequency fields are phase increments, not Hz.

**Protocol 1** sends the frequency directly as a 32-bit **Hz** value in C1–C4 of the `0x02`/`0x04…`
commands; the FPGA converts internally. (HL2 IO-board frequency codes use the logarithmic
`round(15.47*ln(f/18748.1))` mapping for coarse band switching only.)

---

## 5. Device ID tables

**Protocol 1** (discovery byte 10 → `discovered.device`):

| ID | Device | RX range (client) |
|---|---|---|
| 0 | METIS | 0 – 61.44 MHz |
| 1 | HERMES | 0 – 61.44 MHz |
| 2 | GRIFFIN | 0 – 61.44 MHz |
| 4 | ANGELIA | 0 – 61.44 MHz |
| 5 | ORION | 0 – 61.44 MHz |
| 6 | HERMES_LITE (V1; V2 promoted to 506) | 0 – 38.4 MHz |
| 7 | OZY (USB) | — |
| 10 | ORION2 | 0 – 61.44 MHz |
| 100 | STEMLAB (RedPitaya) | 0 – 61.44 MHz |
| 101 | STEMLAB_Z20 | 0 – 61.44 MHz |
| 506 | HERMES_LITE2 (derived) | 0 – 38.4 MHz |

**Protocol 2** (discovery byte 11, then `+1000`):

| Wire ID | `NEW_DEVICE_*` | Name |
|---|---|---|
| 0 | 1000 | ATLAS |
| 1 | 1001 | HERMES |
| 2 | 1002 | HERMES2 |
| 3 | 1003 | ANGELIA |
| 4 | 1004 | ORION |
| 5 | 1005 | ORION2 |
| 6 | 1006 / 1506 | HERMES_LITE (V1) / HERMES_LITE2 (V2, sw ≥ 40) |
| 10 | 1010 | SATURN / G2 |

**Discovery status byte:** `2` = available, `3` = busy/sending (both protocols). `4` would be
"incompatible" in the client's state enum.

---

## 6. Minimal server implementation checklist

**Protocol 1 server:**
1. Listen on UDP **1024**. Reply to `EF FE 02` discovery with the 60-byte response (status, MAC,
   version, device ID).
2. On `EF FE 04` with bit0 set, start streaming; on `00`, stop.
3. Parse incoming `EF FE 01 02 <seq> <512> <512>` frames: decode the `7F 7F 7F C0 C1..C4` header of
   each 512-byte frame; apply MOX (C0 bit0) and the register in C0 bits1-7; consume TX-IQ/audio payload.
4. Stream `EF FE 01 06 <seq> <512> <512>` EP6 frames: `7F 7F 7F` + status C0 (PTT/dot/dash + bank) +
   C1-C4 telemetry + `iq_samples` rounds of (per-RX I/Q) + mic sample. Match `num_receivers` and
   `sample_rate` requested in the `C0=0x00` settings packet.
5. Increment the per-direction Metis sequence number.

**Protocol 2 server:**
1. Listen on UDP **1024**. Reply to `00 00 00 00 02` discovery with the response (status, MAC,
   device ID, versions, DDC count).
2. Listen on **1024–1029** for General / RX-specific / TX-specific / High-Priority / Audio / TX-IQ.
3. Honor the **run flag** (High-Priority byte 4 bit0). Program DDCs from the RX-specific packet and
   tuning from the High-Priority phase words.
4. Stream RX IQ from source ports **1035+ddc**, High-Priority status from **1025**, mic from **1026**,
   each with its own 4-byte sequence number.
5. Use the phase-word arithmetic (`freq * 2^32 / 122.88e6`) for DDC/DUC tuning.

---

*Generated from the deskHPSDR source tree. Offsets/masks reflect the client as of the version in
this repository; when in doubt, `src/old_protocol.c` and `src/new_protocol.c` are authoritative, and
`src/hpsdrsim.c` / `src/newhpsdrsim.c` are working server references.*
