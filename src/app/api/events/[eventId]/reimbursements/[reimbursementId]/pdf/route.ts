/**
 * Speaker reimbursement — the submitted claim as a PDF (organizer download).
 *
 * Rendered on demand and never stored (owner, Sep 15, 2026), so the file always
 * matches the submission and no copy of the bank details is left behind. Only a
 * SUBMITTED form prints: a PENDING one is either not filled in yet or was
 * reopened for edits, and the console already tells finance not to process a
 * reopened form until it comes back.
 *
 * ACCESS: denyReviewer with no allow-list, the reimbursement boundary
 * (SUPER_ADMIN / ADMIN / ORGANIZER), and the event through buildEventAccessWhere.
 * Every download is recorded as an export, because the document carries a
 * passport number and full bank details.
 */
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { recordExport } from "@/lib/audit-data-transfer";
import { reimbursementPdfFilename } from "@/lib/reimbursement/constants";
import { generateReimbursementPdf, readClaimLines } from "@/lib/reimbursement/reimbursement-pdf";

type RouteParams = { params: Promise<{ eventId: string; reimbursementId: string }> };

const ROUTE = "events/[eventId]/reimbursements/[reimbursementId]/pdf:GET";
const PDF_LIMIT_PER_HOUR = 60;

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, reimbursementId }] = await Promise.all([auth(), params]);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session, { route: ROUTE });
    if (denied) return denied;

    const rl = checkRateLimit({
      key: `reimbursement-pdf:${session.user.id}`,
      limit: PDF_LIMIT_PER_HOUR,
      windowMs: 3600_000,
    });
    if (!rl.allowed) {
      return rateLimited(rl, {
        route: ROUTE,
        userId: session.user.id,
        eventId,
        limit: PDF_LIMIT_PER_HOUR,
        windowSeconds: 3600,
      });
    }

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: {
        id: true,
        name: true,
        startDate: true,
        endDate: true,
        venue: true,
        city: true,
        organizationId: true,
        organization: {
          select: {
            name: true,
            logo: true,
            companyName: true,
            companyAddress: true,
            companyCity: true,
            companyState: true,
            companyZipCode: true,
            companyCountry: true,
            taxId: true,
          },
        },
      },
    });
    if (!event) {
      apiLogger.warn({ eventId, reimbursementId, userId: session.user.id }, "reimbursement-pdf:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Bound through the event, read in the resource org (Domain #17).
    const row = await runWithTenant(event.organizationId, () =>
      db.speakerReimbursement.findFirst({
        where: { id: reimbursementId, eventId },
        select: {
          id: true,
          status: true,
          fullName: true,
          designation: true,
          institution: true,
          country: true,
          email: true,
          phone: true,
          nationality: true,
          passportNumber: true,
          roleAtEvent: true,
          claimLines: true,
          bankDetails: true,
          signedName: true,
          submittedAt: true,
          documents: {
            select: { kind: true, filename: true, size: true },
            orderBy: { createdAt: "asc" },
          },
        },
      }),
    );
    if (!row) {
      apiLogger.warn({ eventId, reimbursementId, userId: session.user.id }, "reimbursement-pdf:not-found");
      return NextResponse.json({ error: "Reimbursement not found" }, { status: 404 });
    }
    if (row.status !== "SUBMITTED") {
      apiLogger.warn(
        { eventId, reimbursementId, status: row.status, userId: session.user.id },
        "reimbursement-pdf:not-submitted",
      );
      return NextResponse.json(
        {
          error: "This form has not been submitted, or was reopened for edits, so there is no claim to print yet.",
          code: "NOT_SUBMITTED",
        },
        { status: 409 },
      );
    }

    const { dropped } = readClaimLines(row.claimLines);
    if (dropped > 0) {
      apiLogger.warn({ eventId, reimbursementId, dropped }, "reimbursement-pdf:claim-lines-unreadable");
    }

    const pdf = await generateReimbursementPdf({
      reimbursementId: row.id,
      generatedAt: new Date(),
      organization: event.organization,
      event: {
        name: event.name,
        startDate: event.startDate,
        endDate: event.endDate,
        venue: event.venue,
        city: event.city,
      },
      speaker: {
        fullName: row.fullName,
        designation: row.designation,
        institution: row.institution,
        country: row.country,
        email: row.email,
        phone: row.phone,
        nationality: row.nationality,
        passportNumber: row.passportNumber,
        roleAtEvent: row.roleAtEvent,
      },
      claimLines: row.claimLines,
      bankDetails: row.bankDetails,
      documents: row.documents,
      signedName: row.signedName,
      submittedAt: row.submittedAt,
    });

    recordExport(req, {
      entityType: "SpeakerReimbursement",
      eventId,
      organizationId: event.organizationId,
      userId: session.user.id,
      role: session.user.role,
      rowCount: 1,
      format: "pdf",
      filters: { reimbursementId },
    });
    apiLogger.info(
      { eventId, reimbursementId, userId: session.user.id, bytes: pdf.length },
      "reimbursement-pdf:generated",
    );

    const filename = reimbursementPdfFilename(event.name, row.fullName);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    apiLogger.error({ err }, "reimbursement-pdf:failed");
    return NextResponse.json({ error: "Failed to generate the PDF" }, { status: 500 });
  }
}
