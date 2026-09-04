## Build Dependencies

On Debian/Ubuntu-based systems, install the required development libraries before building:

```bash
sudo apt install libwebsockets-dev libbsd-dev uuid-dev
```

Then build with:

```bash
make
```

libzstd is no longer needed: protocol version 4 replaced the zstd wrapper on the
lossless path with a predictive codec, which lives in `pcm_v4.c` and depends on
nothing.

## Wire format

The bridge asks for `format=pcm-zstd&version=4`, the lossless path at the only
protocol version it reads, unless `--min-margin` asks for the reduced-depth mode
below. `pcm-zstd` is still the server's name for that format, but from version 4
what it carries is not zstd:

- **Packet**: a `PCM4` magic, a flags byte, then only the fields that changed
  since the last packet — sample rate, channel count, sample count and the two
  signal levels are each re-sent when they move and every five seconds
  regardless. About 9 bytes against the 37 version 2 spent on every one.
- **Body**: each sample is predicted from those before it by an adaptive complex
  filter and only the prediction error is sent, Rice coded. The filter is
  *backward* adaptive — its taps come from samples already decoded — so no
  coefficients travel and the decoder recomputes them independently.
- **Bandwidth**, measured live at version 4: iq48 141 kB/s, iq96 281, iq192 563,
  iq384 1129, against 191/381/760/1525 raw. zstd achieved nothing here: it is an
  LZ77 matcher over bytes, and a band-limited RF signal has no repeated byte
  strings, so every IQ mode measured at 0.99x — the compressed stream *larger*
  than the samples it carried.
- **Lossless**, and checked as such: the predictor fails silently, so `test/run.sh`
  decodes a stream the server's own encoder produced and compares the samples
  that come back, under the sanitizers as well.
- **Requires UberSDR 0.1.63 or later.** Older servers clamp the requested version
  to 1-3 and answer with version 1 rather than refusing; the bridge recognises
  those frames and says so.

## Reduced-depth IQ: `--min-margin DB`

Optional, and off unless asked for. It trades a defined amount of quantisation
noise for bandwidth, and the request is a **margin**, not a bit depth: `DB` is
how far below the band's own noise floor the quantisation floor must stay, and
the server works out per packet how many bits that needs.

That is what makes one number mean the same thing on every band. A fixed depth
does not: ten bits leaves 50 dB of headroom on a dead 6 m band and 9 dB on
medium wave, so a depth that is safe on the second wastes most of the saving on
the first.

Measured on this bridge, 20 m at 192 kHz: **4482 kbps lossless against 1781 kbps
at `--min-margin 20`**, the same samples at the same rate for 60% less traffic.
A busy band or a lower margin saves less, which is the point — medium wave
spends the bytes because its carriers genuinely need the depth.

- **15 to 60 dB**, and a value outside that is refused at startup rather than
  quietly clamped to something else. 15 dB is where the added noise (0.14 dB on
  the floor) stops being resolvable by a receiver's own readings; past 60 dB the
  request buys nothing. `0` means the same as leaving the option off.
- **Needs UberSDR 0.1.64 or later.** A server that has never heard of
  `min_margin` ignores it and sends the lossless stream, so nothing breaks.
- Packets coded this way declare their own profile, and a decoder that does not
  implement it refuses them rather than playing noise — which is why the mode is
  reachable only by asking for it. `test/run.sh` decodes a scaled stream the
  server's own encoder produced and compares the samples, as it does for the
  lossless one.

## Throughput

While a client is streaming, the bridge prints what the IQ stream is costing,
every five seconds:

```
IQ: DDC0 1780.5 kbps
IQ: DDC0 1780.5 kbps  DDC1 563.2 kbps  total 2343.7 kbps
```

Counted off the WebSocket, not worked out from the sample rate: version 4 codes
IQ predictively, so a quiet band costs less than a busy one at the same rate,
and `--min-margin` less again. Nothing is printed while no client is connected.

## Protocols

The bridge answers **openHPSDR protocol 2** and **protocol 1** ("Metis"), and a
client picks by which discovery packet it sends — both arrive on UDP 1024 and
cannot be confused, since every protocol 1 datagram opens `EF FE` and every
protocol 2 one opens with four zero bytes.

Protocol 1 exists because a Hermes Lite 2 *is* a protocol 1 board, so software
written against real HL2 hardware looks for it and finds nothing on a
protocol-2-only server. It is the same bridge underneath: the WebSocket, the
version 4 decoder, the tuning range, the reconnect and rate handling have no
idea which protocol is on the other side.

**One client at a time, whichever protocol.** Both drive the same receivers, and
a real radio cannot serve two clients either, so whichever protocol starts first
holds the bridge until it goes idle: a protocol 1 run command is refused while a
protocol 2 client is streaming, and protocol 2's control packets are dropped
while a protocol 1 client is. Both cases say so in the log rather than leaving a
client silently ignored.

Two clients of the SAME protocol are a different matter and predate this: the
bridge keeps one client address, so a second protocol 2 client's general packet
takes the stream over rather than being refused. Discovery reports status 3
while running, which is the warning a well-behaved client acts on, but nothing
enforces it.

**Protocol 1 currently serves one receiver.** That is what the discovery reply
advertises and what a conforming client clamps itself to. More than one is not a
framing problem but an alignment one: protocol 1 interleaves every receiver into
a single packet, one sample from each per round, while ours are independent
WebSockets that drift — so it needs a policy for a starved receiver rather than
a bigger buffer. Protocol 2 has no such constraint and serves all ten.

## Sample rates

48, 96, 192 and 384 kHz — the four DDC rates the HPSDR protocol defines, which
is now exactly what the server offers. The discovery reply advertises all four
in its rate bitmask, so a client may ask for any of them.

384 kHz needs a bypassed session: the server offers the wide IQ modes only to a
password- or IP-privileged user, and refuses at `/connection` otherwise.

## The test client: `ubersdr-hpsdr-client`

`hpsdr_client.c` is the other end of the bridge — a protocol 1 client that
tunes it, demodulates what comes back, and plays or records the audio.

It exists because the bridge used to be testable only by pointing real SDR
software at it, which answers "does it work" and almost nothing else. When the
audio is wrong, that software reports a symptom, and "the bridge sent the wrong
thing" and "the client mishandled the right thing" look identical from outside.
This prints what actually arrived — delivered sample rate against the rate it
asked for, lost packets, and the signal level in the 24-bit field — so audio
coming out wrong here means the bridge.

    make client        # not part of `make all`; see the Makefile

It links no library the bridge does not already need, and no sound library at
all: audio goes to a player process (`aplay` by default, `--player` for
another), so it adds nothing to this directory's build dependencies.

    ./build/ubersdr-hpsdr-client_amd64 --discover
    ./build/ubersdr-hpsdr-client_amd64 --freq 909000 --mode am --play
    ./build/ubersdr-hpsdr-client_amd64 --freq 7150000 --mode lsb --rate 192 --wav out.wav
    ./build/ubersdr-hpsdr-client_amd64 --rate 384 --mode iq --iq-wav iq.wav --seconds 10

With no `--host` it sweeps the network — the global broadcast address, each
interface's own, and loopback — and lists what answered, deduplicated by MAC so
a radio reachable by several routes is one entry rather than three. One radio is
used; several are offered as a numbered list to choose from, or `--radio N`
picks without asking.

**Modes** are `usb`, `lsb`, `am` and `iq`. All four DDC rates work, and the
audio always comes out at 12 kHz — every rate the protocol offers is a
power-of-two multiple of it, so the decimation is a chain of halvings and needs
no resampler.

**`--bandwidth`** sets the audio passband, up to 5000 Hz. SSB runs from `--low`
(300 Hz by default) to `--low` plus the bandwidth; AM runs from 0 to the
bandwidth, which is half the RF width its dial would show. The AM filter is
applied before the envelope detector rather than after, because the envelope of
a signal plus its neighbour is not the envelope of the signal and no filtering
afterwards separates them again.

SSB needs no Hilbert transform: the samples are already complex, so with the
carrier at zero the upper sideband is the positive frequencies and the lower the
negative ones, and passing one and taking the real part is the whole of it.

## Tuning range

Read from `/api/description` at startup and printed. The receiver is not always
a 0-30 MHz box — the span follows the front end sample rate, so a 129.6 Msps
RX888 reaches 60 MHz — and a receiver that publishes nothing falls back to
10 kHz - 30 MHz, which is what this bridge assumed before.

It cannot be passed on to the client: the HPSDR discovery reply carries a board
type and a firmware version and has no field for a tuning range, so the client
takes its limits from whatever hardware it believes it is talking to. A request
outside the receiver's range is forwarded anyway and logged.

---

ka9q_hpsdr translates ka9q-radio channel data in to protocol2 hpsdr
data and sent via ethernet UDP packets. Protocol2 is defined in this
document: https://github.com/TAPR/OpenHPSDR-Firmware/blob/master/Protocol%202/Documentation/openHPSDR%20Ethernet%20Protocol%20v4.3.pdf

ka9q_hpsdr currently supports up to 8 receiver channels from ka9q-radio
defined by MAX_RCVRS. This is per instantiation of ka9q_hpsdr. You can
run another copy of ka9q_hpsdr for up to 16 receiver channels.

The 2nd instance can run on a physical or a virtual net interface, as long
as it's not being used by the 1st instance. These are the 
steps I used to create a virtual interface:

**Create a virtual interface eno1.1 with a unique MAC on physical eno1**

sudo ip link add link eno1 address 00:1C:C0:A2:10:DE eno1.1 type macvlan

**Bring it up and assign an IP**

sudo ip link set dev eno1.1 up

**For dhcp assign IP**

sudo dhcpcd eno1.1

**or**

sudo dhclient -v eno1.1

**Or static IP**

sudo ip addr add 192.168.1.100/24 dev eno1.1

I put this together to be able to use my RX-888Mk2 for CW skimming.

You can find instructions on how to set up for running two instances 
of SkimSrv by googling:

running 2 instances of skimsrv

Hopefully this program will help RX888 owners run hpsdr friendly programs
that can handle multiple receiver slices for skimming cw, ft8, and other modes.

Examples:

https://www.sparksdr.com

https://www.dxatlas.com/SkimServer

https://www.dxatlas.com/RttySkimServ

https://github.com/g0orx/linhpsdr

https://github.com/ramdor/Thetis/releases

https://github.com/dl1ycf/pihpsdr

A sample configuration file 'radiod@rx888-hf.conf' is included for an RX888.

I run ka9q_hpsdr on the same PC as ka9q-radio and in a top level directory along
side ka9q-radio. If ka9q-radio isn't in an adjacent directory, needed source
code from ka9q-radio is used from the ALT_SRC directory.

I made a small patch that modifies rx888.c to write 16k of raw ADC samples
every 66ms to a ramdisk. That data is then used by ka9q_hpsdr to provide a
wideband spectrum for HPSDR programs which implement it. It would be much
better to send it in multicast once I figure out how to do that.

cd ../ka9q-radio

cat ../ka9q_hpsdr/ka9q-radio_wideband.patch | patch -p1

make; make install

If you can suggest improvements or find bugs please post something to the Issues
tab on https://github.com/n1gp/ka9q_hpsdr

Issues:

Rarely I have seen that when initializing the channel, the high and low filters
get set to 5KHz and -5KHz. I'm guessing that the control packet with the proper
settings didn't make it to ka9q-radio.

When switching sample rates there may be no data coming from pcmrecord for a few
seconds or more, or not at all if the rate is above 192k unless I add 100 Hz.
I'm not sure where the problem lies.

Screenshots:

<img width="283" height="275" alt="thetis" src="https://github.com/user-attachments/assets/0d5da337-150c-4b89-ad53-f9e6a51db5cd" />
<img width="413" height="235" alt="sparksdr" src="https://github.com/user-attachments/assets/881db0bb-49f9-48f6-b034-8fb5e906c91e" />
<img width="290" height="245" alt="SkimSrvx2" src="https://github.com/user-attachments/assets/4aaa8617-36c8-4b22-959f-8c83c787387c" />


