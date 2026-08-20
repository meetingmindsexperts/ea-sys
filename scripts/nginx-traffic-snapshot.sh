#!/usr/bin/env bash
#
# Aggregate nginx access logs into logs/nginx-traffic.json for the /admin/infra
# Traffic card, keeping history that outlives the logs themselves.
#
# WHY A HOST SCRIPT AND NOT A ROUTE OR A WORKER JOB
# ------------------------------------------------
# /var/log/nginx/access.log is on the host. The containers mount only
# ./public/uploads and ./logs, and the log files are www-data:adm mode 640, so
# the container user cannot read them even if the directory were mounted.
# Mounting plus an ACL was the other option and was rejected: it widens what the
# web container can read for a read-only reporting feature, and it would need
# redoing on every rebuild. Writing a small file into ./logs, which is ALREADY
# mounted into both web containers, needs no new mount and no permission change.
# This mirrors how the CloudWatch agent works: the host reads the files, the app
# does not.
#
# WHY IT KEEPS ITS OWN ARCHIVE
# ----------------------------
# logrotate is `daily` + `rotate 14`: the box holds today's access.log plus
# fourteen rotations, so roughly a fortnight, and DELETES everything older.
# There is no "all time" to read. Any history beyond that is already gone, and
# no setting here can bring it back. So each run re-parses the whole retained window and MERGES it
# into logs/nginx-traffic-archive.tsv, which is never truncated by logrotate.
# An hour bucket is immutable once it has passed, so the merge is a plain union
# with fresh data winning inside the live window. That turns roughly sixteen
# days of source data into unbounded history going forward, at about 4 KB per
# day (1.6 MB per year).
#
# COST, MEASURED ON THE BOX 2026-08-20
# ------------------------------------
# The full retained window is 19 MB across 15 files, 772,418 lines. Reading and
# decompressing all of it: 0.53s. An awk pass over it: 0.19s. So a complete
# re-parse is under a second, which is why this does NOT bother with an
# incremental read: the complexity would buy nothing, and a full re-parse is
# self-healing if a run is ever missed.
#
# SETUP. Two things have to be true, and the second is NOT true by default:
#
#   1. The cron user must be able to READ /var/log/nginx. Those files are
#      www-data:adm, and `ubuntu` is already in the adm group, so this works
#      with no change and without sudo. Verified on the box 2026-08-20.
#
#   2. The cron user must be able to WRITE into ea-sys/logs, which is the only
#      directory shared with the web containers. That directory is owned by
#      ssm-user (the container's uid) mode 755, so `ubuntu` CANNOT write to it
#      and this script would produce nothing at all while appearing to succeed.
#      Grant exactly that, once, rather than changing ownership on a directory
#      two running containers write to:
#
#        sudo setfacl -m u:ubuntu:rwx /home/ubuntu/ea-sys/logs
#
#      Same ACL approach the CloudWatch agent needed for the same reason. Do NOT
#      solve this by running the cron as root: this file is replaced by
#      `git reset --hard` on every deploy, so it should not execute as root.
#
# CADENCE. Hourly. The data is bucketed by hour, so finer granularity buys
# nothing. Run from the UBUNTU crontab (`sudo -u ubuntu crontab -e`; a plain
# `crontab -e` over SSM edits root's, which is not where anything else lives):
#
#   5 * * * * /home/ubuntu/ea-sys/scripts/nginx-traffic-snapshot.sh >> /home/ubuntu/cron-nginx-traffic.log 2>&1
#
# The cron log goes to the home directory, matching the DR backup jobs, so only
# the snapshot itself depends on the ACL above.
#
# If it stops running, the card reports the snapshot as stale rather than
# showing old numbers as if they were current.

set -euo pipefail

# Read the whole retained window rather than a subset. 16 = today + the 14
# rotations logrotate keeps + a day of slack for a rotation landing mid-run;
# asking for more is harmless, since the parser simply finds nothing older.
# Measured above, a full pass costs under a second, so there is no reason to
# read less than exists.
DAYS="${NGINX_TRAFFIC_DAYS:-16}"
# How much accumulated history to keep. 400 days covers a full year-over-year
# comparison with margin, and matches the analytics retention number.
ARCHIVE_DAYS="${NGINX_TRAFFIC_ARCHIVE_DAYS:-400}"

LOG_DIR="${NGINX_TRAFFIC_LOG_DIR:-/var/log/nginx}"
OUT="${NGINX_TRAFFIC_OUT:-/home/ubuntu/ea-sys/logs/nginx-traffic.json}"
ARCHIVE="${NGINX_TRAFFIC_ARCHIVE:-${OUT%.json}-archive.tsv}"
LOCK="${NGINX_TRAFFIC_LOCK:-/tmp/nginx-traffic-snapshot.lock}"
AWK_PROG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nginx-traffic.awk"
TOP_N="${NGINX_TRAFFIC_TOP_N:-15}"

# Never let a slow run pile up on the next one. -n means "give up immediately",
# not "queue": two concurrent full log parses is exactly the CPU spike this is
# supposed to avoid causing.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  flock -n 9 || { echo "another snapshot is running; skipping"; exit 0; }
fi

# GNU date on the box; the BSD fallback exists so this is testable on a Mac.
hours_ago_stamp() {
  if date -u -d "1 day ago" >/dev/null 2>&1; then
    date -u -d "$1 days ago" +%Y-%m-%dT%H
  else
    date -u -v-"$1"d +%Y-%m-%dT%H
  fi
}
CUTOFF="$(hours_ago_stamp "$DAYS")"
ARCHIVE_CUTOFF="$(hours_ago_stamp "$ARCHIVE_DAYS")"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

[ -f "$AWK_PROG" ] || { echo "missing parser: $AWK_PROG" >&2; exit 1; }
[ -d "$LOG_DIR" ]  || { echo "missing log dir: $LOG_DIR" >&2; exit 1; }

TMP_TSV="$(mktemp)"; TMP_MERGED="$(mktemp)"; TMP_OUT="$(mktemp)"
trap 'rm -f "$TMP_TSV" "$TMP_MERGED" "$TMP_OUT"' EXIT

TAB="$(printf '\t')"

{
  find "$LOG_DIR" -maxdepth 1 \( -name 'access.log' -o -name 'access.log.[0-9]' \) 2>/dev/null \
    | while read -r f; do cat "$f" 2>/dev/null || true; done
  find "$LOG_DIR" -maxdepth 1 -name 'access.log.*.gz' 2>/dev/null \
    | while read -r f; do gzip -dc "$f" 2>/dev/null || true; done
} | awk -f "$AWK_PROG" -v cutoff="$CUTOFF" > "$TMP_TSV"

META="$(grep -m1 '^#META' "$TMP_TSV" || echo "")"
PARSED="$(printf '%s' "$META"    | cut -f2)"; PARSED="${PARSED:-0}"
SKIPPED="$(printf '%s' "$META"   | cut -f3)"; SKIPPED="${SKIPPED:-0}"
SKEW="$(printf '%s' "$META"      | cut -f4)"; SKEW="${SKEW:-0}"
MALFORMED="$(printf '%s' "$META" | cut -f5)"; MALFORMED="${MALFORMED:-0}"

# Merge: keep archived buckets OLDER than this run's window (the fresh parse is
# authoritative for everything inside it), add the fresh ones, drop anything
# past the archive horizon. The two sets cannot overlap because the parser
# already discarded anything below CUTOFF, so this is a union, not a conflict.
{
  if [ -f "$ARCHIVE" ]; then
    awk -F"$TAB" -v c="$CUTOFF" -v a="$ARCHIVE_CUTOFF" \
      '$1 == "#B" && $2 < c && $2 >= a' "$ARCHIVE"
  fi
  grep '^#B' "$TMP_TSV" || true
} | sort -t"$TAB" -k2,2 > "$TMP_MERGED"

BUCKETS="$(wc -l < "$TMP_MERGED" | tr -d ' ')"
OLDEST="$(head -n1 "$TMP_MERGED" | cut -f2)"
NEWEST="$(tail -n1 "$TMP_MERGED" | cut -f2)"

cp "$TMP_MERGED" "$TMP_OUT"
chmod 644 "$TMP_OUT"
mkdir -p "$(dirname "$ARCHIVE")"
mv -f "$TMP_OUT" "$ARCHIVE"

{
  printf '{\n'
  printf '  "generatedAt": "%s",\n' "$NOW"
  printf '  "windowDays": %s,\n' "$DAYS"
  printf '  "archiveDays": %s,\n' "$ARCHIVE_DAYS"
  printf '  "cutoff": "%s",\n' "$CUTOFF"
  printf '  "oldestBucket": "%s",\n' "$OLDEST"
  printf '  "newestBucket": "%s",\n' "$NEWEST"
  printf '  "parsed": %s,\n' "$PARSED"
  printf '  "skipped": %s,\n' "$SKIPPED"
  printf '  "malformed": %s,\n' "$MALFORMED"
  printf '  "offsetSkew": %s,\n' "$SKEW"

  printf '  "buckets": [\n'
  awk -F"$TAB" '
    {
      if (NR > 1) printf ",\n";
      printf "    {\"h\":\"%s\",\"total\":%s,\"bot\":%s,\"s2\":%s,\"s3\":%s,\"s4\":%s,\"s5\":%s,",
        $2, $3, $4, $5, $6, $7, $8;
      printf "\"page\":[%s,%s],\"api\":[%s,%s],\"asset\":[%s,%s],\"health\":[%s,%s],\"other\":[%s,%s]}",
        $9, $10, $11, $12, $13, $14, $15, $16, $17, $18;
    }
    END { if (NR > 0) printf "\n" }' "$TMP_MERGED"
  printf '  ],\n'

  # Top lists cover the LIVE window only, never the archive. Making them
  # time-filterable would mean storing per-path counts per hour, which turns a
  # 4 KB day into a large one for a list nobody filters. The card says so.
  printf '  "topPaths": [\n'
  grep '^#P' "$TMP_TSV" | sort -t"$TAB" -k2,2nr | head -n "$TOP_N" | awk -F"$TAB" '
    { if (NR > 1) printf ",\n"; printf "    {\"path\":\"%s\",\"count\":%s}", $3, $2 }
    END { if (NR > 0) printf "\n" }'
  printf '  ],\n'

  printf '  "topReferrers": [\n'
  grep '^#R' "$TMP_TSV" | sort -t"$TAB" -k2,2nr | head -n "$TOP_N" | awk -F"$TAB" '
    { if (NR > 1) printf ",\n"; printf "    {\"host\":\"%s\",\"count\":%s}", $3, $2 }
    END { if (NR > 0) printf "\n" }'
  printf '  ]\n'
  printf '}\n'
} > "$TMP_MERGED.json"

# Atomic publish. A reader must never see a half-written file, and the web
# container reads this on every Traffic card load.
chmod 644 "$TMP_MERGED.json"
mkdir -p "$(dirname "$OUT")"
mv -f "$TMP_MERGED.json" "$OUT"

echo "wrote $OUT (buckets=$BUCKETS range=$OLDEST..$NEWEST parsed=$PARSED skipped=$SKIPPED malformed=$MALFORMED skew=$SKEW)"
