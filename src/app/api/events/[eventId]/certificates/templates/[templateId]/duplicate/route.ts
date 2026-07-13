/**
 * POST /api/events/[eventId]/certificates/templates/[templateId]/duplicate
 *
 * Clones a CertificateTemplate row + its background PDF file. The clone
 * lands in the same category with `" (copy)"` appended to the name and
 * `sortOrder = max+1` so it shows up at the end of the same category
 * group in the templates list.
 *
 * Background PDF is COPIED on disk (per organizer's preference) rather
 * than referenced via the same URL — so editing the clone's background
 * doesn't affect the original, and deleting the original doesn't break
 * the clone. The copy uses a fresh UUID filename under the same
 * `certificates/{eventId}/` subdir that the upload endpoint writes to.
 *
 * Auth + RBAC mirrors the templates PATCH/DELETE route: denyReviewer +
 * org-binding 404 on cross-tenant.
 *
 * Why not just clone the row and share the file URL: see organizer's
 * stated preference — if they replace the background on one template,
 * they don't want it flowing through to the other. Disk cost is bounded
 * (a cert background is typically <2 MB and templates rarely number in
 * the hundreds per org), so the duplication overhead is acceptable.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { denyReviewer } from "@/lib/auth-guards";
import { apiLogger } from "@/lib/logger";
import { uploadCertificatePdf } from "@/lib/storage";
import { loadCertificatePdfBytes } from "@/lib/certificates/pdf-loader";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";

interface RouteParams {
  params: Promise<{ eventId: string; templateId: string }>;
}

/**
 * Pull the source background PDF into memory. Two paths:
 *   - URL starts with `/uploads/...` (local storage provider) → read
 *     from disk under `public/${url}`. Avoids an internal HTTP loop and
 *     works without NEXT_PUBLIC_APP_URL being set in dev.
 *   - Otherwise (Supabase or any absolute URL) → fetch over HTTP and
 *     buffer the response.
 *
 * Returns null on miss/error so the caller can decide whether to fail
 * the duplicate (today: yes — if the operator uploaded a background and
 * it's gone, the clone would be broken silently).
 */
async function fetchBackgroundBuffer(url: string, eventId: string): Promise<Buffer | null> {
  // Route through the GUARDED shared loader (path-traversal + https/host
  // allowlist + timeout). This helper used to carry its own unguarded
  // readFile/fetch copy — combined with the world-readable URL the clone
  // stores, that made a malicious backgroundPdfUrl a full local-file-read /
  // SSRF exfiltration channel. Loader rejections surface as the same
  // null → 409 BACKGROUND_PDF_MISSING the caller already handles.
  try {
    return await loadCertificatePdfBytes(url, { eventId });
  } catch (e) {
    apiLogger.warn({ msg: "cert-templates:duplicate-read-failed", url, err: String(e) });
    return null;
  }
}

export async function POST(_req: Request, { params }: RouteParams) {
  let eventId: string | undefined;
  let templateId: string | undefined;
  try {
    const [session, p] = await Promise.all([auth(), params]);
    eventId = p.eventId;
    templateId = p.templateId;
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const denied = denyReviewer(session);
    if (denied) return denied;
    if (!session.user.organizationId) {
      apiLogger.warn({
        msg: "cert-templates:duplicate-no-org",
        userId: session.user.id,
      });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Load the source — bind to org via the event relation. 404 (not 403)
    // for cross-tenant to avoid enumeration, same pattern as PATCH/DELETE.
    const source = await db.certificateTemplate.findFirst({
      where: {
        id: templateId,
        event: { organizationId: session.user.organizationId },
      },
    });
    if (!source || source.eventId !== eventId) {
      apiLogger.warn({
        msg: "cert-templates:duplicate-not-found-or-cross-tenant",
        eventId,
        userId: session.user.id,
        templateId,
      });
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    // Copy the background PDF file on disk if one is set. We do this
    // BEFORE the transaction — if the source file is missing or the
    // upload fails, fail the whole operation cleanly without leaving a
    // half-cloned row with a broken backgroundPdfUrl pointer.
    let newBackgroundUrl: string | null = source.backgroundPdfUrl;
    if (source.backgroundPdfUrl) {
      const buf = await fetchBackgroundBuffer(source.backgroundPdfUrl, eventId);
      if (!buf) {
        return NextResponse.json(
          {
            error:
              "Source template's background PDF could not be read (it may have been removed or is on a different machine). Re-upload the background on the source template before duplicating.",
            code: "BACKGROUND_PDF_MISSING",
          },
          { status: 409 },
        );
      }
      const filename = `${randomUUID()}.pdf`;
      newBackgroundUrl = await uploadCertificatePdf(buf, filename, eventId);
    }

    // sortOrder = max+1 in the same category — same logic as POST on the
    // collection. Inside a transaction so two concurrent duplicates of
    // templates in the same category can't both land at the same index.
    const eventIdLocked = eventId;
    const newName = `${source.name} (copy)`;
    const clone = await db.$transaction(async (tx) => {
      const maxOrder = await tx.certificateTemplate.aggregate({
        where: { eventId: eventIdLocked, category: source.category },
        _max: { sortOrder: true },
      });
      const nextOrder = (maxOrder._max.sortOrder ?? -1) + 1;
      return tx.certificateTemplate.create({
        data: {
          eventId: eventIdLocked,
          name: newName,
          category: source.category,
          backgroundPdfUrl: newBackgroundUrl,
          // textBoxes is JSON — Prisma needs a deep-cloned plain value.
          // The source row's textBoxes is read as `Prisma.JsonValue`,
          // which is structurally a JS-clonable object/array.
          textBoxes: source.textBoxes as Prisma.InputJsonValue,
          sortOrder: nextOrder,
          emailSubject: source.emailSubject,
          emailBody: source.emailBody,
        },
      });
    });

    apiLogger.info({
      msg: "cert-templates:duplicated",
      eventId,
      userId: session.user.id,
      sourceTemplateId: templateId,
      newTemplateId: clone.id,
      category: clone.category,
      backgroundCopied: source.backgroundPdfUrl !== null,
    });

    return NextResponse.json({ template: clone }, { status: 201 });
  } catch (error) {
    apiLogger.error({
      err: error,
      msg: "cert-templates:duplicate-failed",
      eventId,
      templateId,
    });
    return NextResponse.json({ error: "Failed to duplicate template" }, { status: 500 });
  }
}
