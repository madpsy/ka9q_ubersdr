"""
test_display.py — Standalone display test for Galactic Unicorn
Run with: mpremote run firmware/test_display.py

This script tests the display hardware directly without loading main.py or
display_engine.py. If this works but main.py doesn't, the issue is in the
firmware files. If this doesn't work, the issue is hardware or the UF2 firmware.

Usage:
    mpremote run firmware/test_display.py
    mpremote connect /dev/ttyACM0 run firmware/test_display.py
"""

import time

print("=== Galactic Unicorn Display Test ===")
print()

# Step 1: Import hardware modules
print("1. Importing hardware modules...")
try:
    # Pimoroni MicroPython v1.24+ uses 'galactic' module name
    try:
        from galactic import GalacticUnicorn
    except ImportError:
        from galactic_unicorn import GalacticUnicorn  # older builds
    print("   ✓ GalacticUnicorn imported")
except ImportError as e:
    print(f"   ✗ FAILED: {e}")
    print("   → Is this the Pimoroni MicroPython firmware?")
    print("   → Download from: https://github.com/pimoroni/pimoroni-pico/releases")
    print("   → Use: galactic_unicorn-vX.Y.Z-pimoroni-micropython.uf2")
    raise SystemExit(1)

try:
    from picographics import PicoGraphics, DISPLAY_GALACTIC_UNICORN
    print("   ✓ picographics imported")
except ImportError as e:
    print(f"   ✗ FAILED: {e}")
    raise SystemExit(1)

# Step 2: Initialise hardware
print()
print("2. Initialising display hardware...")
try:
    gu = GalacticUnicorn()
    graphics = PicoGraphics(display=DISPLAY_GALACTIC_UNICORN)
    print("   ✓ GalacticUnicorn and PicoGraphics initialised")
except Exception as e:
    print(f"   ✗ FAILED: {e}")
    raise SystemExit(1)

# Step 3: Set brightness
print()
print("3. Setting brightness to 0.8...")
try:
    gu.set_brightness(0.8)
    print("   ✓ Brightness set")
except Exception as e:
    print(f"   ✗ FAILED: {e}")

# Step 4: Draw a solid red screen
print()
print("4. Drawing solid RED screen (should see red LEDs)...")
try:
    graphics.set_pen(graphics.create_pen(255, 0, 0))
    graphics.clear()
    gu.update(graphics)
    print("   ✓ Red screen drawn")
    time.sleep(1)
except Exception as e:
    print(f"   ✗ FAILED: {e}")
    raise SystemExit(1)

# Step 5: Draw solid green
print("5. Drawing solid GREEN screen...")
graphics.set_pen(graphics.create_pen(0, 255, 0))
graphics.clear()
gu.update(graphics)
time.sleep(1)

# Step 6: Draw solid blue
print("6. Drawing solid BLUE screen...")
graphics.set_pen(graphics.create_pen(0, 0, 255))
graphics.clear()
gu.update(graphics)
time.sleep(1)

# Step 7: Draw white text
print()
print("7. Drawing white text 'UberSDR'...")
try:
    graphics.set_pen(graphics.create_pen(0, 0, 0))
    graphics.clear()
    graphics.set_pen(graphics.create_pen(255, 255, 255))
    graphics.text("UberSDR", 0, 3, scale=1)
    gu.update(graphics)
    print("   ✓ Text drawn")
    time.sleep(2)
except Exception as e:
    print(f"   ✗ FAILED: {e}")

# Step 8: Rainbow text
print()
print("8. Drawing rainbow text...")
try:
    def hsv_to_rgb(h, s, v):
        if s == 0.0:
            c = int(v * 255)
            return c, c, c
        i = int(h * 6.0)
        f = (h * 6.0) - i
        p = v * (1.0 - s)
        q = v * (1.0 - s * f)
        t = v * (1.0 - s * (1.0 - f))
        i = i % 6
        if i == 0: return int(v*255), int(t*255), int(p*255)
        if i == 1: return int(q*255), int(v*255), int(p*255)
        if i == 2: return int(p*255), int(v*255), int(t*255)
        if i == 3: return int(p*255), int(q*255), int(v*255)
        if i == 4: return int(t*255), int(p*255), int(v*255)
        return int(v*255), int(p*255), int(q*255)

    text = "UberSDR"
    for frame in range(60):  # ~2 seconds at 30fps
        hue_offset = frame / 60.0
        graphics.set_pen(graphics.create_pen(0, 0, 0))
        graphics.clear()
        cx = 0
        for ch in text:
            w = graphics.measure_text(ch, scale=2)
            hue = (hue_offset + cx / 53.0) % 1.0
            r, g, b = hsv_to_rgb(hue, 1.0, 1.0)
            graphics.set_pen(graphics.create_pen(r, g, b))
            graphics.text(ch, cx, 2, scale=2)
            cx += w
        gu.update(graphics)
        time.sleep(0.033)
    print("   ✓ Rainbow animation complete")
except Exception as e:
    print(f"   ✗ FAILED: {e}")

# Step 9: Blank
print()
print("9. Blanking display...")
graphics.set_pen(graphics.create_pen(0, 0, 0))
graphics.clear()
gu.update(graphics)

print()
print("=== Test complete ===")
print()
print("If you saw colours and text: hardware is working correctly.")
print("If the display stayed blank: check USB power and the UF2 firmware.")
print()
print("Next step: run the full firmware with:")
print("  mpremote repl   (then Ctrl+D to soft-reset and watch boot output)")
