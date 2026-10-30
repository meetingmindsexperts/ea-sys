/**
 * The venue's own drawing, to trace the floor plan over (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md,
 * section 10, phase B).
 *
 *   POST multipart { file }   store one drawing (PNG, JPEG or WebP, 10 MB; the editor turns a PDF into
 *                             an image first) and return its stored path. The plan records which
 *                             drawing goes under which floor when it is saved (PUT /venue).
 *   GET  ?path=<stored path>  stream it back.
 *
 * Guards: the venue module (404 while off), session, the organisation, `events.update` to upload and `events.read` to view, the event looked
 * up through the gate's eventWhere, 30 uploads an hour per person, the type from the file's first bytes
 * (never its name), the size cap. The file lives under the PRIVATE `venue-drawings/{eventId}/` prefix (it
 * is often the hotel's drawing), so the GET serves only a path inside this event's own folder, and only to
 * someone who can see the event. Every refusal logs.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { isVenueModuleEnabled } from "@/lib/module-flags";
import { requireOrgId } from "@/lib/require-org";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { runWithTenant } from "@/lib/tenant-context";
import { readStoredFile, uploadFile } from "@/lib/storage";
import { StorageError } from "@/lib/storage-errors";
import { UPLOAD_SEGMENT } from "@/lib/upload-prefixes";
import { MAX_DRAWING_BYTES, drawingFolder, sniffDrawing } from "@/lib/venue/underlay";

type RouteParams = { params: Promise<{ eventId: string }> };

const UPLOADS_PER_HOUR = 30;

const TYPE_OF: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
/** What the upload names a drawing; nothing else in the folder is ever served. */
const STORED_NAME = /^[0-9a-f-]{36}\.(png|jpg|webp)$/;

export async function POST(req: Request, { params }: RouteParams) {
  const ROUTE = "events/[eventId]/venue/drawing:POST";
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    // Dark with the rest of the venue while the module is off.
    if (!isVenueModuleEnabled()) {
      apiLogger.warn({ eventId }, "venue-drawing:module-off");
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!session?.user) {
      apiLogger.warn({ eventId }, "venue-drawing:unauthorized");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "events.update", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    const rl = checkRateLimit({ key: `venue-drawing-upload:${session.user.id}`, limit: UPLOADS_PER_HOUR, windowMs: 3600_000 });
    if (!rl.allowed) return rateLimited(rl, { route: ROUTE, eventId, userId: session.user.id, limit: UPLOADS_PER_HOUR, windowSeconds: 3600 });

    return await runWithTenant(orgGuard.orgId, async () => {
      const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true } });
      if (!event) {
        apiLogger.warn({ eventId, userId: session.user.id }, "venue-drawing:event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const formData = await req.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        apiLogger.warn({ eventId, userId: session.user.id }, "venue-drawing:no-file");
        return NextResponse.json({ error: "No file provided", code: "NO_FILE" }, { status: 400 });
      }
      if (file.size > MAX_DRAWING_BYTES) {
        apiLogger.warn({ eventId, size: file.size }, "venue-drawing:too-large");
        return NextResponse.json({ error: "The drawing is over 10 MB. Save it smaller, or as a PDF, and try again.", code: "TOO_LARGE" }, { status: 400 });
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      const type = sniffDrawing(buffer);
      if (!type) {
        apiLogger.warn({ eventId, name: file.name, claimedType: file.type }, "venue-drawing:unsupported-type");
        return NextResponse.json({ error: "The drawing must be a PDF, PNG, JPEG or WebP file.", code: "UNSUPPORTED_TYPE" }, { status: 400 });
      }
      const path = await uploadFile(buffer, `${randomUUID()}.${type.ext}`, type.contentType, `${UPLOAD_SEGMENT.venueDrawings}/${event.id}`);
      apiLogger.info({ eventId, userId: session.user.id, path, bytes: buffer.length }, "venue-drawing:uploaded");
      return NextResponse.json({ path });
    });
  } catch (err) {
    apiLogger.error({ err, route: ROUTE }, "venue-drawing:upload-failed");
    return NextResponse.json({ error: "Couldn't store the drawing" }, { status: 500 });
  }
}

export async function GET(req: Request, { params }: RouteParams) {
  const ROUTE = "events/[eventId]/venue/drawing:GET";
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    // Dark with the rest of the venue while the module is off.
    if (!isVenueModuleEnabled()) {
      apiLogger.warn({ eventId }, "venue-drawing:module-off");
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!session?.user) {
      apiLogger.warn({ eventId }, "venue-drawing:unauthorized");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "events.read", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    const path = new URL(req.url).searchParams.get("path") ?? "";
    const folder = drawingFolder(eventId);
    // Only a drawing this event's upload named, in this event's own folder: no other event's, nothing else.
    if (!path.startsWith(folder) || !STORED_NAME.test(path.slice(folder.length))) {
      apiLogger.warn({ eventId, userId: session.user.id, path: path.slice(0, 200) }, "venue-drawing:path-refused");
      return NextResponse.json({ error: "Drawing not found" }, { status: 404 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true } });
      if (!event) {
        apiLogger.warn({ eventId, userId: session.user.id }, "venue-drawing:event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      let bytes: Buffer;
      try {
        bytes = await readStoredFile(path, folder);
      } catch (err) {
        if (err instanceof StorageError) {
          apiLogger.warn({ eventId, path, reason: err.reason }, "venue-drawing:file-missing");
          return NextResponse.json({ error: "Drawing not found" }, { status: 404 });
        }
        throw err;
      }
      const ext = path.split(".").pop() ?? "png";
      return new NextResponse(new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength), {
        status: 200,
        headers: {
          "Content-Type": TYPE_OF[ext] ?? "application/octet-stream",
          "Content-Length": String(bytes.length),
          // The name is a fresh uuid per upload, so the bytes behind a path never change.
          "Cache-Control": "private, max-age=86400, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    });
  } catch (err) {
    apiLogger.error({ err, route: ROUTE }, "venue-drawing:read-failed");
    return NextResponse.json({ error: "Couldn't read the drawing" }, { status: 500 });
  }
}
