#!/usr/bin/env bash
# User-by-email lookup scope guard (multi-tenancy item 6).
#
# WHY THIS EXISTS
# ---------------
# `User.email` is globally unique on master and unique PER TENANT on the
# platform (prisma/platform/010-user-identity.sql). Prisma's generated client
# still believes the old `@unique`, so every `user.findUnique({ where: { email
# } })` keeps compiling and keeps running once that index is gone — it simply
# returns whichever tenant's row the planner reaches first.
#
# That is the whole problem: **dropping an index cannot make application code
# fail loudly.** There is no type error, no exception, no empty result. A
# sign-in resolves to another tenant's account; a "this email is taken" answer
# is decided by a tenant the caller cannot see. Nothing short of a rule about
# the SHAPE of the query can catch it, which is what this gate is.
#
# WHAT IT CHECKS
# --------------
# A by-email `User` lookup must be tenant-safe in one of exactly two ways:
#
#   1. through the resolver — `findUserByEmail(` / `userEmailWhere(`, which
#      match this tenant's row or a tenant-less one, preferring this tenant's;
#      or
#   2. by carrying `organizationId` in the SAME where — a strict org filter,
#      correct where the answer must be an org member (the CRM deal-owner
#      lookups) and where an org-less row must NOT match.
#
# A bare `where: { email }` is neither, and is what this refuses.
#
# Comments are blanked before matching (newlines preserved, so reported line
# numbers still point at the real source line). `src/app/api/auth/register/route.ts`
# keeps its original multi-org body inside a block comment as a restore-later
# stub; a gate that could not tell prose from code would fail on it, the same
# lesson check-tenant-als.sh learned from its own documentation.
#
# HOW TO GROW IT
# --------------
# Nothing to grow — the rule is universal. If a new call site genuinely must
# look across tenants, say so in code: `findUserByEmail({ unscoped: true,
# reason: "..." }, ...)`. That is not a loophole, it is the point — a
# cross-tenant lookup should be a sentence someone wrote and a reviewer read,
# not an omission nobody noticed. `grep 'unscoped: true'` is then the list of
# decisions the platform has to revisit.
#
# Usage: bash scripts/check-user-email-scope.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

fail=0

# Files that touch the User model at all — the search space.
candidates=$(grep -rl --include='*.ts' --include='*.tsx' \
  -e '\.user\.find' src/ worker/ scripts/ prisma/ 2>/dev/null | sort || true)

for f in $candidates; do
  # Strip // line comments and /* block */ comments, then scan a small window
  # after each `.user.find*` for an email predicate.
  offenders=$(
    perl -0777 -pe 's{/\*.*?\*/}{ my $c = $&; $c =~ tr/\n//cd; $c }gse; s{^\s*//.*$}{}gm;' "$f" | awk '
      /\.user\.(findUnique|findFirst|findMany)/ { start = NR; buf = ""; keep = 9 }
      keep > 0 { buf = buf " " $0; keep--
        if (keep == 0) {
          if (buf ~ /where:[[:space:]]*\{[^}]*email/ || buf ~ /userEmailWhere/) {
            safe = (buf ~ /userEmailWhere/ || buf ~ /organizationId/)
            if (!safe) print start
          }
        }
      }
    '
  )
  for line in $offenders; do
    echo "✖ $f:$line — by-email User lookup with no tenant scope."
    fail=1
  done
done

# The resolver itself is the one module allowed to build the bare-email where
# (its `unscoped` branch). Assert it still exists, so deleting it cannot make
# this gate pass vacuously — the failure mode check-tenant-als.sh warns about.
if [ ! -f src/lib/tenant/user-lookup.ts ]; then
  echo "✖ src/lib/tenant/user-lookup.ts is missing — the rule above has nothing to point at."
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  cat <<'MSG'

Route the lookup through src/lib/tenant/user-lookup.ts:

    const user = await findUserByEmail({ organizationId: orgId }, email, {
      select: { id: true },
    });

Or, where the answer must be an ORG MEMBER and a tenant-less row must not
match, keep a strict filter carrying `organizationId` in the same where.

Genuinely cross-tenant? Say why, in code:

    findUserByEmail({ unscoped: true, reason: "..." }, email, { ... })

MSG
  exit 1
fi

echo "✓ every by-email User lookup is tenant-scoped or explicitly unscoped"
