/**
 * Who uses the attendee portal (Nov 24, 2026; owner: "add these stats in
 * analytics and separate card for it"). Counts of the accounts that are not
 * staff (registrants, abstract authors, reviewers) linked to the events a
 * person may read analytics for: a registrant by a registration on one of
 * them, an author by a speaker record, a reviewer by the event's pool or an
 * assignment. These accounts belong to no organisation, so an event is the
 * only thing that makes one ours.
 *
 * "Active" is `User.lastSeenAt`, stamped about every five minutes while
 * someone is signed in (any page: My account, an event's own pages, My
 * Reviews). Sign-ins are `LoginEvent` rows, recorded since July 28, 2026.
 * Visits to a page are not recorded for signed-in pages, so neither figure
 * is "opened My account" exactly.
 *
 * Counts only: no names, addresses or other personal data leave this file.
 * Call inside the organisation's tenant lane (Registration, Speaker and
 * AbstractReviewer have row policies; User and LoginEvent have none).
 */
import { db } from "@/lib/db";
import { reviewerPoolIds } from "@/lib/abstract-reviewer-access";

export const PORTAL_ROLES = ["REGISTRANT", "SUBMITTER", "REVIEWER"] as const;
export type PortalRole = (typeof PORTAL_ROLES)[number];

/** How many weeks of sign-ins the card shows. */
export const PORTAL_WEEKS = 8;

const DAY_MS = 24 * 3600_000;

export interface PortalRoleUsage {
  role: PortalRole;
  accounts: number;
  activeToday: number;
  active7d: number;
  active30d: number;
  everActive: number;
}

export interface PortalUsage {
  roles: PortalRoleUsage[];
  totals: Omit<PortalRoleUsage, "role">;
  /** Monday-start UTC weeks, oldest first; the last is the week in progress. */
  weekly: { weekStart: string; people: number; signIns: number }[];
  signInsRecordedFrom: string | null;
}

/** The Monday (UTC) that starts the week holding `date`. */
export function weekStartUtc(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const fromMonday = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - fromMonday * DAY_MS);
}

function usageOf(users: { lastSeenAt: Date | null }[], now: Date): Omit<PortalRoleUsage, "role"> {
  const since = (days: number) => users.filter((u) => u.lastSeenAt && now.getTime() - u.lastSeenAt.getTime() <= days * DAY_MS).length;
  return {
    accounts: users.length,
    activeToday: since(1),
    active7d: since(7),
    active30d: since(30),
    everActive: users.filter((u) => u.lastSeenAt).length,
  };
}

export async function getPortalUsage(events: { id: string; settings: unknown }[], now: Date = new Date()): Promise<PortalUsage> {
  const eventIds = events.map((e) => e.id);
  const poolIds = [...new Set(events.flatMap((e) => reviewerPoolIds(e.settings)))];
  const thisWeek = weekStartUtc(now);
  const firstWeek = new Date(thisWeek.getTime() - (PORTAL_WEEKS - 1) * 7 * DAY_MS);
  const weekly = Array.from({ length: PORTAL_WEEKS }, (_, i) => ({
    weekStart: new Date(firstWeek.getTime() + i * 7 * DAY_MS).toISOString().slice(0, 10),
    people: 0,
    signIns: 0,
  }));
  const empty: PortalUsage = {
    roles: PORTAL_ROLES.map((role) => ({ role, ...usageOf([], now) })),
    totals: usageOf([], now),
    weekly,
    signInsRecordedFrom: null,
  };
  if (eventIds.length === 0) return empty;

  const users = await db.user.findMany({
    where: {
      role: { in: [...PORTAL_ROLES] },
      OR: [
        { registrations: { some: { eventId: { in: eventIds } } } },
        { speakers: { some: { eventId: { in: eventIds } } } },
        { abstractReviewerOf: { some: { abstract: { eventId: { in: eventIds } } } } },
        ...(poolIds.length ? [{ id: { in: poolIds } }] : []),
      ],
    },
    select: { id: true, role: true, lastSeenAt: true },
  });
  if (users.length === 0) return empty;

  const [signIns, firstSignIn] = await Promise.all([
    db.loginEvent.findMany({
      where: { userId: { in: users.map((u) => u.id) }, outcome: "SUCCESS", createdAt: { gte: firstWeek } },
      select: { userId: true, createdAt: true },
    }),
    db.loginEvent.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);

  const peoplePerWeek = weekly.map(() => new Set<string>());
  for (const s of signIns) {
    const i = Math.floor((weekStartUtc(s.createdAt).getTime() - firstWeek.getTime()) / (7 * DAY_MS));
    if (i < 0 || i >= PORTAL_WEEKS || !s.userId) continue;
    weekly[i].signIns += 1;
    peoplePerWeek[i].add(s.userId);
  }
  weekly.forEach((w, i) => (w.people = peoplePerWeek[i].size));

  return {
    roles: PORTAL_ROLES.map((role) => ({ role, ...usageOf(users.filter((u) => u.role === role), now) })),
    totals: usageOf(users, now),
    weekly,
    signInsRecordedFrom: firstSignIn?.createdAt.toISOString() ?? null,
  };
}
