/**
 * Webinar handouts, producer side (Oct 6, 2026; docs/WEBINAR_INTERACTION_PLAN.md §4).
 *
 *   POST  multipart { file }  add one handout (PDF, PPTX or DOCX, 8 MB)
 *   PATCH { order: id[] }     reorder
 *
 * Guards: session, `webinar.manage` with the event looked up through the
 * gate's eventWhere, 60 uploads an hour per user, type from the extension and
 * checked against the file's first bytes, size cap, at most 10 handouts. The
 * file lands under the PRIVATE `webinar-handouts/{eventId}/` prefix; the list
 * in settings is written by updateHandouts under a row lock. Every refusal
 * logs.
 */
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { requireOrgId } from "@/lib/require-org";
import { requirePermission } from "@/lib/permissions/require-permission";
import { checkRateLimit } from "@/lib/security";
import { rateLimited } from "@/lib/api-errors";
import { runWithTenant } from "@/lib/tenant-context";
import { deleteStoredFile, uploadFile } from "@/lib/storage";
import { UPLOAD_SEGMENT } from "@/lib/upload-prefixes";
import {
  HANDOUT_TYPES,
  MAX_HANDOUTS,
  MAX_HANDOUT_BYTES,
  MAX_HANDOUT_MB,
  handoutBytesMatch,
  resolveHandoutType,
  sanitizeHandoutName,
  type WebinarHandout,
} from "@/lib/webinar/handouts";
import { updateHandouts } from "@/lib/webinar/handouts-store";
import { handoutFolder } from "@/lib/webinar/handout-download";

type RouteParams = { params: Promise<{ eventId: string }> };

const reorderSchema = z.object({ order: z.array(z.string().min(1).max(64)).max(MAX_HANDOUTS) });

export async function POST(req: Request, { params }: RouteParams) {
  const ROUTE = "events/[eventId]/webinar/handouts:POST";
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      apiLogger.warn({ eventId }, "webinar-handouts:unauthorized");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.manage", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    const rl = checkRateLimit({ key: `webinar-handout-upload:${session.user.id}`, limit: 60, windowMs: 3600_000 });
    if (!rl.allowed) {
      return rateLimited(rl, { route: ROUTE, eventId, userId: session.user.id, limit: 60, windowSeconds: 3600 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true, eventType: true } });
      if (!event) {
        apiLogger.warn({ eventId, userId: session.user.id }, "webinar-handouts:event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      if (event.eventType !== "WEBINAR") {
        apiLogger.warn({ eventId, eventType: event.eventType }, "webinar-handouts:not-a-webinar");
        return NextResponse.json({ error: "Handouts are for webinars only." }, { status: 400 });
      }

      const formData = await req.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        apiLogger.warn({ eventId, userId: session.user.id }, "webinar-handouts:no-file");
        return NextResponse.json({ error: "No file provided", code: "NO_FILE" }, { status: 400 });
      }
      const contentType = resolveHandoutType({ name: file.name, type: file.type });
      if (!contentType) {
        apiLogger.warn({ eventId, name: file.name, claimedType: file.type }, "webinar-handouts:unsupported-type");
        return NextResponse.json(
          { error: `"${file.name}" is not a PDF, PPTX or DOCX file.`, code: "UNSUPPORTED_TYPE" },
          { status: 400 },
        );
      }
      if (file.size > MAX_HANDOUT_BYTES) {
        apiLogger.warn({ eventId, size: file.size }, "webinar-handouts:too-large");
        return NextResponse.json(
          { error: `"${file.name}" is over the ${MAX_HANDOUT_MB} MB limit.`, code: "TOO_LARGE" },
          { status: 400 },
        );
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      if (!handoutBytesMatch(buffer, contentType)) {
        apiLogger.warn({ eventId, name: file.name, contentType }, "webinar-handouts:bytes-mismatch");
        return NextResponse.json(
          { error: `"${file.name}" does not look like a real ${HANDOUT_TYPES[contentType].toUpperCase()} file.`, code: "BYTES_MISMATCH" },
          { status: 400 },
        );
      }

      const storedPath = await uploadFile(
        buffer,
        `${randomUUID()}.${HANDOUT_TYPES[contentType]}`,
        contentType,
        `${UPLOAD_SEGMENT.webinarHandouts}/${event.id}`,
      );
      const handout: WebinarHandout = {
        id: randomUUID(),
        name: sanitizeHandoutName(file.name, contentType),
        storedPath,
        contentType,
        size: buffer.length,
        uploadedAt: new Date().toISOString(),
      };
      const removeStoredFile = () =>
        deleteStoredFile(storedPath, handoutFolder(event.id)).catch((err) =>
          apiLogger.error({ err, eventId, storedPath }, "webinar-handouts:orphan-delete-failed"),
        );
      let result: Awaited<ReturnType<typeof updateHandouts>>;
      try {
        result = await updateHandouts(event.id, (current) =>
          current.length >= MAX_HANDOUTS ? "too-many" : [...current, handout],
        );
      } catch (err) {
        // The list write failed after the file was stored: remove it again.
        apiLogger.error({ err, eventId, storedPath }, "webinar-handouts:list-write-failed");
        await removeStoredFile();
        return NextResponse.json({ error: "Failed to add the handout" }, { status: 500 });
      }
      if (!result.ok) {
        // The file was stored before the list refused it: remove it again.
        await removeStoredFile();
        apiLogger.warn({ eventId, reason: result.reason }, "webinar-handouts:add-refused");
        return NextResponse.json(
          { error: result.reason === "too-many" ? `A webinar can have up to ${MAX_HANDOUTS} handouts.` : "Event not found" },
          { status: result.reason === "too-many" ? 400 : 404 },
        );
      }
      apiLogger.info({ eventId, handoutId: handout.id, size: handout.size, contentType, userId: session.user.id }, "webinar-handouts:added");
      return NextResponse.json({ handouts: result.handouts }, { status: 201 });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-handouts:add-failed");
    return NextResponse.json({ error: "Failed to add the handout" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const ROUTE = "events/[eventId]/webinar/handouts:PATCH";
  try {
    const [session, { eventId }, body] = await Promise.all([auth(), params, req.json().catch(() => ({}))]);
    if (!session?.user) {
      apiLogger.warn({ eventId }, "webinar-handouts:unauthorized");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const orgGuard = requireOrgId(session, { route: ROUTE });
    if ("error" in orgGuard) return orgGuard.error;
    const gate = requirePermission(session, "webinar.manage", { route: ROUTE, eventId });
    if (!gate.ok) return gate.response;

    const parsed = reorderSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ errors: parsed.error.flatten() }, "webinar-handouts:reorder-validation-failed");
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }

    return await runWithTenant(orgGuard.orgId, async () => {
      const event = await db.event.findFirst({ where: gate.eventWhere, select: { id: true } });
      if (!event) {
        apiLogger.warn({ eventId, userId: session.user.id }, "webinar-handouts:event-not-found");
        return NextResponse.json({ error: "Event not found" }, { status: 404 });
      }
      const order = parsed.data.order;
      const result = await updateHandouts(event.id, (current) => {
        // The order must name exactly the current handouts, once each.
        const same = order.length === current.length && new Set(order).size === order.length && current.every((h) => order.includes(h.id));
        if (!same) return "order-mismatch";
        return order.map((id) => current.find((h) => h.id === id)!);
      });
      if (!result.ok) {
        apiLogger.warn({ eventId, reason: result.reason }, "webinar-handouts:reorder-refused");
        return NextResponse.json(
          { error: result.reason === "order-mismatch" ? "The handout list changed. Refresh and try again." : "Event not found" },
          { status: result.reason === "order-mismatch" ? 409 : 404 },
        );
      }
      apiLogger.info({ eventId, userId: session.user.id }, "webinar-handouts:reordered");
      return NextResponse.json({ handouts: result.handouts });
    });
  } catch (error) {
    apiLogger.error({ err: error }, "webinar-handouts:reorder-failed");
    return NextResponse.json({ error: "Failed to reorder the handouts" }, { status: 500 });
  }
}
