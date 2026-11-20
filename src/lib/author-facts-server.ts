/**
 * The server's reader for author-facts.ts: one query per event, answered per
 * registration. See that file for what the facts are and why they are read
 * and never stored.
 */
import { db } from "@/lib/db";
import { abstractOutcomeOf, type AuthorFacts } from "@/lib/author-facts";

type FactsFor = (registration: { id: string; createdSource: string | null }) => AuthorFacts;

/**
 * Loads the facts of every registration on the event that has a linked
 * speaker record, and returns the function that answers for one row. Called
 * inside the caller's tenant lane (Speaker and Abstract are tenant tables).
 */
export async function loadAuthorFacts(eventId: string): Promise<FactsFor> {
  const speakers = await db.speaker.findMany({
    where: { eventId, sourceRegistrationId: { not: null } },
    select: {
      sourceRegistrationId: true,
      abstracts: { select: { status: true } },
      _count: { select: { sessions: true, topicSpeakers: true } },
    },
  });
  // Two speaker records pointing at one registration should not happen; if they do, both count.
  const byRegistration = new Map<string, { statuses: string[]; onProgramme: boolean }>();
  for (const s of speakers) {
    if (!s.sourceRegistrationId) continue;
    const entry = byRegistration.get(s.sourceRegistrationId) ?? { statuses: [], onProgramme: false };
    entry.statuses.push(...s.abstracts.map((a) => a.status));
    entry.onProgramme = entry.onProgramme || s._count.sessions + s._count.topicSpeakers > 0;
    byRegistration.set(s.sourceRegistrationId, entry);
  }
  return (registration) => {
    const linked = byRegistration.get(registration.id);
    const place = linked?.onProgramme ? "programme" : "record";
    return {
      abstractOutcome: abstractOutcomeOf(linked?.statuses ?? [], registration.createdSource === "PUBLIC_SUBMITTER"),
      speakerPlace: linked ? place : null,
    };
  };
}
