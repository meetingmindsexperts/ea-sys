import type { Prisma } from "@prisma/client";

/**
 * Which issued certificates a signed-in person may see and download on their
 * own portal (/my-registration). One rule for the list and the download, so
 * the two cannot drift: a certificate the list hides is a certificate the
 * download refuses.
 *
 * WHOSE. The person's registrations and speaker records, found the same two
 * ways the portal finds registrations: linked to the account, or on the
 * account's email. A speaker's appreciation certificate hangs off the Speaker,
 * not a registration, so both are asked.
 *
 * WHICH. Only what has been released to them:
 *  - never a revoked one, never one whose PDF has not been rendered;
 *  - a certificate from a bulk or survey run only once that run has emailed
 *    it. A run stops at AWAITING_REVIEW with every PDF rendered so the
 *    organiser can look before anything goes out; showing it here first would
 *    hand out what they have not yet approved, and a cancelled run's rendered
 *    PDFs would never go out at all;
 *  - a certificate issued directly from a person's detail sheet (no run item),
 *    because an organiser issued it to that one person on purpose, including
 *    "issue only" for handing over by hand;
 *  - anything resent since, which is a release by definition.
 */
export function releasedCertificatesWhere(userId: string, email: string): Prisma.IssuedCertificateWhereInput {
  return {
    revokedAt: null,
    pdfUrl: { not: null },
    AND: [
      {
        OR: [
          { registration: { OR: [{ userId }, { attendee: { email } }] } },
          { speaker: { OR: [{ userId }, { email }] } },
        ],
      },
      {
        OR: [
          { issueRunItemId: null, issueRunItem: { is: null } },
          { deliveredViaItem: { emailedAt: { not: null } } },
          { issueRunItem: { emailedAt: { not: null } } },
          { lastResentAt: { not: null } },
        ],
      },
    ],
  };
}

export const PORTAL_CERTIFICATE_SELECT = {
  id: true,
  type: true,
  serial: true,
  issuedAt: true,
  cmeHoursSnapshot: true,
  certificateTemplate: { select: { name: true, role: true } },
  event: { select: { id: true, name: true, slug: true, startDate: true, endDate: true, timezone: true } },
} satisfies Prisma.IssuedCertificateSelect;
