/**
 * READ-ONLY webinar/Zoom diagnostic. Prints the live config state behind the
 * three reported bugs (Settings Zoom card, public banner, Join Meeting) WITHOUT
 * revealing any secret values — only presence booleans. Writes nothing.
 *
 *   npx tsx scripts/webinar-diagnostic.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function has(v: unknown): string {
  return v ? "✅ set" : "—  missing";
}

async function main() {
  // ── Org-level Zoom config ────────────────────────────────────────
  const orgs = await db.organization.findMany({ select: { id: true, name: true, settings: true } });
  for (const org of orgs) {
    const s = (org.settings as Record<string, unknown> | null) || {};
    const zoom = (s.zoom as Record<string, unknown> | undefined) || undefined;
    console.log(`\n━━━ Org "${org.name}" (${org.id}) — settings.zoom ━━━`);
    if (!zoom) {
      console.log("  settings.zoom is ABSENT → org Zoom not configured at all.");
      continue;
    }
    console.log(`  enabled (top-level):     ${zoom.enabled === undefined ? "(unset)" : zoom.enabled}`);
    console.log(`  accountId:               ${has(zoom.accountId)}`);
    console.log(`  clientId:                ${has(zoom.clientId)}`);
    console.log(`  clientSecretEncrypted:   ${has(zoom.clientSecretEncrypted)}`);
    console.log(`  sdkMode:                 ${zoom.sdkMode ?? "(unset → defaults 'dev')"}`);
    console.log(`  sdkKeyDev:               ${has(zoom.sdkKeyDev)}`);
    console.log(`  sdkSecretDevEncrypted:   ${has(zoom.sdkSecretDevEncrypted)}`);
    console.log(`  sdkKeyProd:              ${has(zoom.sdkKeyProd)}`);
    console.log(`  sdkSecretProdEncrypted:  ${has(zoom.sdkSecretProdEncrypted)}`);
    const mode = (zoom.sdkMode as string) || "dev";
    const activeKey = mode === "prod" ? zoom.sdkKeyProd : zoom.sdkKeyDev;
    const activeSecret = mode === "prod" ? zoom.sdkSecretProdEncrypted : zoom.sdkSecretDevEncrypted;
    console.log(
      `  ➜ ACTIVE embed creds for mode='${mode}': key ${activeKey ? "present" : "MISSING"}, secret ${
        activeSecret ? "present" : "MISSING"
      }  ${activeKey && activeSecret ? "(embed CAN sign)" : "(embed will fall back to URL mode)"}`
    );
  }

  // ── Webinar / HYBRID events + their Zoom meetings + banner ────────
  const events = await db.event.findMany({
    where: { OR: [{ eventType: "WEBINAR" }, { eventType: "HYBRID" }] },
    select: {
      id: true,
      name: true,
      slug: true,
      eventType: true,
      status: true,
      organizationId: true,
      bannerImage: true,
      eventSessions: {
        select: {
          id: true,
          name: true,
          startTime: true,
          endTime: true,
          zoomMeeting: {
            select: {
              meetingType: true,
              zoomMeetingId: true,
              joinUrl: true,
              passcode: true,
              recordingStatus: true,
              streamStatus: true,
            },
          },
        },
      },
    },
    orderBy: { startDate: "desc" },
    take: 25,
  });

  console.log(`\n\n━━━ Webinar/Hybrid events (${events.length}) ━━━`);
  for (const e of events) {
    const banner = e.bannerImage;
    let bannerKind = "NULL (no banner set)";
    if (banner) {
      if (banner.startsWith("/uploads/")) bannerKind = `LOCAL file path → served by box: ${banner}`;
      else if (/^https?:\/\//.test(banner)) bannerKind = `ABSOLUTE URL → host: ${new URL(banner).host}  | ${banner}`;
      else bannerKind = `OTHER/relative: ${banner}`;
    }
    console.log(`\n• ${e.name}  [${e.eventType}/${e.status}]  slug=${e.slug}  id=${e.id}`);
    console.log(`    org=${e.organizationId}`);
    console.log(`    bannerImage: ${bannerKind}`);
    const withZoom = e.eventSessions.filter((x) => x.zoomMeeting);
    console.log(`    sessions: ${e.eventSessions.length} (with Zoom meeting: ${withZoom.length})`);
    for (const sess of withZoom) {
      const z = sess.zoomMeeting!;
      console.log(
        `      └ session ${sess.id} "${sess.name}": type=${z.meetingType} zoomMeetingId=${
          z.zoomMeetingId ? "set" : "MISSING"
        } joinUrl=${z.joinUrl ? "set" : "MISSING"} passcode=${z.passcode ? "set" : "(none)"} rec=${
          z.recordingStatus
        } stream=${z.streamStatus}`
      );
    }
  }

  console.log("\n✅ Diagnostic complete (read-only, no secrets printed).");
}

main()
  .catch((err) => {
    console.error("Diagnostic failed:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
