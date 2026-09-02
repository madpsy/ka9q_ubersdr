BINARY := ubersdr-rtltcp-bridge

# Everything built here lands in build/, which is where build.sh puts the
# release binaries and which .gitignore already covers. Writing to the source
# directory instead is what put a committed copy of this program in the repo:
# a bare `go build .` names its output after the directory, so the two kept
# overwriting each other.
OUT := build

GOFLAGS := -ldflags="-s -w"

.PHONY: all build clean install

all: build

build:
	@mkdir -p $(OUT)
	go build $(GOFLAGS) -o $(OUT)/$(BINARY) .

clean:
	rm -f $(OUT)/$(BINARY)

install: build
	install -m 755 $(OUT)/$(BINARY) /usr/local/bin/$(BINARY)

install-service: install
	install -m 644 ubersdr-rtltcp-bridge.service /etc/systemd/system/
	systemctl daemon-reload
	@echo "Service installed. Edit /etc/systemd/system/ubersdr-rtltcp-bridge.service then:"
	@echo "  systemctl enable --now ubersdr-rtltcp-bridge"
