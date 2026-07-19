# UberSDR + Home Assistant

UberSDR can publish its health, user sessions, propagation, and per-band
conditions to [Home Assistant](https://www.home-assistant.io/) over MQTT. With
Home Assistant MQTT Discovery enabled, every metric is turned into a Home
Assistant entity automatically - no manual entity YAML required - all grouped
under a single device named after your receiver's callsign.

This guide describes exactly how to set that up and build an all-in-one
dashboard.

---

## What you get

Once configured, UberSDR appears in Home Assistant as one device,
"UberSDR &lt;CALLSIGN&gt;", with entities including:

- **Users** - active listener count, plus the full live session list (frequency,
  mode, country, city, chat username) as attributes.
- **Propagation / space weather** - Solar Flux Index, K-index, A-index, solar
  wind Bz, propagation quality, geomagnetic status.
- **Per-band noise floor** - occupancy percent and estimated FT8 SNR for every
  configured band.
- **Receiver identity and status** - callsign, name, location, grid square,
  antenna, ASL, timezone, available client slots, chat users, wideband SNR, and
  feature flags (carried as attributes of the "Receiver Info" sensor).
- **Local weather** - when the weather source is configured: outside temperature,
  feels-like, humidity, pressure, wind speed and bearing, and current conditions.
- **Antennas** - when an antenna switch and/or rotator are enabled: the currently
  selected antenna, grounded state, thunderstorm protection, rotator azimuth and
  elevation, and moving/connected state.
- **Diagnostics** - system load, CPU temperature, NTP offset, GPSDO frequency
  reference offset and SNR.
- **Health** - connectivity, NTP, DSP, tunnel server, and instance reporter
  health as binary sensors.
- **Optional live map** - listeners plotted as markers that appear and disappear
  as users come and go.

Everything is auto-populated per instance. The included dashboard uses generic,
callsign-independent entity IDs, so it works as-is on any receiver.

---

## Prerequisites

You need an MQTT broker that both UberSDR and Home Assistant can reach.

If you do not already have one, the simplest option is the Mosquitto broker
add-on inside Home Assistant:

1. Settings -> Add-ons -> Add-on Store -> **Mosquitto broker** -> Install ->
   Start.
2. Settings -> People -> add a Home Assistant user (for example `ubersdr` with a
   password). Mosquitto authenticates against Home Assistant users by default.

---

## Step 1 - Enable MQTT and discovery in UberSDR

Edit your UberSDR `config.yaml` and set the following under the `mqtt` section:

```yaml
mqtt:
  enabled: true
  broker: "tcp://BROKER_HOST:1883"        # IP/hostname of your broker
  username: "ubersdr"                      # if the broker requires auth
  password: "YOUR_PASSWORD"
  topic_prefix: "ubersdr/metrics"          # default; leave as-is
  homeassistant_discovery: true            # turns metrics into HA entities
  homeassistant_prefix: "homeassistant"    # default; must match HA's discovery prefix
```

Key settings:

- `homeassistant_discovery: true` is the switch that makes entities appear in
  Home Assistant. It also publishes an availability topic
  (`ubersdr/metrics/status`) with an online/offline birth and Last Will message,
  so entities go unavailable if UberSDR disconnects from the broker.
- `homeassistant_prefix` must match the discovery prefix configured in Home
  Assistant's MQTT integration (the default is `homeassistant` on both sides).

Restart UberSDR to apply the change (for example `./restart-ubersdr.sh`, or
restart the container). In the UberSDR log you should see:

```
MQTT: Connected to broker
MQTT: Home Assistant discovery enabled (prefix=homeassistant)
MQTT: Published N Home Assistant discovery configs (node=ubersdr_YOURCALL)
```

---

## Step 2 - Add the MQTT integration in Home Assistant

1. Settings -> Devices & Services -> **Add Integration** -> **MQTT**.
2. Enter your broker host, port `1883`, and the username/password if required.
   (If you use the Mosquitto add-on, Home Assistant often auto-discovers it -
   just confirm.)

No entity configuration is needed. Within a few seconds a device named
"UberSDR &lt;CALLSIGN&gt;" appears under Settings -> Devices & Services -> MQTT ->
devices, with all sensors created automatically.

To verify data is flowing: open the MQTT integration -> Configure -> "Listen to
a topic", enter `ubersdr/metrics/#`, and you should see live messages.

---

## Step 3 - Add the dashboard

A ready-made dashboard is provided at
[`homeassistant/ubersdr-dashboard.yaml`](homeassistant/ubersdr-dashboard.yaml).

1. Settings -> Dashboards -> **Add Dashboard** -> create a new empty dashboard.
2. Open it, then top-right menu (three dots) -> **Edit Dashboard** -> menu (three
   dots) -> **Raw configuration editor**.
3. Delete the placeholder content and paste the entire contents of
   `homeassistant/ubersdr-dashboard.yaml`. Save.

The file is a complete dashboard (it defines `title:` and `views:`). To instead
add it as a view on an existing dashboard, paste only the single item under
`views:` as a new view.

Because the entity IDs are generic (`sensor.ubersdr_*`), no editing is needed for
your callsign.

---

## Step 4 (optional) - Live listener map

This plots active listeners on a map using Home Assistant's built-in GeoJSON
integration. Markers are transient - they appear and vanish as users connect and
disconnect - with no entity-registry clutter.

First enable the feed in UberSDR `config.yaml`:

```yaml
server:
  sessions_geojson_enabled: true

geoip:
  enabled: true            # required so listener locations can be resolved
```

Restart UberSDR, then confirm the feed works:

```
curl https://YOUR_SDR/api/sessions.geojson
```

It should return a GeoJSON `FeatureCollection`.

Then add it in Home Assistant, either via the UI (Settings -> Devices & Services
-> **Add Integration** -> **GeoJSON**, with the feed URL) or in
`configuration.yaml`:

```yaml
geo_location:
  - platform: geo_json_events
    url: https://YOUR_SDR/api/sessions.geojson
    radius: 20000          # km - global, so no listeners are filtered out
    scan_interval: 30      # seconds between polls
```

The map card in the dashboard picks these up automatically via its
`geo_location_sources` setting.

Privacy note: the feed exposes approximate (GeoIP city-level) visitor locations
on an unauthenticated endpoint. If Home Assistant is on your LAN, restrict
`/api/sessions.geojson` to Home Assistant's IP at your reverse proxy or firewall.

---

## Step 5 (optional) - Live chat feed

When chat is enabled on the instance, UberSDR publishes every chat message to
`ubersdr/metrics/chat` the instant it is sent. Home Assistant's MQTT integration
is push-based, so this is genuinely real-time.

Out of the box, discovery creates `sensor.ubersdr_last_chat_message`, which holds
the latest message (state) with `username`, `message`, `ip`, and `timestamp` as
attributes, updating the moment a message arrives. The dashboard's "Latest
message" tile uses this.

An MQTT sensor only keeps the newest message. To show a rolling history of the
last 10 messages, add a small trigger-based template sensor that accumulates them
Home Assistant side. In `configuration.yaml`:

```yaml
template:
  - trigger:
      - platform: mqtt
        topic: ubersdr/metrics/chat
    sensor:
      - name: UberSDR Chat History
        unique_id: ubersdr_chat_history
        state: "{{ trigger.payload_json.message | truncate(250) }}"
        attributes:
          messages: >
            {% set prior = this.attributes.get('messages', []) %}
            {% set new = {'time': now().strftime('%H:%M'),
                          'username': trigger.payload_json.username,
                          'message': trigger.payload_json.message} %}
            {{ (prior + [new])[-10:] }}
```

The dashboard's "Recent messages" markdown card renders this sensor's `messages`
attribute (newest first). Until the sensor exists the card shows a "waiting"
placeholder; the real-time "Latest message" tile works regardless.

Optional - live notifications on every message. Add an automation that triggers
on the same topic (replace `notify.mobile_app_...` with your notify service):

```yaml
automation:
  - alias: UberSDR chat notification
    trigger:
      - platform: mqtt
        topic: ubersdr/metrics/chat
    action:
      - service: notify.mobile_app_your_phone
        data:
          title: "UberSDR chat"
          message: "{{ trigger.payload_json.username }}: {{ trigger.payload_json.message }}"
```

Note: the `ubersdr/metrics/chat` payload includes the sender's IP address. The
history template sensor above intentionally keeps only time/username/message.

## Step 6 (optional, recommended) - Reduce recorder load

The `sensor.ubersdr_active_users` entity updates once per second and carries the
full session list as attributes (used by the "Active Listeners" table). To keep
that large attribute out of the history database, add to `configuration.yaml`:

```yaml
recorder:
  exclude:
    entity_globs:
      - sensor.ubersdr_active_users
```

The live table and gauge still work (they read the current state); you simply do
not retain a second-by-second history of the attribute blob.

---

## Entity reference

All entity IDs are prefixed `ubersdr_` and are the same on every instance.

| Entity | Description |
| --- | --- |
| `sensor.ubersdr_active_users` | Active listener count; session list in attributes |
| `sensor.ubersdr_receiver_info` | Version; full identity (callsign, location, grid, antenna, ASL, timezone, feature flags) in attributes |
| `sensor.ubersdr_grid_square` | Maidenhead grid locator |
| `sensor.ubersdr_available_clients` | Free client slots |
| `sensor.ubersdr_chat_users` | Users currently in chat |
| `sensor.ubersdr_last_chat_message` | Latest chat message (real-time), if chat enabled; details in attributes |
| `sensor.ubersdr_snr_0_30` | Wideband SNR, 0-30 MHz (dB) |
| `sensor.ubersdr_snr_1_8_30` | Wideband SNR, 1.8-30 MHz (dB) |
| `sensor.ubersdr_solar_flux` | Solar Flux Index (SFU) |
| `sensor.ubersdr_k_index` | K-index |
| `sensor.ubersdr_a_index` | A-index |
| `sensor.ubersdr_solar_wind_bz` | Solar wind Bz (nT) |
| `sensor.ubersdr_propagation_quality` | Overall propagation quality (text) |
| `sensor.ubersdr_weather_temp` | Outside temperature (C), if weather configured |
| `sensor.ubersdr_weather_feels_like` | Feels-like temperature (C), if weather configured |
| `sensor.ubersdr_weather_humidity` | Outside humidity (%), if weather configured |
| `sensor.ubersdr_weather_pressure` | Atmospheric pressure (hPa), if weather configured |
| `sensor.ubersdr_weather_wind_speed` | Wind speed (m/s), if weather configured |
| `sensor.ubersdr_weather_wind_bearing` | Wind bearing (degrees), if weather configured |
| `sensor.ubersdr_weather_condition` | Weather condition, e.g. Clouds/Rain, if weather configured |
| `sensor.ubersdr_weather_description` | Detailed weather description, if weather configured |
| `sensor.ubersdr_k_index_status` | Geomagnetic status (text) |
| `sensor.ubersdr_noisefloor_<band>_occupancy` | Band occupancy percent (per configured band) |
| `sensor.ubersdr_noisefloor_<band>_ft8_snr` | Estimated FT8 SNR, dB (per configured band) |
| `sensor.ubersdr_system_load_1m` | 1-minute system load |
| `sensor.ubersdr_cpu_temp` | CPU temperature (C) |
| `sensor.ubersdr_ntp_offset` | NTP time offset (ms) |
| `sensor.ubersdr_freq_ref_offset` | GPSDO frequency reference offset (Hz), if enabled |
| `sensor.ubersdr_freq_ref_snr` | GPSDO frequency reference SNR (dB), if enabled |
| `sensor.ubersdr_antenna_switch` | Selected antenna label (or "Grounded"), if antenna switch enabled |
| `sensor.ubersdr_rotator_azimuth` | Antenna rotator azimuth (degrees), if rotator enabled |
| `sensor.ubersdr_rotator_elevation` | Antenna rotator elevation (degrees), if rotator enabled |
| `binary_sensor.ubersdr_antenna_grounded` | Antenna grounded (on = grounded), if antenna switch enabled |
| `binary_sensor.ubersdr_antenna_thunderstorm` | Thunderstorm auto-protection enabled, if antenna switch enabled |
| `binary_sensor.ubersdr_rotator_moving` | Rotator moving (on = moving), if rotator enabled |
| `binary_sensor.ubersdr_rotator_connected` | Rotator device connected, if rotator enabled |
| `binary_sensor.ubersdr_online` | Receiver connectivity (on = connected) |
| `binary_sensor.ubersdr_ntp_health` | NTP health (on = problem) |
| `binary_sensor.ubersdr_dsp_health` | DSP health (on = problem), if DSP enabled |
| `binary_sensor.ubersdr_instance_reporter_health` | Instance reporter health, if enabled |
| `binary_sensor.ubersdr_tunnel_server_health` | Tunnel server health, if enabled |

Health binary sensors use the `problem` device class: "on" means a problem is
present, "off" means healthy.

---

## Multiple receivers

If you run several UberSDR instances into one Home Assistant, each publishes its
own device (the discovery topic node ID is callsign-scoped, and unique IDs are
globally unique, so registry entries never collide). However, the generic entity
IDs will collide, and Home Assistant will auto-suffix the second instance's
entities (for example `sensor.ubersdr_active_users_2`). In that case, use a
separate dashboard per instance, or rename the entities in the Home Assistant UI.

---

## Troubleshooting

- **No device appears.** Confirm the UberSDR log shows "Published N discovery
  configs". Confirm Home Assistant's MQTT integration is connected to the same
  broker. Confirm `homeassistant_prefix` matches Home Assistant's discovery
  prefix (default `homeassistant`).
- **Entities show "unavailable".** UberSDR is not publishing - the broker is down
  or UberSDR is disconnected. The availability topic (`ubersdr/metrics/status`)
  drives this; when UberSDR drops, its Last Will marks everything offline.
- **A health or diagnostic sensor has no value at first.** Several topics publish
  every 60 seconds and are not retained, so allow up to a minute after startup
  for the first value to arrive.
- **The map is empty.** Confirm `server.sessions_geojson_enabled: true` and
  `geoip.enabled: true`, that `/api/sessions.geojson` returns features, and that
  the GeoJSON integration `radius` is large enough to include distant listeners.
