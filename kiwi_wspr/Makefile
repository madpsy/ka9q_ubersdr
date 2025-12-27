.PHONY: build clean install

# Build with CGO enabled (required for libsamplerate resampling)
build:
	CGO_ENABLED=1 go build -v

# Clean build artifacts
clean:
	go clean
	rm -f kiwi_wspr

# Install to /usr/local/bin
install: build
	sudo cp kiwi_wspr /usr/local/bin/

# Run with one-shot mode
test-oneshot: build
	./kiwi_wspr --one-shot

# Run normally
run: build
	./kiwi_wspr
