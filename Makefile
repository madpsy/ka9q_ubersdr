# Makefile for ka9q_ubersdr

.PHONY: all build run clean test install deps

# Binary name
BINARY=ka9q_ubersdr

# Build the application
all: build

# Build the binary
build:
	@echo "Building $(BINARY)..."
	go build -o $(BINARY) .
	@echo "Build complete: ./$(BINARY)"

# Run the application
run: build
	@echo "Starting $(BINARY)..."
	./$(BINARY)

# Run with custom config
run-config: build
	@echo "Starting $(BINARY) with custom config..."
	./$(BINARY) -config $(CONFIG)

# Install dependencies
deps:
	@echo "Installing dependencies..."
	go mod download
	go mod tidy

# Run tests
test:
	@echo "Running tests..."
	go test -v ./...

# Clean build artifacts
clean:
	@echo "Cleaning..."
	rm -f $(BINARY)
	@echo "Clean complete"

# Install the binary to $GOPATH/bin
install: build
	@echo "Installing $(BINARY) to $$GOPATH/bin..."
	go install .
	@echo "Install complete"

# Format code
fmt:
	@echo "Formatting code..."
	go fmt ./...

# Run linter
lint:
	@echo "Running linter..."
	golangci-lint run

# Build for multiple platforms
build-all:
	@echo "Building for multiple platforms..."
	GOOS=linux GOARCH=amd64 go build -o $(BINARY)-linux-amd64 .
	GOOS=linux GOARCH=arm64 go build -o $(BINARY)-linux-arm64 .
	GOOS=darwin GOARCH=amd64 go build -o $(BINARY)-darwin-amd64 .
	GOOS=darwin GOARCH=arm64 go build -o $(BINARY)-darwin-arm64 .
	@echo "Multi-platform build complete"

# Show help
help:
	@echo "Available targets:"
	@echo "  make build       - Build the application"
	@echo "  make run         - Build and run the application"
	@echo "  make run-config  - Run with custom config (CONFIG=path/to/config.yaml)"
	@echo "  make deps        - Install dependencies"
	@echo "  make test        - Run tests"
	@echo "  make clean       - Remove build artifacts"
	@echo "  make install     - Install binary to \$$GOPATH/bin"
	@echo "  make fmt         - Format code"
	@echo "  make lint        - Run linter"
	@echo "  make build-all   - Build for multiple platforms"
	@echo "  make help        - Show this help message"