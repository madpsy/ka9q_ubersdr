# 07 April 2026

## Version 0.1.44 - Latest Release

### New Features
- Added **EiBi Boomarks** uses the shortwave database from [www.eibispace.de](http://www.eibispace.de) to dynamically create bookmarks. Enable in Admin -> Config -> EiBi
- Added **Addons** which are seperate self contained decoders for specific background tasks. CW Skimmer, HFDL and SSTV currently available (check [UberSDR.org](https://ubersdr.org) for updates). CW Skimmer can be installed via Admin -> CW Skimmer directly. Note: CW Skimmer requires significant CPU power
- Added **MIDI / FlexControl** extensions for the Web UI to control via DJ Controllers or the FlexControl USB controller
- Added **CPU Temperature** to the Load charts in Admin -> Monitor
- Added **FreeDV** decoder with integration with their reporter service. Enable in Admin -> Config -> Freedv Reporter and Admin -> Extensions
- Added **Network Traffic** in Admin -> Active Sessions now splits network throughput between Local (on the host), LAN and Public Internet
- Added **Audio device selection** in Web UI by clicking on the latency bar in the bottom right. Useful for piping audio to a specific audio device
- Added **Lightweight Audio client** for Windows and Linux designed for piping audio to other applications. Allows saving profiles to switch easily between instances / tuning  & audio settings

### Improvements
- Changed **Waterfall scaling logic** to better align with signals seen in the Spectrum view
- Fixed **Regular user session logic** which was causing incorrect max user limit to be reached
- Fixed **Sporadic permission errors** in Admin via Tunnel caused by an HTTP/3 bug in the Tunnel system
- Fixed **Bookmark Snapping** which cause a bookmark to activate when tuning via on the Waterfall when Spectrum is enabled
- Fixed **Space Weather A+K Index** caused by NOAA changing their API response format
- Fixed **Ordering and colouring** of Noise Floor charts

### In Progress (Coming Soon)
- NavTex Addon for background NavTex decoding

### Other Announcements
- Public instances (with TLS enabled) can be used for ['Smart Listening'](https://instances.ubersdr.org/multi_monitor.html) which can automatically switch instance based on SNR. Example uses: Listening to a net where one instance can't hear all participants. Diversity receive (L+R audio) between two instances

## Version 0.1.43

### New Features
- Added **Admin Session Logs** to show login attempts and current admin sessions (in memory only). Admin -> Active Sessions -> Login History button
- Added **RM Noise** in the web UI and desktop client - see https://rmnoise.com/ (waiting for feedback from the author). RMN button in the UI
- Added **Default frequency / mode** to set what users are tuned to when first opening the UI (config -> admin -> default frequency/mode)
- Added **rtl_tcp service** which emulates an RTL-SDR over the network. Listens on port 1234 - LAN use only. Limited to 192 KHz.

### Improvements
- Added **Band view in current listener map** which is easier to see where listeners are currently tuned ('Show Map' at the bottom of the web UI)
- Removed **Log message every time a banned IP tries to access** as it caused a lot of noise

### In Progress (Coming Soon)
- CW Skimmer (SkimSrv) as a Docker container (thanks to K1RA for making me aware this was possible)

## Version 0.1.42

### New Features
- Added **Live Listener Map** with a 'Show Map' button in the Active Channels section 
- Added **FT2 Decoding** using WSJT-X Improved implementation. Existing installations will need to add a decoder manually for each band due to how config key merges work
- Added **Voice Announcements** for Frequency and Mode changes. Button is the megaphone next to the 10m band button. Mainly designed for accessibility and requires Chrome or Edge
- Added **Real-Time Speech To Text** transcription and translation to and from multiple languages. Contact me directly if interested (I have a hosted version or you need a GPU)
- Added **IQ Recorder** with automated scheduling. Stand alone desktop application available from the https://ubersdr.org website

### Improvements
- Added **Signal data for recordings** when recording audio the ZIP now also contains power data, once per second, in CSV format
- Changed **SSB maximum bandwidth** to 6 KHz for ESSB listening
- Migrated **FT2/4/8 decoding** from WAV file record -> jt9 processing model to purely in-memory using a circular buffer and IPC. WSPR still uses WAV -> wsprd. This is how WSJT-X does it.

### In Progress (Coming Soon)
- RMNoise.com integration for SSB & CW noise reduction
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
