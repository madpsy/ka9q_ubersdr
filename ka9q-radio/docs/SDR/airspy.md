# Airspy R2 and HF+ SDRs

Phil Karn, KA9Q

## Description

[Airspy R2](https://airspy.com/airspy-r2/) is a SDR for the VHF and UHF (24 – 1700 MHz) bands. It has a low-IF architecture based on Rafael Micro R820T2 (or R860), a high quality oversampling 12-bit ADC and a state of the art DSP resulting in up to 16-bit resolution at narrow band channels. The sample rate is 10Msps (complex)

[Airspy HF+](https://airspy.com/airspy-hf-plus/) is a SDR for the HF (9 kHz - 31 MHz) and VHF (64 - 260 MHz) bands. It has very high dynamic range ADC’s and front-ends and a polyphase harmonic rejection mixer for improved performance. The maximum sample rate is 912 ksps (complex).

The [Airspy Mini](https://airspy.com/airspy-mini/) is very similar with the Airspy R2 so it can also be used by `radiod`.

## SW Installation

Airspy SW is supported by default on most linux distributions by the `airspy[hf]` and `libairspy[hf]-dev` packages.

## Configuration

See below for an basic example.

```
[global]
hardware = airspy
status = airspy.local

[airspy]
device = airspy
description = "My Airspy SDR"
```

You can also reference the [generic Airspy R2 config file](/config/radiod@airspy-generic.conf) or the [generic Airspy HF+ config file](/config/radiod@airspyhf-generic.conf).

Multiple instances of `radiod` can run on the same system, provided each has its own front end (they cannot be shared).

You can have as many as you want, subject to your CPU and USB limits. (The Airspy R2 generates 240 Mb/s, but it's a USB 2.0 -- not 3.0 -- device so each will have to be on its own USB host controller.)

The "description" parameter is advertised with mDNS (multicast DNS) service discovery on the LAN and this constrains its content. It should be 63 characters or less and not contain slashes ('/') or control characters (spaces are ok).

### device (mandatory)

In the example above, the `hardware` entry in the `[global]` section specifies the section containing SDR configuration information (in this example the name of the hardware section happens to be the same as the device type, but it is not essential.)

The `device` key is mandatory. This specifies the front end hardware type, i.e, `airspy` (which means an Airspy R2) or `airspyhf` (the Airspy HF+).

### serial (optional)

If not specified, `radiod` uses the first device discovered. Since this is probably not what you want, you should explicitly specify the serial number if more than one is present.

The `serial` must exactly match the SDR serial number, in hex (the leading 0x is optional).

For Airspy R2 you can find the serial number with the `airspy_info` utility.

```
>$ airspy_info
airspy_lib_version: 1.0.9
Found AirSpy board 1
Board ID Number: 0 (AIRSPY)
Firmware Version: AirSpy NOS v1.0.0-rc10-6-g4008185 2020-05-08
Part ID Number: 0x6906002B 0x00000030
Serial Number: 0x91D064DC27839FCF
Supported sample rates:
    10.000000 MSPS
    2.500000 MSPS
Close board 1
```

For the Airspy HF+ you can find the serial number with the `airspyhf_info` utility.

```
>$ airspyhf_info
AirSpy HF library version: 1.6.8
S/N: 0x3652D65D4ACB39F8
Part ID: 0x00000002
Firmware Version: R3.0.7-CD
Available sample rates: 912 kS/s 768 kS/s 456 kS/s 384 kS/s 256 kS/s 192 kS/s
```

Note that `airspy_info` (or `airspyhf_info`) will not see the device when any other program (including `radiod`) has it open.

If the serial number is specified for a non-existent device, `radiod` will exit and Linux `systemd` will restart it every 5 seconds until the device appears.

I find it very helpful to externally label each of my Airspy devices with their serial numbers.

### samprate (optional)

Integer, default is the highest speed advertised by the device, usually 20 MHz for the Airspy R2 and 912 kHz for the Airspy HF+.

This sets the A/D sample rate. Note that the Airspy R2 is typically described as producing complex samples at 10 MHz. However, there's actually only one A/D converter that can sample at 20 MHz; the real -> complex conversion and half-rate decimation is performed in the Airspy library.

Since `radiod` performs a FFT on its input stream that can accept either real or complex samples, it is considerably faster to bypass the library conversion and accept the raw real-valued samples.

On the other hand, the current Airspy HF+ library readily supports only complex output samples.

The supported sample rates are logged in */var/log/syslog* when `radiod` starts and the device is initialized.

## Airspy R2 only options

### agc-high-threshold (optional)

Float, default -10.0 dBFS. Set the average A/D output level at which the the software AGC will decrease the front end analog gain by one step.

### agc-low-threshold (optional)

Float, default -40.0 dBFS. Set the average A/D output level at which the software AGC will increase the front end analog gain by one step.

### bias (optional)

Boolean, default false. Enable the bias tee (preamplifier power).

### converter (optional)

Integer, default 0. Upconverter frequency (120Mhz, used for SpyVerter with Airspy R2).

### gainstep (optional)

Integer, default -1. 0-21 inclusive, manually select an entry in the Airspy library gain table and disable software AGC. The default is to select an entry automatically with a software AGC based on the average A/D output level and the `linearity` setting.

### linearity (optional)

Boolean, default false. Like most second-generation SDRs with Mirics (or similar) analog tuners, the Airspy R2 has three stages of analog gain ahead of the A/D converters that any AGC must carefully manage.

The Airspy library provides separate gain tables optimized for sensitivity and for linearity (i.e. resistance to intermod). The sensitivity table is used by default, but in areas with strong signals the linearity table may provide better resistance to intermod. I'm about 6 km line of sight from a dozen FM broadcast transmitters so I often use the linearity setting.

### lna-agc (optional)

Boolean, default false. Enable the hardware LNA AGC and disable the software AGC. Doesn't seem to keep proper gain distribution, i.e., poor sensitivity and/or excessive intermodulation products seem to result. Use the default (software AGC) instead.

### mixer-agc (optional)

Boolean, default false. Enable the hardware mixer AGC and disable the software AGC. Doesn't seem to keep proper gain distribution, i.e., poor sensitivity and/or excessive intermodulation
products seem to result. Use the default (software AGC) instead.

### lna-gain, mixer-gain, vga-gain (optional)

Integers, default -1. Manually set gains for the LNA, mixer and variable gain (baseband) analog amplifier stages. The units are supposed to be in decibels but don't seem well calibrated. Setting any of these values disables the software AGC.

## Airspy HF+ only options

### agc-thresh (optional)

Boolean, default false. Exact function unknown. Do not confuse with the `airspy` options `agc-high-threshold` and `agc-low-threshold`.

### hf-agc (optional)

Boolean, default false. Exact function unknown.

### hf-att (optional)

Boolean, default false. Exact function unknown.

### hf-lna (optional)

Boolean, default false. Exact function unknown.

### lib-dsp (optional)

Boolean, default true. Enables the Airspy HF+ library to correct fine frequency errors and I/Q gain and phase imbalances. This library seems a little inefficient (it doesn't use FFTW3, and it consumes more resources than the rest of `radiod` combined) but is acceptable because of the relatively low HF+ sample rate (912 kHz).
