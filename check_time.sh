#!/usr/bin/env bash

echo "== Time =="
date

echo "== Timedatectl =="
timedatectl | grep -E 'Time zone|System clock synchronized'

echo "== NTP Health =="

ntpq -pn 2>/dev/null | awk '
/^\*/ {
    sub(/^\*/, "", $1)
    server=$1
    stratum=$3
    reach=$7
    delay=$8
    offset=$9
    jitter=$10

    status="OK"

    if (reach < 377) status="WARN: unstable reach"
    if (offset > 50 || offset < -50) status="WARN: high offset"
    if (offset > 100 || offset < -100) status="BAD: very high offset"

    print "Active peer:"
    printf "  Server   : %s\n", server
    printf "  Stratum  : %s\n", stratum
    printf "  Reach    : %s\n", reach
    printf "  Delay    : %s ms\n", delay
    printf "  Offset   : %s ms\n", offset
    printf "  Jitter   : %s ms\n", jitter
    printf "  Status   : %s\n", status

    found=1
}

END {
    if (!found) {
        print "No active NTP peer found [BAD]"
        exit 1
    }
}
' || ntpstat 2>/dev/null || echo "NTP not running [BAD]"
