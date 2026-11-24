/**
 * Who uses the attendee portal (Nov 24, 2026; owner: "add these stats in
 * analytics and separate card for it"). Counts of the accounts that are not
 * staff (registrant, author and reviewer accounts) linked to the events a
 * person may read analytics for. These accounts belong to no organisation, so
 * an event is the only thing that makes one ours.
 *
 * The rows are by how the person is linked to THOSE events, not by the
 * account's role (review of 85a9b8ce3: most reviewers are speakers with an
 * author account, and a role upgraded on another event says nothing about
 * this one). One person can be in several rows; the totals count each once.
 *   - Registered: a registration on one of the events.
 *   - Abstract authors: a speaker record on one of the events with an abstract.
 *   - Reviewers: on an event's reviewer pool, or assigned an abstract on one.
 *
 * "Active" is `User.lastSeenAt`, stamped about every five minutes while
 * someone is signed in (any page: My account, an event's own pages, My
 * Reviews). Sign-ins are `LoginEvent` rows, kept 180 days, so the card's eight
 * weeks are always covered; the sign-in an abstract sign-up makes counts too.
 * Neither is tied to an event or an organisation: with a second organisation
 * on the instance, a person's activity on its events would count here as well
 * (fine while accounts are shared and there is one organisation).
 *
 * Counts only: no names, addresses or other personal data leave this file.
 * Call inside the organisation's tenant lane (Registration, Speaker, Abstract
 * and AbstractReviewer have row policies; User and LoginEvent have none).
 */
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { reviewerPoolIds } from "@/lib/abstract-reviewer-access";

export const PORTAL_ROLES = ["REGISTRANT", "SUBMITTER", "REVIEWER"] as const;
export const PORTAL_LINKS = ["REGISTERED", "AUTHOR", "REVIEWER"] as const;
export type PortalLink = (typeof PORTAL_LINKS)[number];

/** How many weeks of sign-ins the card shows. */
export const PORTAL_WEEKS = 8;

const DAY_MS = 24 * 3600_000;

export interface PortalUsageFigures {
  accounts: number;
  activeToday: number;
  active7d: number;
  active30d: number;
  everActive: number;
}

export interface PortalUsage {
  links: (PortalUsageFigures & { link: PortalLink })[];
  totals: PortalUsageFigures;
  /** Monday-start UTC weeks, oldest first; the last is the week in progress. */
  weekly: { weekStart: string; people: number; signIns: number }[];
}

/** The Monday (UTC) that starts the week holding `date`. */
export function weekStartUtc(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const fromMonday = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - fromMonday * DAY_MS);
}

function figuresOf(users: { lastSeenAt: Date | null }[], now: Date): PortalUsageFigures {
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
    links: PORTAL_LINKS.map((link) => ({ link, ...figuresOf([], now) })),
    totals: figuresOf([], now),
    weekly,
  };
  if (eventIds.length === 0) return empty;

  const inScope = { in: eventIds };
  const registered: Prisma.UserWhereInput = { registrations: { some: { eventId: inScope } } };
  const author: Prisma.UserWhereInput = { speakers: { some: { eventId: inScope, abstracts: { some: {} } } } };
  const assigned: Prisma.UserWhereInput = { abstractReviewerOf: { some: { abstract: { eventId: inScope } } } };
  // Deactivated accounts cannot sign in, so they are not portal accounts.
  const portalWhere: Prisma.UserWhereInput = {
    role: { in: [...PORTAL_ROLES] },
    deactivatedAt: null,
    OR: [registered, author, assigned, ...(poolIds.length ? [{ id: { in: poolIds } }] : [])],
  };

  const [users, signIns] = await Promise.all([
    db.user.findMany({
      where: portalWhere,
      select: {
        id: true,
        lastSeenAt: true,
        registrations: { where: { eventId: inScope }, select: { id: true }, take: 1 },
        speakers: { where: { eventId: inScope, abstracts: { some: {} } }, select: { id: true }, take: 1 },
        abstractReviewerOf: { where: { abstract: { eventId: inScope } }, select: { id: true }, take: 1 },
      },
    }),
    // Through the same filter, never a list of ids (review of 85a9b8ce3: one bind per account does not scale).
    db.loginEvent.findMany({
      where: { outcome: "SUCCESS", createdAt: { gte: firstWeek }, user: portalWhere },
      select: { userId: true, createdAt: true },
    }),
  ]);
  if (users.length === 0) return empty;

  const pool = new Set(poolIds);
  const linked: Record<PortalLink, typeof users> = {
    REGISTERED: users.filter((u) => u.registrations.length > 0),
    AUTHOR: users.filter((u) => u.speakers.length > 0),
    REVIEWER: users.filter((u) => pool.has(u.id) || u.abstractReviewerOf.length > 0),
  };

  const peoplePerWeek = weekly.map(() => new Set<string>());
  for (const s of signIns) {
    const i = Math.floor((weekStartUtc(s.createdAt).getTime() - firstWeek.getTime()) / (7 * DAY_MS));
    if (i < 0 || i >= PORTAL_WEEKS || !s.userId) continue;
    weekly[i].signIns += 1;
    peoplePerWeek[i].add(s.userId);
  }
  weekly.forEach((w, i) => (w.people = peoplePerWeek[i].size));

  return {
    links: PORTAL_LINKS.map((link) => ({ link, ...figuresOf(linked[link], now) })),
    totals: figuresOf(users, now),
    weekly,
  };
}
