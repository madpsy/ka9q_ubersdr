BINARY := ubersdr-rtltcp-bridge

# Everything built here lands in build/, which is where build.sh puts the
# release binaries and which .gitignore already covers. Writing to the source
# directory instead is what put a committed copy of this program in the repo:
# a bare `go build .` names its output after the directory, so the two kept
# overwriting each other.
OUT := build

# Named with the architecture, as build.sh names its two: the release assets are
# ubersdr-rtltcp-bridge_amd64 and _arm64, and a local build that dropped the
# suffix would sit beside them looking like a third thing. Taken from the Go
# environment rather than uname, so `GOARCH=arm64 make` cross-compiles to the
# name that architecture's asset already has.
ARCH := $(shell go env GOARCH)

GOFLAGS := -ldflags="-s -w"

.PHONY: all build clean install

all: build

build:
	@mkdir -p $(OUT)
	go build $(GOFLAGS) -o $(OUT)/$(BINARY)_$(ARCH) .

clean:
	rm -f $(OUT)/$(BINARY)_$(ARCH)

install: build
	install -m 755 $(OUT)/$(BINARY)_$(ARCH) /usr/local/bin/$(BINARY)

install-service: install
	install -m 644 ubersdr-rtltcp-bridge.service /etc/systemd/system/
	systemctl daemon-reload
	@echo "Service installed. Edit /etc/systemd/system/ubersdr-rtltcp-bridge.service then:"
	@echo "  systemctl enable --now ubersdr-rtltcp-bridge"
