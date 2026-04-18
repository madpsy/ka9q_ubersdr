# UberSDR Bridge Chrome Extension — Makefile
#
# Targets:
#   make build     — build the .zip package into dist/
#   make icons     — regenerate PNG icons from icon_source.png (requires ImageMagick)
#   make clean     — remove dist/
#   make zip       — alias for build
#
# Requirements:
#   - Node.js >= 18  (for build.mjs)
#   - zip            (system package, for packaging)
#   - ImageMagick convert (for `make icons`)
#
# To load in Chrome (developer mode):
#   chrome://extensions → Enable "Developer mode" → "Load unpacked" → select extension/
#
# To submit to Chrome Web Store:
#   Upload dist/ubersdr_bridge_chrome-{version}.zip via the developer dashboard.

.PHONY: all build zip icons clean help

EXTENSION_DIR := extension
DIST_DIR      := dist
ICON_SRC      := $(EXTENSION_DIR)/icons/icon_source.png
ICON_48       := $(EXTENSION_DIR)/icons/icon48.png
ICON_96       := $(EXTENSION_DIR)/icons/icon96.png
ICON_128      := $(EXTENSION_DIR)/icons/icon128.png

# Read version from manifest.json
VERSION := $(shell python3 -c "import json,sys; print(json.load(open('$(EXTENSION_DIR)/manifest.json'))['version'])" 2>/dev/null || echo "unknown")

all: build

## build: Build the .zip extension package into dist/
build: icons
	@mkdir -p $(DIST_DIR)
	cd $(EXTENSION_DIR) && zip -r ../$(DIST_DIR)/ubersdr_bridge_chrome-$(VERSION).zip . \
		--exclude "*.DS_Store" \
		--exclude "__MACOSX/*"
	@echo ""
	@echo "✅ Built: $(DIST_DIR)/ubersdr_bridge_chrome-$(VERSION).zip"
	@echo "   Load unpacked: chrome://extensions → Developer mode → Load unpacked → select extension/"
	@echo "   Web Store:     upload the .zip via the Chrome Web Store developer dashboard"

## zip: Alias for build
zip: build

## icons: Regenerate PNG icons from icon_source.png (requires ImageMagick)
icons: $(ICON_48) $(ICON_96) $(ICON_128)

$(ICON_48): $(ICON_SRC)
	convert $< -resize 48x48 $@
	@echo "  Generated $@"

$(ICON_96): $(ICON_SRC)
	convert $< -resize 96x96 $@
	@echo "  Generated $@"

$(ICON_128): $(ICON_SRC)
	convert $< -resize 128x128 $@
	@echo "  Generated $@"

## clean: Remove build artifacts
clean:
	rm -rf $(DIST_DIR)/
	@echo "Cleaned."

## help: Show this help
help:
	@echo "UberSDR Bridge — Chrome Extension Build"
	@echo ""
	@grep -E '^## ' Makefile | sed 's/## /  make /'
