/**
 * Server side of live polls (Oct 6, 2026): the webinar's room session for a
 * console request, and polls with their tallies. Server only.
 */
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { readWebinarSettings } from "@/lib/webinar";
import { livePollsEnabled, readPollOptions, tallyPoll, type LivePollOption, type LivePollStatus, type PollTally } from "./live-polls";

/** The event (through the gate's eventWhere) and its webinar room session. */
export async function pollContextFor(eventWhere: Prisma.EventWhereInput) {
  const event = await db.event.findFirst({ where: eventWhere, select: { id: true, organizationId: true, settings: true } });
  if (!event) return null;
  const webinar = readWebinarSettings(event.settings);
  return {
    eventId: event.id,
    organizationId: event.organizationId,
    sessionId: webinar?.sessionId ?? null,
    /** The organiser's "Enable live polls" switch. */
    enabled: livePollsEnabled(webinar),
  };
}

export interface ConsolePoll {
  id: string;
  question: string;
  options: LivePollOption[];
  allowMultiple: boolean;
  status: LivePollStatus;
  showResults: boolean;
  openedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  tally: PollTally;
}

const POLL_SELECT = {
  id: true,
  question: true,
  options: true,
  allowMultiple: true,
  status: true,
  showResults: true,
  openedAt: true,
  closedAt: true,
  createdAt: true,
} satisfies Prisma.LivePollSelect;

/** The session's polls, newest first, each with its tally (one vote read for all). */
export async function listPollsWithTally(eventId: string, sessionId: string): Promise<ConsolePoll[]> {
  const polls = await db.livePoll.findMany({
    where: { eventId, sessionId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: POLL_SELECT,
  });
  if (polls.length === 0) return [];
  const votes = await db.livePollVote.findMany({
    where: { pollId: { in: polls.map((p) => p.id) } },
    select: { pollId: true, choices: true },
  });
  return polls.map((p) => {
    const options = readPollOptions(p.options);
    return {
      ...p,
      options,
      status: p.status as LivePollStatus,
      tally: tallyPoll(options, votes.filter((v) => v.pollId === p.id)),
    };
  });
}

/** What an attendee's page receives about the current poll. */
export interface ViewerPoll {
  id: string;
  question: string;
  options: LivePollOption[];
  allowMultiple: boolean;
  status: "OPEN" | "CLOSED";
  /** This viewer's answer, if any (staff testing the page have none). */
  myChoices: string[] | null;
  /** Only when the producer shows results. */
  results: PollTally | null;
}

// Results are read by every viewer on every refresh: cached per poll for a
// few seconds so 1,000 viewers do not each read every vote row.
const TALLY_TTL_MS = 5_000;
const tallyCache = new Map<string, { at: number; tally: PollTally }>();

async function cachedTally(pollId: string, options: LivePollOption[]): Promise<PollTally> {
  const hit = tallyCache.get(pollId);
  if (hit && Date.now() - hit.at < TALLY_TTL_MS) return hit.tally;
  const votes = await db.livePollVote.findMany({ where: { pollId }, select: { choices: true } });
  const tally = tallyPoll(options, votes);
  tallyCache.set(pollId, { at: Date.now(), tally });
  if (tallyCache.size > 500) tallyCache.clear();
  return tally;
}

/** Forget a poll's cached results (after this viewer's own vote). */
export function forgetTally(pollId: string): void {
  tallyCache.delete(pollId);
}

/**
 * The poll an attendee sees: the session's most recently launched poll, while
 * it is open, or after it closes if the producer shows its results. Nothing
 * when the organiser has live polls switched off.
 */
export async function viewerPoll(args: {
  eventId: string;
  sessionId: string;
  enabled: boolean;
  registrationId: string | null;
}): Promise<ViewerPoll | null> {
  if (!args.enabled) return null;
  const poll = await db.livePoll.findFirst({
    where: { eventId: args.eventId, sessionId: args.sessionId, status: { in: ["OPEN", "CLOSED"] } },
    orderBy: { openedAt: "desc" },
    select: { id: true, question: true, options: true, allowMultiple: true, status: true, showResults: true },
  });
  if (!poll || (poll.status === "CLOSED" && !poll.showResults)) return null;
  const options = readPollOptions(poll.options);
  const [mine, results] = await Promise.all([
    args.registrationId
      ? db.livePollVote.findUnique({
          where: { pollId_registrationId: { pollId: poll.id, registrationId: args.registrationId } },
          select: { choices: true },
        })
      : Promise.resolve(null),
    poll.showResults ? cachedTally(poll.id, options) : Promise.resolve(null),
  ]);
  return {
    id: poll.id,
    question: poll.question,
    options,
    allowMultiple: poll.allowMultiple,
    status: poll.status as "OPEN" | "CLOSED",
    myChoices: mine ? (Array.isArray(mine.choices) ? (mine.choices as string[]) : []) : null,
    results,
  };
}
