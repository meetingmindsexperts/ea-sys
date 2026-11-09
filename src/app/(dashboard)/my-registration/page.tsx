import Link from "next/link";
import { AlertCircle, Calendar, CalendarX, MapPin, Ticket } from "lucide-react";
import { db } from "@/lib/db";
import { DEFAULT_EVENT_TIMEZONE, formatEventDateRange } from "@/lib/event-time";
import { certificateMeta, certificateTitle, cmeTotals, findReleasedCertificates, type PortalCertificate } from "@/lib/registrant-certificates";
import { ownRegistrationWhere, type RegistrantScope } from "@/lib/registrant-access";
import { loadRegistrantPortal } from "@/lib/registrant-portal";
import {
  buildJourney,
  JOURNEY_REGISTRATION_FIELDS,
  loadSurveyFacts,
  surveyLinesFor,
  type JourneyStep,
  type SurveyLine,
} from "@/lib/registrant-journey";
import { CertificateList } from "@/components/registrant/certificate-list";
import { CmeTotalsCard } from "@/components/registrant/cme-totals-card";
import { ConfirmEmailNotice } from "@/components/registrant/confirm-email-notice";
import { JourneySteps, SurveyList } from "@/components/registrant/journey-steps";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, SectionHeading } from "@/components/ui/typography";

/**
 * Every event a person is registered for, each as a journey: registered,
 * paid, checked in, survey, certificate (Nov 4, 2026; journey Nov 9, 2026,
 * docs/MY_PORTAL_PLAN.md phase 2).
 *
 * A LIST, NOT A SECOND PORTAL. Until April 21 this route rendered a full
 * cross-event registration page, which was removed so that a registration is
 * viewed, edited and paid for on its own event's page (`322b421e`). That still
 * holds: each card links to /e/{slug}/my-registration and nothing here edits.
 * The journey only SAYS where each event stands, and the event page is where
 * a person acts on it.
 *
 * It is always the list, even of one (owner, Nov 4, 2026): it is the page the
 * event pages' "All my events" link names, so it must not bounce a person
 * with one registration back to where they came from.
 */

const EVENT_FIELDS = {
  id: true,
  name: true,
  slug: true,
  startDate: true,
  endDate: true,
  timezone: true,
  venue: true,
  city: true,
  country: true,
  eventType: true,
  surveyConfig: true,
} as const;

async function loadEvents(scope: RegistrantScope) {
  const [registrations, certificates] = await Promise.all([
    db.registration.findMany({
      // Linked registrations, plus those carrying the address once the
      // account has proven it owns it (registrant-access.ts).
      where: { status: { not: "CANCELLED" }, ...ownRegistrationWhere(scope) },
      select: { ...JOURNEY_REGISTRATION_FIELDS, event: { select: EVENT_FIELDS } },
      orderBy: { createdAt: "desc" },
    }),
    findReleasedCertificates(scope),
  ]);
  const facts = await loadSurveyFacts(
    [...new Set(registrations.map((r) => r.event.id))],
    registrations.map((r) => r.id),
  );
  return { registrations, certificates, ...facts };
}

type Loaded = Awaited<ReturnType<typeof loadEvents>>;

interface EventSummary {
  id: string;
  name: string;
  slug: string;
  startDate: Date;
  endDate: Date;
  timezone: string;
}

interface RegistrationJourney {
  id: string;
  ticketName: string | null;
  steps: JourneyStep[];
  surveys: SurveyLine[];
}

interface EventCardData {
  event: EventSummary;
  where: string;
  journeys: RegistrationJourney[];
  certificates: PortalCertificate[];
}

/** One card per event: its registrations' journeys and its certificates. */
function buildCards(data: Loaded, now: Date): EventCardData[] {
  const { registrations, certificates, surveys, responses } = data;
  const events = new Map<string, EventSummary>();
  for (const r of registrations) events.set(r.event.id, r.event);
  // A speaker's appreciation certificate can belong to an event they never registered for.
  for (const c of certificates) if (!events.has(c.event.id)) events.set(c.event.id, c.event);

  return [...events.values()].map((event) => {
    const regs = registrations.filter((r) => r.event.id === event.id);
    const certs = certificates.filter((c) => c.event.id === event.id);
    const first = regs[0]?.event;
    const journeys = regs.map((r) => {
      const lines = surveyLinesFor({
        registration: r,
        event: r.event,
        surveys: surveys.filter((s) => s.eventId === event.id),
        responses: responses.filter((x) => x.registrationId === r.id),
        now,
      });
      return {
        id: r.id,
        ticketName: r.ticketType?.name ?? null,
        steps: buildJourney({ registration: r, event: r.event, surveys: lines, certificateCount: certs.length, now }),
        surveys: lines,
      };
    });
    return {
      event,
      where: first ? [first.venue, first.city, first.country].filter(Boolean).join(", ") : "",
      journeys,
      certificates: certs,
    };
  });
}

/** What needs the person, across every event: surveys to answer and payments due. */
function toDo(cards: EventCardData[]): { surveys: number; payments: number } {
  let surveys = 0;
  let payments = 0;
  for (const card of cards)
    for (const j of card.journeys) {
      surveys += j.surveys.filter((s) => !s.answered && s.open).length;
      if (j.steps.some((s) => s.key === "payment" && s.state === "action")) payments += 1;
    }
  return { surveys, payments };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export default async function MyRegistrationPage() {
  const { scope, data } = await loadRegistrantPortal("/my-registration", loadEvents);
  const now = new Date();
  const cards = buildCards(data, now);
  // Upcoming soonest first; past newest first.
  const upcoming = cards.filter((c) => c.event.endDate.getTime() >= now.getTime()).sort((a, b) => a.event.startDate.getTime() - b.event.startDate.getTime());
  const past = cards.filter((c) => c.event.endDate.getTime() < now.getTime()).sort((a, b) => b.event.startDate.getTime() - a.event.startDate.getTime());
  const cme = cmeTotals(data.certificates, now, DEFAULT_EVENT_TIMEZONE);
  const todo = toDo(cards);
  const todoParts = [
    todo.surveys > 0 && plural(todo.surveys, "survey to answer", "surveys to answer"),
    todo.payments > 0 && plural(todo.payments, "payment due", "payments due"),
  ].filter(Boolean);

  return (
    // Mobile first (owner, Nov 4, 2026): most people open this from the
    // confirmation email on a phone. Everything stacks and buttons span the
    // card by default; from `sm` up the actions sit beside their text.
    <div className="mx-auto w-full max-w-3xl space-y-4 sm:space-y-6 sm:py-2">
      <PageHeader title="My events" description={`Signed in as ${scope.email}`} />

      {/* Registrations made earlier under this address appear once it is
          confirmed. Never a count: that would tell an unproven account the
          address has history. */}
      {!scope.confirmed && <ConfirmEmailNotice email={scope.email} />}

      {todoParts.length > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900" role="status">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          <p className="text-sm">
            <span className="font-semibold">Waiting for you: </span>
            {todoParts.join(" and ")}. Look for the amber steps below.
          </p>
        </div>
      )}

      {cme.allTime > 0 && <CmeTotalsCard {...cme} />}

      {cards.length === 0 && (
        <Card>
          <CardContent className="space-y-2 py-10 text-center">
            <CalendarX className="mx-auto h-10 w-10 text-muted-foreground/40" aria-hidden />
            <p className="font-medium">No registrations yet</p>
            <p className="text-sm text-muted-foreground">
              Use the event link from the organiser to register. It will show here once you have.
            </p>
          </CardContent>
        </Card>
      )}

      {upcoming.length > 0 && (
        <section className="space-y-3">
          <SectionHeading title="Upcoming" />
          {upcoming.map((card) => (
            <EventCard key={card.event.id} card={card} />
          ))}
        </section>
      )}

      {past.length > 0 && (
        <section className="space-y-3">
          <SectionHeading title="Past" />
          {past.map((card) => (
            <EventCard key={card.event.id} card={card} />
          ))}
        </section>
      )}
    </div>
  );
}

function EventCard({ card }: { card: EventCardData }) {
  const { event, where, journeys, certificates } = card;
  return (
    <Card className="gap-4">
      <CardHeader className="space-y-2">
        <CardTitle className="leading-snug">{event.name}</CardTitle>
        <div className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:flex-wrap sm:gap-x-4">
          <span className="flex items-start gap-1.5">
            <Calendar className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            {formatEventDateRange(event.startDate, event.endDate, event.timezone)}
          </span>
          {where && (
            <span className="flex items-start gap-1.5">
              <MapPin className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              {where}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {journeys.map((j) => (
          <div key={j.id} className="space-y-3">
            {j.ticketName && (
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Ticket className="h-3.5 w-3.5" aria-hidden />
                {j.ticketName}
              </p>
            )}
            <JourneySteps steps={j.steps} />
            <SurveyList surveys={j.surveys} />
          </div>
        ))}
        {journeys.length > 0 && (
          <Button asChild className="h-11 w-full sm:h-9 sm:w-auto">
            <Link href={`/e/${event.slug}/my-registration`}>Open registration</Link>
          </Button>
        )}

        {certificates.length > 0 && (
          <CertificateList certificates={certificates.map((c) => ({ id: c.id, title: certificateTitle(c), meta: certificateMeta(c) }))} />
        )}
      </CardContent>
    </Card>
  );
}
