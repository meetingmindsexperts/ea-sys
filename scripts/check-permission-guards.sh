#!/usr/bin/env bash
# Keep the route files already moved onto requirePermission() moved.
#
# WHY THIS EXISTS
# ---------------
# Custom roles Phase 2 (docs/CUSTOM_ROLES_PLAN.md §6) moves the routes, one
# domain at a time, from role checks (`denyReviewer`, the `*_ALLOW` lists,
# inline `role === "..."` comparisons) onto `requirePermission()`, whose
# permission and event scope come from one grant. A swept file that later
# gains a role check again has two authorities that can disagree, and the one
# a role editor cannot see wins. This gate fails CI on that, naming the file.
#
# A file joins SWEPT only after its domain's route status matrix
# (__tests__/api/route-matrix/) was recorded on the unswept code and matched
# byte for byte after the sweep. The list only grows.
#
# NOT FLAGGED, on purpose: `buildEventAccessWhere` (the external roles,
# REVIEWER / SUBMITTER / REGISTRANT, keep their row-linked branches; plan §1)
# and `requireOrgId` (the separate org-null refusal stays; plan G5).
#
# Usage: bash scripts/check-permission-guards.sh
# Exit:  0 = clean, 1 = a role check in a swept file

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SWEPT=(
  # events core (Oct 1, 2026)
  "src/app/api/events/route.ts"
  "src/app/api/events/[eventId]/route.ts"
  # registration types, tiers and promo codes (Oct 1, 2026)
  "src/app/api/events/[eventId]/tickets/route.ts"
  "src/app/api/events/[eventId]/tickets/[ticketId]/route.ts"
  "src/app/api/events/[eventId]/tickets/[ticketId]/tiers/route.ts"
  "src/app/api/events/[eventId]/tickets/[ticketId]/tiers/[tierId]/route.ts"
  "src/app/api/events/[eventId]/promo-codes/route.ts"
  "src/app/api/events/[eventId]/promo-codes/[promoCodeId]/route.ts"
  # sessions and tracks (Oct 2, 2026)
  "src/app/api/events/[eventId]/sessions/route.ts"
  "src/app/api/events/[eventId]/sessions/[sessionId]/route.ts"
  "src/app/api/events/[eventId]/sessions/bulk-delete/route.ts"
  "src/app/api/events/[eventId]/tracks/route.ts"
  "src/app/api/events/[eventId]/tracks/[trackId]/route.ts"
  # speakers (Oct 2, 2026); honorarium and reimbursement types go with faculty extras
  "src/app/api/events/[eventId]/speakers/route.ts"
  "src/app/api/events/[eventId]/speakers/[speakerId]/route.ts"
  "src/app/api/events/[eventId]/speakers/bulk-tags/route.ts"
  "src/app/api/events/[eventId]/speakers/tags/route.ts"
  "src/app/api/events/[eventId]/speakers/import-contacts/route.ts"
  "src/app/api/events/[eventId]/speakers/import-registrations/route.ts"
  "src/app/api/events/[eventId]/speakers/[speakerId]/activity/route.ts"
  "src/app/api/events/[eventId]/speakers/[speakerId]/agreement/route.ts"
  "src/app/api/events/[eventId]/speakers/[speakerId]/documents/route.ts"
  "src/app/api/events/[eventId]/speakers/[speakerId]/documents/[documentId]/route.ts"
  "src/app/api/events/[eventId]/speakers/[speakerId]/documents/[documentId]/file/route.ts"
  "src/app/api/events/[eventId]/speakers/[speakerId]/email/route.ts"
  "src/app/api/events/[eventId]/speakers/[speakerId]/grant-companion/route.ts"
  "src/app/api/events/[eventId]/speakers/[speakerId]/profile-form/route.ts"
  # abstracts and proposals, staff side (Oct 2, 2026); part B (the author and reviewer routes) follows
  "src/app/api/events/[eventId]/abstract-themes/route.ts"
  "src/app/api/events/[eventId]/abstract-themes/[themeId]/route.ts"
  "src/app/api/events/[eventId]/abstract-themes/[themeId]/sub-themes/route.ts"
  "src/app/api/events/[eventId]/abstract-themes/[themeId]/sub-themes/[subThemeId]/route.ts"
  "src/app/api/events/[eventId]/session-proposal-themes/route.ts"
  "src/app/api/events/[eventId]/session-proposal-themes/[themeId]/route.ts"
  "src/app/api/events/[eventId]/review-criteria/route.ts"
  "src/app/api/events/[eventId]/review-criteria/[criterionId]/route.ts"
  "src/app/api/events/[eventId]/reviewers/route.ts"
  "src/app/api/events/[eventId]/reviewers/[reviewerId]/route.ts"
  "src/app/api/events/[eventId]/reviewers/[reviewerId]/resend-invitation/route.ts"
  "src/app/api/events/[eventId]/abstracts/[abstractId]/reviewers/route.ts"
  "src/app/api/events/[eventId]/abstracts/[abstractId]/reviewers/[userId]/route.ts"
  "src/app/api/events/[eventId]/abstracts/[abstractId]/resend-confirmation/route.ts"
  "src/app/api/events/[eventId]/abstracts/[abstractId]/presenter-agreement/email/route.ts"
  "src/app/api/events/[eventId]/submission-shares/route.ts"
  # abstracts and proposals, author and reviewer side (Oct 2, 2026)
  "src/app/api/events/[eventId]/abstracts/route.ts"
  "src/app/api/events/[eventId]/abstracts/[abstractId]/route.ts"
  "src/app/api/events/[eventId]/abstracts/[abstractId]/submissions/route.ts"
  "src/app/api/events/[eventId]/abstracts/my-profile/route.ts"
  "src/app/api/events/[eventId]/session-proposals/route.ts"
  "src/app/api/events/[eventId]/session-proposals/[proposalId]/route.ts"
  # accommodation (Oct 2, 2026)
  "src/app/api/events/[eventId]/hotels/route.ts"
  "src/app/api/events/[eventId]/hotels/[hotelId]/route.ts"
  "src/app/api/events/[eventId]/hotels/[hotelId]/rooms/route.ts"
  "src/app/api/events/[eventId]/hotels/[hotelId]/rooms/[roomId]/route.ts"
  "src/app/api/events/[eventId]/accommodations/route.ts"
  "src/app/api/events/[eventId]/accommodations/[accommodationId]/route.ts"
  # communications (Oct 2, 2026)
  "src/app/api/events/[eventId]/emails/audience-count/route.ts"
  "src/app/api/events/[eventId]/emails/bulk/route.ts"
  "src/app/api/events/[eventId]/emails/schedule/route.ts"
  "src/app/api/events/[eventId]/emails/schedule/[id]/route.ts"
  "src/app/api/events/[eventId]/emails/schedule/[id]/retry/route.ts"
  "src/app/api/events/[eventId]/email-templates/route.ts"
  "src/app/api/events/[eventId]/email-templates/[templateId]/route.ts"
  "src/app/api/events/[eventId]/email-templates/[templateId]/duplicate/route.ts"
  "src/app/api/events/[eventId]/email-preview/route.ts"
  "src/app/api/events/[eventId]/email-attachments/route.ts"
  "src/app/api/events/[eventId]/email-activity/route.ts"
  # certificates (Oct 2, 2026)
  "src/app/api/events/[eventId]/certificates/auto-issue/analytics/route.ts"
  "src/app/api/events/[eventId]/certificates/bulk-reissue/route.ts"
  "src/app/api/events/[eventId]/certificates/eligible/route.ts"
  "src/app/api/events/[eventId]/certificates/issue-single/route.ts"
  "src/app/api/events/[eventId]/certificates/issue/route.ts"
  "src/app/api/events/[eventId]/certificates/issued/[certificateId]/reissue/route.ts"
  "src/app/api/events/[eventId]/certificates/issued/resend-bundle/route.ts"
  "src/app/api/events/[eventId]/certificates/issued/resend-preview/route.ts"
  "src/app/api/events/[eventId]/certificates/issued/route.ts"
  "src/app/api/events/[eventId]/certificates/preview/route.ts"
  "src/app/api/events/[eventId]/certificates/runs/[runId]/cancel/route.ts"
  "src/app/api/events/[eventId]/certificates/runs/[runId]/download/route.ts"
  "src/app/api/events/[eventId]/certificates/runs/[runId]/retry-failed/route.ts"
  "src/app/api/events/[eventId]/certificates/runs/[runId]/route.ts"
  "src/app/api/events/[eventId]/certificates/runs/[runId]/send/route.ts"
  "src/app/api/events/[eventId]/certificates/runs/route.ts"
  "src/app/api/events/[eventId]/certificates/settings/route.ts"
  "src/app/api/events/[eventId]/certificates/templates/[templateId]/duplicate/route.ts"
  "src/app/api/events/[eventId]/certificates/templates/[templateId]/route.ts"
  "src/app/api/events/[eventId]/certificates/templates/route.ts"
  "src/app/api/events/[eventId]/certificates/templates/starter/route.ts"
  # webinar console and Zoom (Oct 2, 2026)
  "src/app/api/events/[eventId]/webinar/route.ts"
  "src/app/api/events/[eventId]/webinar/attendance/route.ts"
  "src/app/api/events/[eventId]/webinar/engagement/route.ts"
  "src/app/api/events/[eventId]/webinar/livestream/route.ts"
  "src/app/api/events/[eventId]/webinar/panelists/route.ts"
  "src/app/api/events/[eventId]/webinar/panelists/[panelistId]/resend/route.ts"
  "src/app/api/events/[eventId]/webinar/panelists/sync-speakers/route.ts"
  "src/app/api/events/[eventId]/webinar/presence/route.ts"
  "src/app/api/events/[eventId]/webinar/questions/route.ts"
  "src/app/api/events/[eventId]/webinar/recording/fetch/route.ts"
  "src/app/api/events/[eventId]/webinar/room/route.ts"
  "src/app/api/events/[eventId]/webinar/sequence/route.ts"
  "src/app/api/events/[eventId]/zoom/settings/route.ts"
  "src/app/api/events/[eventId]/sessions/[sessionId]/zoom/route.ts"
  "src/app/api/events/[eventId]/sessions/[sessionId]/zoom/panelists/route.ts"
  # faculty extras (Oct 2, 2026)
  "src/app/api/events/[eventId]/reimbursements/route.ts"
  "src/app/api/events/[eventId]/reimbursements/[reimbursementId]/route.ts"
  "src/app/api/events/[eventId]/reimbursements/[reimbursementId]/pdf/route.ts"
  "src/app/api/events/[eventId]/reimbursements/[reimbursementId]/documents/[documentId]/route.ts"
  "src/app/api/events/[eventId]/reimbursements/send/route.ts"
  "src/app/api/events/[eventId]/reimbursements/settings/route.ts"
  "src/app/api/events/[eventId]/speakers/[speakerId]/reimbursement-types/route.ts"
  "src/app/api/events/[eventId]/speakers/[speakerId]/honorarium/route.ts"
  "src/app/api/events/[eventId]/travel-grants/route.ts"
  "src/app/api/events/[eventId]/travel-grants/[grantId]/route.ts"
  "src/app/api/events/[eventId]/rsvp-campaigns/route.ts"
  "src/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/route.ts"
  "src/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/items/route.ts"
  "src/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/items/[itemId]/route.ts"
  "src/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/invites/route.ts"
  "src/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/invites/[inviteId]/route.ts"
  "src/app/api/events/[eventId]/rsvp-campaigns/[campaignId]/invites/send/route.ts"
  "src/app/api/events/[eventId]/survey/responses/route.ts"
  "src/app/api/events/[eventId]/survey/responses/export/route.ts"
  "src/app/api/events/[eventId]/registrations/[registrationId]/survey/route.ts"
  # contacts (Oct 5, 2026)
  "src/app/api/contacts/route.ts"
  "src/app/api/contacts/[contactId]/route.ts"
  "src/app/api/contacts/[contactId]/email/route.ts"
  "src/app/api/contacts/bulk-tags/route.ts"
  "src/app/api/contacts/tags/route.ts"
  "src/app/api/contacts/export/route.ts"
  "src/app/api/contacts/import/route.ts"
  "src/app/api/contacts/import-eventsair/route.ts"
  # registrations desk (Oct 5, 2026)
  "src/app/api/events/[eventId]/registrations/route.ts"
  "src/app/api/events/[eventId]/registrations/[registrationId]/route.ts"
  "src/app/api/events/[eventId]/registrations/[registrationId]/activity/route.ts"
  "src/app/api/events/[eventId]/registrations/[registrationId]/barcode/route.ts"
  "src/app/api/events/[eventId]/registrations/[registrationId]/check-in/route.ts"
  "src/app/api/events/[eventId]/registrations/[registrationId]/payments/route.ts"
  "src/app/api/events/[eventId]/registrations/[registrationId]/email/route.ts"
  "src/app/api/events/[eventId]/registrations/[registrationId]/documents/resend/route.ts"
  "src/app/api/events/[eventId]/registrations/[registrationId]/supporting-document/route.ts"
  "src/app/api/events/[eventId]/registrations/badges/route.ts"
  "src/app/api/events/[eventId]/registrations/badges/preview/route.ts"
  "src/app/api/events/[eventId]/registrations/bulk-tags/route.ts"
  "src/app/api/events/[eventId]/registrations/bulk-type/route.ts"
  "src/app/api/events/[eventId]/registrations/import-contacts/route.ts"
  "src/app/api/events/[eventId]/import/registrations/route.ts"
  "src/app/api/events/[eventId]/import/registrations/send-completion-emails/route.ts"
  "src/app/api/events/[eventId]/tags/route.ts"
  "src/app/api/events/[eventId]/dtcm-pool/route.ts"
  "src/app/api/events/[eventId]/registration-shares/route.ts"
  "src/app/api/events/[eventId]/registration-shares/[viewId]/route.ts"
  "src/app/api/events/[eventId]/registration-shares/[viewId]/regenerate/route.ts"
  "src/app/api/events/[eventId]/onsite-staff/route.ts"
)

# What a swept file may no longer contain, once comments are stripped: the old
# guard, an allow-list, a comparison against a STAFF role name (the eight roles
# the catalogue covers), or the caller's own role compared with a VARIABLE
# (it could hold a staff name). The outside identities (REVIEWER, SUBMITTER,
# REGISTRANT) are not flagged as literals: plan §1 keeps their own checks (an
# author edits only their own abstract), and a route may test an invitee's
# account type.
STAFF='(SUPER_ADMIN|ADMIN|ORGANIZER|MEMBER|ONSITE|WEBINARS|CRM_USER|HR_USER)'
PATTERN="denyReviewer\\(|[A-Za-z_]+_ALLOW\\b|[!=]==[[:space:]]*\"${STAFF}\"|\"${STAFF}\"[[:space:]]*[!=]==|session\\.user\\.role[[:space:]]*[!=]==[[:space:]]*[^\"[:space:]]|[^\"[:space:]][[:space:]]*[!=]==[[:space:]]*session\\.user\\.role"

fail=0
for rel in "${SWEPT[@]}"; do
  f="$REPO_ROOT/$rel"
  if [[ ! -f "$f" ]]; then
    echo "check-permission-guards: swept file is missing: $rel (moved? update SWEPT)"
    fail=1
    continue
  fi
  stripped="$(sed -e 's|//.*$||' "$f" | perl -0777 -pe 's{/\*.*?\*/}{}gs')"
  hits="$(printf '%s\n' "$stripped" | grep -nE "$PATTERN" || true)"
  if [[ -n "$hits" ]]; then
    echo "check-permission-guards: $rel was moved onto requirePermission() and has a role check again:"
    printf '%s\n' "$hits" | sed 's/^/  /'
    fail=1
  fi
done

if [[ $fail -ne 0 ]]; then
  echo
  echo "Use requirePermission(session, \"<key>\", { route, eventId }) and gate.eventWhere instead."
  echo "If the role really needs something the catalogue cannot express, raise it; do not mix the two."
  exit 1
fi
echo "check-permission-guards: ${#SWEPT[@]} swept route files hold no role checks."
