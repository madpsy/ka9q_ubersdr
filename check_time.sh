#!/usr/bin/env bash

echo "== Time =="
date

echo "== Timedatectl =="
timedatectl | grep -E 'Time zone|System clock synchronized' | sed 's/^[[:space:]]*//'

echo "== NTP Health =="

# chrony is what install-hub.sh installs. Hosts installed before the switch
# still run ntpsec until install-hub.sh is re-run, so keep the ntpq path.
if command -v chronyc >/dev/null 2>&1; then
    # -c gives CSV: sources is mode,state,name,stratum,poll,reach,lastrx,...
    # and tracking is refid,name,stratum,reftime,offset,...,root delay (11th),
    # root dispersion, update interval, leap status (14th). The tracking
    # offset is in seconds, NTP minus system time.
    {
        chronyc -n -c sources 2>/dev/null | sed 's/^/S,/'
        chronyc -n -c tracking 2>/dev/null | sed 's/^/T,/'
    } | awk -F, '
    $1 == "S" && $3 == "*" {
        server=$4
        stratum=$5
        reach=$7
        found=1
    }
    $1 == "T" && NF >= 15 {
        offset=$6 * 1000
        rms=$8 * 1000
        delay=$12 * 1000
        leap=$15
    }

    END {
        if (!found) {
            print "No active NTP source found [BAD]"
            exit 0
        }

        status="OK"
        abs=offset < 0 ? -offset : offset

        # reach is an octal bitmask of the last 8 polls; 377 means all answered
        if (reach != 377) status="WARN: unstable reach"
        if (abs > 50) status="WARN: high offset"
        if (abs > 100) status="BAD: very high offset"
        if (leap == "Not synchronised") status="BAD: not synchronised"

        print "Active peer:"
        printf "  Server   : %s\n", server
        printf "  Stratum  : %s\n", stratum
        printf "  Reach    : %s\n", reach
        printf "  Delay    : %.3f ms\n", delay
        printf "  Offset   : %+.3f ms\n", offset
        printf "  Jitter   : %.3f ms\n", rms
        printf "  Status   : %s\n", status
    }
    '
    exit 0
fi

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

    if (reach != 377) status="WARN: unstable reach"
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
