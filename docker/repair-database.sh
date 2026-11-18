#!/bin/bash
#
# Checks the UberSDR SQLite database and, if it is damaged, rebuilds it.
#
# Built into the ka9q_ubersdr image as /usr/local/bin/repair-database. Run by
# ~/ubersdr/repair-database.sh on the host, which stops the ka9q_ubersdr
# container, runs this in a one-off container from the same image with the
# same config volume, and starts ka9q_ubersdr again. Not meant to be run while
# the receiver is using the database; it refuses if the database is in use.
#
#   repair-database [--force] [--no-backup]
#
#   --force      rebuild even when the check finds no problems
#   --no-backup  delete the damaged original after a successful rebuild
#                instead of keeping it next to the database
#
# How it rebuilds: a new database file is created with the same schema, every
# table's rows are copied into it, and only then are the indexes created, from
# the copied rows. No old index is ever read, so damage confined to indexes
# (the usual case) is repaired with no data lost. (VACUUM INTO cannot be used
# for this: it copies index b-trees as they are and fails on the damaged one.
# Ubuntu's sqlite3 is built without .recover.)
#
# If a table itself is damaged, its rows are copied in rowid ranges instead;
# a range that cannot be read is narrowed down, and only rows that really
# cannot be read are lost. The row counts before and after are printed.
#
# The new file must pass a full integrity_check and have every table and index
# of the original before it replaces it. Until then the original is never
# modified, so stopping this at any time leaves the database as it was.
#
# Exit status: 0 healthy or repaired, 1 failed (original left in place).

set -u

DB_DIR=${REPAIR_DB_DIR:-/app/config/db} # override for tests only
DB="$DB_DIR/ubersdr.db"
NEW="$DB_DIR/ubersdr.db.repair-new"
WORK="$DB_DIR/.repair-work"
FORCE=0
KEEP_BACKUP=1

# Rows per range when salvaging a damaged table, then per narrowed range.
CHUNK=10000
SUBCHUNK=64

for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        --no-backup) KEEP_BACKUP=0 ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

log() { echo "[$(date -u +%H:%M:%S)] $*"; }
progress_pid=""
cleanup() {
    [ -n "$progress_pid" ] && kill "$progress_pid" 2>/dev/null
    rm -rf "$WORK"
    rm -f "$NEW" "$NEW-journal" "$NEW-wal" "$NEW-shm"
}
fail() {
    log "FAILED: $*"
    cleanup
    log "The original database has not been changed."
    exit 1
}
on_signal() {
    log "Interrupted."
    fail "stopped before finishing"
}
trap on_signal INT TERM

human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || echo "$1 bytes"; }

if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "sqlite3 is not in this image. Update UberSDR (~/ubersdr/update-ubersdr.sh) and try again." >&2
    exit 1
fi
[ -f "$DB" ] || { echo "No database at $DB" >&2; exit 1; }

# Left by an interrupted earlier run.
cleanup
mkdir -p "$WORK" || fail "cannot create $WORK"

# Fold any WAL into the main file, so the file is the whole database and the
# size checks below are right. Reports busy if something still has the
# database open, which also stops this running against a live receiver.
log "Opening $DB ($(human "$(stat -c %s "$DB")"))"
if ! out=$(sqlite3 -cmd ".timeout 0" "$DB" "PRAGMA wal_checkpoint(TRUNCATE);" 2>&1); then
    fail "could not open the database: $out"
fi
case "$out" in
    0\|*) ;;
    *) fail "the database is in use. Stop the ka9q_ubersdr container first." ;;
esac
# The last connection to close a WAL database deletes its -wal file, so if it
# is still there, another process has the database open, even if it is idle.
if [ -e "$DB-wal" ]; then
    fail "the database is open in another process. Stop the ka9q_ubersdr container first."
fi

if [ "$FORCE" -eq 0 ]; then
    log "Checking the database (quick_check). On a large database this takes a few minutes..."
    check=$(sqlite3 "$DB" "PRAGMA quick_check(20);" 2>&1)
    if [ "$check" = "ok" ]; then
        log "No problems found. Nothing to repair."
        cleanup
        exit 0
    fi
    log "Problems found:"
    echo "$check" | sed 's/^/    /'
else
    log "--force: rebuilding without checking first."
fi

# Room for the rebuilt copy next to the original, plus a margin.
db_bytes=$(stat -c %s "$DB")
avail=$(( $(df -Pk "$DB_DIR" | awk 'NR==2 {print $4}') * 1024 ))
need=$(( db_bytes + db_bytes / 10 + 256 * 1024 * 1024 ))
if [ "$avail" -lt "$need" ]; then
    fail "not enough disk space: the rebuild needs about $(human "$need"), $(human "$avail") available"
fi

# The schema, read from the original's first page (which every check above
# has already read). sqlite_* tables are SQLite's own: sqlite_sequence is
# created and copied separately, and statistics are rebuilt by ANALYZE below.
tables=$(sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid;") ||
    fail "cannot read the schema"
[ -n "$tables" ] || fail "the database has no tables"
sqlite3 "$DB" "SELECT sql || ';' FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid;" > "$WORK/tables.sql" ||
    fail "cannot read the schema"
sqlite3 "$DB" "SELECT sql || ';' FROM sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL ORDER BY type='view', type='trigger', rowid;" > "$WORK/indexes.sql" ||
    fail "cannot read the schema"
has_seq=$(sqlite3 "$DB" "SELECT count(*) FROM sqlite_master WHERE name='sqlite_sequence';")

# Runs SQL from stdin against the new file with the original attached as
# "old". The new file is scratch until verified, so it is written without a
# journal or syncs: an interruption just throws it away.
on_new() {
    sqlite3 -cmd "PRAGMA main.journal_mode=OFF" -cmd "PRAGMA main.synchronous=OFF" \
        -cmd "ATTACH '$DB' AS old" "$@" "$NEW"
}

# Shows progress by the new file's size, since SQLite reports none.
progress() {
    while sleep 30; do
        [ -f "$NEW" ] && log "    ... $(human "$(stat -c %s "$NEW" 2>/dev/null || echo 0)") written so far (original $(human "$db_bytes"))"
    done
}
progress &
progress_pid=$!

log "Rebuilding into a new file. This can take several minutes on a large database..."

# auto_vacuum must be set before the first table exists; the rebuilt
# database gets incremental space reclaim like a newly created one.
{ echo "PRAGMA main.auto_vacuum=INCREMENTAL;"; cat "$WORK/tables.sql"; } | on_new -bail >/dev/null 2>"$WORK/err" ||
    fail "creating the tables: $(tail -3 "$WORK/err")"

# Statement lines that failed, from the shell's "... near line N: ..." errors.
failed_lines() { grep -oE 'near line [0-9]+' "$1" | awk '{print $3}' | sort -un; }

# Copies rows lo..hi of a damaged table in ranges of size step, then retries
# each range that failed in smaller ranges. Prints the ranges still failing
# at the smallest size, which are the rows that could not be read.
salvage_ranges() { # table step ranges-file
    local t=$1 step=$2 in=$3 sql="$WORK/salvage.sql" map="$WORK/salvage.map"
    : > "$sql"; : > "$map"
    while read -r lo hi; do
        local a=$lo
        while [ "$a" -le "$hi" ]; do
            local b=$(( a + step - 1 )); [ "$b" -gt "$hi" ] && b=$hi
            echo "INSERT INTO main.\"$t\" SELECT * FROM old.\"$t\" WHERE rowid BETWEEN $a AND $b;" >> "$sql"
            echo "$a $b" >> "$map"
            a=$(( b + 1 ))
        done
    done < "$in"
    on_new < "$sql" >/dev/null 2>"$WORK/err"
    for n in $(failed_lines "$WORK/err"); do sed -n "${n}p" "$map"; done
}

# Copy every table. WHERE 1 stops SQLite's transfer optimisation, which would
# otherwise copy the table's b-tree page by page. One statement per line, so
# an error's line number names the table that failed; the others still copy.
: > "$WORK/copy.sql"
for t in $tables; do
    echo "INSERT INTO main.\"$t\" SELECT * FROM old.\"$t\" WHERE 1;" >> "$WORK/copy.sql"
done
on_new < "$WORK/copy.sql" >/dev/null 2>"$WORK/err"
damaged=""
for n in $(failed_lines "$WORK/err"); do
    damaged="$damaged $(echo "$tables" | sed -n "${n}p")"
done

lost_rows=0
for t in $damaged; do
    log "Table $t is damaged; copying the rows that can still be read..."
    lo=$(sqlite3 "$DB" "SELECT min(rowid) FROM \"$t\";" 2>/dev/null)
    hi=$(sqlite3 "$DB" "SELECT max(rowid) FROM \"$t\";" 2>/dev/null)
    if [ -z "$hi" ] && [ "$has_seq" = "1" ]; then
        hi=$(sqlite3 "$DB" "SELECT seq FROM sqlite_sequence WHERE name='$t';" 2>/dev/null)
    fi
    [ -n "$lo" ] || lo=1
    if [ -z "$hi" ]; then
        log "    cannot find the extent of $t; its rows are lost"
        continue
    fi
    echo "$lo $hi" > "$WORK/r0"
    salvage_ranges "$t" "$CHUNK" "$WORK/r0" > "$WORK/r1"
    salvage_ranges "$t" "$SUBCHUNK" "$WORK/r1" > "$WORK/r2"
    salvage_ranges "$t" 1 "$WORK/r2" > "$WORK/r3"
    n=$(wc -l < "$WORK/r3")
    lost_rows=$(( lost_rows + n ))
    log "    $t: $n row ids could not be read"
done

# Then the AUTOINCREMENT counters, so new rows never reuse an old id, the
# indexes, built from the copied rows, and fresh planner statistics.
{
    if [ "$has_seq" = "1" ]; then
        echo "DELETE FROM main.sqlite_sequence;"
        echo "INSERT INTO main.sqlite_sequence SELECT * FROM old.sqlite_sequence WHERE 1;"
    fi
    cat "$WORK/indexes.sql"
    # Planner statistics, which are not copied: without them SQLite can pick
    # an index that reads months of rows for a one-day query. analysis_limit
    # samples each index (as the receiver's own maintenance does), so this
    # takes seconds even on a large database.
    echo "PRAGMA main.analysis_limit=1000;"
    echo "ANALYZE main;"
    echo "PRAGMA main.journal_mode=DELETE;"
} | on_new -bail >/dev/null 2>"$WORK/err" ||
    fail "creating the indexes: $(tail -3 "$WORK/err")"

kill "$progress_pid" 2>/dev/null
wait "$progress_pid" 2>/dev/null
progress_pid=""

log "Verifying the rebuilt database (integrity_check)..."
verify=$(sqlite3 "$NEW" "PRAGMA integrity_check(20);" 2>&1)
if [ "$verify" != "ok" ]; then
    echo "$verify" | sed 's/^/    /'
    fail "the rebuilt database did not pass integrity_check"
fi
schema_q="SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name;"
if [ "$(sqlite3 "$DB" "$schema_q")" != "$(sqlite3 "$NEW" "$schema_q")" ]; then
    fail "the rebuilt database is missing tables or indexes"
fi

# Rows per table, before and after. The original is counted with NOT INDEXED
# so a damaged index cannot give a wrong count.
log "Row counts:"
differ=0
for t in $tables; do
    after=$(sqlite3 "$NEW" "SELECT count(*) FROM \"$t\";" 2>/dev/null)
    before=$(sqlite3 "$DB" "SELECT count(*) FROM \"$t\" NOT INDEXED;" 2>/dev/null)
    [ -n "$before" ] || before="?"
    if [ "$before" = "$after" ]; then
        printf '    %-32s %12s\n' "$t" "$after"
    else
        printf '    %-32s %12s (original: %s)\n' "$t" "$after" "$before"
        differ=1
    fi
done

# Swap. Signals are ignored for these few renames so the database is never
# left half swapped.
trap '' INT TERM
backup="$DB.damaged-$(date -u +%Y%m%d-%H%M%S)"
chown --reference="$DB" "$NEW" 2>/dev/null
chmod --reference="$DB" "$NEW" 2>/dev/null
mv "$DB" "$backup" || fail "could not move the original aside"
rm -f "$DB-wal" "$DB-shm"
if ! mv "$NEW" "$DB"; then
    mv "$backup" "$DB"
    fail "could not move the rebuilt database into place"
fi
rm -rf "$WORK"
trap on_signal INT TERM

log "Repaired: $(human "$db_bytes") -> $(human "$(stat -c %s "$DB")")."
if [ "$lost_rows" -gt 0 ] || [ "$differ" -eq 1 ]; then
    log "Some rows could not be read and were not copied (see the counts above)."
fi
if [ "$KEEP_BACKUP" -eq 1 ]; then
    log "The original is kept as $backup"
else
    rm -f "$backup"
    log "The original was deleted (--no-backup)."
fi
exit 0
