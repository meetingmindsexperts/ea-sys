/**
 * One-time reconciliation: make tags common across a person's Registration
 * (Attendee) and Speaker facets, for data that predates the forward tag-sync
 * (src/lib/person-tag-sync.ts).
 *
 * A "person" is the connected set of Attendee(s) + Speaker(s) in one event that
 * are linked by `Speaker.sourceRegistrationId` OR share an email
 * (case-insensitive). For each such set we take the UNION of all their tags and
 * write it back to every facet in the set — so nothing is lost and both sides
 * end up consistent. Only sets that contain BOTH at least one attendee AND at
 * least one speaker are touched (nothing to reconcile otherwise).
 *
 * Idempotent (a converged set is a no-op). Dry-run by default.
 *
 * Usage:
 *   npx tsx scripts/reconcile-person-tags.ts                     # dry run, all events
 *   npx tsx scripts/reconcile-person-tags.ts --write             # apply, all events
 *   npx tsx scripts/reconcile-person-tags.ts --event <eventId>   # scope to one event
 *   npx tsx scripts/reconcile-person-tags.ts --write --event <id>
 */
import { db } from "../src/lib/db";

const write = process.argv.includes("--write");
const eventArgIdx = process.argv.indexOf("--event");
const eventFilter = eventArgIdx >= 0 ? process.argv[eventArgIdx + 1] : undefined;

const lc = (s: string) => (s || "").trim().toLowerCase();
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && new Set([...a, ...b]).size === a.length;

// Tiny union-find over string node ids.
class UF {
  private parent = new Map<string, string>();
  add(x: string) {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  find(x: string): string {
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    // path-compress
    while (this.parent.get(x) !== r) {
      const next = this.parent.get(x)!;
      this.parent.set(x, r);
      x = next;
    }
    return r;
  }
  union(a: string, b: string) {
    this.add(a);
    this.add(b);
    this.parent.set(this.find(a), this.find(b));
  }
  roots(): string[] {
    return [...this.parent.keys()].filter((k) => this.find(k) === k);
  }
  members(): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const k of this.parent.keys()) {
      const r = this.find(k);
      (m.get(r) ?? m.set(r, []).get(r)!).push(k);
    }
    return m;
  }
}

async function reconcileEvent(eventId: string, eventName: string) {
  const [regs, speakers] = await Promise.all([
    db.registration.findMany({
      where: { eventId },
      select: { id: true, attendee: { select: { id: true, email: true, tags: true } } },
    }),
    db.speaker.findMany({
      where: { eventId },
      select: { id: true, email: true, tags: true, sourceRegistrationId: true },
    }),
  ]);

  // Unique attendees (an attendee can back multiple registrations).
  const attendees = new Map<string, { email: string; tags: string[] }>();
  const regToAttendee = new Map<string, string>();
  for (const r of regs) {
    if (!r.attendee) continue;
    attendees.set(r.attendee.id, { email: r.attendee.email, tags: r.attendee.tags });
    regToAttendee.set(r.id, r.attendee.id);
  }
  const speakerMap = new Map(speakers.map((s) => [s.id, s]));

  const uf = new UF();
  const aNode = (id: string) => `a:${id}`;
  const sNode = (id: string) => `s:${id}`;

  for (const id of attendees.keys()) uf.add(aNode(id));
  for (const id of speakerMap.keys()) uf.add(sNode(id));

  // Edge 1 — explicit link.
  for (const s of speakers) {
    if (s.sourceRegistrationId) {
      const attId = regToAttendee.get(s.sourceRegistrationId);
      if (attId) uf.union(sNode(s.id), aNode(attId));
    }
  }
  // Edge 2 — shared email (case-insensitive).
  const byEmail = new Map<string, string[]>();
  for (const [id, a] of attendees) {
    const e = lc(a.email);
    if (!e) continue;
    (byEmail.get(e) ?? byEmail.set(e, []).get(e)!).push(aNode(id));
  }
  for (const s of speakers) {
    const e = lc(s.email);
    if (!e) continue;
    (byEmail.get(e) ?? byEmail.set(e, []).get(e)!).push(sNode(s.id));
  }
  for (const group of byEmail.values()) {
    for (let i = 1; i < group.length; i++) uf.union(group[0], group[i]);
  }

  let reconciled = 0;
  let attUpdated = 0;
  let spkUpdated = 0;

  for (const [, nodes] of uf.members()) {
    const attIds = nodes.filter((n) => n.startsWith("a:")).map((n) => n.slice(2));
    const spkIds = nodes.filter((n) => n.startsWith("s:")).map((n) => n.slice(2));
    // Only cross-facet sets need reconciling.
    if (attIds.length === 0 || spkIds.length === 0) continue;

    // Union of all tags in the set (insertion-ordered, deduped).
    const union: string[] = [];
    const seen = new Set<string>();
    const push = (tags: string[]) => {
      for (const t of tags) if (!seen.has(t)) { seen.add(t); union.push(t); }
    };
    for (const id of attIds) push(attendees.get(id)!.tags);
    for (const id of spkIds) push(speakerMap.get(id)!.tags);

    const changed: string[] = [];
    for (const id of attIds) {
      if (!sameSet(attendees.get(id)!.tags, union)) {
        changed.push(`attendee ${id}: [${attendees.get(id)!.tags.join(", ")}] → [${union.join(", ")}]`);
        if (write) await db.attendee.update({ where: { id }, data: { tags: union } });
        attUpdated++;
      }
    }
    for (const id of spkIds) {
      if (!sameSet(speakerMap.get(id)!.tags, union)) {
        changed.push(`speaker ${id}: [${speakerMap.get(id)!.tags.join(", ")}] → [${union.join(", ")}]`);
        if (write) await db.speaker.update({ where: { id }, data: { tags: union } });
        spkUpdated++;
      }
    }
    if (changed.length) {
      reconciled++;
      const email = attIds.map((id) => attendees.get(id)!.email).find(Boolean) || speakerMap.get(spkIds[0])!.email;
      console.log(`  • ${email}`);
      for (const c of changed) console.log(`      ${c}`);
    }
  }

  if (reconciled) {
    console.log(`  ${eventName}: ${reconciled} person(s) reconciled — ${attUpdated} attendee + ${spkUpdated} speaker rows.`);
  }
  return { reconciled, attUpdated, spkUpdated };
}

async function main() {
  console.log(write ? "Mode: WRITE\n" : "Mode: DRY RUN (pass --write to apply)\n");
  const events = await db.event.findMany({
    where: eventFilter ? { id: eventFilter } : {},
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  let totals = { reconciled: 0, attUpdated: 0, spkUpdated: 0 };
  for (const ev of events) {
    const r = await reconcileEvent(ev.id, ev.name);
    totals = {
      reconciled: totals.reconciled + r.reconciled,
      attUpdated: totals.attUpdated + r.attUpdated,
      spkUpdated: totals.spkUpdated + r.spkUpdated,
    };
  }
  console.log(
    `\nTotal: ${totals.reconciled} person(s) ${write ? "reconciled" : "would be reconciled"} across ${events.length} event(s) — ${totals.attUpdated} attendee + ${totals.spkUpdated} speaker rows.`,
  );
  if (!write && totals.reconciled) console.log("Re-run with --write to apply.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
