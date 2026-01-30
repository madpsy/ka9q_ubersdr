#!/bin/bash

# Extract version from version.go
VERSION=$(grep -oP 'const Version = "\K[^"]+' version.go)
IMAGE=madpsy/ka9q_ubersdr
FLUENT_BIT_IMAGE=madpsy/fluent-bit-ubersdr

# Parse command line flags
TAG_LATEST=true
NO_CACHE=""
BUILD_FLUENT_BIT=false

for arg in "$@"; do
    case $arg in
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
        *)
            echo "Unknown option: $arg"
            echo "Usage: $0 [--no-latest] [--no-cache] [--fluent-bit]"
            exit 1
            ;;
    esac
done

echo "Ensure version.go has been version bumped"
echo "Current version: $VERSION"
echo ""
read -p "Press any key to continue..." -n1 -s
echo ""

# Check if GeoIP database exists
if [ ! -f "geoip/GeoLite2-Country.mmdb" ]; then
    echo "ERROR: geoip/GeoLite2-Country.mmdb not found!"
    echo ""
    echo "Please download the GeoLite2 Country database from MaxMind:"
    echo "  1. Sign up for a free account at https://www.maxmind.com/en/geolite2/signup"
    echo "  2. Download GeoLite2-Country.mmdb"
    echo "  3. Place it in the geoip/ directory"
    echo ""
    exit 1
fi

# Build UberSDR image with version tag
echo "Building UberSDR Docker image..."
if ! docker build $NO_CACHE -t $IMAGE:$VERSION -f docker/Dockerfile .; then
    echo "ERROR: UberSDR Docker build failed!"
    exit 1
fi

echo "UberSDR build successful!"

# Build Fluent Bit image with version tag (only if --fluent-bit flag is set)
if [ "$BUILD_FLUENT_BIT" = true ]; then
    echo "Building Fluent Bit Docker image..."
    if ! docker build $NO_CACHE -t $FLUENT_BIT_IMAGE:$VERSION -f docker/Dockerfile.fluent-bit docker/; then
        echo "ERROR: Fluent Bit Docker build failed!"
        exit 1
    fi
    echo "Fluent Bit build successful!"
else
    echo "Skipping Fluent Bit build (use --fluent-bit flag to build)"
fi

# Tag version as latest (unless --no-latest flag is set)
if [ "$TAG_LATEST" = true ]; then
    echo "Tagging as latest..."
    docker tag $IMAGE:$VERSION $IMAGE:latest
    if [ "$BUILD_FLUENT_BIT" = true ]; then
        docker tag $FLUENT_BIT_IMAGE:$VERSION $FLUENT_BIT_IMAGE:latest
    fi
else
    echo "Skipping 'latest' tag (--no-latest flag set)"
fi

# Push tags
echo "Pushing UberSDR to Docker Hub..."
docker push $IMAGE:$VERSION

if [ "$TAG_LATEST" = true ]; then
    docker push $IMAGE:latest
fi

if [ "$BUILD_FLUENT_BIT" = true ]; then
    echo "Pushing Fluent Bit to Docker Hub..."
    docker push $FLUENT_BIT_IMAGE:$VERSION

    if [ "$TAG_LATEST" = true ]; then
        docker push $FLUENT_BIT_IMAGE:latest
    fi
else
    echo "Skipping Fluent Bit push (not built)"
fi

# Commit and push version changes (unless --no-latest flag is set)
if [ "$TAG_LATEST" = true ]; then
    echo "Committing and pushing to git..."
    git add .
    git commit -m "$VERSION"
    git push -v
else
    echo "Skipping git commit and push (--no-latest flag set)"
fi
