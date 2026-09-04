#!/usr/bin/env bash
#
# No credential-shaped string may be committed.
#
# WHY A GATE. On 2026-09-04 a live organisation API key was found in
# `.claude/settings.local.json`, tracked in this PUBLIC repository since
# 2026-04-07: Claude Code writes every approved command string, secrets
# included, into that file, and an ignore rule never untracks a file that is
# already in. Nothing noticed for five months because GitHub's secret scanning
# does not know our `mmg_` shape and no gate here looked. This one looks.
#
# WHAT IT CHECKS. Every TRACKED text file (`git ls-files`, so a staged file
# counts and an untracked local one does not) for the shapes of the credentials
# this system actually handles: our API keys, Anthropic/OpenAI, Stripe, AWS
# access keys, GitHub tokens, Slack, Brevo, SendGrid, JWTs, private-key blocks,
# and a Postgres URL carrying a real-looking password to a real-looking host.
#
# PLACEHOLDERS ARE FINE. Docs legitimately show `ghp_xxxxxxxx…` or
# `mmg_XXXX`. A match is ignored when its body is one repeated character or
# contains an obvious placeholder marker (xxxx, <...>, YOUR, EXAMPLE, ...).
# Anything else that looks real is treated as real: a false positive costs a
# minute, a false negative cost five months.
#
# THE REPORT MASKS THE MATCH. Actions logs on a public repo are public, so the
# gate prints the file, the line number and the first few characters only.
#
# ALLOW-LIST: exact path plus a reason of at least 30 characters, for files that
# hold deliberately fake credentials (test fixtures). Add an entry only after
# confirming the value is fake; never to make CI green.
#
# Run from the repo root. `--self-test` exercises the detector on fixtures.
set -euo pipefail

ALLOW=(
  "__tests__/lib/email-ses-diagnostic.test.ts|fake AKIA0987/AKIASTALE/AKIATEST fixtures for the SES credential-source diagnostic"
)

PATTERN='mmg_[A-Za-z0-9]{16,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-proj-[A-Za-z0-9_-]{20,}|sk_(live|test)_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pous]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[bpa]-[A-Za-z0-9-]{10,}|xkeysib-[A-Za-z0-9-]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(ql)?://[^:/@ ]+:[^@ ]{16,}@[^ /]*(supabase\.co|supabase\.com|rds\.amazonaws\.com)'

# Drop placeholder matches; mask the rest. Reads "file:line:text" lines.
filter_and_mask() {
  perl -ne '
    my $line = $_;
    my ($file, $ln, $text) = $line =~ /^([^:]+):(\d+):(.*)$/s or next;
    my $re = qr/(mmg_[A-Za-z0-9]{16,}|sk-ant-[A-Za-z0-9_-]{10,}|sk-proj-[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pous]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|xox[bpa]-[A-Za-z0-9-]{10,}|xkeysib-[A-Za-z0-9-]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(?:ql)?:\/\/[^:\/@ ]+:[^@ ]{16,}@[^ \/]*(?:supabase\.co|supabase\.com|rds\.amazonaws\.com))/;
    my @real;
    while ($text =~ /$re/g) {
      my $tok = $1;
      my ($prefix, $body) = $tok =~ /^([A-Za-z_-]*?[_.-]|postgres(?:ql)?:\/\/|-----BEGIN )(.*)$/s;
      $body //= $tok;
      next if $body =~ /^(.)\1*$/;                         # one repeated character: a placeholder
      next if $body =~ /x{4,}|X{4,}|\.\.\.|…|<|YOUR|EXAMPLE|PLACEHOLDER|example|placeholder|REDACTED/;
      push @real, $tok;
    }
    next unless @real;
    my @masked = map { my $t = $_; $t =~ s/^((?:[A-Za-z_-]*?[_.-]|postgres(?:ql)?:\/\/|-----BEGIN )?.{0,4}).*/$1…/s; $t } @real;
    print "$file:$ln: ", join(", ", @masked), "\n";
  '
}

if [ "${1:-}" = "--self-test" ]; then
  # Fixtures are assembled from parts so this file never contains a
  # credential-shaped literal (the gate scans itself once it is tracked).
  hex64=$(printf '0123456789abcdef%.0s' 1 2 3 4)
  k_ours=$(printf 'mmg_%s' "$hex64")
  k_aws=$(printf '%s%s' 'AKIA' 'IOSFODNN7EXAMPL3')
  k_db=$(printf 'postgresql://postgres.abc:%s@aws-0-ap-south-1.pooler.%s:6543/postgres' 'Qw3rTyUiOpAsDfGhJkL9' 'supabase.com')
  real=$(printf 'x.ts:1:key = "%s"\nx.ts:2:"%s"\nx.ts:3:url = "%s"\n' "$k_ours" "$k_aws" "$k_db" | grep -E "$PATTERN" | filter_and_mask | wc -l | tr -d ' ')
  fake=$(printf 'x.md:1:KEY="mmg_XXXXXXXXXXXXXXXXXXXXXXXX"\nx.md:2:ghp_%s\nx.md:3:postgresql://postgres:postgres@localhost:55432/tenancy\nx.md:4:sk-ant-<REDACTED>\n' "$(printf 'x%.0s' $(seq 1 36))" | grep -E "$PATTERN" | filter_and_mask | wc -l | tr -d ' ')
  leak=$(printf 'x.ts:1:%s\n' "$k_ours" | grep -E "$PATTERN" | filter_and_mask | grep -c "${hex64:0:20}" || true)
  if [ "$real" = "3" ] && [ "$fake" = "0" ] && [ "$leak" = "0" ]; then echo "self-test OK (3 real detected, 0 placeholders flagged, report is masked)"; exit 0; fi
  echo "✋ self-test FAILED: real=$real (want 3) fake=$fake (want 0) unmasked=$leak (want 0)"; exit 1
fi

fail=0
for entry in "${ALLOW[@]}"; do
  reason="${entry#*|}"
  if [ "$reason" = "$entry" ] || [ "${#reason}" -lt 30 ]; then echo "✋ allow-list entry needs a reason of 30+ chars: $entry"; exit 1; fi
  path="${entry%%|*}"
  if ! git ls-files --error-unmatch "$path" >/dev/null 2>&1; then echo "✋ allow-list entry for a file that is not tracked (stale entry): $path"; exit 1; fi
done

allow_re=""
for entry in "${ALLOW[@]}"; do p="${entry%%|*}"; allow_re="${allow_re:+$allow_re|}^$(printf '%s' "$p" | sed 's/[.[\*^$]/\\&/g'):"; done

hits=$(git ls-files -z | grep -zv -E '^package-lock\.json$' | xargs -0 grep -nIE "$PATTERN" 2>/dev/null | { if [ -n "$allow_re" ]; then grep -vE "$allow_re"; else cat; fi; } | filter_and_mask || true)

if [ -n "$hits" ]; then
  echo "✋ credential-shaped string(s) in tracked files (masked):"
  echo "$hits" | sed 's/^/   /'
  echo "   Remove the value, rotate it if it was ever real, and keep the file out of git if it is per-machine."
  fail=1
fi

[ "$fail" -eq 0 ] && echo "✓ no credential-shaped strings in tracked files"
exit "$fail"
