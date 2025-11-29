# Multi-stage build for UberSDR Instance Collector
FROM golang:1.24-bookworm AS builder

# Set working directory
WORKDIR /build

# Copy go mod files first for better caching
COPY go.mod go.sum* ./
RUN go mod download

# Copy source files
COPY *.go ./

# Build the collector
RUN CGO_ENABLED=1 GOOS=linux go build -o collector .

# Runtime stage
FROM ubuntu:24.04

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    sqlite3 \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy pre-built binary from builder
COPY --from=builder /build/collector /usr/local/bin/collector
RUN chmod +x /usr/local/bin/collector

# Copy example configuration file
COPY config.json.example /etc/collector/config.json.example

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create directory for database
RUN mkdir -p /app/data

# Expose default port
EXPOSE 8443/tcp

# Environment variables
ENV TZ=UTC

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8443/health || exit 1

# Use entrypoint script to handle configuration
ENTRYPOINT ["/entrypoint.sh"]

# Default command
CMD ["collector"]