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
docker build -t $IMAGE:$VERSION -f docker/Dockerfile .

# Tag version as latest
docker tag $IMAGE:$VERSION $IMAGE:latest

# Push both tags
docker push $IMAGE:$VERSION
docker push $IMAGE:latest

# Commit and push version changes
git add .
git commit -m "$VERSION"
git push -v
