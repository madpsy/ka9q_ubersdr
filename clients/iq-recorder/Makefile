.PHONY: all build release publish clean install deps test run

BINARY_NAME=iq-recorder
BUILD_DIR=build

all: build

build:
	@echo "Building $(BINARY_NAME)..."
	@mkdir -p $(BUILD_DIR)
	go build -o $(BUILD_DIR)/$(BINARY_NAME) .
	@echo "Build complete: $(BUILD_DIR)/$(BINARY_NAME)"

# Release artifacts are build.sh's job, not this file's: it cross-compiles both
# architectures under the names the GitHub release serves them by, and knows how
# to upload them. Delegating rather than duplicating keeps one definition of
# what a published binary is.
release:
	@./build.sh --test

publish:
	@./build.sh --test --publish

clean:
	@echo "Cleaning..."
	@rm -rf $(BUILD_DIR)
	@go clean
	@echo "Clean complete"

install: build
	@echo "Installing $(BINARY_NAME) to /usr/local/bin..."
	@sudo cp $(BUILD_DIR)/$(BINARY_NAME) /usr/local/bin/
	@echo "Installation complete"

deps:
	@echo "Downloading dependencies..."
	@go mod download
	@echo "Dependencies downloaded"

test:
	@echo "Running tests..."
	@go test -v ./...

run: build
	@echo "Running $(BINARY_NAME)..."
	@$(BUILD_DIR)/$(BINARY_NAME)
