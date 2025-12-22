#!/bin/bash

# Extract version from version.go
VERSION=$(grep -oP 'const Version = "\K[^"]+' version.go)
IMAGE=madpsy/ka9q_ubersdr

echo "Ensure version.go has been version bumped"
echo "Current version: $VERSION"
echo ""
read -p "Press any key to continue..." -n1 -s
echo ""

# Build image with version tag
echo "Building Docker image..."
if ! docker build -t $IMAGE:$VERSION -f docker/Dockerfile .; then
    echo "ERROR: Docker build failed!"
    exit 1
fi

echo "Build successful!"

# Tag version as latest
docker tag $IMAGE:$VERSION $IMAGE:latest

# Push both tags
echo "Pushing to Docker Hub..."
docker push $IMAGE:$VERSION
docker push $IMAGE:latest

# Commit and push version changes
git add .
git commit -m "$VERSION"
git push -v
