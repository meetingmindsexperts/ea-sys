/**
 * Delete a TEST event and everything under it, in one transaction.
 *
 * WHY A SCRIPT AND NOT A FEATURE. The app deliberately refuses to delete a
 * registration carrying invoices or payments (409 HAS_FINANCIAL_RECORDS),
 * because Invoice and Payment both cascade from Registration and the delete
 * audit snapshots only the registration row. There is no delete route for an
 * invoice anywhere, on purpose. That guard is right for real events and no UI
 * should get around it. What is left is the narrow case of test data that
 * should never have reached production, and the honest answer to that is a
 * one-off run with a human reading the dry run first.
 *
 * WHAT IT REFUSES, WITH NO FLAG TO OVERRIDE IT: an event carrying a real Stripe
 * payment or any recorded refund. Money that actually moved is not test data,
 * and removing an event that took payments is a conversation, not an argument.
 *
 * THE ANTI-TYPO GUARD. `--expect-name` must match the event's name EXACTLY. A
 * mis-pasted id resolves to some other event, the name will not match, and
 * nothing happens. An id on its own is one keystroke from a live conference.
 *
 * WHAT CASCADES AND WHAT DOES NOT. 41 tables cascade from Event: registrations,
 * invoices, payments, ticket types, email templates, media rows, stats, every
 * counter. Four things do not, and each is a real trap:
 *
 *   - `AnalyticsEvent` holds an `eventId` with NO foreign key (the analytics
 *     module is deliberately decoupled), so its rows would DANGLE. Deleted here.
 *   - `Attendee` is referenced BY Registration rather than owned by the event,
 *     so it survives the cascade. Deleted here, but ONLY where no registration
 *     on any other event still points at it — the public register path can
 *     share one attendee row across events.
 *   - `Contact` is an ORG-level CRM row that merely lists the event in an array.
 *     The person must survive; only the dead id is pruned. One left referencing
 *     nothing is reported and removed only under `--delete-orphan-contacts`,
 *     because deleting somebody's CRM record is a separate decision.
 *   - Files on disk behind `MediaFile`. The rows cascade, the bytes do not.
 *     Removed only under `--delete-files`, and only after the transaction
 *     commits, because an unlink cannot be rolled back.
 *
 * `AuditLog`, `Notification` and `EmailLog` are SET NULL, so they survive as
 * org-level history with the event pointer cleared. One more such row is
 * written BEFORE the delete carrying the whole inventory, so the deletion is
 * answerable afterwards.
 *
 * Usage (dry run prints a full inventory and writes nothing):
 *   npx tsx scripts/delete-test-event.ts --event <id> --expect-name "<exact name>"
 *   npx tsx scripts/delete-test-event.ts --event <id> --expect-name "<exact name>" --write
 *   ... --write --delete-files --delete-orphan-contacts
 *
 * On the box, run it in the worker container so it uses production's runtime,
 * Prisma client and env:
 *   docker exec ea-sys-worker npx tsx scripts/delete-test-event.ts --event ... --expect-name "..."
 */
import { db, tenantTransaction } from "../src/lib/db";
import { runWithTenant } from "../src/lib/tenant-context";
import { deleteMedia } from "../src/lib/storage";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const eventId = arg("--event");
const expectName = arg("--expect-name");
const write = process.argv.includes("--write");
const deleteFiles = process.argv.includes("--delete-files");
const deleteOrphanContacts = process.argv.includes("--delete-orphan-contacts");

/** Tables holding an `eventId` that are worth showing in the inventory. */
const COUNTED = [
  "registration", "ticketType", "invoice", "invoiceCounter", "mediaFile",
  "emailTemplate", "emailLog", "analyticsEvent", "auditLog", "notification",
  "eventStats", "registrationSerialCounter",
] as const;

async function main() {
  if (!eventId || !expectName) {
    console.error(
      'Both --event <id> and --expect-name "<exact name>" are required.\n' +
        "The name is the anti-typo guard: a mis-pasted id will not match and nothing happens.",
    );
    process.exit(1);
  }

  const event = await db.event.findUnique({
    where: { id: eventId },
    select: {
      id: true, name: true, slug: true, code: true, status: true,
      eventType: true, startDate: true, endDate: true, organizationId: true,
    },
  });
  if (!event) {
    console.error(`No event with id ${eventId}.`);
    process.exit(1);
  }
  if (event.name !== expectName) {
    console.error(
      `Name guard failed. Refusing to touch anything.\n` +
        `  id ${eventId} is "${event.name}"\n` +
        `  --expect-name was "${expectName}"`,
    );
    process.exit(1);
  }

  await runWithTenant(event.organizationId, async () => {
    const counts: Record<string, number> = {};
    for (const model of COUNTED) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      counts[model] = await (db as any)[model].count({ where: { eventId } });
    }

    const registrations = await db.registration.findMany({
      where: { eventId },
      select: {
        id: true, serialId: true, status: true, paymentStatus: true, attendeeId: true,
        attendee: { select: { email: true, firstName: true, lastName: true } },
      },
      orderBy: { serialId: "asc" },
    });
    const invoices = await db.invoice.findMany({
      where: { eventId },
      select: { id: true, invoiceNumber: true, type: true, status: true, total: true, currency: true },
    });
    const payments = await db.payment.findMany({
      where: { registration: { eventId } },
      select: {
        id: true, amount: true, currency: true, status: true,
        stripePaymentId: true, paymentMethodType: true, cardLast4: true,
      },
    });
    const media = await db.mediaFile.findMany({
      where: { eventId },
      select: { id: true, filename: true, url: true, size: true },
    });

    console.log(`\n${event.name}  [${event.code ?? "no code"}]  ${event.status}  ${event.eventType}`);
    console.log(`  ${event.id}   /${event.slug}`);
    console.log(`  ${event.startDate.toISOString().slice(0, 10)} → ${event.endDate.toISOString().slice(0, 10)}\n`);
    console.log("Rows attached:");
    for (const [k, v] of Object.entries(counts)) if (v > 0) console.log(`  ${k.padEnd(28)} ${v}`);

    // The refusal that has no override.
    const realStripe = payments.filter((p) => p.stripePaymentId && p.stripePaymentId.length > 0);
    const refunded = await db.registration.count({ where: { eventId, refundedAmount: { gt: 0 } } });
    if (realStripe.length > 0 || refunded > 0) {
      console.error(
        `\nREFUSING. ${realStripe.length} Stripe payment(s) and ${refunded} registration(s) ` +
          `with a recorded refund. Money that moved through Stripe is not test data, ` +
          `and there is no flag to override this.`,
      );
      process.exit(1);
    }
    console.log(`\n  no Stripe payments, no refunds — safe to treat as test data`);

    // The things that do NOT cascade.
    const attendeeIds = registrations.map((r) => r.attendeeId).filter((id): id is string => !!id);
    const shared = attendeeIds.length
      ? await db.registration.findMany({
          where: { attendeeId: { in: attendeeIds }, eventId: { not: eventId } },
          select: { attendeeId: true },
          distinct: ["attendeeId"],
        })
      : [];
    const sharedIds = new Set(shared.map((r) => r.attendeeId));
    const deletableAttendees = attendeeIds.filter((id) => !sharedIds.has(id));

    const contacts = await db.contact.findMany({
      where: { eventIds: { has: eventId } },
      select: { id: true, email: true, eventIds: true },
    });

    console.log(`\nHandled explicitly (these do not cascade):`);
    console.log(`  analytics rows deleted     ${counts.analyticsEvent ?? 0}`);
    console.log(`  attendees deleted          ${deletableAttendees.length} of ${attendeeIds.length}` +
      (sharedIds.size ? `  (${sharedIds.size} shared with another event, kept)` : ""));
    console.log(`  contacts pruned            ${contacts.length}`);
    for (const c of contacts) {
      const left = c.eventIds.length - 1;
      console.log(`     ${c.email.padEnd(28)} ${left} event(s) left` +
        (left === 0
          ? deleteOrphanContacts ? "  → will be DELETED" : "  → kept (--delete-orphan-contacts to remove)"
          : ""));
    }
    console.log(`  media files on disk        ${media.length}` +
      (media.length ? (deleteFiles ? "  → will be unlinked" : "  → kept (--delete-files to remove)") : ""));

    console.log(`\nRegistrations:`);
    for (const r of registrations) {
      console.log(`  #${String(r.serialId ?? "—").padStart(3)}  ${(r.attendee?.email ?? "no attendee").padEnd(30)} ${r.status} / ${r.paymentStatus}`);
    }
    if (invoices.length) {
      console.log(`\nFinancial documents that will be destroyed:`);
      for (const i of invoices) console.log(`  ${i.invoiceNumber.padEnd(16)} ${i.type.padEnd(12)} ${i.status.padEnd(9)} ${i.total} ${i.currency}`);
    }
    if (payments.length) {
      console.log(`\nPayments that will be destroyed:`);
      for (const p of payments) console.log(`  ${p.amount} ${p.currency}  ${p.status}  ${p.paymentMethodType ?? "?"}${p.cardLast4 ? ` ****${p.cardLast4}` : ""}  stripe=${p.stripePaymentId || "none"}`);
    }

    if (!write) {
      console.log(`\nDRY RUN — nothing written. Re-run with --write to apply.\n`);
      return;
    }

    await tenantTransaction(
      async (tx) => {
        // Written FIRST and with a null eventId so it neither depends on the row
        // it describes nor gets cleared by the cascade. This is the only thing
        // left explaining why the surviving audit rows have no event.
        await tx.auditLog.create({
          data: {
            eventId: null,
            organizationId: event.organizationId,
            userId: null,
            action: "DELETE",
            entityType: "Event",
            entityId: event.id,
            changes: {
              reason: "test-event-removal",
              script: "scripts/delete-test-event.ts",
              event, counts, registrations, invoices, payments,
              mediaFiles: media,
              attendeesDeleted: deletableAttendees,
              contactsPruned: contacts.map((c) => c.id),
              orphanContactsDeleted: deleteOrphanContacts
                ? contacts.filter((c) => c.eventIds.length === 1).map((c) => c.id)
                : [],
            },
          },
        });

        // No foreign key, so these would be left pointing at nothing.
        await tx.analyticsEvent.deleteMany({ where: { eventId } });

        // Org-level rows: prune the dead id, keep the person.
        for (const c of contacts) {
          const next = c.eventIds.filter((id) => id !== eventId);
          if (next.length === 0 && deleteOrphanContacts) {
            await tx.contact.delete({ where: { id: c.id } });
          } else {
            await tx.contact.update({ where: { id: c.id }, data: { eventIds: next } });
          }
        }

        await tx.event.delete({ where: { id: eventId } });

        // Re-check emptiness INSIDE the transaction rather than trusting the
        // count taken before it.
        for (const id of deletableAttendees) {
          const still = await tx.registration.count({ where: { attendeeId: id } });
          if (still === 0) await tx.attendee.delete({ where: { id } });
        }
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    console.log(`\nDeleted. Audit row written with the full inventory.`);

    // Outside the transaction on purpose: an unlink cannot be rolled back.
    if (deleteFiles && media.length) {
      for (const m of media) {
        try {
          await deleteMedia(m.url);
          console.log(`  unlinked ${m.url}`);
        } catch (err) {
          console.warn(`  could NOT unlink ${m.url}:`, err);
        }
      }
    } else if (media.length) {
      console.log(`\n${media.length} media file(s) left on disk. --delete-files removes them; an orphan file is cheap.`);
    }
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
