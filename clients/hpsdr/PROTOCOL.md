This protocol is based on the original protocol1 from openHPSDR consisting of [USB_protocol_V document](https://github.com/TAPR/OpenHPSDR-SVN/tree/master/Documentation) and [Metis](https://github.com/TAPR/OpenHPSDR-Firmware/tree/master/Protocol%201/Documentation). It is intended to remain compatible with a core subset of the openHPSDR protocol such that the Hermes-Lite2 may operate in basic mode with standard openHPSDR software.

The Hermes-Lite2 will use Board_ID 0x06.

## Data from PC to Hermes-Lite2

## Discovery, Start, Stop

There is no change to the Metis Discovery packet <0xEFFE><0x02><60 bytes of 0x00>, but the Reply packet is extended. See below. The Metis Start packet is <0xEFFE><0x04>< Command><60 bytes of 0x00> where Command
bit[0] starts the radio and bit[1] starts the wideband data as in protocol 1. The HL2 also uses bit[7] to disable the internal watchdog timer. The watchdog timer requires that the host computer send regular commands to keep the HL2 running. This ensures that the HL2 doesn't continue sending data if the host computer program crashes. Setting bit[7] disables this feature. It is useful for some receive-only programs such as CW skimmer.
The Metis Stop packet is <0xEFFE><0x04>< Command><60 bytes of 0x00> where Command bit[0] clear stops
the radio, bit[1] clear stops the wideband data and bit[7] is as above.

### Interpretation of Original Protocol Command & Control

| Command & Control | Bits | Description |
| ------------- | ------------- | ----- |
| C0 | [7] | | RQST |
|    | [6:1] | ADDR[5:0] |
|    | [0] | MOX (1 = active, 0 = inactive) |
| C1 | [7:0] | DATA[31:24] |
| C2 | [7:0] | DATA[23:16] |
| C3 | [7:0] | DATA[15:8]  |
| C4 | [7:0] | DATA[7:0]   |


### Base Memory Map

This table shows the Hermes-Lite2 64 word memory map. These 64 addresses correspond to the first 64 addresses of the original openHPSDR's 128 address space. Since only 17 addresses are currently in use by the original openHPSDR protocol, no existing funtionality is left uncovered. Instead of the full address space, Hermes-Lite2 repurposes C0[7] to serve as a request bit, RQST. If this bit is set, the Hermes-Lite2 will respond as described later. If this bit is not set, the Hermes-Lite2 will cycle through the standard openHPSDR responses as specified in the original protocol.

Please refer to the [original openHPSDR protocol](https://github.com/TAPR/OpenHPSDR-SVN/tree/master/Documentation) when adding or repurposing locations. As of version 1.58, openHPSDR defines uses for addresses from 0x00 up to and including 0x11.

| ADDR | DATA    | Description |
| ---- | ------- | ----------- |
| 0x00 | [25:24] | Speed (00=48kHz, 01=96kHz, 10=192kHz, 11=384kHz) |
| 0x00 | [23:17] | openHPSDR Open Collector Outputs; see Filter Selection below |
| 0x00 | [13] | openHPSDR Rx Antenna; see Filter Selection below |
| 0x00 | [12] | FPGA-generated power supply switching clock (0=on, 1=off) |
| 0x00 | [11] | Fan or Band Volts PWM (0=Fan, 1=Band Volts) |
| 0x00 | [10] | VNA fixed RX Gain (0=-6dB, 1=+6dB) |
| 0x00 | [6:3] | Number of Receivers (0000=1 to max 1011=12) |
| 0x00 | [2] | Duplex (0=off, 1=on) |
| 0x01 | [31:0] | TX1 NCO Frequency in Hz |
| 0x02 | [31:0] | RX1 NCO Frequency in Hz |
| 0x03 | [31:0] | If present, RX2 NCO Frequency in Hz |
| 0x04 | [31:0] | If present, RX3 NCO Frequency in Hz |
| 0x05 | [31:0] | If present, RX4 NCO Frequency in Hz |
| 0x06 | [31:0] | If present, RX5 NCO Frequency in Hz |
| 0x07 | [31:0] | If present, RX6 NCO Frequency in Hz |
| 0x08 | [31:0] | If present, RX7 NCO Frequency in Hz |
| 0x09 | [31:24] | Hermes TX Drive Level (only [31:28] used)
| 0x09 | [23] | VNA mode (0=off, 1=on) |
| 0x09 | [22] | Alex manual mode (see Filter Selection below - Not Yet Implemented) |
| 0x09 | [20] | Tune request: Set during TX spot or tune to initiate an ATU tune or bypass request |
| 0x09 | [19] | Onboard power amplifier PA (0=off, 1=on) |
| 0x09 | [18] | If the PA is Off, disable the T/R relay (1=antenna connector always Rx)|
| 0x09 | [17] | For tune request: 1=send the bypass command; 0=send the normal tune request |
| 0x09 | [15:8] | Alex Rx filter (see Filter Selection below); or VNA count MSB |
| 0x09 | [7:0]  | Alex Tx filter (see Filter Selection below); or VNA count LSB |
| 0x0a | [22] | PureSignal (0=disable, 1=enable) |
| 0x0a | [6] | See LNA gain section below |
| 0x0a | [5:0] | LNA[5:0] gain |
| 0x0e | [15] | Enable hardware managed LNA gain for TX |
| 0x0e | [14] | See LNA gain section below |
| 0x0e | [13:8] | LNA[5:0] gain during TX if enabled |
| 0x0f | [24] | Enable CWX, I[0] of IQ stream is CWX keydown |
| 0x10 | [31:24] | CW Hang Time in ms, bits [9:2] |
| 0x10 | [17:16] | CW Hang Time in ms, bits [1:0] |
| 0x12 | [31:0] | If present, RX8 NCO Frequency in Hz |
| 0x13 | [31:0] | If present, RX9 NCO Frequency in Hz |
| 0x14 | [31:0] | If present, RX10 NCO Frequency in Hz |
| 0x15 | [31:0] | If present, RX11 NCO Frequency in Hz |
| 0x16 | [31:0] | If present, RX12 NCO Frequency in Hz |
| 0x17 | [12:8] | PTT hang time, default is 12ms |
| 0x17 | [6:0]  | TX buffer latency in ms, default is 20ms |
| 0x2b | [31:24] | Predistortion subindex |
| 0x2b | [19:16] | Predistortion |
| 0x39 | [27:24] | Misc Commands |
|      |         | 0x0 No command |
|      |         | 0x8 Enable watchdog timer |
|      |         | 0x9 Disable watchdog timer |
| 0x39 | [23]    | Enable update of locked receivers |
| 0x39 | [21]    | Lock RX12 to RX 11 |
| 0x39 | [20]    | Lock RX10 to RX 9 |
| 0x39 | [19]    | Lock RX8  to RX7 |
| 0x39 | [18]    | Lock RX6  to RX5 |
| 0x39 | [17]    | Lock RX4  to RX3 |
| 0x39 | [16]    | Lock RX2  to RX1 |
| 0x39 | [11:8]  | Master Commands |
|      |         | 0x0 No command |
|      |         | 0x8 Disable Master |
|      |         | 0x9 Enable Master |
| 0x39 | [7:4]   | Synchronization Commands |
|      |         | 0x0 No command
|      |         | 0x8 Reset all filter pipelines |
|      |         | 0x9 Reset and align all NCOs |
| 0x39 | [3:0]   | Clock Generator Commands |
|      |         | 0x0 No command
|      |         | 0x8 Synchronize clock outputs |
|      |         | 0xA Disable CL2 clock output |
|      |         | 0xB Enable CL2 clock output |
|      |         | 0xC Disable CL1 clock input |
|      |         | 0XD Enable CL1 clock input |
| 0x3a | [0] | Reset HL2 on disconnect (0=no reset, 1=reset)|
| 0x3b | [31:24] | AD9866 SPI cookie, must be 0x06 to write |
| 0x3b | [20:16] | AD9866 SPI address |
| 0x3b | [7:0] | AD9866 SPI data |
| 0x3c | [31:24] | I2C1 cookie, must be 0x06 to write, 0x07 to read |
| 0x3c | [23] | I2C1 stop at end (0=continue, 1=stop) |
| 0x3c | [22:16] | I2C1 target chip address |
| 0x3c | [15:8] | I2C1 control |
| 0x3c | [7:0] | I2C1 data (only for write) |
| 0x3d | [31:24] | I2C2 cookie, must be 0x06 to write, 0x07 to read |
| 0x3d | [23] | I2C2 stop at end (0=continue, 1=stop) |
| 0x3d | [22:16] | I2C2 target chip address |
| 0x3d | [15:8] | I2C2 control |
| 0x3d | [7:0] | I2C2 data (only for write) |
| 0x3f | [31:0] | Error for responses |

### I2C Read and Write

The Hermes-Lite2 has two I2C buses at ADDR 0x3c and 0x3d. To read from an I2C bus, the RQST bit C0[7] must be set. So a read request looks like this:

 * c0[7] one, ADDR either 0x3c or 0x3d depending on which bus is addressed.
 * The next byte is 0x07 to read.
 * The next byte is the 7-bit I2C address of the device, with continue or stop in the most significant bit. This bit is not currently used but should be "stop" for future compatibility.
 * The next byte is the register or control number in the device.
 * The next byte is not used for a read.

Note that there are three addresses, the address of the bus, the I2C address of the device on the bus and the register or control number in the device. The Hermes will then request four bytes of data from the I2C device and return the data in C1, C2, C3 and C4. Bit C0[7] ACK will be set in the response and there can be an error response. See below for ACK equal to one. A simple I2C device may just return the same register value four times. Or the device may keep an index and return four different bytes.

An I2C write is similar. Using C0[7] to request a response is optional. Otherwise the bytes are the same as a read except that the second byte is 0x06 to write and the last byte is the data to write to the register of the device. The Hermes only supports one-byte writes at this time.


### LNA Gain

When bit 6 at address 0x0a is set, then LNA LNA[5:0] is passed directly to the AD9866 for full -12dB (0) to +48dB (60) gain range. When bit 6 is not set, Hermes backwards compatibility is selected. Only gain levels from -12dB to +20dB are available. The value LNA[4:0] is 32 bits of attenuation to match the Hermes, where 0 is no attenuation (+19dB) and 32 is maximum attenuation (-12dB). The Hermes has +20dB of gain by default which is attenuated by the step attenuator. Address 0x0a bit 5 selects whether the step attenuator is on (1) or off (0). If the step attenuator is off, the Hermes-Lite will default to +20dB of LNA gain.

### Additional Command and Control

Since the Hermes-Lite2 does not include an audio codec, there is no use for the audio data sent to the Hermes-Lite2. The first stereo audio sample pair, <L1><L0><R1><R0>, as described in the openHPSDR specification, occurs immediately after the 32-bit DATA word in a frame. This 32-bit word is reserved for Hermes-Lite2 use as follows:

 * [31:24] Reserved
 * [15:0] EADDR

The extended address, EADDR, is the location to which the extended write data, base address 0x3f, will be written. This reserves space for possible future expansion. The extended address space does not overlap with the base address space. The extended memory map will be added as needed.


### Filter Selection

The Hermes-Lite 2 sends one byte of data to the I2C bus address 0x20 to communicate with a companion filter board. Software can use this bus to write any data it wants. To support some integration with PowerSDR and other software, the Hermes-Lite 2 will translate some openHPSDR protocol 1 filter selection commands into the appropriate I2C byte.

See the memory map above to identify the "Alex manual mode" bit. When this bit is zero (the default) the gateware sends the 7 bits of "openHPSDR Open Collector Outputs" as bits 6 to 0 of the data byte, and it sends "openHPSDR Rx Antenna" as bit 7. The original Alex used "Rx Antenna" to choose between the Tx antenna for Rx, or a separate Rx-only antenna. These bits stay the same for Rx and Tx. When the "Alex manual mode" bit is one, the gateware sends the eight bits "Alex Rx Filter" to the same I2C address 0x20 when in receive mode, and it sends the eight bits "Alex Tx Filter" when in transmit mode. Note: The behavior when "Alex manual mode" is one is not yet implemented by the gateware, and the feature is under discussion.

The N2ADR filter board uses the I2C bus chip MCP23008 to receive the data byte. Bits 6 to 0 are used for one-hot control of six low pass filters and one high pass filter. Bit 7 is not used, but is available at a pad for other hardware. Bit 7 could be used to choose between two antennas.

SDR software will typically provide controls to set all these filter bits separately for each band, and it will provide a global setting for "openHPSDR Rx Antenna" to provide a choice of antenna. It is up to the SDR software and the filter board in use to define a meaning for each of these bits. For "Alex manual mode" zero (same filter bits for Rx and Tx) the SDR typically sends the antenna bit and seven one-hot filter bits, but this is not required. The SDR could send the antenna bit, three bits selecting one of 8 HP filters, and four bits selecting one of 16 LP filters. For "Alex manual mode" one, the SDR sends different bits for Rx and Tx, so it could send a bit indicating Rx/Tx, two antenna bits and five bits for different Rx and Tx filters.

#### Bias

Bias voltages are set via I2C2. Bias[7:0] is an 8-bit value. A value of 0xff is the lowest bias voltage in the range. A value of 0x00 is the highest. There are 256 linear steps. The actual bias range depends on the PA implemented.

During experimentation or initial current measurement, set the volatile value. Once a user picks a final bias value, set the nonvolatile value. The nonvolatile value is only loaded at the next power cycle.

##### Set Bias0 Volatile Value
I2C2 = 0x06ac00vv where vv is bias0[7:0]

##### Set Bias0 Nonvolatile Value
I2C2 = 0x06ac20vv where vv is bias0[7:0]

##### Set Bias1 Volatile Value
I2C2 = 0x06ac10vv where vv is bias1[7:0]

##### Set Bias1 Nonvolatile Value
I2C2 = 0x06ac30vv where vv is bias1[7:0]

Note that for the Hermes-Lite2 beta2 and earlier the 0xac byte in the values above should be replaced with 0xa8 since a different digital POT was used there. A beta2 board will report a Code Version lower than 60 (decimal).

## Data from Hermes-Lite2 to PC

### Interpretation of Original Protocol Command & Control

C0[7] is the ACK flag. It is set if this response from the Hermes-Lite2 is due to receiving a RQST from the PC. The remaining bits of C0 are decoded differently depending on the state of C0[7].

### Classic Response when ACK==0

| Command & Control | Bits | Description |
| ------------- | ------------- | ----- |
| C0 | [7]   | ACK==0 |
|    | [6:3] | RADDR[3:0] |
|    | [2] | Dot, see below |
|    | [1] | Dash, always zero |
|    | [0] | PTT, see below |
| C1 | [7:0] | RDATA[31:24] |
| C2 | [7:0] | RDATA[23:16] |
| C3 | [7:0] | RDATA[15:8]  |
| C4 | [7:0] | RDATA[7:0]   |

The Hermes-Lite2 has a 3.5mm phone jack at CN4. When the ring is grounded, C0[0] is sent as one. Software should
interpret this as an external PTT switch. There is no internal keyer, so C0[1] is always sent as zero. When the tip is grounded, both C0[0] and C0[2] are sent as one. C0[2] follows the signal at the tip, and a shaped CW
signal is generated by the Hermes-Lite2. C0[0] stays set during the entire time TX is on for CW, which includes
any specified CW hang time. The MOX bit must be sent as zero when sending CW.

### Wideband data

When the "start" command [1] bit is set, wideband ADC data (in either 16-bit or 12-bit (indicated by the reply packet address 0x14 bits [7:6]) is sent from Hermes-Lite-2 to the PC with with the [Byte[3] of the payload, the End Point byte](https://github.com/TAPR/OpenHPSDR-SVN/blob/master/Metis/Documentation/Metis-%20How%20it%20works_V1.33.pdf) as 0x04. The command 0x04 is so because originally in the HPSDR project, this was sent via USB from endpoint EP4, and later the HPSDR Metis protocol converted this USB protocol into an equivalent UDP packet payload to de-multiplex wideband data from the I/Q data. 

HL2 has an ADC sampling rate of 76.8 MHz. The HL2 FPGA collects 2048 ADC samples and sends them over to the PC. This sample represents the entire HF spectrum from 0 Hz to 38.4 MHz (76.8/2). HL2 data payload is 1024 bytes, so each packet can send 512 16-bit samples. The 2048 16-bit samples gets sent over 4 payloads, so to track the block boundaries, the software should track the two least significant bits of the sequence number and check if it is zero and treat that as the block beginning with a WB "block" spanning 4 packets to constitute 2048 samples. Samples are continuous in time from the block beginning, but discontinuous across different blocks.

### Base Memory Map when ACK==0

Only the first 3 addresses are in use and correspond to response in the original protocol.

| RADDR | RDATA    | Description |
| ---- | ------- | ----------- |
| 0x00 | [25]  | Tx Inhibited (Active Low) |
| 0x00 | [24]  | RF ADC Overload (Active High)|
| 0x00 | [15] | Under/overflow Recovery** |
| 0x00 | [14:8] | TX IQ FIFO Count MSBs |
| 0x00 | [7:0] | Firmware Version |
| 0x01 | [31:16] | Temperature |
| 0x01 | [15:0] | Forward Power |
| 0x02 | [31:16] | Reverse Power |
| 0x02 | [15:0] | Current |

An explanation of the TX IQ FIFO Count can be found [here](https://groups.google.com/g/hermes-lite/c/WFxM4AAk-8M/m/YXzHjCgTHgAJ).

** Underflow when [15:14] == 2'b10  Overflow when [15:14] == 2'b11


### Request Response when ACK==1

| Command & Control | Bits | Description |
| ------------- | ------------- | ----- |
| C0 | [7]   | ACK==1 |
|    | [6:1] | RADDR[5:0] |
|    | [0] | PTT |
| C1 | [7:0] | RDATA[31:24] |
| C2 | [7:0] | RDATA[23:16] |
| C3 | [7:0] | RDATA[15:8]  |
| C4 | [7:0] | RDATA[7:0]   |

### Base Memory Map when ACK==1

For writes, the default case, gateware will echo the request address and data, RADDR=ADDR and RDATA=DATA, once per each request received. Note that historic write commands such as set RX frequency are forced to respond if RQST was set. For I2C reads, the RDATA will be populated with 4 bytes of I2C data. RADDR will still match the original ADDR. If a write or read is attempted when the I2C or AD9866 subsystems are busy, an error response will returned. An RADDR of 0x3F is indicates error. RDATA will match the original request.

To prevent starvation of the classic responses, software should only send a command with RQST set periodically. For example, every other sent command may be one that is a request. Also, it is expected that software never makes more than one request at a time. If a RQST is made, another RQST should not be made until after the last RQST was acknowledged with ACK.



## Configuration EEPROM

U15, the MCP4662 digital rheostat used to store the PA bias settings, contains 10 9-bit words of general purpose nonvolatile memory. The HL2 will allocate this memory as shown in the table below. In most cases, the 9th bit is not used and only byte values matter.

| Address | Bits | Description |
| ------- | ---- | ----------- |
| 0x00 | [7:0] | Volatile Wiper 0 |
| 0x01 | [7:0] | Volatile Wiper 1 |
| 0x02 | [7:0] | Nonvolatile Wiper 0 (PA Bias0) |
| 0x03 | [7:0] | Nonvolatile Wiper 1 (PA Bias1) |
| 0x04 | [8:0] | Volatile TCON Register |
| 0x05 | [8:0] | Status Register |
| 0x06 | [7]   | 1 = Valid IP |
|      | [6]   | 1 = Valid MAC Bytes |
|      | [5]   | 1 = Favor DHCP over Fixed IP |
|      |       | 0 = Favor Fixed IP over DHCP |
|      | [4:0] | Reserved |
| 0x07 | [7:0] | Reserved |
| 0x08 | [7:0] | W of IP W.X.Y.Z |
| 0x09 | [7:0] | X of IP W.X.Y.Z |
| 0x0A | [7:0] | Y of IP W.X.Y.Z |
| 0x0B | [7:0] | Z of IP W.X.Y.Z |
| 0x0C | [7:0] | Y of MAC U:V:W:X:Y:Z |
| 0x0D | [7:0] | Z of MAC U:V:W:X:Y:Z |
| 0x0E | [7:0] | Reserved |
| 0x0F | [7:0] | Reserved |

### Write EEPROM

The EEPROM is written in the same way that bias values are written. A 32-bit word is written to ADDR 0x3d or 0x7d for response. This 32-bit word has the format 0x06acA0vv where A is the address from the table above and vv is the byte to be written. For example, to set 0xEF of MAC U:V:W:X:Y:0xEF, the 32-bit word should be 0x06acD0EF.

### Read EEPROM

To read the EEPROM or any I2C data, the RQST flag must be set and the read data is returned as part of the ACK response. To read the EEPROM register at address A, write the 32-bit word 0x07acACXX to register 0x7d, where XX is don't care. After a short time, less than 5 ms, a response with ACK flag set and RADDR matching the 0x7d will be seen. The 32-bits of RDATA are 4 byte reads from the I2C. Since the MCP4662 stores 9 bit data and does not increment address on reads, the EEPROM data will be as shown in the table below.

| Bits | Description |
| ---- | ----------- |
| [31:24] | value[7:0] |
| [16] | value[8] |
| [15:8] | value[7:0] |
| [0] | value[8] |


For example, to read the EEPROM register at address 0x8 where the value 0x2 is stored, send the 32-bit word 0x07ac8c00 to ADDR of 0x7d. Expect a response with ACK set and matching address, 0x7d. The 32-bit RDATA will be 0x02000200.


## Metis Discovery Reply

The [Metis](https://github.com/TAPR/OpenHPSDR-Firmware/tree/master/Protocol%201/Documentation) document describes the discovery reply packet as,

<0xEFFE>< Status>< Metis MAC Address>< Code Version>< Board_ID>< 49 bytes of 0x00>

Some of the 49 bytes of 0x00 are repurposed to provide software with additional information.
The Hermes-Lite2 Reply packet is as follows:

| Address | Bits | Description |
| ------- | ---- | ----------- |
| 0x00 | [7:0] | 0xEF |
| 0x01 | [7:0] | 0xFE |
| 0x02 | [7:0] | 0x02 if not sending and 0x03 if sending data |
| 0x03 | [7:0] | U of MAC U:V:W:X:Y:Z |
| 0x04 | [7:0] | V of MAC U:V:W:X:Y:Z |
| 0x05 | [7:0] | W of MAC U:V:W:X:Y:Z |
| 0x06 | [7:0] | X of MAC U:V:W:X:Y:Z |
| 0x07 | [7:0] | Y of MAC U:V:W:X:Y:Z |
| 0x08 | [7:0] | Z of MAC U:V:W:X:Y:Z |
| 0x09 | [7:0] | Gateware Major Version |
| 0x0A | [7:0] | Board ID, 0x06 for HL2, 0x01 for Hermes Emulation |
| 0x0B | [7:0] | MCP4662 0x06 Config Bits |
| 0x0C | [7:0] | MCP4662 0x07 Reserved Config Bits |
| 0x0D | [7:0] | MCP4662 0x08 Fixed IP |
| 0x0E | [7:0] | MCP4662 0x09 Fixed IP |
| 0x0F | [7:0] | MCP4662 0x0A Fixed IP |
| 0x10 | [7:0] | MCP4662 0x0B Fixed IP |
| 0x11 | [7:0] | MCP4662 0x0C MAC |
| 0x12 | [7:0] | MCP4662 0x0D MAC |
| 0x13 | [7:0] | Number of Hardware Receivers |
| 0x14 | [7:6] | 00 wide band data is 12-bit sign extended two's complement |
|      |       | 01 wide band data is 16-bit two's complement |
|      | [5:0] | Board ID: 5, 3 or 2 for build |
| 0x15 | [7:0] | Gateware Minor Version/Patch |
| 0x16 | [5:0] | Reserved |
| 0x17 | [7:0] | Response Data [31:24] |
| 0x18 | [7:0] | Response Data [23:16] |
| 0x19 | [7:0] | Response Data [15:8] |
| 0x1A | [7:0] | Response Data [7:0] |
| 0x1B | [7]   | External CW Key |
| 0x1B | [6]   | PTT (TX is on) |
| 0x1B | [1:0] | ADC clip count |
| 0x1C | [3:0] | Temperature msb |
| 0x1D | [7:0] | Temperature lsb |
| 0x1E | [3:0] | Forward power msb |
| 0x1F | [7:0] | Forward power lsb |
| 0x20 | [3:0] | Reverse power msb |
| 0x21 | [7:0] | Reverse power lsb |
| 0x22 | [3:0] | Bias current msb |
| 0x23 | [7:0] | Bias current lsb |
| 0x24 | [7]   | Under/overflow recovery flag |
| 0x24 | [6:0] | TX IQ FIFO count most significant bits |
| 0x26-0x3B | | Reserved |






