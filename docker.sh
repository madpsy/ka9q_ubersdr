#!/bin/bash

# Extract version from version.go
VERSION=$(grep -oP 'const Version = "\K[^"]+' version.go)
IMAGE=madpsy/ka9q_ubersdr
FLUENT_BIT_IMAGE=madpsy/fluent-bit-ubersdr

# Parse command line flags
TAG_LATEST=true
NO_CACHE=""

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
        *)
            echo "Unknown option: $arg"
            echo "Usage: $0 [--no-latest] [--no-cache]"
            exit 1
            ;;
    esac
done

echo "Ensure version.go has been version bumped"
echo "Current version: $VERSION"
echo ""
read -p "Press any key to continue..." -n1 -s
echo ""

# Build UberSDR image with version tag
echo "Building UberSDR Docker image..."
if ! docker build $NO_CACHE -t $IMAGE:$VERSION -f docker/Dockerfile .; then
    echo "ERROR: UberSDR Docker build failed!"
    exit 1
fi

echo "UberSDR build successful!"

# Build Fluent Bit image with version tag
echo "Building Fluent Bit Docker image..."
if ! docker build $NO_CACHE -t $FLUENT_BIT_IMAGE:$VERSION -f docker/Dockerfile.fluent-bit docker/; then
    echo "ERROR: Fluent Bit Docker build failed!"
    exit 1
fi

echo "Fluent Bit build successful!"

# Tag version as latest (unless --no-latest flag is set)
if [ "$TAG_LATEST" = true ]; then
    echo "Tagging as latest..."
    docker tag $IMAGE:$VERSION $IMAGE:latest
    docker tag $FLUENT_BIT_IMAGE:$VERSION $FLUENT_BIT_IMAGE:latest
else
    echo "Skipping 'latest' tag (--no-latest flag set)"
fi

# Push tags
echo "Pushing UberSDR to Docker Hub..."
docker push $IMAGE:$VERSION

if [ "$TAG_LATEST" = true ]; then
    docker push $IMAGE:latest
fi

echo "Pushing Fluent Bit to Docker Hub..."
docker push $FLUENT_BIT_IMAGE:$VERSION

if [ "$TAG_LATEST" = true ]; then
    docker push $FLUENT_BIT_IMAGE:latest
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
