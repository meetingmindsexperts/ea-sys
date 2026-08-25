/**
 * Sending a travel-grant link from the console.
 *
 * Two shapes, one implementation:
 *   - named authors (`speakerIds`) — the per-row send, which covers "I deleted
 *     the email" and "my country was wrong, fix it and send it to me".
 *   - everyone still outstanding (`pendingOnly`) — decision D9.
 *
 * ## The guard, which is the reason this file reads the way it does
 *
 * The console deliberately lists people who must NOT be emailed: UAE-based
 * authors and authors with no country recorded both appear so that a
 * mis-classified person is recoverable (D7). Directly above them sits a bulk
 * send button.
 *
 * So recipients are resolved from the GRANT table, never from the roster:
 * `pendingOnly` reads `TravelGrant where status = PENDING`, and the named form
 * only ever sends to a speaker who ALREADY HAS A GRANT ROW. An author who was
 * never invited has no row, so neither path can reach them by accident. Minting
 * a row for a named speaker is a separate, explicit decision (`allowMint`),
 * taken only when the caller passed that speaker's id by hand.
 */
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  brandingCc,
  brandingFrom,
  getDefaultTemplate,
  getEventTemplate,
  renderAndWrap,
  sendEmail,
} from "@/lib/email";
import { formatPersonName } from "@/lib/utils";
import { classifyResidency } from "@/lib/travel-grant/eligibility";
import { buildTravelGrantBlock, type TravelGrantBlockStatus } from "@/lib/travel-grant/block";
import { buildTravelGrantLink, generateTravelGrantToken } from "@/lib/travel-grant/server";

const SLUG = "travel-grant-invitation";

export interface SendTravelGrantArgs {
  event: {
    id: string;
    slug: string;
    name: string;
    organizationId: string;
    travelGrantMessageHtml: string | null;
  };
  speakerIds?: string[];
  pendingOnly?: boolean;
  subject?: string;
  message?: string;
  actor: { id?: string; name?: string | null; firstName?: string | null; lastName?: string | null };
}

export interface SendTravelGrantResult {
  sent: number;
  failed: number;
  /** Named speakers we refused to email because they are not eligible. */
  skippedNotEligible: number;
  /** Named speakers with no email address on file. */
  skippedNoEmail: number;
}

export async function sendTravelGrantInvitations(
  args: SendTravelGrantArgs,
): Promise<SendTravelGrantResult> {
  const { event } = args;
  const result: SendTravelGrantResult = { sent: 0, failed: 0, skippedNotEligible: 0, skippedNoEmail: 0 };

  const recipients = args.pendingOnly
    ? await resolvePending(event.id)
    : await resolveNamed(event, args.speakerIds ?? [], result);

  if (recipients.length === 0) return result;

  const eventTpl = await getEventTemplate(event.id, SLUG);
  const tpl = eventTpl || getDefaultTemplate(SLUG);
  if (!tpl) {
    apiLogger.error({ eventId: event.id }, "travel-grant-send:no-template");
    result.failed = recipients.length;
    return result;
  }
  const branding = eventTpl?.branding || { eventName: event.name };
  const organizerName =
    args.actor.name ||
    [args.actor.firstName, args.actor.lastName].filter(Boolean).join(" ") ||
    "The organising team";

  for (const r of recipients) {
    try {
      const block = buildTravelGrantBlock({
        link: buildTravelGrantLink(event.slug, r.token),
        messageHtml: event.travelGrantMessageHtml,
        status: r.status,
      });
      const vars: Record<string, string> = {
        speakerName: formatPersonName(r.title, r.firstName ?? "", r.lastName ?? ""),
        firstName: r.firstName ?? "",
        lastName: r.lastName ?? "",
        eventName: event.name,
        travelGrantBlock: block.html,
        travelGrantBlockText: block.text,
        personalMessage: args.message ?? "",
        organizerName,
        organizerSignature: "",
      };
      const rendered = renderAndWrap(
        args.subject ? { ...tpl, subject: args.subject } : tpl,
        vars,
        branding,
      );
      const res = await sendEmail({
        to: [{ email: r.email, name: `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() }],
        cc: brandingCc(branding, [{ email: r.email }], []),
        ...rendered,
        from: brandingFrom(branding),
        emailType: "travel_grant_invitation",
        stream: "transactional",
        logContext: {
          organizationId: event.organizationId,
          eventId: event.id,
          entityType: "SPEAKER",
          entityId: r.speakerId,
          templateSlug: SLUG,
          triggeredByUserId: args.actor.id,
        },
      });
      if (!res.success) {
        result.failed += 1;
        apiLogger.error(
          { eventId: event.id, speakerId: r.speakerId, error: res.error },
          "travel-grant-send:failed",
        );
        continue;
      }
      result.sent += 1;
      await db.travelGrant
        .updateMany({ where: { id: r.grantId }, data: { invitedAt: new Date() } })
        .catch((err) =>
          apiLogger.warn({ err, grantId: r.grantId }, "travel-grant-send:invitedAt-stamp-failed"),
        );
    } catch (err) {
      // Per-recipient isolation: one bad address must not kill the batch.
      result.failed += 1;
      apiLogger.error({ err, eventId: event.id, speakerId: r.speakerId }, "travel-grant-send:threw");
    }
  }
  return result;
}

interface Recipient {
  grantId: string;
  speakerId: string;
  token: string;
  status: TravelGrantBlockStatus;
  email: string;
  title: string | null;
  firstName: string | null;
  lastName: string | null;
}

/** D9. Sourced from the grant table, so it cannot reach an uninvited author. */
async function resolvePending(eventId: string): Promise<Recipient[]> {
  const rows = await db.travelGrant.findMany({
    where: { eventId, status: "PENDING" },
    select: {
      id: true,
      token: true,
      status: true,
      speakerId: true,
      speaker: { select: { title: true, firstName: true, lastName: true, email: true } },
    },
  });
  return rows
    .filter((r) => !!r.speaker?.email)
    .map((r) => ({
      grantId: r.id,
      speakerId: r.speakerId,
      token: r.token,
      status: r.status as TravelGrantBlockStatus,
      email: r.speaker!.email!,
      title: r.speaker!.title ?? null,
      firstName: r.speaker!.firstName ?? null,
      lastName: r.speaker!.lastName ?? null,
    }));
}

/**
 * Named speakers. Mints a grant row when the speaker does not have one, which
 * is the recovery path for a corrected country — but ONLY after re-checking
 * eligibility, so passing a UAE-based speaker's id still refuses.
 */
async function resolveNamed(
  event: SendTravelGrantArgs["event"],
  speakerIds: string[],
  result: SendTravelGrantResult,
): Promise<Recipient[]> {
  if (speakerIds.length === 0) return [];
  const speakers = await db.speaker.findMany({
    where: { id: { in: speakerIds }, eventId: event.id },
    select: {
      id: true,
      title: true,
      firstName: true,
      lastName: true,
      email: true,
      country: true,
      travelGrant: { select: { id: true, token: true, status: true } },
    },
  });

  const out: Recipient[] = [];
  for (const sp of speakers) {
    if (!sp.email) {
      result.skippedNoEmail += 1;
      continue;
    }
    // Re-checked here and not only in the UI: an organizer can pass any id, and
    // the whole point of D4 is that we do not email someone we cannot place.
    if (classifyResidency(sp.country) !== "overseas") {
      result.skippedNotEligible += 1;
      apiLogger.warn(
        { eventId: event.id, speakerId: sp.id, country: sp.country ?? null },
        "travel-grant-send:refused-not-eligible",
      );
      continue;
    }
    let grant = sp.travelGrant;
    if (!grant) {
      grant = await db.travelGrant.create({
        data: {
          eventId: event.id,
          organizationId: event.organizationId,
          speakerId: sp.id,
          token: generateTravelGrantToken(),
          invitedAt: new Date(),
        },
        select: { id: true, token: true, status: true },
      });
    }
    out.push({
      grantId: grant.id,
      speakerId: sp.id,
      token: grant.token,
      status: grant.status as TravelGrantBlockStatus,
      email: sp.email,
      title: sp.title ?? null,
      firstName: sp.firstName,
      lastName: sp.lastName,
    });
  }
  return out;
}
