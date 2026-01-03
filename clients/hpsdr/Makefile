# Makefile for UberSDR to HPSDR Protocol 2 Bridge

BINARY_NAME=ubersdr-hpsdr-bridge
GO=go
GOFLAGS=-v

.PHONY: all build clean install test run help

all: build

# Build the bridge
build:
	@echo "Building $(BINARY_NAME)..."
	$(GO) build $(GOFLAGS) -o $(BINARY_NAME) .
	@echo "Build complete: $(BINARY_NAME)"

# Clean build artifacts
clean:
	@echo "Cleaning..."
	rm -f $(BINARY_NAME)
	$(GO) clean
	@echo "Clean complete"

# Install to /usr/local/bin (requires sudo)
install: build
	@echo "Installing $(BINARY_NAME) to /usr/local/bin..."
	sudo cp $(BINARY_NAME) /usr/local/bin/
	@echo "Install complete"

# Run with default settings
run: build
	./$(BINARY_NAME) --host localhost --port 8073

# Run tests
test:
	$(GO) test -v ./...

# Download dependencies
deps:
	@echo "Downloading dependencies..."
	$(GO) mod download
	@echo "Dependencies downloaded"

# Update dependencies
update-deps:
	@echo "Updating dependencies..."
	$(GO) get -u ./...
	$(GO) mod tidy
	@echo "Dependencies updated"

# Show help
help:
	@echo "UberSDR to HPSDR Protocol 2 Bridge - Makefile"
	@echo ""
	@echo "Available targets:"
	@echo "  make build       - Build the bridge binary"
	@echo "  make clean       - Remove build artifacts"
	@echo "  make install     - Install to /usr/local/bin (requires sudo)"
	@echo "  make run         - Build and run with default settings"
	@echo "  make test        - Run tests"
	@echo "  make deps        - Download dependencies"
	@echo "  make update-deps - Update dependencies"
	@echo "  make help        - Show this help message"
	@echo ""
	@echo "Example usage:"
	@echo "  make build"
	@echo "  ./$(BINARY_NAME) --host localhost --port 8073"
