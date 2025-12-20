# Multi-stage build for WSPR MQTT Aggregator
# Stage 1: Build the Go application
FROM golang:1.21-bookworm AS builder

WORKDIR /build

# Copy go.mod and go.sum
COPY go.mod go.sum ./

# Download dependencies
RUN go mod download

# Copy source code
COPY *.go ./

# Build the application
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o wsprnet_mqtt .

# Stage 2: Create the runtime image using Ubuntu 24.04
FROM ubuntu:24.04

# Set metadata
LABEL maintainer="WSPR MQTT Aggregator"
LABEL description="WSPR MQTT Aggregator - Aggregates WSPR spots from multiple UberSDR instances"

# Install ca-certificates, yq for config merging, and wget for health checks
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        tzdata \
        wget \
        curl && \
    # Install yq for YAML processing
    curl -L https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 -o /usr/bin/yq && \
    chmod +x /usr/bin/yq && \
    rm -rf /var/lib/apt/lists/*

# Create app directory
RUN mkdir -p /app/data

WORKDIR /app

# Copy the binary from builder
COPY --from=builder /build/wsprnet_mqtt .

# Copy example config
COPY config.yaml.example ./config.yaml.example

# Copy entrypoint script
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Expose web interface port
EXPOSE 9009

# Volume for configuration and data persistence
VOLUME ["/app/data"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:9009/ || exit 1

# Run the application via entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]
CMD []