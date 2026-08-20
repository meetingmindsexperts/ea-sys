#!/usr/bin/env bash
#
# Test suite for scripts/nginx-traffic.awk + scripts/nginx-traffic-snapshot.sh.
#
# These are ops scripts, so without this they would sit outside every gate we
# run and rot unnoticed. Run directly, or via the vitest wrapper in
# __tests__/scripts/nginx-traffic.test.ts which fails CI on any regression.
#
# The properties worth protecting, in rough order of how much a break would
# cost: a log line we cannot split reliably must be REJECTED rather than parsed
# into plausible rubbish; an attacker-controlled request path must never be able
# to break the generated JSON; and the archive merge must not double count, lose
# pre-window history, or let a stale bucket beat a fresh parse.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

AWK_PROG="scripts/nginx-traffic.awk"
SNAP="scripts/nginx-traffic-snapshot.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL - $1"; echo "         expected: $2"; echo "         actual:   $3"; }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }

line() { # ip, ts, request, status, referer, ua
  printf '%s - - [%s] "%s" %s 100 "%s" "%s"\n' "$1" "$2" "$3" "$4" "$5" "$6"
}

FIX="$TMP/access.log"
: > "$FIX"
line 1.1.1.1 "20/Aug/2026:08:00:00 +0000" "GET /health HTTP/1.1"              200 "-" "Amazon-Route53-Health-Check-Service" >> "$FIX"
line 2.2.2.2 "20/Aug/2026:08:10:00 +0000" "GET /e/x/register HTTP/1.1"        200 "https://www.linkedin.com/feed/" "Mozilla/5.0 Chrome/120" >> "$FIX"
line 2.2.2.2 "20/Aug/2026:08:11:00 +0000" "GET /_next/static/a.js HTTP/1.1"   200 "-" "Mozilla/5.0 Chrome/120" >> "$FIX"
line 3.3.3.3 "20/Aug/2026:08:12:00 +0000" "POST /api/public/x HTTP/1.1"       500 "-" "Mozilla/5.0 Chrome/120" >> "$FIX"
line 4.4.4.4 "20/Aug/2026:08:13:00 +0000" "GET /e/x/agenda HTTP/1.1"          404 "-" "Mozilla/5.0 (compatible; AhrefsBot/7.0)" >> "$FIX"
line 5.5.5.5 "01/Jan/2020:08:00:00 +0000" "GET /e/ancient HTTP/1.1"           200 "-" "Mozilla/5.0 Chrome/120" >> "$FIX"
line 6.6.6.6 "20/Aug/2026:08:14:00 +0000" "GET /dashboard HTTP/1.1"           200 "-" "Mozilla/5.0 Chrome/120" >> "$FIX"
line 7.7.7.7 "20/Aug/2026:08:15:00 +0000" "GET /e/shared HTTP/1.1"            200 "-" "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" >> "$FIX"

echo "nginx-traffic.awk"

OUT="$(awk -f "$AWK_PROG" -v cutoff=2026-08-01T00 "$FIX")"
B="$(printf '%s' "$OUT" | grep '^#B' | head -1)"

is "one hour bucket is produced"            1     "$(printf '%s' "$OUT" | grep -c '^#B')"
is "total counts every in-window line"      7     "$(printf '%s' "$B" | cut -f3)"
is "bots counted (route53+ahrefs+fb)"       3     "$(printf '%s' "$B" | cut -f4)"
is "2xx counted"                            5     "$(printf '%s' "$B" | cut -f5)"
is "4xx counted"                            1     "$(printf '%s' "$B" | cut -f7)"
is "5xx counted"                            1     "$(printf '%s' "$B" | cut -f8)"

# Columns 9-20 are six [human,bot] pairs in this order:
#   public, app, api, asset, health, other
is "human PUBLIC (/e/) requests"            1     "$(printf '%s' "$B" | cut -f9)"
is "bot PUBLIC requests"                    2     "$(printf '%s' "$B" | cut -f10)"
is "human ADMIN (/dashboard) requests"      1     "$(printf '%s' "$B" | cut -f11)"
is "public and admin do NOT share a bucket" 0     "$(printf '%s' "$B" | cut -f12)"
is "human api requests"                     1     "$(printf '%s' "$B" | cut -f13)"
is "human asset requests"                   1     "$(printf '%s' "$B" | cut -f15)"
is "health is its OWN category, not api"    1     "$(printf '%s' "$B" | cut -f18)"
is "cutoff excludes the 2020 line"          1     "$(printf '%s' "$OUT" | grep '^#META' | cut -f3)"

# Link-preview fetchers do not contain the string "bot", so they slip through a
# naive bot list. Event links circulate in WhatsApp groups and on Facebook, and
# every share triggers a preview fetch that would otherwise read as a visit.
is "facebookexternalhit is a bot, not a visit" "/e/x/register" \
   "$(printf '%s' "$OUT" | grep '^#P' | cut -f3 | sort | tr '\n' ' ' | sed 's/ $//')"
is "staff pages go in their OWN list"       "/dashboard" \
   "$(printf '%s' "$OUT" | grep '^#S' | cut -f3)"

is "top referrers keeps a real host"        "linkedin.com" \
   "$(printf '%s' "$OUT" | grep '^#R' | cut -f3)"

# An internal referrer is our own navigation, not acquisition.
INT="$TMP/internal.log"
line 6.6.6.6 "20/Aug/2026:09:00:00 +0000" "GET /e/y HTTP/1.1" 200 "https://events.meetingmindsgroup.com/e/x" "Mozilla/5.0 Chrome/120" > "$INT"
is "internal referrer is not acquisition"   0     "$(awk -f "$AWK_PROG" -v cutoff=2026-08-01T00 "$INT" | grep -c '^#R')"

# THE line that matters. A quote inside the request shifts every field after
# it, so status, referrer and user agent all get mis-read. nginx escapes an
# embedded quote as \" but that is still a separator to awk, so escaping does
# not save us. Reject and count, never parse into something plausible.
MAL="$TMP/malformed.log"
printf '7.7.7.7 - - [20/Aug/2026:10:00:00 +0000] "GET /e/x/%s HTTP/1.1" 200 1 "-" "Mozilla/5.0 Chrome/120"\n' 'evil","x":"pwned' > "$MAL"
MOUT="$(awk -f "$AWK_PROG" -v cutoff=2026-08-01T00 "$MAL")"
is "line with an embedded quote is rejected" 1 "$(printf '%s' "$MOUT" | grep '^#META' | cut -f5)"
is "rejected line produces no bucket"        0 "$(printf '%s' "$MOUT" | grep -c '^#B')"
is "rejected line produces no referrer"      0 "$(printf '%s' "$MOUT" | grep -c '^#R')"

echo
echo "nginx-traffic-snapshot.sh"

run_snap() {
  NGINX_TRAFFIC_LOG_DIR="$TMP" \
  NGINX_TRAFFIC_OUT="$TMP/out.json" \
  NGINX_TRAFFIC_ARCHIVE="$TMP/archive.tsv" \
  NGINX_TRAFFIC_LOCK="$TMP/lock" \
  bash "$SNAP" >/dev/null 2>&1
}

# Seed the archive with three cases the merge has to get right.
{
  printf '#B\t2026-07-01T10\t999\t0\t999\t0\t0\t0\t999\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\n'
  printf '#B\t2020-01-01T10\t555\t0\t555\t0\t0\t0\t555\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\n'
  printf '#B\t2026-08-20T08\t111111\t0\t1\t0\t0\t0\t1\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\t0\n'
} > "$TMP/archive.tsv"

run_snap
JQ() { node -e "const d=require('$TMP/out.json');$1"; }

is "output is valid JSON"                   "ok"  "$(node -e "require('$TMP/out.json');console.log('ok')" 2>/dev/null || echo parse-error)"
is "pre-window archive history is KEPT"     999   "$(JQ "console.log((d.buckets.find(b=>b.h==='2026-07-01T10')||{}).total)")"
is "beyond-horizon history is dropped"      undefined "$(JQ "console.log((d.buckets.find(b=>b.h==='2020-01-01T10')||{}).total)")"
is "fresh parse SUPERSEDES a stale bucket"  7     "$(JQ "console.log((d.buckets.find(b=>b.h==='2026-08-20T08')||{}).total)")"
is "buckets are sorted ascending"           "true" "$(JQ "console.log(d.buckets.every((b,i,a)=>i===0||a[i-1].h<=b.h))")"
is "no bucket is double counted"            "true" "$(JQ "console.log(new Set(d.buckets.map(b=>b.h)).size===d.buckets.length)")"

# Re-running must be idempotent: the same logs must not inflate the archive.
BEFORE="$(JQ "console.log(d.buckets.reduce((a,b)=>a+b.total,0))")"
run_snap
AFTER="$(JQ "console.log(d.buckets.reduce((a,b)=>a+b.total,0))")"
is "a second run is idempotent"             "$BEFORE" "$AFTER"

# THE REGRESSION THAT REACHED PRODUCTION.
#
# grep exits 1 when it matches nothing. Under `set -euo pipefail` that fails the
# pipeline and kills the script AFTER the archive has been written, so it exits
# silently having produced no JSON while the cron log looks clean.
#
# Both empty cases below are ordinary, not exotic. The first fixture has
# referer "-" on every line, which is what a direct visit looks like; the
# second is all bots and health checks, which is most of a quiet hour on this
# box. The original suite missed it because every fixture happened to contain
# at least one of each row type.
#
# (My first attempt at this test used 40 distinct paths, on a wrong diagnosis
# that `head` was causing SIGPIPE. It passed against the bug. Kept below as the
# third case, because head-into-a-full-pipe IS a real hazard at scale, just not
# the one that bit.)

mk_case() { mkdir -p "$TMP/$1"; }

# 1. No external referrers at all: every visit direct.
mk_case direct
i=1
while [ "$i" -le 5 ]; do
  line "1.1.1.$i" "20/Aug/2026:08:00:00 +0000" "GET /e/event-$i HTTP/1.1" 200 "-" "Mozilla/5.0 Chrome/120"
  i=$((i+1))
done > "$TMP/direct/access.log"

# 2. No human page views at all: bots and health checks only.
mk_case botsonly
line 1.1.1.1 "20/Aug/2026:08:00:00 +0000" "GET /health HTTP/1.1"   200 "-" "Amazon-Route53-Health-Check-Service" >  "$TMP/botsonly/access.log"
line 2.2.2.2 "20/Aug/2026:08:01:00 +0000" "GET /e/x HTTP/1.1"      200 "-" "Mozilla/5.0 (compatible; AhrefsBot/7.0)" >> "$TMP/botsonly/access.log"

# 3. More distinct paths than the cap, so truncation is actually exercised.
mk_case many
i=1
while [ "$i" -le 40 ]; do
  line "1.1.1.$i" "20/Aug/2026:08:00:00 +0000" "GET /e/event-$i/register HTTP/1.1" 200 "https://ref-$i.example.com/" "Mozilla/5.0 Chrome/120"
  i=$((i+1))
done > "$TMP/many/access.log"

run_case() {
  NGINX_TRAFFIC_LOG_DIR="$TMP/$1" NGINX_TRAFFIC_OUT="$TMP/$1/out.json" \
  NGINX_TRAFFIC_ARCHIVE="$TMP/$1/archive.tsv" NGINX_TRAFFIC_LOCK="$TMP/$1/lock" \
  bash "$SNAP" >/dev/null 2>&1
  echo $?
}
json_ok() { node -e "require('$TMP/$1/out.json');console.log('ok')" 2>/dev/null || echo no-json; }
json_len() { node -e "console.log(require('$TMP/$1/out.json').$2.length)" 2>/dev/null || echo missing; }

is "survives a window with NO referrers"        0     "$(run_case direct)"
is "  and still writes JSON"                    "ok"  "$(json_ok direct)"
is "  with an empty referrer list"              0     "$(json_len direct topReferrers)"

is "survives a window with NO human pages"      0     "$(run_case botsonly)"
is "  and still writes JSON"                    "ok"  "$(json_ok botsonly)"
is "  with an empty page list"                  0     "$(json_len botsonly topPaths)"

is "survives more paths than the cap"           0     "$(run_case many)"
is "  and truncates rather than dropping"       15    "$(json_len many topPaths)"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
