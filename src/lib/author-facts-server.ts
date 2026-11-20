/**
 * The server's reader for author-facts.ts: one query per event, answered per
 * registration. See that file for what the facts are and why they are read
 * and never stored.
 *
 * WHO A REGISTRATION'S PERSON IS (review of b4493d67, HIGH): the speaker
 * record that POINTS at the registration (`Speaker.sourceRegistrationId`), or
 * any speaker record on the event with the SAME ADDRESS. The pointer alone
 * missed people: nothing links at registration time, so an author who signs
 * up where nothing is on sale and registers afterwards (the public form, Add
 * Registration) is never pointed at. The other readers of "this person's
 * speaker record" resolve the same way (certificates' recipients report, the
 * activity feed, the tag sync). A CANCELLED registration is nobody's live
 * registration and carries no facts, even where an old pointer still names it.
 */
import { db } from "@/lib/db";
import { equalsIgnoringCase } from "@/lib/like-escape";
import { abstractOutcomeOf, type AuthorFacts, type SpeakerPlace } from "@/lib/author-facts";
import { registrationFacultyByHand, registrationOnFacultyType, speakerKindOf } from "@/lib/speaker-kinds";

type RegistrationRow = {
  id: string;
  status: string;
  createdSource: string | null;
  attendee: { email: string } | null;
  ticketType?: { isFaculty?: boolean | null } | null;
};
type FactsFor = (registration: RegistrationRow) => AuthorFacts;

type PersonFacts = {
  statuses: string[];
  /** Came through the abstract sign-up door ("abstract" or "both"), whatever made the registration. */
  signedUpForAbstracts: boolean;
  /** A session role, a topic, or an abstract of theirs placed on the agenda (a cancelled session is not it). */
  onProgramme: boolean;
  /** What the Speakers page's rule reads (speaker-kinds.ts), kept so each row asks it with its own type. */
  submissions: { abstracts: { status: string }[]; sessionProposals: { status: string }[]; submitterSource: string | null };
};

const NO_FACTS: AuthorFacts = { abstractOutcome: null, speakerPlace: null };
const sameAddress = (email: string) => email.trim().toLowerCase();

/**
 * Loads the facts of every speaker record on the event and returns the
 * function that answers for one registration row. Called inside the caller's
 * tenant lane (Speaker, Abstract and the session tables are tenant tables).
 */
export async function loadAuthorFacts(eventId: string): Promise<FactsFor> {
  const speakers = await db.speaker.findMany({
    where: { eventId },
    select: {
      id: true,
      email: true,
      sourceRegistrationId: true,
      submitterSource: true,
      // An accepted abstract is put on the agenda by its own id, with no speaker row for its author.
      abstracts: { select: { status: true, eventSession: { select: { status: true } }, sessionTopic: { select: { id: true } } } },
      sessionProposals: { select: { status: true } },
      sessions: { select: { session: { select: { status: true } } } },
      _count: { select: { topicSpeakers: true } },
    },
  });

  const byRegistration = new Map<string, Map<string, PersonFacts>>();
  const byAddress = new Map<string, Map<string, PersonFacts>>();
  const file = (index: Map<string, Map<string, PersonFacts>>, key: string, speakerId: string, facts: PersonFacts) => {
    const entry = index.get(key) ?? new Map<string, PersonFacts>();
    entry.set(speakerId, facts);
    index.set(key, entry);
  };

  for (const s of speakers) {
    // A cancelled session is not the programme.
    const onProgramme =
      s.sessions.some((r) => r.session.status !== "CANCELLED") ||
      s._count.topicSpeakers > 0 ||
      s.abstracts.some((a) => (a.eventSession !== null && a.eventSession.status !== "CANCELLED") || a.sessionTopic !== null);
    const facts: PersonFacts = {
      statuses: s.abstracts.map((a) => a.status),
      signedUpForAbstracts: s.submitterSource === "abstract" || s.submitterSource === "both",
      onProgramme,
      submissions: { abstracts: s.abstracts, sessionProposals: s.sessionProposals, submitterSource: s.submitterSource },
    };
    if (s.sourceRegistrationId) file(byRegistration, s.sourceRegistrationId, s.id, facts);
    file(byAddress, sameAddress(s.email), s.id, facts);
  }

  return (registration) => {
    if (registration.status === "CANCELLED") return NO_FACTS;
    // Keyed by speaker id, so a record found both ways counts once.
    const people = new Map<string, PersonFacts>([
      ...(byRegistration.get(registration.id) ?? []),
      ...(registration.attendee ? (byAddress.get(sameAddress(registration.attendee.email)) ?? []) : []),
    ]);
    const all = [...people.values()];
    const signedUp = registration.createdSource === "PUBLIC_SUBMITTER" || all.some((p) => p.signedUpForAbstracts);
    const onProgramme = all.some((p) => p.onProgramme);
    // Off the programme, "a speaker" is one the organisers invited: the
    // Speakers page's own rule, asked with THIS row's facts (speaker-kinds.ts).
    // Put on the Faculty type by the organisers, they are invited whatever
    // they submitted (owner, Nov 20, 2026: authors are kept apart "except
    // those who are invited and submitted"); otherwise someone who is there
    // because they submitted is an author, not a speaker. A Faculty
    // registration the OLD abstract sign-up gave an author does not count:
    // the rule says why.
    const ownRegistration = { status: registration.status, createdSource: registration.createdSource, ticketType: { isFaculty: registration.ticketType?.isFaculty === true } };
    const onFacultyType = registrationOnFacultyType(ownRegistration);
    const facultyByHand = registrationFacultyByHand(ownRegistration);
    const invited = all.some((p) => speakerKindOf({ ...p.submissions, onFacultyType, facultyByHand }) === "invited");
    const offProgramme: SpeakerPlace | null = invited ? "record" : null;
    return {
      abstractOutcome: abstractOutcomeOf(all.flatMap((p) => p.statuses), signedUp),
      speakerPlace: onProgramme ? "programme" : offProgramme,
    };
  };
}

/**
 * The other direction: a speaker's LIVE registration on the event, by the same
 * two ways (the pointer, else the same address), never a cancelled one.
 * Returns the function that answers for one speaker record.
 */
export async function loadLiveRegistrationOf(
  eventId: string,
): Promise<(speaker: { sourceRegistrationId: string | null; email: string }) => string | null> {
  const live = await db.registration.findMany({
    where: { eventId, status: { not: "CANCELLED" } },
    select: { id: true, attendee: { select: { email: true } } },
    // Oldest first, so two rows on one address (a changed email can make such
    // a pair) always answer the same one: the first registration wins.
    orderBy: { createdAt: "asc" },
  });
  const ids = new Set(live.map((r) => r.id));
  const byAddress = new Map<string, string>();
  for (const r of live) {
    const address = sameAddress(r.attendee.email);
    if (!byAddress.has(address)) byAddress.set(address, r.id);
  }
  return (speaker) => {
    if (speaker.sourceRegistrationId && ids.has(speaker.sourceRegistrationId)) return speaker.sourceRegistrationId;
    return byAddress.get(sameAddress(speaker.email)) ?? null;
  };
}

/**
 * Which of these speakers hold a live registration on the event: the same two
 * ways as above (the pointer, else the same address, exact whatever its case).
 *
 * Reads only what it is asked about (review of 54404a7a, MED): the speakers
 * list is loaded by a dozen screens, and the first version read every live
 * registration of the event for each of them. Callers pass the few speakers
 * the answer matters for (the accepted authors).
 */
export async function speakersWithLiveRegistration(
  eventId: string,
  speakers: readonly { id: string; sourceRegistrationId: string | null; email: string }[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (speakers.length === 0) return found;
  const pointers = [...new Set(speakers.flatMap((s) => (s.sourceRegistrationId ? [s.sourceRegistrationId] : [])))];
  const livePointers = new Set(
    pointers.length === 0
      ? []
      : (await db.registration.findMany({ where: { eventId, id: { in: pointers }, status: { not: "CANCELLED" } }, select: { id: true } })).map((r) => r.id),
  );
  for (const s of speakers) if (s.sourceRegistrationId && livePointers.has(s.sourceRegistrationId)) found.add(s.id);

  const byAddress = speakers.filter((s) => !found.has(s.id) && s.email.trim() !== "");
  if (byAddress.length === 0) return found;
  const rows = await db.registration.findMany({
    where: { eventId, status: { not: "CANCELLED" }, OR: byAddress.map((s) => ({ attendee: { email: equalsIgnoringCase(s.email.trim()) } })) },
    select: { attendee: { select: { email: true } } },
  });
  const registered = new Set(rows.map((r) => sameAddress(r.attendee.email)));
  for (const s of byAddress) if (registered.has(sameAddress(s.email))) found.add(s.id);
  return found;
}
