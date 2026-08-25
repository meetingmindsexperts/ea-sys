/**
 * Server side of Travel Grant: mint-or-reuse a grant row and turn it into the
 * email block. Server-only (imports `db`); the pure pieces live in
 * eligibility.ts, settings.ts and block.ts so a client component can import
 * those without dragging Prisma into the browser bundle.
 */
import crypto from "crypto";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { classifyResidency } from "@/lib/travel-grant/eligibility";
import { isTravelGrantEnabled } from "@/lib/travel-grant/settings";
import { buildTravelGrantBlock, type TravelGrantBlockStatus } from "@/lib/travel-grant/block";

/**
 * Plaintext and globally unique, like the reimbursement token, because the
 * organizer copies the link out of the console. 24 random bytes.
 */
export function generateTravelGrantToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function buildTravelGrantLink(eventSlug: string, token: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return `${appUrl}/e/${eventSlug}/travel-grant/${token}`;
}

export interface TravelGrantBlockInput {
  eventId: string;
  organizationId?: string | null;
  /** Needed to build the public link. Without it there is no working URL. */
  eventSlug?: string | null;
  speakerId: string;
  /** The author's recorded country. The ONLY input to eligibility (D6). */
  speakerCountry?: string | null;
  /** Organizer copy from Content -> Abstracts. */
  messageHtml?: string | null;
  /** The event's `settings` JSON, for the master switch. */
  settings: unknown;
  /** For logs only. */
  abstractId?: string;
}

/**
 * Resolve the travel-grant block for one abstract submission, minting the
 * author's grant row on first sight.
 *
 * **Never throws.** Every failure resolves to an empty block, because a
 * travel-grant problem must never stop an abstract confirmation from reaching
 * its author. Same contract as `ensureSpeakerCompanionRegistration`.
 *
 * Returns `{ html: "", text: "" }` for every not-applicable case, which is what
 * makes the caller's job a plain substitution with no branching.
 */
export async function resolveTravelGrantBlock(
  input: TravelGrantBlockInput,
): Promise<{ html: string; text: string }> {
  const empty = { html: "", text: "" };
  const { eventId, organizationId, eventSlug, speakerId, abstractId } = input;

  try {
    if (!isTravelGrantEnabled(input.settings)) return empty;

    const residency = classifyResidency(input.speakerCountry);

    if (residency === "uae") return empty;

    if (residency === "unknown") {
      // D4: do not send, but leave a trace. A refusal that logs nothing is
      // indistinguishable from the feature being off, and this is the one
      // branch where a human has to decide.
      apiLogger.warn({
        msg: "travel-grant:residency-unknown-not-invited",
        eventId,
        abstractId,
        speakerId,
        // The value, not the person: it is the thing an organizer has to fix.
        country: input.speakerCountry ?? null,
      });
      return empty;
    }

    if (!eventSlug) {
      // A token link with no slug cannot be built, and a half-formed URL is
      // worse than no block. Loud, because it means an eligible author was
      // silently skipped for a reason that is ours, not theirs.
      apiLogger.error({
        msg: "travel-grant:no-event-slug-cannot-build-link",
        eventId,
        abstractId,
        speakerId,
      });
      return empty;
    }

    const run = async () => {
      // Find-or-create on speakerId, which is unique. This is what makes D2
      // hold: a second abstract from the same author reuses the same row and
      // the same link rather than minting a second invitation.
      const existing = await db.travelGrant.findUnique({
        where: { speakerId },
        select: { token: true, status: true },
      });

      if (existing) {
        // Re-stamp when the link is put in front of them again. Not a status
        // change, so a CONSENTED or DECLINED row is untouched apart from this.
        await db.travelGrant
          .updateMany({ where: { speakerId }, data: { invitedAt: new Date() } })
          .catch((err) => {
            apiLogger.warn({ err, msg: "travel-grant:invitedAt-stamp-failed", eventId, speakerId });
          });
        return existing;
      }

      const created = await db.travelGrant.create({
        data: {
          eventId,
          organizationId: organizationId ?? null,
          speakerId,
          token: generateTravelGrantToken(),
          invitedAt: new Date(),
        },
        select: { token: true, status: true },
      });
      apiLogger.info({ msg: "travel-grant:invited", eventId, abstractId, speakerId });
      return created;
    };

    const row = organizationId ? await runWithTenant(organizationId, run) : await run();

    return buildTravelGrantBlock({
      link: buildTravelGrantLink(eventSlug, row.token),
      messageHtml: input.messageHtml,
      status: row.status as TravelGrantBlockStatus,
    });
  } catch (err) {
    // Failure-isolated by contract: the confirmation email still goes out.
    apiLogger.error({ err, msg: "travel-grant:block-failed", eventId, abstractId, speakerId });
    return empty;
  }
}
