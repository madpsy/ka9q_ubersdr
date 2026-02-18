## Version 0.1.40 - Latest Release

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
