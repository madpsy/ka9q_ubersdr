# UberSDR Bridge Firefox Extension — Makefile
#
# Targets:
#   make install   — install npm dependencies (web-ext)
#   make build     — build the .xpi package into dist/
#   make dev       — run the extension in a temporary Firefox profile (live reload)
#   make lint      — lint the extension with web-ext
#   make icons     — regenerate PNG icons from icon.svg (requires ImageMagick)
#   make clean     — remove dist/ and node_modules/
#   make zip       — build a plain .zip (alternative to .xpi, same format)
#
# Requirements:
#   - Node.js >= 18
#   - npm >= 9
#   - Firefox (for `make dev`)
#   - ImageMagick convert (for `make icons`)

.PHONY: all install build dev lint icons clean zip help

EXTENSION_DIR := extension
DIST_DIR      := dist
ICON_SRC      := $(EXTENSION_DIR)/icons/icon_source.png
ICON_48       := $(EXTENSION_DIR)/icons/icon48.png
ICON_96       := $(EXTENSION_DIR)/icons/icon96.png
ICON_128      := $(EXTENSION_DIR)/icons/icon128.png

# Read version from manifest.json (requires python3 or jq)
VERSION := $(shell python3 -c "import json,sys; print(json.load(open('$(EXTENSION_DIR)/manifest.json'))['version'])" 2>/dev/null || echo "unknown")

all: build

## install: Install npm dependencies (web-ext)
install:
	npm install

## build: Build the .xpi extension package into dist/
build: install icons
	npm run build
	@echo ""
	@echo "✅ Built: $(DIST_DIR)/ubersdr_bridge-$(VERSION).xpi (rename from .zip if needed)"
	@echo "   Load in Firefox: about:debugging → This Firefox → Load Temporary Add-on"

## dev: Run the extension in a temporary Firefox profile with live reload
dev: install
	npm run dev

## lint: Lint the extension source with web-ext
lint: install
	npm run lint

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

## zip: Build a plain .zip (same content as .xpi, different extension)
zip: install icons
	@mkdir -p $(DIST_DIR)
	cd $(EXTENSION_DIR) && zip -r ../$(DIST_DIR)/ubersdr_bridge-$(VERSION).zip . \
		--exclude "*.DS_Store" \
		--exclude "__MACOSX/*"
	@echo "✅ Built: $(DIST_DIR)/ubersdr_bridge-$(VERSION).zip"

## clean: Remove build artifacts and node_modules
clean:
	rm -rf $(DIST_DIR)/ node_modules/ package-lock.json
	@echo "Cleaned."

## help: Show this help
help:
	@echo "UberSDR Bridge — Firefox Extension Build"
	@echo ""
	@grep -E '^## ' Makefile | sed 's/## /  make /'
