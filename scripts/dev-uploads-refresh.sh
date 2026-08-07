#!/usr/bin/env bash
#
# Pull the uploaded FILES into the local checkout, from the Singapore DR mirror.
#
# `npm run db:refresh` restores the rows; it does not bring the files those rows
# point at. Uploads live on the box (and in the DR bucket), never in git — so a
# freshly refreshed local DB renders broken images everywhere: the org logo,
# event banners, speaker photos, certificate backgrounds. This closes that gap.
#
# Local-only and read-only against AWS: it downloads from the bucket into
# public/uploads/ (gitignored). Nothing is written to S3 or to prod, and no
# local file is deleted — deliberately NO --delete, mirroring the hourly prod
# sync, whose non-deleting behaviour is what made INC-004 recoverable.
#
# Usage:  npm run uploads:refresh   (or: bash scripts/dev-uploads-refresh.sh)
# Reqs:   AWS creds with read on the DR bucket.
#
# NOTE ON CONTENT: this pulls real attendee photos and any speaker or
# reimbursement documents that exist in the bucket. Fine for a work machine you
# already trust with a prod DB dump; think twice anywhere else, and prefer
# copying the single file you need.
set -euo pipefail

BUCKET="ea-sys-dr-singapore"
REGION="ap-southeast-1"
DEST="public/uploads"

echo "== dev-uploads-refresh → ${DEST} (local only) =="

before_files=$(find "$DEST" -type f 2>/dev/null | wc -l | tr -d ' ')
echo "-- before: ${before_files} files, $(du -sh "$DEST" 2>/dev/null | cut -f1 || echo 0) --"

mkdir -p "$DEST"
aws s3 sync "s3://${BUCKET}/uploads/" "$DEST/" --region "$REGION" --only-show-errors

after_files=$(find "$DEST" -type f | wc -l | tr -d ' ')
echo "-- after:  ${after_files} files, $(du -sh "$DEST" | cut -f1) (+$((after_files - before_files))) --"

echo "-- by category --"
for d in "$DEST"/*/; do
  [ -d "$d" ] || continue
  printf "   %-18s %5s files  %6s\n" "$(basename "$d")" \
    "$(find "$d" -type f | wc -l | tr -d ' ')" "$(du -sh "$d" | cut -f1)"
done

echo "✓ uploads refreshed from s3://${BUCKET}/uploads/"
