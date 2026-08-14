/**
 * Resident/trainee official letter — authed staff file stream.
 *
 * /uploads/resident-letters/ is BLOCKED on the public catch-all, so this is the
 * only way to read one. Mirrors the speaker-document file route: registration
 * bound to the event via buildEventAccessWhere, then the on-disk path verified
 * to sit inside public/uploads/resident-letters/ before the read.
 *
 * The stored column is validated on the way IN (`isSupportingDocumentPath` in the
 * register POST), and re-validated here. Both, deliberately: the column is
 * written from an attacker-controlled form field, and a read path that trusts
 * the database is one bad write away from arbitrary file disclosure.
 */
import { NextResponse } from "next/server";
import { readFile, realpath } from "fs/promises";
import path from "path";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { runWithTenant } from "@/lib/tenant-context";
import { apiLogger } from "@/lib/logger";
import { denyReviewer, REGISTRATION_DESK_ALLOW } from "@/lib/auth-guards";
import { buildEventAccessWhere } from "@/lib/event-access";
import { SUPPORTING_DOCUMENT_PATH_PREFIX, isSupportingDocumentPath } from "@/lib/supporting-document";

type RouteParams = {
  params: Promise<{ eventId: string; registrationId: string }>;
};

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  png: "image/png",
};

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId, registrationId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      apiLogger.warn({ eventId, registrationId }, "supporting-document-file:unauthenticated");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Desk staff verify the letter at the registration desk, so the same
    // allow-list that lets them check someone in lets them read it.
    const denied = denyReviewer(session, { allow: REGISTRATION_DESK_ALLOW });
    if (denied) return denied;

    const event = await db.event.findFirst({
      where: buildEventAccessWhere(session.user, eventId),
      select: { id: true, organizationId: true },
    });
    if (!event) {
      apiLogger.warn({ eventId, registrationId, userId: session.user.id }, "supporting-document-file:event-not-found");
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    const registration = await runWithTenant(event.organizationId, () =>
      db.registration.findFirst({
        where: { id: registrationId, eventId },
        select: { supportingDocumentUrl: true, supportingDocumentFilename: true },
      }),
    );
    if (!registration?.supportingDocumentUrl) {
      apiLogger.warn({ eventId, registrationId, userId: session.user.id }, "supporting-document-file:not-found");
      return NextResponse.json({ error: "No document on file" }, { status: 404 });
    }

    const url = registration.supportingDocumentUrl;
    // The path's {eventId} segment must be THIS event's. isSupportingDocumentPath
    // validates the SHAPE of that segment and never its ownership, so a value
    // written by some other path (or a future one) could point at another
    // event's directory — another TENANT's, on the platform instance, where all
    // events share one uploads volume. Checked here as well as on write,
    // because the whole premise of validating on the way out is that the read
    // side never has to trust the column.
    if (!url.startsWith(`${SUPPORTING_DOCUMENT_PATH_PREFIX}${eventId}/`)) {
      apiLogger.error({ eventId, registrationId, url }, "supporting-document-file:event-mismatch");
      return NextResponse.json({ error: "No document on file" }, { status: 404 });
    }
    if (!isSupportingDocumentPath(url)) {
      // Only reachable if something wrote the column without going through the
      // register POST's validation. Loud, because that is a bug worth finding.
      apiLogger.error({ eventId, registrationId, url }, "supporting-document-file:url-outside-root");
      return NextResponse.json({ error: "No document on file" }, { status: 404 });
    }

    const allowedRoot = path.resolve(process.cwd(), "public", SUPPORTING_DOCUMENT_PATH_PREFIX.slice(1));
    const abs = path.resolve(process.cwd(), "public", url.slice(1));
    let resolved: string;
    try {
      resolved = await realpath(abs);
    } catch {
      apiLogger.error({ eventId, registrationId, abs }, "supporting-document-file:file-missing");
      return NextResponse.json(
        {
          error:
            "The file is missing on this server. With local storage, files uploaded on another machine are not present here.",
          code: "FILE_MISSING",
        },
        { status: 404 },
      );
    }
    // realpath resolves symlinks, so this also catches a symlink planted inside
    // the allowed directory that points outside it.
    if (!resolved.startsWith(allowedRoot + path.sep)) {
      apiLogger.warn({ eventId, registrationId, resolved }, "supporting-document-file:traversal-blocked");
      return NextResponse.json({ error: "No document on file" }, { status: 404 });
    }

    const file = await readFile(resolved);
    const ext = (url.split(".").pop() ?? "").toLowerCase();
    const safeName =
      (registration.supportingDocumentFilename ?? "supporting-document")
        .replace(/[^\w.\- ]+/g, "_")
        .slice(0, 120) || "supporting-document";
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "Content-Disposition": `inline; filename="${safeName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'",
      },
    });
  } catch (err) {
    apiLogger.error({ err }, "supporting-document-file:stream-failed");
    return NextResponse.json({ error: "Failed to load the document" }, { status: 500 });
  }
}
