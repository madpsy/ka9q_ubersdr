BINARY := ubersdr-rtltcp-bridge
GOFLAGS := -ldflags="-s -w"

.PHONY: all build clean install

all: build

build:
	go build $(GOFLAGS) -o $(BINARY) .

clean:
	rm -f $(BINARY)

install: build
	install -m 755 $(BINARY) /usr/local/bin/$(BINARY)

install-service: install
	install -m 644 ubersdr-rtltcp-bridge.service /etc/systemd/system/
	systemctl daemon-reload
	@echo "Service installed. Edit /etc/systemd/system/ubersdr-rtltcp-bridge.service then:"
	@echo "  systemctl enable --now ubersdr-rtltcp-bridge"
