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
import { abstractOutcomeOf, type AuthorFacts, type SpeakerPlace } from "@/lib/author-facts";
import { speakerKindOf } from "@/lib/speaker-kinds";

type RegistrationRow = { id: string; status: string; createdSource: string | null; attendee: { email: string } | null };
type FactsFor = (registration: RegistrationRow) => AuthorFacts;

type PersonFacts = {
  statuses: string[];
  /** Came through the abstract sign-up door ("abstract" or "both"), whatever made the registration. */
  signedUpForAbstracts: boolean;
  place: SpeakerPlace | null;
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
    // Off the programme, "a speaker" is one the organisers invited: the Speakers
    // page's own rule (speaker-kinds.ts). Someone who is there only because they
    // signed up to submit is an author, not a speaker.
    const invited = speakerKindOf({ abstracts: s.abstracts, sessionProposals: s.sessionProposals, submitterSource: s.submitterSource }) === "invited";
    const offProgramme: SpeakerPlace | null = invited ? "record" : null;
    const facts: PersonFacts = {
      statuses: s.abstracts.map((a) => a.status),
      signedUpForAbstracts: s.submitterSource === "abstract" || s.submitterSource === "both",
      place: onProgramme ? "programme" : offProgramme,
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
    const onProgramme = all.some((p) => p.place === "programme");
    const invited = all.some((p) => p.place === "record");
    const offProgramme: SpeakerPlace | null = invited ? "record" : null;
    return {
      abstractOutcome: abstractOutcomeOf(all.flatMap((p) => p.statuses), signedUp),
      speakerPlace: onProgramme ? "programme" : offProgramme,
    };
  };
}
