import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { denyReviewer } from "@/lib/auth-guards";
import { checkRateLimit } from "@/lib/security";
import { readSponsors, SPONSOR_TIERS, type SponsorEntry } from "@/lib/webinar";

type RouteParams = { params: Promise<{ eventId: string }> };

// ── Zod schema ─────────────────────────────────────────────────────
// PUT replaces the entire array — simpler than row-level CRUD and a
// good fit for a JSON settings field. The whole array is ~tens of rows
// at most, so shipping it whole costs nothing.

// Logo URLs can be either http(s):// (external CDN, Supabase Storage) or a
// relative /uploads/... path produced by the local file-storage provider.
// Reject anything else to prevent javascript: / data: URLs from landing
// on the public page.
const logoUrlSchema = z
  .string()
  .max(2000)
  .refine(
    (v) => v === "" || v.startsWith("http://") || v.startsWith("https://") || v.startsWith("/"),
    { message: "Logo URL must start with http://, https://, or / (relative path)" },
  )
  .optional()
  .or(z.literal(""));

// Website URLs must be absolute (http/https) — never relative and never
// protocol-less. Preventing blank values is intentional: a partial URL like
// "acme.com" silently breaks link rendering downstream.
const websiteUrlSchema = z
  .string()
  .max(2000)
  .refine(
    (v) => v === "" || v.startsWith("http://") || v.startsWith("https://"),
    { message: "Website URL must start with http:// or https://" },
  )
  .optional()
  .or(z.literal(""));

const sponsorEntrySchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(255),
  logoUrl: logoUrlSchema,
  websiteUrl: websiteUrlSchema,
  tier: z.enum(SPONSOR_TIERS).optional(),
  description: z.string().max(2000).optional().or(z.literal("")),
  sortOrder: z.number().int().min(0).max(10_000),
});

const sponsorsPutSchema = z.object({
  sponsors: z.array(sponsorEntrySchema).max(200),
});

// ── GET — return the current sponsor list ────────────────────────

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }] = await Promise.all([auth(), params]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true, settings: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    return NextResponse.json({ sponsors: readSponsors(event.settings) });
  } catch (err) {
    apiLogger.error({ err }, "sponsors:list-failed");
    return NextResponse.json(
      { error: "Failed to load sponsors" },
      { status: 500 },
    );
  }
}

// ── PUT — replace the entire sponsor list ───────────────────────

export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const [session, { eventId }, body] = await Promise.all([
      auth(),
      params,
      req.json().catch(() => null),
    ]);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const denied = denyReviewer(session);
    if (denied) return denied;

    const { allowed, retryAfterSeconds } = checkRateLimit({
      key: `sponsors-update:${eventId}`,
      limit: 20,
      windowMs: 3600_000,
    });
    if (!allowed) {
      apiLogger.warn(
        { eventId, userId: session.user.id },
        "sponsors:update-rate-limited",
      );
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
      );
    }

    const validated = sponsorsPutSchema.safeParse(body);
    if (!validated.success) {
      apiLogger.warn(
        { errors: validated.error.flatten(), eventId },
        "sponsors:update-validation-failed",
      );
      return NextResponse.json(
        { error: "Invalid input", details: validated.error.flatten() },
        { status: 400 },
      );
    }

    const event = await db.event.findFirst({
      where: { id: eventId, organizationId: session.user.organizationId! },
      select: { id: true, settings: true },
    });
    if (!event) {
      return NextResponse.json({ error: "Event not found" }, { status: 404 });
    }

    // Normalize empty strings to undefined so the stored JSON stays tidy,
    // and re-assign sortOrder to the array index so the client doesn't
    // have to keep counters in sync.
    const normalizedSponsors: SponsorEntry[] = validated.data.sponsors.map(
      (row, index) => ({
        id: row.id,
        name: row.name.trim(),
        logoUrl: row.logoUrl?.trim() || undefined,
        websiteUrl: row.websiteUrl?.trim() || undefined,
        tier: row.tier,
        description: row.description?.trim() || undefined,
        sortOrder: index,
      }),
    );

    const settingsObj = (event.settings as Record<string, unknown>) || {};
    // JSON.parse(JSON.stringify(...)) strips undefined — Prisma's Json
    // type rejects them — and gives us a clean value to persist.
    const mergedSettings = JSON.parse(
      JSON.stringify({
        ...settingsObj,
        sponsors: normalizedSponsors,
      }),
    );

    await db.event.update({
      where: { id: eventId },
      data: { settings: mergedSettings },
    });

    apiLogger.info(
      {
        eventId,
        userId: session.user.id,
        count: normalizedSponsors.length,
      },
      "sponsors:updated",
    );

    return NextResponse.json({ sponsors: normalizedSponsors });
  } catch (err) {
    apiLogger.error({ err }, "sponsors:update-failed");
    return NextResponse.json(
      { error: "Failed to update sponsors" },
      { status: 500 },
    );
  }
}
