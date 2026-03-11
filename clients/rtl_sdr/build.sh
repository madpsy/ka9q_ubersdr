#!/usr/bin/env bash
# build.sh — Build the UberSDR rtl_tcp bridge
set -euo pipefail

BINARY="ubersdr-rtltcp-bridge"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$SCRIPT_DIR"

echo "==> Tidying dependencies..."
go mod tidy

echo "==> Building ${BINARY}..."
go build -ldflags="-s -w" -o "${BINARY}" .

echo "==> Done: ${SCRIPT_DIR}/${BINARY}"
echo ""
echo "Usage:"
echo "  ./${BINARY} --help"
echo "  ./${BINARY}                                    # connect to http://127.0.0.1:8080"
echo "  ./${BINARY} --url http://myserver:8080         # custom server"
echo "  ./${BINARY} --config routing.yaml              # frequency routing"
echo "  ./${BINARY} --upsample=false                   # disable upsampling (for GQRX etc.)"
