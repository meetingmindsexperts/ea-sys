import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ownRegistrationWhere, type RegistrantScope } from "@/lib/registrant-access";
import { formatDate } from "@/lib/utils";
import { localDateInTz } from "@/lib/event-time";

/**
 * Which issued certificates a signed-in person may see and download on their
 * own portal (/my-registration). One function for the list and the download,
 * so the two cannot drift: a certificate the list hides is a certificate the
 * download refuses.
 *
 * WHOSE. The person's registrations and speaker records, found the same two
 * ways the portal finds registrations: linked to the account, or on the
 * account's email. A speaker's appreciation certificate hangs off the Speaker,
 * not a registration, so both are asked. A blank email matches nothing.
 * Matching a Speaker by email is the owner's decision (Nov 4, 2026), taken
 * knowing registrant accounts are not email-verified: it is the trust the
 * registration list already runs on, and faculty an organiser added by hand
 * have no account link to match on.
 *
 * WHICH. Never a revoked one, never one whose PDF has not been rendered, and
 * only once it has been RELEASED to them (`isReleased`).
 */

const PORTAL_FIELDS = {
  id: true,
  type: true,
  serial: true,
  issuedAt: true,
  cmeHoursSnapshot: true,
  pdfUrl: true,
  certificateTemplate: { select: { name: true, role: true, cmeHours: true } },
  event: { select: { id: true, name: true, slug: true, startDate: true, endDate: true, timezone: true, cmeHours: true } },
} satisfies Prisma.IssuedCertificateSelect;

const RELEASE_FIELDS = {
  eventId: true,
  registrationId: true,
  speakerId: true,
  certificateTemplateId: true,
  issueRunItemId: true,
  lastResentAt: true,
  issueRunItem: { select: { emailedAt: true, run: { select: { reissue: true } } } },
} satisfies Prisma.IssuedCertificateSelect;

type ReleaseFacts = Prisma.IssuedCertificateGetPayload<{ select: typeof RELEASE_FIELDS }>;
export type EmailedRunItem = {
  registrationId: string | null;
  speakerId: string | null;
  templateIds: string[];
  run: { eventId: string; certificateTemplateId: string | null };
};
export type PortalCertificate = Prisma.IssuedCertificateGetPayload<{ select: typeof PORTAL_FIELDS }>;

/**
 * The person's certificates: through a registration they own (registrant-access.ts)
 * or a speaker record linked to them. A speaker record matched only by email
 * counts once the account has proven that address, the same rule.
 */
function ownedWhere(scope: RegistrantScope): Prisma.IssuedCertificateWhereInput {
  const speaker: Prisma.SpeakerWhereInput[] = [{ userId: scope.userId }];
  if (scope.confirmed && scope.email) speaker.push({ email: { equals: scope.email, mode: "insensitive" } });
  return {
    revokedAt: null,
    pdfUrl: { not: null },
    OR: [{ registration: ownRegistrationWhere(scope) }, { speaker: { OR: speaker } }],
  };
}

/**
 * Has this certificate been handed to its holder?
 *
 * A run renders every PDF and then stops at AWAITING_REVIEW so the organiser
 * can look before anything goes out, and a cancelled run's PDFs never go out
 * at all, so "it exists" is not "it was sent". The certificate's own run
 * pointers cannot answer either: a run that REUSES a certificate leaves its
 * provenance alone (bundle.ts), and the send phase works out what to email
 * from each item's person and templates. So the answer is read from the
 * items that were actually emailed.
 *
 *  - resent since (any path), or its own item was emailed: released;
 *  - made outside any run, i.e. issued directly from the person's detail
 *    sheet, including "issue only" to hand over by hand: released. A bulk
 *    reissue run pointing at it later does not take that back;
 *  - otherwise: released once ANY run emailed this person a bundle that
 *    included this certificate's template at this event.
 */
export function isReleased(cert: ReleaseFacts, emailedItems: readonly EmailedRunItem[]): boolean {
  if (cert.lastResentAt) return true;
  if (cert.issueRunItem?.emailedAt) return true;
  if (!cert.issueRunItemId && (!cert.issueRunItem || cert.issueRunItem.run.reissue)) return true;
  const templateId = cert.certificateTemplateId;
  if (!templateId) return false;
  return emailedItems.some(
    (item) =>
      item.run.eventId === cert.eventId &&
      ((cert.registrationId !== null && item.registrationId === cert.registrationId) ||
        (cert.speakerId !== null && item.speakerId === cert.speakerId)) &&
      (item.templateIds.includes(templateId) || item.run.certificateTemplateId === templateId),
  );
}

/** The person's released certificates, newest first; `certificateId` narrows to one. */
export async function findReleasedCertificates(scope: RegistrantScope, certificateId?: string): Promise<PortalCertificate[]> {
  const certs = await db.issuedCertificate.findMany({
    where: { ...ownedWhere(scope), ...(certificateId && { id: certificateId }) },
    select: { ...PORTAL_FIELDS, ...RELEASE_FIELDS },
    orderBy: { issuedAt: "desc" },
  });
  if (certs.length === 0) return [];

  const registrationIds = [...new Set(certs.flatMap((c) => (c.registrationId ? [c.registrationId] : [])))];
  const speakerIds = [...new Set(certs.flatMap((c) => (c.speakerId ? [c.speakerId] : [])))];
  const emailedItems = await db.certificateIssueRunItem.findMany({
    where: {
      emailedAt: { not: null },
      OR: [{ registrationId: { in: registrationIds } }, { speakerId: { in: speakerIds } }],
    },
    select: { registrationId: true, speakerId: true, templateIds: true, run: { select: { eventId: true, certificateTemplateId: true } } },
  });

  return certs.filter((c) => isReleased(c, emailedItems));
}

/**
 * The CME hours a certificate carries. A direct issue never snapshotted them
 * (deliver.ts), so fall back the way the run worker snapshots: the template's
 * hours, then the event's.
 */
export function cmeHoursOf(cert: Pick<PortalCertificate, "cmeHoursSnapshot" | "certificateTemplate" | "event">): string | null {
  const hours = cert.cmeHoursSnapshot ?? cert.certificateTemplate?.cmeHours ?? cert.event.cmeHours ?? null;
  return hours === null ? null : hours.toString();
}

const CERT_TYPE_LABEL: Record<string, string> = {
  ATTENDANCE: "Attendance",
  APPRECIATION: "Appreciation",
};

/**
 * What the certificate is called: its template's role ("Speaker"), else the
 * template's own name, else its kind. The name before the kind because one
 * person can hold several of the same kind for one event: on production a
 * registrant held "CME (Speaker)" and "CME (Moderator)", both ATTENDANCE with
 * no role, and a kind-only title showed two identical rows.
 */
export function certificateTitle(cert: Pick<PortalCertificate, "type" | "certificateTemplate">): string {
  const name = cert.certificateTemplate?.role?.trim() || cert.certificateTemplate?.name?.trim();
  return name || `Certificate of ${(CERT_TYPE_LABEL[cert.type] ?? "attendance").toLowerCase()}`;
}

/**
 * The line under the title: kind (unless the title already is the kind), CME
 * hours, serial, issue date.
 */
export function certificateMeta(cert: PortalCertificate): string {
  const hours = cmeHoursOf(cert);
  const titled = cert.certificateTemplate?.role?.trim() || cert.certificateTemplate?.name?.trim();
  return [titled && CERT_TYPE_LABEL[cert.type], hours && `${hours} CME hours`, `No. ${cert.serial}`, `Issued ${formatDate(cert.issuedAt)}`]
    .filter(Boolean)
    .join(" · ");
}

/**
 * A person's CME hours from the certificates they have been sent, this year
 * and all time.
 *
 * ATTENDANCE certificates only, and an event counted ONCE (its largest): a
 * speaker can hold an attendance and an appreciation certificate for one
 * event, or two attendance ones ("CME (Speaker)" and "CME (Moderator)"), and
 * each would otherwise add the event's hours again. CME is earned by
 * attending; an appreciation certificate is a thank-you.
 *
 * The year is the EVENT's, in the event's own time zone (a conference that
 * starts at 00:00 on 1 January in Dubai is that year's, not the last), and
 * "this year" is now in `timeZone`. Summed in tenths, so 0.5 + 0.5 + 0.5 is
 * 1.5 and not 1.4999.
 */
export function cmeTotals(
  certs: Pick<PortalCertificate, "type" | "cmeHoursSnapshot" | "certificateTemplate" | "event">[],
  now: Date,
  timeZone: string,
): { thisYear: number; allTime: number; year: string } {
  const year = localDateInTz(now, timeZone).slice(0, 4);
  const perEvent = new Map<string, { tenths: number; year: string }>();
  for (const cert of certs) {
    if (cert.type !== "ATTENDANCE") continue;
    const hours = cmeHoursOf(cert);
    const tenths = hours ? Math.round(Number(hours) * 10) : 0;
    if (!Number.isFinite(tenths) || tenths <= 0) continue;
    const seen = perEvent.get(cert.event.id);
    if (seen && seen.tenths >= tenths) continue;
    perEvent.set(cert.event.id, { tenths, year: localDateInTz(cert.event.startDate, cert.event.timezone).slice(0, 4) });
  }
  let thisYear = 0;
  let allTime = 0;
  for (const e of perEvent.values()) {
    allTime += e.tenths;
    if (e.year === year) thisYear += e.tenths;
  }
  return { thisYear: thisYear / 10, allTime: allTime / 10, year };
}
