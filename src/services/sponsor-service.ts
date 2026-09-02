/**
 * The ONE writer for an event's sponsor list.
 *
 * Both callers send the WHOLE list and expect it to become the truth: the
 * dashboard PUT posts the array the editor holds, and MCP `upsert_sponsors`
 * offers the same as `mode: "replace"`. That was harmless while sponsors were a
 * JSON blob, because replacing an array cannot break anything that points into
 * it, and it stopped being harmless the moment registrations and promo codes
 * carried a real foreign key to these rows.
 *
 * So replace-all becomes a DIFF with a refusal (docs/SPONSOR_ATTRIBUTION_PLAN.md
 * §4): rows in the payload are upserted, rows absent from it are deleted, and a
 * row absent from it that something still REFERENCES stops the whole save.
 *
 * WHY REFUSE RATHER THAN CASCADE. The foreign keys are `SetNull`, so a delete
 * would succeed and silently blank the attribution on every registration that
 * sponsor funded. That is the exact defect this table was created to end: the
 * old PUT removed a sponsor from the array and orphaned pointers with no
 * warning, which the detail sheet still anticipates by rendering
 * "(sponsor removed)". `SetNull` is there so a delete that IS intended cannot
 * fail an unrelated event deletion; the intent check belongs here, where the
 * organiser can be told what is in the way. It follows the abstract sub-theme
 * precedent exactly: SET NULL in the schema, refuse-while-in-use in the app.
 */
import { Prisma } from "@prisma/client";
import { db, tenantTransaction } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { SPONSOR_TIERS, type SponsorEntry } from "@/lib/webinar";
import { SPONSOR_SELECT, toSponsorEntry } from "@/lib/sponsors";

export interface SponsorInput {
  id?: string | null;
  name: string;
  tier?: string | null;
  logoUrl?: string | null;
  websiteUrl?: string | null;
  description?: string | null;
}

export type SaveSponsorsErrorCode =
  | "EVENT_NOT_FOUND"
  | "INVALID_NAME"
  | "INVALID_TIER"
  | "DUPLICATE_NAME"
  | "SPONSOR_IN_USE"
  | "UNKNOWN";

export interface SponsorInUse {
  id: string;
  name: string;
  registrations: number;
  promoCodes: number;
}

export type SaveSponsorsResult =
  | { ok: true; sponsors: SponsorEntry[] }
  | {
      ok: false;
      code: SaveSponsorsErrorCode;
      message: string;
      /** Present on SPONSOR_IN_USE, so the caller can say WHAT is in the way. */
      inUse?: SponsorInUse[];
    };

const clean = (v: string | null | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/** Identity as the application means it: case-insensitive name plus tier. */
const identityKey = (name: string, tier: string | null) =>
  `${name.trim().toLowerCase()}::${(tier ?? "").toLowerCase()}`;

/**
 * Replace an event's sponsor list with `incoming`.
 *
 * `mode: "merge"` keeps every existing row that the payload does not mention,
 * which is what an agent adding one sponsor means and what `mode: "replace"`
 * silently did not do.
 */
export async function saveSponsors(input: {
  eventId: string;
  organizationId: string;
  actorUserId: string | null;
  source: "rest" | "mcp";
  sponsors: SponsorInput[];
  mode?: "replace" | "merge";
}): Promise<SaveSponsorsResult> {
  const mode = input.mode ?? "replace";
  try {
    const event = await db.event.findFirst({
      where: { id: input.eventId, organizationId: input.organizationId },
      select: { id: true },
    });
    if (!event) return { ok: false, code: "EVENT_NOT_FOUND", message: "Event not found or access denied" };

    const rows = input.sponsors.map((s) => ({
      id: clean(s.id),
      name: clean(s.name),
      tier: clean(s.tier),
      logoUrl: clean(s.logoUrl),
      websiteUrl: clean(s.websiteUrl),
      description: clean(s.description),
    }));

    for (const r of rows) {
      if (!r.name) return { ok: false, code: "INVALID_NAME", message: "Every sponsor needs a name" };
      if (r.tier && !(SPONSOR_TIERS as readonly string[]).includes(r.tier)) {
        return {
          ok: false,
          code: "INVALID_TIER",
          message: `Unknown tier "${r.tier}". One of: ${SPONSOR_TIERS.join(", ")}`,
        };
      }
    }

    // The uniqueness rule lives here rather than in a database index, because
    // it is CASE-INSENSITIVE and a plain unique index is not. See the model's
    // header in schema.prisma.
    const seen = new Set<string>();
    for (const r of rows) {
      const key = identityKey(r.name!, r.tier);
      if (seen.has(key)) {
        return {
          ok: false,
          code: "DUPLICATE_NAME",
          message: `"${r.name}" appears twice at the same tier. Sponsor names are compared without case.`,
        };
      }
      seen.add(key);
    }

    // The org comes from the ALS store, so every caller must already be inside
    // runWithTenant. Both are.
    return await tenantTransaction(async (tx) => {
      const existing = await tx.sponsor.findMany({
        where: { eventId: input.eventId },
        select: { id: true, name: true, tier: true },
      });
      const existingById = new Map(existing.map((e) => [e.id, e]));
      // Match a payload row with no id to an existing row by the same identity
      // the app uses, so re-sending the editor's list does not delete and
      // recreate every sponsor and, with it, every foreign key pointing at one.
      const existingByIdentity = new Map(existing.map((e) => [identityKey(e.name, e.tier), e.id]));

      const keptIds = new Set<string>();
      const result: SponsorEntry[] = [];
      // In REPLACE mode the payload IS the order, so sortOrder is the array
      // index. In MERGE mode it is not: rows the payload never mentions are
      // kept, and re-indexing from the incoming array alone would collide with
      // theirs and silently reshuffle a list the caller did not ask to reorder.
      // A matched row keeps its place; a new one lands after the current last.
      const existingOrder = new Map(
        (await tx.sponsor.findMany({ where: { eventId: input.eventId }, select: { id: true, sortOrder: true } }))
          .map((e) => [e.id, e.sortOrder] as const),
      );
      let nextOrder = Math.max(-1, ...existingOrder.values()) + 1;

      for (const [index, r] of rows.entries()) {
        const matchedId =
          (r.id && existingById.has(r.id) ? r.id : null) ??
          existingByIdentity.get(identityKey(r.name!, r.tier)) ??
          null;
        const data = {
          name: r.name!,
          tier: r.tier,
          logoUrl: r.logoUrl,
          websiteUrl: r.websiteUrl,
          description: r.description,
          sortOrder:
            mode === "replace"
              ? // The client never has to keep counters in sync, which is what
                // the JSON writer did.
                index
              : matchedId && existingOrder.has(matchedId)
                ? existingOrder.get(matchedId)!
                : nextOrder++,
        };
        const saved = matchedId
          ? await tx.sponsor.update({ where: { id: matchedId }, data, select: SPONSOR_SELECT })
          : await tx.sponsor.create({
              data: { ...data, eventId: input.eventId, organizationId: input.organizationId },
              select: SPONSOR_SELECT,
            });
        keptIds.add(saved.id);
        result.push(toSponsorEntry(saved));
      }

      if (mode === "replace") {
        const doomed = existing.filter((e) => !keptIds.has(e.id));
        if (doomed.length > 0) {
          const ids = doomed.map((d) => d.id);
          const [regCounts, promoCounts] = await Promise.all([
            tx.registration.groupBy({ by: ["sponsorId"], where: { sponsorId: { in: ids } }, _count: { _all: true } }),
            tx.promoCode.groupBy({ by: ["sponsorId"], where: { sponsorId: { in: ids } }, _count: { _all: true } }),
          ]);
          const regBy = new Map(regCounts.map((c) => [c.sponsorId, c._count._all]));
          const promoBy = new Map(promoCounts.map((c) => [c.sponsorId, c._count._all]));
          const inUse: SponsorInUse[] = doomed
            .map((d) => ({
              id: d.id,
              name: d.name,
              registrations: regBy.get(d.id) ?? 0,
              promoCodes: promoBy.get(d.id) ?? 0,
            }))
            .filter((u) => u.registrations > 0 || u.promoCodes > 0);

          if (inUse.length > 0) {
            // Throwing rolls the upserts back too, which is the point: a save
            // that cannot be applied whole should not be applied in part.
            throw new SponsorInUseError(inUse);
          }
          await tx.sponsor.deleteMany({ where: { id: { in: ids } } });
        }
      }

      apiLogger.info({
        msg: "sponsors:saved",
        eventId: input.eventId,
        userId: input.actorUserId,
        source: input.source,
        mode,
        count: result.length,
      });
      return { ok: true as const, sponsors: result };
    });
  } catch (err) {
    if (err instanceof SponsorInUseError) {
      apiLogger.warn({
        msg: "sponsors:delete-refused-in-use",
        eventId: input.eventId,
        userId: input.actorUserId,
        source: input.source,
        inUse: err.inUse.map((u) => u.id),
      });
      return {
        ok: false,
        code: "SPONSOR_IN_USE",
        message:
          `Cannot remove ${err.inUse.map((u) => `"${u.name}"`).join(", ")}: ` +
          err.inUse
            .map((u) => {
              const parts = [];
              if (u.registrations) parts.push(`${u.registrations} registration(s)`);
              if (u.promoCodes) parts.push(`${u.promoCodes} promo code(s)`);
              return `${u.name} is referenced by ${parts.join(" and ")}`;
            })
            .join("; ") +
          ". Re-assign or remove those first.",
        inUse: err.inUse,
      };
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      apiLogger.error({ msg: "sponsors:save-failed", eventId: input.eventId, prismaCode: err.code, err });
    } else {
      apiLogger.error({ msg: "sponsors:save-failed", eventId: input.eventId, err });
    }
    return { ok: false, code: "UNKNOWN", message: "Failed to save sponsors" };
  }
}

/** Typed sentinel, the house pattern for aborting a transaction with detail. */
class SponsorInUseError extends Error {
  constructor(readonly inUse: SponsorInUse[]) {
    super("SPONSOR_IN_USE");
    this.name = "SponsorInUseError";
  }
}
