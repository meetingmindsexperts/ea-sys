#!/usr/bin/env bash
# Tenant-scoping guard for PUBLIC event lookups (multi-tenancy Phase 0).
#
# WHY THIS EXISTS
# ---------------
# `Event.slug` is only unique PER ORGANIZATION (`@@unique([organizationId,
# slug])`). The July 2026 Phase-0 sweep routed every public event-by-slug
# lookup through `publicEventWhere` / `publicEventWhereForHost`
# (src/lib/public-event.ts), which binds the org resolved from the request's
# Host header. A future public route that hand-rolls `where: { slug }` — or an
# `event: { slug }` relation filter — silently reopens the cross-tenant hole:
# on a multi-tenant DB, `findFirst` by slug alone returns an ARBITRARY
# tenant's event on a public URL.
#
# This guard fails CI when a file in the public surface contains a direct
# event lookup that doesn't go through the sanctioned helper. It only fires
# on NEW code in the scoped paths, so it can never block an unrelated hotfix.
#
# HOW TO ACKNOWLEDGE
# ------------------
# If a lookup is genuinely tenant-safe without the helper (rare — think hard),
# add the file's repo-relative path to scripts/tenant-scoping-allow.txt with a
# one-line reason. The allow-list shows up in review, which is the point.
#
# Usage: bash scripts/check-tenant-scoping.sh
# Exit:  0 = clean, 1 = unsanctioned lookup found

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALLOW_FILE="$REPO_ROOT/scripts/tenant-scoping-allow.txt"

# The public surface: everything reachable without a session, where the org
# must come from the request Host rather than the caller's identity.
# (Authenticated /api/events/* routes bind organizationId from the session /
# API key via getOrgContext — different mechanism, out of scope here.)
SCOPED_PATHS=(
  "src/app/api/public"
  "src/lib/public-event-metadata.ts"
  "src/app/api/auth/forgot-password/route.ts"
)

# The one file allowed to build slug-wheres by hand.
SANCTIONED_FILE="src/lib/public-event.ts"

allowed() {
  local rel="$1"
  [ -f "$ALLOW_FILE" ] || return 1
  grep -vE '^\s*(#|$)' "$ALLOW_FILE" | awk '{print $1}' | grep -qxF "$rel"
}

# Strip // line comments and /* */ blocks so prose mentioning the patterns
# doesn't trip the guard (same technique as check-migration-safety.sh).
executable_ts() {
  sed -e 's|//.*$||' "$1" | perl -0777 -pe 's{/\*.*?\*/}{}gs'
}

violations=0

report() {
  local rel="$1" reason="$2" hits="$3"
  if [ "$violations" -eq 0 ]; then
    echo ""
    echo "✗ Public event lookup(s) bypassing the tenant-scoped helper"
    echo "  (Event.slug is only unique per org — an unscoped public lookup can"
    echo "  serve ANOTHER tenant's event once a second org exists.)"
    echo ""
  fi
  violations=$((violations + 1))
  echo "  $rel — $reason"
  echo "$hits" | sed 's/^/      /'
  echo ""
}

while IFS= read -r file; do
  rel="${file#"$REPO_ROOT"/}"
  [ "$rel" = "$SANCTIONED_FILE" ] && continue
  allowed "$rel" && continue

  src="$(executable_ts "$file")"

  # Pattern 1: any direct event find in the public surface must use the
  # helper in its where. Flag db.event.find* calls whose following ~400 chars
  # don't mention publicEventWhere.
  hits="$(printf '%s' "$src" | perl -0777 -ne '
    while (/db\.event\.find(?:First|Unique|Many)\s*\(.{0,400}/gs) {
      my $m = $&;
      print "db.event.find… without publicEventWhere\n" unless $m =~ /publicEventWhere/;
    }')"
  [ -n "$hits" ] && report "$rel" "direct event lookup" "$hits"

  # Pattern 2: hand-rolled relation filter `event: { … slug … }` (Shape C).
  # The (?!\s*:) lookahead excludes SELECT blocks (`slug: true`) — a where
  # filter uses the shorthand `event: { slug }` / `event: { slug, status }`.
  # Known limit: an OR:[{slug},…] nested inside a relation filter isn't seen
  # here, but pattern 1 covers the direct-find variants of that shape.
  hits="$(printf '%s' "$src" | perl -0777 -ne '
    while (/event:\s*\{[^{}]{0,200}(?<![.\w])slug\b(?!\s*:)/gs) {
      print "event: { … slug … } relation filter (use event: await publicEventWhere(...))\n";
    }')"
  [ -n "$hits" ] && report "$rel" "relation-filter by slug" "$hits"
done < <(
  for p in "${SCOPED_PATHS[@]}"; do
    if [ -d "$REPO_ROOT/$p" ]; then
      find "$REPO_ROOT/$p" -name "*.ts" -type f
    elif [ -f "$REPO_ROOT/$p" ]; then
      echo "$REPO_ROOT/$p"
    fi
  done
)

if [ "$violations" -gt 0 ]; then
  cat <<'EOF'
  Fix: build the where through the sanctioned helper —

      import { publicEventWhere } from "@/lib/public-event";
      const event = await db.event.findFirst({
        where: await publicEventWhere(req, slug, { statuses: [...] }),
        select: { ... },
      });

  or for relation filters: `event: await publicEventWhere(req, slug, {...})`.
  Token routes should additionally assert eventMatchesRequestTenant() after
  loading the row. If the lookup is genuinely safe without the helper, add
  the file to scripts/tenant-scoping-allow.txt with a reason.

EOF
  exit 1
fi

echo "✓ Tenant scoping: all public event lookups go through publicEventWhere"
