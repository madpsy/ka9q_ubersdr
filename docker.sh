#!/bin/bash

# Extract version from version.go
VERSION=$(grep -oP 'const Version = "\K[^"]+' version.go)
IMAGE=madpsy/ka9q_ubersdr
FLUENT_BIT_IMAGE=madpsy/fluent-bit-ubersdr

# Parse command line flags
TAG_LATEST=true
NO_CACHE=""
BUILD_FLUENT_BIT=false
SKIP_GEOIP=false
NO_GIT=false
PLATFORM="linux/amd64,linux/arm64"   # default: both arches
PUSH_OR_LOAD="--push"                 # default: push to registry
CUSTOM_TAG=""
SKIP_SCAN=false
TRIVY_IMAGE="aquasec/trivy:latest"
TRIVY_SEVERITY="HIGH,CRITICAL"

for arg in "$@"; do
    case $arg in
        --tag=*)
            CUSTOM_TAG="${arg#*=}"
            if [ -z "$CUSTOM_TAG" ]; then
                echo "ERROR: --tag requires a value, e.g. --tag=test-1"
                exit 1
            fi
            TAG_LATEST=false
            NO_GIT=true
            echo "Using custom tag: $CUSTOM_TAG (will not tag as version or latest)"
            ;;
        --no-latest)
            TAG_LATEST=false
            echo "Running in --no-latest mode (will not tag as latest)"
            ;;
        --no-cache)
            NO_CACHE="--no-cache"
            echo "Running in --no-cache mode (will rebuild all layers)"
            ;;
        --fluent-bit)
            BUILD_FLUENT_BIT=true
            echo "Will build Fluent Bit image"
            ;;
        --no-geoip)
            SKIP_GEOIP=true
            echo "Running in --no-geoip mode (will skip GeoIP database download)"
            ;;
        --no-git)
            NO_GIT=true
            echo "Running in --no-git mode (will skip git commit and push)"
            ;;
        --no-scan)
            SKIP_SCAN=true
            echo "Running in --no-scan mode (will skip Trivy vulnerability scan)"
            ;;
        --amd64)
            PLATFORM="linux/amd64"
            PUSH_OR_LOAD="--load"
            TAG_LATEST=false
            NO_GIT=true
            echo "Building amd64 only — image will be loaded into local Docker (not pushed)"
            ;;
        --arm64)
            PLATFORM="linux/arm64"
            PUSH_OR_LOAD="--push"
            TAG_LATEST=false
            NO_GIT=true
            echo "Building arm64 only — image will be pushed to registry (not tagged latest)"
            ;;
        *)
            echo "Unknown option: $arg"
            echo "Usage: $0 [--tag=<value>] [--no-latest] [--no-cache] [--fluent-bit] [--no-geoip] [--no-git] [--no-scan] [--amd64] [--arm64]"
            exit 1
            ;;
    esac
done

# Scan an image with Trivy for known vulnerabilities.
#
# Advisory only: this reports findings but NEVER fails the build or blocks the
# push/git steps. Every failure mode (no network, Docker Hub rate limit, Trivy
# image unavailable, vuln DB download failure, scan timeout) is caught and
# downgraded to a warning, so an offline build still succeeds.
scan_image() {
    local image_ref="$1"
    local socket_args=()
    local platform_args=()

    if [ "$SKIP_SCAN" = true ]; then
        return 0
    fi

    echo ""
    echo "=========================================="
    echo "Trivy vulnerability scan: $image_ref"
    echo "=========================================="

    # Pull Trivy up front so an unavailable image is a clean skip rather than a
    # confusing scan failure. Quiet on success; the warning below covers failure.
    if ! docker pull --quiet "$TRIVY_IMAGE" >/dev/null 2>&1; then
        echo "WARNING: Could not pull $TRIVY_IMAGE - skipping vulnerability scan"
        echo "         (build is unaffected; scan is advisory only)"
        return 0
    fi

    # Images built with --load exist only in the local Docker daemon, so Trivy
    # needs the socket to read them. Registry images (--push) are fetched
    # directly and need no socket access.
    if [ "$PUSH_OR_LOAD" = "--load" ]; then
        socket_args=(-v /var/run/docker.sock:/var/run/docker.sock)
    else
        # Pin the arch explicitly: a multi-arch tag would otherwise default to
        # amd64, and an arm64-only push has no amd64 manifest to scan at all.
        platform_args=(--platform "${PLATFORM%%,*}")
    fi

    # A named volume caches the ~100MB vuln DB between runs.
    # --exit-code is left at 0 so findings never fail the build.
    if ! docker run --rm \
        "${socket_args[@]}" \
        -v trivy-cache:/root/.cache/ \
        "$TRIVY_IMAGE" image \
        "${platform_args[@]}" \
        --scanners vuln \
        --severity "$TRIVY_SEVERITY" \
        --exit-code 0 \
        --timeout 10m \
        "$image_ref"; then
        echo "WARNING: Trivy scan did not complete for $image_ref"
        echo "         (build is unaffected; scan is advisory only)"
    fi

    return 0
}

echo "Ensure version.go has been version bumped"
echo "Current version: $VERSION"
echo ""
read -p "Press any key to continue..." -n1 -s
echo ""

# Auto-fetch GeoIP City and ASN databases (unless --no-geoip flag is set)
if [ "$SKIP_GEOIP" = true ]; then
    echo "Skipping GeoIP database download (--no-geoip flag set)"
else
    GEOIP_DIR="geoip"
    GEOIP_FILE="$GEOIP_DIR/GeoLite2-Country.mmdb"  # Keep filename for compatibility
    GEOIP_ASN_FILE="$GEOIP_DIR/GeoLite2-ASN.mmdb"
    GEOIP_LICENSE_FILE="$GEOIP_DIR/licence.txt"

    # Check if license file exists
    if [ ! -f "$GEOIP_LICENSE_FILE" ]; then
        echo "WARNING: $GEOIP_LICENSE_FILE not found - skipping GeoIP database download"
        echo ""
        echo "To enable automatic GeoIP database downloads:"
        echo "  1. Sign up for a free account at https://www.maxmind.com/en/geolite2/signup"
        echo "  2. Generate a license key in your account settings"
        echo "  3. Save the license key to $GEOIP_LICENSE_FILE"
        echo ""

        # Check if database files exist
        if [ ! -f "$GEOIP_FILE" ]; then
            echo "ERROR: $GEOIP_FILE not found and cannot auto-download without license key!"
            exit 1
        fi

        if [ ! -f "$GEOIP_ASN_FILE" ]; then
            echo "WARNING: $GEOIP_ASN_FILE not found and cannot auto-download without license key"
        fi

        echo "Using existing GeoIP database: $GEOIP_FILE"
    else
        # Read license key from file
        GEOIP_LICENSE_KEY=$(cat "$GEOIP_LICENSE_FILE" | tr -d '[:space:]')

        if [ -z "$GEOIP_LICENSE_KEY" ]; then
            echo "WARNING: License key in $GEOIP_LICENSE_FILE is empty - skipping download"

            if [ ! -f "$GEOIP_FILE" ]; then
                echo "ERROR: $GEOIP_FILE not found and cannot auto-download with empty license key!"
                exit 1
            fi

            echo "Using existing GeoIP database: $GEOIP_FILE"
        else
            mkdir -p "$GEOIP_DIR"

            # Download and extract City database (saved as Country.mmdb for compatibility)
            echo "Downloading latest GeoLite2-City database..."
            if ! wget -q -O /tmp/GeoLite2-City.tar.gz \
                "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${GEOIP_LICENSE_KEY}&suffix=tar.gz"; then
                echo "WARNING: Failed to download GeoIP City database. Check your license key in $GEOIP_LICENSE_FILE"

                if [ ! -f "$GEOIP_FILE" ]; then
                    echo "ERROR: $GEOIP_FILE not found and download failed!"
                    exit 1
                fi

                echo "Using existing GeoIP database: $GEOIP_FILE"
            else
                tar -xzf /tmp/GeoLite2-City.tar.gz -C /tmp/
                find /tmp/GeoLite2-City_* -name "*.mmdb" -exec cp {} "$GEOIP_FILE" \;
                rm -rf /tmp/GeoLite2-City_* /tmp/GeoLite2-City.tar.gz

                echo "GeoIP City database downloaded successfully to $GEOIP_FILE"
            fi

            # Download and extract ASN database
            echo "Downloading latest GeoLite2-ASN database..."
            if ! wget -q -O /tmp/GeoLite2-ASN.tar.gz \
                "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-ASN&license_key=${GEOIP_LICENSE_KEY}&suffix=tar.gz"; then
                echo "WARNING: Failed to download GeoIP ASN database. Check your license key in $GEOIP_LICENSE_FILE"

                if [ ! -f "$GEOIP_ASN_FILE" ]; then
                    echo "WARNING: $GEOIP_ASN_FILE not found and download failed - ASN lookups will be unavailable"
                else
                    echo "Using existing GeoIP ASN database: $GEOIP_ASN_FILE"
                fi
            else
                tar -xzf /tmp/GeoLite2-ASN.tar.gz -C /tmp/
                find /tmp/GeoLite2-ASN_* -name "*.mmdb" -exec cp {} "$GEOIP_ASN_FILE" \;
                rm -rf /tmp/GeoLite2-ASN_* /tmp/GeoLite2-ASN.tar.gz

                echo "GeoIP ASN database downloaded successfully to $GEOIP_ASN_FILE"
            fi
        fi
    fi
fi

# Ensure a buildx builder with multi-arch support exists
BUILDER_NAME="multiarch-builder"
if ! docker buildx inspect "$BUILDER_NAME" &>/dev/null; then
    echo "Creating multi-arch buildx builder: $BUILDER_NAME"
    docker buildx create --name "$BUILDER_NAME" --driver docker-container --use
else
    docker buildx use "$BUILDER_NAME"
fi
docker buildx inspect --bootstrap

# Determine tags for UberSDR image
if [ -n "$CUSTOM_TAG" ]; then
    UBERSDR_TAGS="-t $IMAGE:$CUSTOM_TAG"
else
    UBERSDR_TAGS="-t $IMAGE:$VERSION"
    if [ "$TAG_LATEST" = true ]; then
        UBERSDR_TAGS="$UBERSDR_TAGS -t $IMAGE:latest"
    fi
fi

# Build UberSDR image
echo "Building UberSDR Docker image (platform: $PLATFORM)..."
if ! docker buildx build $NO_CACHE \
    --platform "$PLATFORM" \
    $UBERSDR_TAGS \
    $PUSH_OR_LOAD \
    -f docker/Dockerfile .; then
    echo "ERROR: UberSDR Docker build failed!"
    exit 1
fi

echo "UberSDR build and push successful!"

if [ -n "$CUSTOM_TAG" ]; then
    scan_image "$IMAGE:$CUSTOM_TAG"
else
    scan_image "$IMAGE:$VERSION"
fi

# Build Fluent Bit image with version tag (only if --fluent-bit flag is set)
if [ "$BUILD_FLUENT_BIT" = true ]; then
    if [ -n "$CUSTOM_TAG" ]; then
        FLUENT_TAGS="-t $FLUENT_BIT_IMAGE:$CUSTOM_TAG"
    else
        FLUENT_TAGS="-t $FLUENT_BIT_IMAGE:$VERSION"
        if [ "$TAG_LATEST" = true ]; then
            FLUENT_TAGS="$FLUENT_TAGS -t $FLUENT_BIT_IMAGE:latest"
        fi
    fi

    echo "Building Fluent Bit Docker image (platform: $PLATFORM)..."
    if ! docker buildx build $NO_CACHE \
        --platform "$PLATFORM" \
        $FLUENT_TAGS \
        $PUSH_OR_LOAD \
        -f docker/Dockerfile.fluent-bit docker/; then
        echo "ERROR: Fluent Bit Docker build failed!"
        exit 1
    fi
    echo "Fluent Bit build and push successful!"

    if [ -n "$CUSTOM_TAG" ]; then
        scan_image "$FLUENT_BIT_IMAGE:$CUSTOM_TAG"
    else
        scan_image "$FLUENT_BIT_IMAGE:$VERSION"
    fi
else
    echo "Skipping Fluent Bit build (use --fluent-bit flag to build)"
fi

# Commit and push version changes (unless --no-latest or --no-git flag is set)
if [ "$TAG_LATEST" = true ] && [ "$NO_GIT" = false ]; then
    echo "Committing and pushing to git..."
    git add .
    git commit -m "$VERSION"
    git push -v
else
    echo "Skipping git commit and push (--no-latest or --no-git flag set)"
fi
