# Multi-stage build for KiwiSDR WSPR Decoder
# Stage 1: Build the Go application
FROM golang:1.24-bookworm AS builder

WORKDIR /build

# Install libsamplerate for audio resampling
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libsamplerate0-dev \
        pkg-config && \
    rm -rf /var/lib/apt/lists/*

# Copy go.mod and go.sum
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy all source code files
COPY *.go ./

# Copy static files and data
COPY static/ ./static/
COPY cty/ ./cty/

# Build the application with CGO enabled for libsamplerate
RUN CGO_ENABLED=1 GOOS=linux go build -a -o kiwi_wspr .

# Stage 2: Create the runtime image using Ubuntu 24.04
FROM ubuntu:24.04

# Set metadata
LABEL maintainer="KiwiSDR WSPR Decoder"
LABEL description="KiwiSDR WSPR Decoder - Multi-instance WSPR decoder with web interface"

# Install dependencies including WSJT-X for wsprd and libsamplerate for resampling
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        tzdata \
        wget \
        curl \
        # WSJT-X for wsprd binary
        wsjtx \
        # libsamplerate for audio resampling (runtime library)
        libsamplerate0 \
        && \
    # Install yq for YAML processing
    curl -L https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -o /usr/bin/yq && \
    chmod +x /usr/bin/yq && \
    rm -rf /var/lib/apt/lists/*

# Verify wsprd is installed
RUN which wsprd && wsprd --help || echo "wsprd installed"

# Create app directory
RUN mkdir -p /app/data /app/wspr_data

WORKDIR /app

# Copy the binary from builder
COPY --from=builder /build/kiwi_wspr .

# Copy static files from builder
COPY --from=builder /build/static ./static
COPY --from=builder /build/cty ./cty

# Copy example config
COPY config.yaml.example ./config.yaml.example

# Copy entrypoint script
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Expose web interface port
EXPOSE 8080

# Volume for configuration and data persistence
VOLUME ["/app/data"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/ || exit 1

# Run the application via entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]
CMD []
