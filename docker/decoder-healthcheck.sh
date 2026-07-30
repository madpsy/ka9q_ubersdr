#!/bin/sh
set -eu

# Human- and automation-friendly inventory of decoder binaries in the image.
# Exit non-zero with --required if the two core additions are unavailable.
required=false
if [ "${1:-}" = "--required" ]; then
    required=true
fi

missing=0
printf '%-20s %s\n' "decoder" "status"
for decoder in dsd-fme multimon-ng jt9 wsprd js8 cw-decoder QtSoundModem freedv-ka9q; do
    if command -v "$decoder" >/dev/null 2>&1; then
        printf '%-20s %s\n' "$decoder" "available"
    elif [ "$decoder" = "freedv-ka9q" ] && [ -x /opt/freedv/freedv-ka9q ]; then
        printf '%-20s %s\n' "$decoder" "available"
    else
        printf '%-20s %s\n' "$decoder" "missing"
        if [ "$decoder" = "dsd-fme" ] || [ "$decoder" = "multimon-ng" ]; then
            missing=1
        fi
    fi
done

if [ "$required" = true ] && [ "$missing" -ne 0 ]; then
    exit 1
fi
