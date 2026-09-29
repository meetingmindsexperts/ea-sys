/**
 * Shared submission views, the organiser side (Sep 29, 2026;
 * docs/SUBMISSION_SHARE_PLAN.md).
 *
 *   GET  → the event's two links (abstracts, session proposals), each with its
 *          settings and public path, or the defaults when none exists yet.
 *   PUT  { kind, enabled, statuses, fields } → create the link on first save
 *          (token minted), update it after.
 *   POST { kind, action: "regenerate" } → a new token; the old link dies at once.
 *
 * The same boundary as the CSV export: denyReviewer (admins and organisers),
 * the event resolved through buildEventAccessWhere. Every change is audited,
 * and switching a contact field ON is logged at warn so there is a trail of
 * who published contact details.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { SubmissionShareLink } from "@prisma/client";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { runWithTenant } from "@/lib/tenant-context";
import { resolveShareEvent, userNames } from "@/lib/share-link-access";
import { newShareToken } from "@/lib/share-token";
import {
  SHARE_KINDS,
  contactFieldKeys,
  defaultShareConfig,
  sharePath,
  validateShareConfig,
  type ShareKind,
} from "@/lib/submission-share";

interface RouteParams {
  params: Promise<{ eventId: string }>;
}

const kindSchema = z.enum(["ABSTRACTS", "SESSION_PROPOSALS"]);

const putSchema = z.object({
  kind: kindSchema,
  enabled: z.boolean(),
  statuses: z.array(z.string().max(40)).max(20),
  fields: z.array(z.string().max(40)).max(40),
});

const postSchema = z.object({
  kind: kindSchema,
  action: z.literal("regenerate"),
});

type LinkView = {
  kind: ShareKind;
  exists: boolean;
  enabled: boolean;
  statuses: string[];
  fields: string[];
  path: string | null;
  updatedAt: string | null;
  updatedByName: string | null;
};

function toView(kind: ShareKind, slug: string, link: SubmissionShareLink | undefined, names: Map<string, string>): LinkView {
  if (!link) {
    return { kind, exists: false, enabled: false, ...defaultShareConfig(kind), path: null, updatedAt: null, updatedByName: null };
  }
  return {
    kind,
    exists: true,
    enabled: link.enabled,
    statuses: link.statuses,
    fields: link.fields,
    path: sharePath(slug, link.token),
    updatedAt: link.updatedAt.toISOString(),
    updatedByName: names.get(link.updatedById) ?? null,
  };
}

async function listViews(eventId: string, slug: string): Promise<LinkView[]> {
  const links = await db.submissionShareLink.findMany({ where: { eventId } });
  const names = await userNames(links.map((l) => l.updatedById));
  return SHARE_KINDS.map((k) => toView(k, slug, links.find((l) => l.kind === k), names));
}

export async function GET(_req: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { eventId } = await params;
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session, { route: "events/[eventId]/submission-shares:GET", eventId });
    if (denied) return denied;
    const r = await resolveShareEvent(session, "events/[eventId]/submission-shares:GET", eventId);
    if (r.error) return r.error;
    return await runWithTenant(r.event.organizationId, async () => {
      const links = await listViews(r.event.id, r.event.slug);
      return NextResponse.json({ links }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "submission-shares:get-failed" });
    return NextResponse.json({ error: "Failed to load shared links" }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const [{ eventId }, body] = await Promise.all([params, req.json().catch(() => null)]);
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session, { route: "events/[eventId]/submission-shares:PUT", eventId });
    if (denied) return denied;
    const r = await resolveShareEvent(session, "events/[eventId]/submission-shares:PUT", eventId);
    if (r.error) return r.error;

    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "submission-shares:invalid-input", eventId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const { kind, enabled } = parsed.data;
    const checked = validateShareConfig(kind, parsed.data);
    if (!checked.ok) {
      apiLogger.warn({ msg: "submission-shares:invalid-config", eventId, kind, code: checked.code });
      return NextResponse.json({ error: checked.message, code: checked.code }, { status: 400 });
    }

    const userId = session.user.id;
    return await runWithTenant(r.event.organizationId, async () => {
      const before = await db.submissionShareLink.findUnique({ where: { eventId_kind: { eventId: r.event.id, kind } } });
      const link = before
        ? await db.submissionShareLink.update({
            where: { id: before.id },
            data: { enabled, statuses: checked.statuses, fields: checked.fields, updatedById: userId },
          })
        : await db.submissionShareLink.create({
            data: {
              eventId: r.event.id,
              organizationId: r.event.organizationId,
              kind,
              token: newShareToken(),
              enabled,
              statuses: checked.statuses,
              fields: checked.fields,
              createdById: userId,
              updatedById: userId,
            },
          });

      const contact = contactFieldKeys(kind);
      const contactNowOn = checked.fields.filter((f) => contact.includes(f));
      const contactAdded = contactNowOn.filter((f) => !before?.fields.includes(f));
      if (contactAdded.length > 0) {
        // Owner ruling D3: allowed, but never quietly. This is the trail.
        apiLogger.warn({ msg: "submission-shares:contact-fields-enabled", eventId, kind, userId, fields: contactAdded, enabled });
      }

      await db.auditLog.create({
        data: {
          eventId: r.event.id,
          organizationId: r.event.organizationId,
          userId,
          action: before ? "SUBMISSION_SHARE_UPDATED" : "SUBMISSION_SHARE_CREATED",
          entityType: "SubmissionShareLink",
          entityId: link.id,
          changes: {
            kind,
            before: before ? { enabled: before.enabled, statuses: before.statuses, fields: before.fields } : null,
            after: { enabled, statuses: checked.statuses, fields: checked.fields },
            contactFieldsShown: contactNowOn,
            source: "rest",
          },
        },
      });
      apiLogger.info({ msg: "submission-shares:saved", eventId, kind, enabled, created: !before, userId });

      const links = await listViews(r.event.id, r.event.slug);
      return NextResponse.json({ links });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "submission-shares:put-failed" });
    return NextResponse.json({ error: "Failed to save the shared link" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const [{ eventId }, body] = await Promise.all([params, req.json().catch(() => null)]);
    const session = await auth();
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const denied = denyReviewer(session, { route: "events/[eventId]/submission-shares:POST", eventId });
    if (denied) return denied;
    const r = await resolveShareEvent(session, "events/[eventId]/submission-shares:POST", eventId);
    if (r.error) return r.error;

    const parsed = postSchema.safeParse(body);
    if (!parsed.success) {
      apiLogger.warn({ msg: "submission-shares:invalid-input", eventId, errors: parsed.error.flatten() });
      return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
    }
    const { kind } = parsed.data;
    const userId = session.user.id;

    return await runWithTenant(r.event.organizationId, async () => {
      const existing = await db.submissionShareLink.findUnique({ where: { eventId_kind: { eventId: r.event.id, kind } } });
      if (!existing) {
        apiLogger.warn({ msg: "submission-shares:regenerate-no-link", eventId, kind, userId });
        return NextResponse.json({ error: "There is no link to regenerate yet. Save one first.", code: "NO_LINK" }, { status: 404 });
      }
      await db.submissionShareLink.update({ where: { id: existing.id }, data: { token: newShareToken(), updatedById: userId } });
      await db.auditLog.create({
        data: {
          eventId: r.event.id,
          organizationId: r.event.organizationId,
          userId,
          action: "SUBMISSION_SHARE_REGENERATED",
          entityType: "SubmissionShareLink",
          entityId: existing.id,
          changes: { kind, source: "rest" },
        },
      });
      apiLogger.info({ msg: "submission-shares:regenerated", eventId, kind, userId });
      const links = await listViews(r.event.id, r.event.slug);
      return NextResponse.json({ links });
    });
  } catch (error) {
    apiLogger.error({ err: error, msg: "submission-shares:post-failed" });
    return NextResponse.json({ error: "Failed to regenerate the link" }, { status: 500 });
  }
}
