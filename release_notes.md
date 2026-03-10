
## Version 0.1.42 - Latest Release

### New Features
- Added **Live Listener Map** with a 'Show Map' button in the Active Channels section 
- Added **FT2 Decoding** using WSJT-X Improved implementation. Existing installations will need to add a decoder manually for each band
- Added **Voice Announcements** for Frequency and Mode changes. Button is the megaphone next to the 10m band button. Mainly designed for accessibility
- Added **Real-Time Speech To Text** transcription and translation to and from multiple languages. Contact me directly if interested
- Added **IQ Recorder** with automated scheduling. Stand alone desktop application available from the https://ubersdr.org website

### Improvements
- Added **Signal data for recordings** when recording audio the ZIP now also contains power data, once per second, in CSV format.
- Changed **SSB maximum bandwidth** to 6 KHz for ESSB listening
- Migrated **FT2/4/8 decoding** from WAV file record -> jt9 processing model to purely in-memory using a circular buffer and IPC. WSPR still uses WAV -> wsprd. This is how WSJT-X does it.

### In Progress (Coming Soon)
- CW Skimmer (SkimSrv) as a Docker container (thanks to K1RA for making me aware this was possible)

## Version 0.1.41

### New Features
- Added **SpinTheDial.live** dedicated website which is meant as a bit of fun to find voice activity
- Added **Signal Data** now read from audio packets rather than spectrum
- Added **Example Popup JS** in Admin -> Config -> Server -> Custom Head HTML
- Added **Local Bookmarks** so users can save their own bookmarks (import and export supported)
- Improved **Voice Activity** detection logic - still not perfect but seems better
- Improved **Spectral Data** processing logic to multi-thread architechture
- Improved **Session Activity** API response time in admin (for >50 simultaneous listeners)

### Bug Fixes
- Various tuning issues where the spectrum didn't readjust (still work in progress)
- Caddy container now runs Docker Init so wait() is called for child processes (issue with zombies)

### In Progress (Coming Soon)
- CW Skimmer (SkimSrv) as a Docker container (thanks to K1RA for making me aware this was possible)
- FT2 Decoder / Skimmer

## Version 0.1.40

### New Features
- Added **Extension** for FT8/F4 Decoder for web users (FT8 only just now)

### Bug Fixes
- Single thread performance issue for spectrum (waterfall) pipeline fixed (when 50+ users)
- Admin API/interface client IP resolution issues (and disabled IPv6 on host as it breaks Docker DNAT)

## Version 0.1.39

### New Features
- Added **Extensions** for WEFAX/NAVTEX/Generic FSK
- Added **Extension** for SSTV though known issue with alignment so work in progress
- Added **Voice Activity** scanner to find active SSB phone activity

### Bug Fixes
- Elevation for some rotators being set to azimuth value which failed in rotctld


## Version 0.1.38

### New Features
- Added **Release notes** in version footer of admin interface
- Added **Listener Map** showing sessions by location at /session_stats.html
- Added **Host terminal access** with tmux sessions
- Added **Admin IP address allow list** to restrict admin access
- Implemented **Rotctld (Rotator Control) wizard** for easier rotator setup
- Added **FFTW Wisdom generation wizard** for optimised FFT performance
- Integrated **GeoIP lookups** for location-based features
- Added **Decoder execution time clamping** for FT8/FT4/WSPR decoders
- Added **MCP Proof of Concept** optional MCP endpoint for AI agents

### Bug Fixes
- Fixed waterfall underlapping frequency notches
- Corrected waterfall height inconsistency when spectrum is enabled
- Set maximum wrapping width for start overlay description/map
