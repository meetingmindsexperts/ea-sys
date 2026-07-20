/**
 * Speaker reimbursements — organizer list + invite creation.
 *
 *   GET  → all reimbursement rows for the event (speaker, status, totals,
 *          submitted data incl. bank details). `?export=csv` streams a CSV
 *          for finance (wire-processing fields included).
 *   POST → create invites for a set of the event's speakers (mints a token
 *          per speaker; a speaker who already has one is skipped, not
 *          errored — speakerId is unique).
 *
 * ACCESS: every handler (reads included) is `denyReviewer(session)`-gated —
 * bank details + passport numbers are wire-transfer data, visible ONLY to
 * SUPER_ADMIN / ADMIN / ORGANIZER (owner decision, July 20 2026; see
 * `canManageReimbursements` in src/lib/reimbursement/constants.ts).
 * Event lookup routes through buildEventAccessWhere.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit } from "@/lib/security";
import { escapeCsvCell as csvCell } from "@/lib/csv-escape";
import { generateReimbursementToken } from "@/lib/reimbursement/server";
import { formatClaimTotals, type ClaimLine, type BankDetails } from "@/lib/reimbursement/constants";

type RouteParams = { params: Promise<{ eventId: string }> };

const createSchema = z.object({
  speakerIds: z.array(z.string().min(1).max(100)).min(1).max(200),
});

const LIST_SELECT = {
  id: true,
  speakerId: true,
  token: true,
  status: true,
  fullName: true,
  email: true,
  country: true,
  nationality: true,
  passportNumber: true,
  roleAtEvent: true,
  claimLines: true,
  bankDetails: true,
  signedName: true,
  submittedAt: true,
  createdAt: true,
  speaker: {
    select: { id: true, title: true, firstName: true, lastName: true, email: true },
  },
  documents: {
    select: { id: true, kind: true, filename: true, size: true, createdAt: true },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // Read-gate too: this payload carries passport numbers, bank details and
    // the impersonation token (the copy-link button needs it).
    const denied = denyReviewer(session);
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "reimbursements:list-event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const reimbursements = await db.speakerReimbursement.findMany({
      where: { eventId },
      orderBy: { createdAt: "asc" },
      select: LIST_SELECT,
    });

    const url = new URL(req.url);
    if (url.searchParams.get("export") === "csv") {
      // A bulk extraction of wire-transfer PII must leave a trace of who
      // pulled it and when (same rule as the RSVP roster export).
      apiLogger.info(
        { eventId, userId: session.user.id, rowCount: reimbursements.length },
        "reimbursements:csv-exported",
      );
      const header = [
        "Speaker",
        "Email",
        "Status",
        "Submitted At",
        "Full Name (passport)",
        "Nationality",
        "Passport Number",
        "Role at Event",
        "Claim Lines",
        "Totals",
        "Beneficiary Name",
        "Bank Name",
        "Bank Country",
        "Account Number",
        "IBAN",
        "SWIFT",
        "Routing Number",
        "Sort Code",
        "Intermediary Bank",
        "Signed Name",
      ];
      const rows = reimbursements.map((r) => {
        const lines = (r.claimLines as ClaimLine[] | null) ?? [];
        const bank = (r.bankDetails as BankDetails | null) ?? null;
        return [
          `${r.speaker.firstName} ${r.speaker.lastName}`,
          r.email ?? r.speaker.email,
          r.status,
          r.submittedAt ? r.submittedAt.toISOString() : "",
          r.fullName ?? "",
          r.nationality ?? "",
          r.passportNumber ?? "",
          r.roleAtEvent ?? "",
          lines.map((l) => `${l.item} ${l.currency} ${l.amount}`).join("; "),
          formatClaimTotals(lines),
          bank?.beneficiaryName ?? "",
          bank?.bankName ?? "",
          bank?.bankCountry ?? "",
          bank?.accountNumber ?? "",
          bank?.iban ?? "",
          bank?.swift ?? "",
          bank?.routingNumber ?? "",
          bank?.sortCode ?? "",
          bank?.intermediaryBank ?? "",
          r.signedName ?? "",
        ];
      });
      const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="speaker-reimbursements-${eventId}.csv"`,
        },
      });
    }

    return NextResponse.json({ reimbursements });
  } catch (err) {
    apiLogger.error({ err }, "reimbursements:list-failed");
    return NextResponse.json({ error: "Failed to load reimbursements" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => null),
    ]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `reimbursements-add:${eventId}`,
      limit: 30,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn({ eventId, userId: session.user.id }, "reimbursements:add-rate-limited");
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten(), eventId }, "reimbursements:add-validation-failed");
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, userId: session.user.id }, "reimbursements:add-event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Only THIS event's speakers — a foreign speakerId is silently dropped
    // (it can't be acted on, and reporting it would leak existence).
    const speakers = await db.speaker.findMany({
      where: { eventId, id: { in: parsed.data.speakerIds } },
      select: { id: true },
    });
    const validIds = speakers.map((s) => s.id);

    const existing = await db.speakerReimbursement.findMany({
      where: { speakerId: { in: validIds } },
      select: { speakerId: true },
    });
    const already = new Set(existing.map((e) => e.speakerId));
    const toCreate = validIds.filter((id) => !already.has(id));

    let created = 0;
    if (toCreate.length > 0) {
      // skipDuplicates + reading the DB's actual count: a row that lost a
      // race to a concurrent add (unique speakerId) is dropped silently, so
      // this is the honest number.
      const result = await db.speakerReimbursement.createMany({
        data: toCreate.map((speakerId) => ({
          eventId,
          speakerId,
          token: generateReimbursementToken(),
          createdById: session.user.id,
        })),
        skipDuplicates: true,
      });
      created = result.count;
    }

    db.auditLog
      .create({
        data: {
          eventId,
          userId: session.user.id,
          action: "CREATE",
          entityType: "SPEAKER_REIMBURSEMENT",
          entityId: `bulk:${created}`,
          changes: {
            created,
            skippedExisting: validIds.length - toCreate.length,
            droppedForeign: parsed.data.speakerIds.length - validIds.length,
            bulk: true,
          },
        },
      })
      .catch((err) => apiLogger.error({ err }, "reimbursements:audit-failed"));

    apiLogger.info(
      { eventId, userId: session.user.id, created, skipped: validIds.length - toCreate.length },
      "reimbursements:invites-created",
    );
    return NextResponse.json(
      { created, skipped: validIds.length - toCreate.length },
      { status: 201 },
    );
  } catch (err) {
    apiLogger.error({ err }, "reimbursements:add-failed");
    return NextResponse.json({ error: "Failed to create reimbursement invites" }, { status: 500 });
  }
}
