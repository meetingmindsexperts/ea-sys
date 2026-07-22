/**
 * GET /api/events/[eventId]/certificates/runs/[runId]/download
 *
 * "Download all certificates" for one issue run, as a single ZIP — one PDF
 * per certificate, entry names `{serial} - {recipientName}.pdf`. Built for
 * the organizer who issues in bulk and hands certificates over personally
 * instead of (or before) emailing them.
 *
 * Follows the invoices ZIP-export pattern (src/app/api/.../invoices/export):
 * jszip in-memory with hard caps — NOT a second zip mechanism. Caps:
 *   - MAX_ZIP_CERTS certs per export (memory bound; a run bigger than this
 *     gets a clear 400, never a silently truncated archive)
 *   - MAX_ZIP_BYTES accumulated PDF bytes (background-PDF-heavy templates
 *     can make individual certs large)
 *
 * The cert set is collected per run item via the SAME collectRunItemCertRows
 * the worker's send phase uses, so "what the zip contains" can never drift
 * from "what the emails would attach". Available from AWAITING_REVIEW onward
 * (certs are fully rendered before the email phase) including FAILED /
 * CANCELLED runs (their already-rendered certs are still real).
 *
 * Auth: ADMIN / ORGANIZER (denyReviewer). Org-bound. 20/hr/user rate limit.
 */

import { NextResponse } from "next/server";
import JSZip from "jszip";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security";
import { collectRunItemCertRows } from "@/lib/certificates/bundle";
import { loadCertificatePdfBytes } from "@/lib/certificates/pdf-loader";
import { certZipEntryName } from "@/lib/certificates/zip";

interface RouteParams {
  params: Promise<{ eventId: string; runId: string }>;
}

const MAX_ZIP_CERTS = 500;
const MAX_ZIP_BYTES = 300 * 1024 * 1024; // 300 MB of raw PDF bytes

export async function GET(_req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  let runId: string | undefined;
  try {
    const [session, p] = await Promise.all([auth(), params]);
    eventId = p.eventId;
    runId = p.runId;
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      apiLogger.warn({ msg: "cert-run-download:no-org", userId: session.user.id, eventId, runId });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const rl = checkRateLimit({
      key: `cert-run-download:${session.user.id}`,
      limit: 20,
      windowMs: 60 * 60 * 1000,
    });
    if (!rl.allowed) {
      apiLogger.warn({
        msg: "cert-run-download:rate-limited",
        userId: session.user.id,
        eventId,
        runId,
        retryAfterSeconds: rl.retryAfterSeconds,
      });
      return NextResponse.json(
        { error: "Too many downloads. Try again later.", code: "RATE_LIMITED", retryAfterSeconds: rl.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
      );
    }

    const run = await db.certificateIssueRun.findFirst({
      where: { id: runId, eventId, event: { organizationId: session.user.organizationId } },
      select: {
        id: true,
        status: true,
        templateIds: true,
        certificateTemplateId: true,
        event: { select: { code: true } },
      },
    });
    if (!run) {
      apiLogger.warn({ msg: "cert-run-download:not-found", eventId, runId, userId: session.user.id });
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }
    if (run.status === "PENDING" || run.status === "RENDERING") {
      apiLogger.warn({ msg: "cert-run-download:not-rendered", eventId, runId, status: run.status });
      return NextResponse.json(
        {
          error: "Certificates are still rendering — try again once the run reaches review.",
          code: "NOT_RENDERED",
          currentStatus: run.status,
        },
        { status: 409 },
      );
    }

    const items = await db.certificateIssueRunItem.findMany({
      where: { runId, renderedAt: { not: null } },
      select: {
        registrationId: true,
        speakerId: true,
        templateIds: true,
        issuedCertificateId: true,
        recipientName: true,
      },
    });
    const runTemplateIds = run.templateIds.length
      ? run.templateIds
      : run.certificateTemplateId
        ? [run.certificateTemplateId]
        : [];

    // Resolve every item's cert rows first so the count cap applies to the
    // real cert total (an item can carry several certs in the bundle model).
    const entries: Array<{ pdfUrl: string; serial: string; recipientName: string }> = [];
    for (const item of items) {
      const rows = await collectRunItemCertRows({ eventId, runTemplateIds, item });
      for (const row of rows) {
        if (!row.pdfUrl) continue; // render-failed leftovers — nothing to include
        entries.push({ pdfUrl: row.pdfUrl, serial: row.serial, recipientName: item.recipientName });
      }
    }

    if (entries.length === 0) {
      apiLogger.warn({ msg: "cert-run-download:no-certs", eventId, runId });
      return NextResponse.json(
        { error: "This run has no rendered certificates to download yet.", code: "NO_RENDERED_CERTS" },
        { status: 409 },
      );
    }
    if (entries.length > MAX_ZIP_CERTS) {
      apiLogger.warn({ msg: "cert-run-download:too-large", eventId, runId, certCount: entries.length });
      return NextResponse.json(
        {
          error: `Too many certificates to zip at once (${entries.length}, max ${MAX_ZIP_CERTS}). Download individual certificates from each person's card instead.`,
          code: "EXPORT_TOO_LARGE",
        },
        { status: 400 },
      );
    }

    const zip = new JSZip();
    const usedNames = new Set<string>();
    let ok = 0;
    let failed = 0;
    let totalBytes = 0;

    for (const entry of entries) {
      try {
        const bytes = await loadCertificatePdfBytes(entry.pdfUrl, { eventId, runId });
        totalBytes += bytes.length;
        if (totalBytes > MAX_ZIP_BYTES) {
          apiLogger.warn({ msg: "cert-run-download:byte-budget-exceeded", eventId, runId, totalBytes, ok });
          return NextResponse.json(
            {
              error: "The combined certificate PDFs are too large to zip in one download.",
              code: "EXPORT_TOO_LARGE",
            },
            { status: 400 },
          );
        }
        zip.file(certZipEntryName(entry.serial, entry.recipientName, usedNames), bytes);
        ok++;
      } catch (err) {
        // One unreadable PDF must not sink the whole export — mirror the
        // invoices export: count it, log it, keep going.
        failed++;
        apiLogger.warn({ msg: "cert-run-download:pdf-load-failed", eventId, runId, serial: entry.serial, err });
      }
    }

    if (ok === 0) {
      apiLogger.error({ msg: "cert-run-download:all-pdfs-failed", eventId, runId, failed });
      return NextResponse.json({ error: "Failed to load any certificate PDFs." }, { status: 500 });
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    apiLogger.info({
      msg: "cert-run-download:zip",
      eventId,
      runId,
      certCount: ok,
      failed,
      totalBytes,
      userId: session.user.id,
    });

    const filename = `certificates-${run.event.code || eventId}-${runId.slice(0, 8)}.zip`;
    return new NextResponse(new Uint8Array(zipBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, max-age=0",
      },
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "cert-run-download:failed", eventId, runId });
    return NextResponse.json({ error: "Failed to build the certificates ZIP" }, { status: 500 });
  }
}
