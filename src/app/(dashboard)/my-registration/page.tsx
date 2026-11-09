import Link from "next/link";
import {
  AlertCircle,
  ArrowRight,
  Award,
  Calendar,
  CalendarCheck,
  CalendarClock,
  CalendarX,
  ClipboardList,
  CreditCard,
  GraduationCap,
  MapPin,
  Ticket,
} from "lucide-react";
import { db } from "@/lib/db";
import { DEFAULT_EVENT_TIMEZONE, formatEventDateRange, localDateInTz } from "@/lib/event-time";
import { cmeTotals, findReleasedCertificates, type PortalCertificate } from "@/lib/registrant-certificates";
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
import { EventBanner } from "@/components/public/event-banner";
import { ConfirmEmailNotice } from "@/components/registrant/confirm-email-notice";
import { JourneySteps } from "@/components/registrant/journey-steps";
import { TakeSurveyButton } from "@/components/registrant/take-survey-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader, SectionHeading } from "@/components/ui/typography";
import { cn } from "@/lib/utils";

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
  bannerImage: true,
  bannerImageMobile: true,
} as const;

async function loadEvents(scope: RegistrantScope) {
  const [registrations, certificates, user] = await Promise.all([
    db.registration.findMany({
      // Linked registrations, plus those carrying the address once the
      // account has proven it owns it (registrant-access.ts).
      where: { status: { not: "CANCELLED" }, ...ownRegistrationWhere(scope) },
      select: { ...JOURNEY_REGISTRATION_FIELDS, event: { select: EVENT_FIELDS } },
      orderBy: { createdAt: "desc" },
    }),
    findReleasedCertificates(scope),
    db.user.findUnique({ where: { id: scope.userId }, select: { firstName: true } }),
  ]);
  const facts = await loadSurveyFacts(
    registrations.map((r) => ({ id: r.id, eventId: r.event.id })),
    new Date(),
  );
  return { registrations, certificates, firstName: user?.firstName?.trim() || null, ...facts };
}

type Loaded = Awaited<ReturnType<typeof loadEvents>>;

interface EventSummary {
  id: string;
  name: string;
  slug: string;
  startDate: Date;
  endDate: Date;
  timezone: string;
  /** Absent for an event known only from a certificate. */
  bannerImage?: string | null;
  bannerImageMobile?: string | null;
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
  const liveLinks = new Set(data.liveLinks);
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
        liveLinks,
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

/** One thing waiting for the person: a survey to answer or a payment due. */
type WaitingItem =
  | { kind: "survey"; key: string; eventName: string; registrationId: string; surveyId: string | null; surveyName: string; certificate: boolean }
  | { kind: "payment"; key: string; eventName: string; slug: string };

function waitingItems(cards: EventCardData[]): WaitingItem[] {
  const items: WaitingItem[] = [];
  for (const { event, journeys } of cards)
    for (const j of journeys) {
      if (j.steps.some((s) => s.key === "payment" && s.state === "action")) {
        items.push({ kind: "payment", key: `pay-${j.id}`, eventName: event.name, slug: event.slug });
      }
      for (const s of j.surveys) {
        if (s.answered || !s.open) continue;
        items.push({ kind: "survey", key: `survey-${j.id}-${s.id ?? "cert"}`, eventName: event.name, registrationId: j.id, surveyId: s.id, surveyName: s.name, certificate: s.certificate });
      }
    }
  return items;
}

/** "In 3 days", "Tomorrow", "Today", "Happening now", counted in the event's own calendar. */
function countdown(event: EventSummary, now: Date): string {
  if (now.getTime() >= event.startDate.getTime()) return "Happening now";
  const day = (d: Date) => Date.parse(`${localDateInTz(d, event.timezone)}T00:00:00Z`);
  const days = Math.round((day(event.startDate) - day(now)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

export default async function MyRegistrationPage() {
  const { scope, data } = await loadRegistrantPortal("/my-registration", loadEvents);
  const now = new Date();
  const cards = buildCards(data, now);
  // Upcoming soonest first; past newest first.
  const upcoming = cards.filter((c) => c.event.endDate.getTime() >= now.getTime()).sort((a, b) => a.event.startDate.getTime() - b.event.startDate.getTime());
  const past = cards.filter((c) => c.event.endDate.getTime() < now.getTime()).sort((a, b) => b.event.startDate.getTime() - a.event.startDate.getTime());
  const cme = cmeTotals(data.certificates, now, DEFAULT_EVENT_TIMEZONE);
  const waiting = waitingItems(cards);
  const [next, ...laterUpcoming] = upcoming;

  return (
    // Mobile first (owner, Nov 4, 2026): most people open this from the
    // confirmation email on a phone. Everything stacks and buttons span the
    // card by default; from `sm` up the actions sit beside their text.
    // The whole right pane (owner, Nov 9, 2026), events two to a row from xl:
    // below that a card is too narrow for the five-step journey.
    <div className="w-full space-y-6 sm:space-y-8 sm:py-2">
      <PageHeader title={data.firstName ? `Welcome back, ${data.firstName}` : "My events"} description={`Signed in as ${scope.email}`} />

      {/* Registrations made earlier under this address appear once it is
          confirmed. Never a count: that would tell an unproven account the
          address has history. */}
      {!scope.confirmed && <ConfirmEmailNotice email={scope.email} />}

      {cards.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryTile icon={CalendarClock} label="Upcoming" value={upcoming.length} />
          <SummaryTile icon={CalendarCheck} label="Past events" value={past.length} />
          <SummaryTile icon={Award} label="Certificates" value={data.certificates.length} href={data.certificates.length > 0 ? "/my-registration/certificates" : undefined} />
          <SummaryTile icon={GraduationCap} label={`CME hours in ${cme.year}`} value={cme.thisYear} note={cme.allTime > 0 ? `${cme.allTime} in total` : undefined} />
        </div>
      )}

      {waiting.length > 0 && <WaitingForYou items={waiting} />}

      {cards.length === 0 && (
        <Card>
          <CardContent className="space-y-2 py-10 text-center">
            <CalendarX className="mx-auto h-10 w-10 text-muted-foreground/40" aria-hidden />
            <p className="font-medium">No registrations yet</p>
            <p className="text-sm text-muted-foreground">
              When you register for an event it shows here, with its certificate and CME hours.
            </p>
            {/* An account can now exist before any registration (/signup, Nov 5 2026). */}
            <Button asChild className="mt-3">
              <Link href="/catalogue">Browse events</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {next && (
        <section className="space-y-3" aria-labelledby="next-up">
          <SectionHeading title={<span id="next-up">Next up</span>} />
          <div className="grid gap-4 xl:grid-cols-2">
            <div className="xl:col-span-2">
              <EventCard card={next} featured={countdown(next.event, now)} />
            </div>
            {laterUpcoming.map((card) => (
              <EventCard key={card.event.id} card={card} />
            ))}
          </div>
        </section>
      )}

      {past.length > 0 && (
        <section className="space-y-3" aria-labelledby="past-events">
          <SectionHeading title={<span id="past-events">Past events</span>} />
          <div className="grid gap-4 xl:grid-cols-2">
            {past.map((card) => (
              <EventCard key={card.event.id} card={card} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function SummaryTile({ icon: Icon, label, value, note, href }: { icon: typeof Award; label: string; value: number; note?: string; href?: string }) {
  const body = (
    <>
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <span className="mt-3 block text-2xl font-semibold tabular-nums tracking-tight">{value}</span>
      <span className="block text-xs text-muted-foreground">{label}</span>
      {note && <span className="block text-xs text-muted-foreground">{note}</span>}
    </>
  );
  const tile = "block rounded-xl border bg-card p-4 shadow-[0_1px_3px_rgba(0,0,0,0.06)]";
  if (!href) return <div className={tile}>{body}</div>;
  return (
    <Link href={href} className={cn(tile, "transition-colors hover:border-primary/40 hover:bg-primary/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}>
      {body}
    </Link>
  );
}

/** Everything that needs the person, with its action, so nobody has to hunt through the cards. */
function WaitingForYou({ items }: { items: WaitingItem[] }) {
  return (
    <section aria-labelledby="waiting-for-you" className="overflow-hidden rounded-xl border border-amber-300 bg-amber-50/60">
      <div className="flex items-center gap-2 border-b border-amber-200 px-4 py-3">
        <AlertCircle className="h-5 w-5 text-amber-700" aria-hidden />
        <h2 id="waiting-for-you" className="font-semibold text-amber-950">
          Waiting for you <span className="font-normal text-amber-900">({items.length})</span>
        </h2>
      </div>
      <ul className="divide-y divide-amber-200/70">
        {items.map((item) => (
          <li key={item.key} className="flex flex-col gap-3 bg-white/70 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              {item.kind === "survey" ? (
                <ClipboardList className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden />
              ) : (
                <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium">{item.kind === "survey" ? `Answer the ${item.surveyName}` : "Complete your payment"}</p>
                <p className="text-xs text-muted-foreground">
                  {item.eventName}
                  {item.kind === "survey" && item.certificate && " · the certificate survey"}
                </p>
              </div>
            </div>
            {item.kind === "survey" ? (
              <TakeSurveyButton registrationId={item.registrationId} surveyId={item.surveyId} />
            ) : (
              <Button asChild size="sm" className="h-10 w-full sm:h-8 sm:w-auto">
                <Link href={`/e/${item.slug}/my-registration`}>Pay now</Link>
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The event's month and day, in its own time zone, for scanning a list by date. */
function DateBlock({ event }: { event: EventSummary }) {
  const part = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: event.timezone }).format(event.startDate);
  return (
    <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center rounded-xl border bg-background text-center" aria-hidden>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-label">{part({ month: "short" })}</span>
      <span className="text-xl font-semibold leading-none tabular-nums">{part({ day: "numeric" })}</span>
    </div>
  );
}

function EventCard({ card, featured }: { card: EventCardData; featured?: string }) {
  const { event, where, journeys, certificates } = card;
  const hasBanner = Boolean(event.bannerImage || event.bannerImageMobile);
  return (
    <Card id={`event-${event.id}`} className={cn("h-full gap-0 overflow-hidden py-0", featured && "border-primary/40 ring-1 ring-primary/20")}>
      {/* The event's own branding, so it is recognised before it is read: the
          mobile banner on a phone, the web banner wider up, whichever exists
          when only one does (EventBanner, as on the event's own pages). Capped
          in height and never cropped: a banner carries its own text. */}
      {hasBanner && (
        <div className="flex justify-center border-b bg-white">
          <EventBanner banner={event.bannerImage} bannerMobile={event.bannerImageMobile} name={event.name} className="block h-auto max-h-44 w-auto max-w-full sm:max-h-36" />
        </div>
      )}

      <div className="flex items-start gap-4 p-4 sm:p-5">
        <DateBlock event={event} />
        <div className="min-w-0 flex-1 space-y-1.5">
          {featured && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-label">
              <CalendarClock className="h-3.5 w-3.5" aria-hidden />
              {featured}
            </span>
          )}
          <h3 className="text-base font-semibold leading-snug">{event.name}</h3>
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
            {journeys.map((j) =>
              j.ticketName ? (
                <span key={j.id} className="flex items-start gap-1.5">
                  <Ticket className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                  {j.ticketName}
                </span>
              ) : null,
            )}
          </div>
        </div>
      </div>

      {journeys.length > 0 && (
        <div className="space-y-4 px-4 pb-5 sm:px-5">
          {journeys.map((j) => (
            <JourneySteps key={j.id} steps={j.steps} />
          ))}
        </div>
      )}

      {/* mt-auto: two cards in a row end level however long their journeys are. */}
      <div className="mt-auto flex flex-col gap-2 border-t bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:px-5">
        {journeys.length > 0 && (
          <Button asChild variant={featured ? "default" : "outline"} className="h-11 w-full sm:h-9 sm:w-auto">
            <Link href={`/e/${event.slug}/my-registration`}>
              {featured ? "View registration and badge" : "Open registration"}
              <ArrowRight className="ml-1.5 h-4 w-4" aria-hidden />
            </Link>
          </Button>
        )}
        {certificates.length > 0 && (
          <Button asChild variant="ghost" className="h-11 w-full text-label hover:text-label sm:ml-auto sm:h-9 sm:w-auto">
            <Link href={`/my-registration/certificates#event-${event.id}`}>
              <Award className="mr-1.5 h-4 w-4" aria-hidden />
              {certificates.length === 1 ? "1 certificate" : `${certificates.length} certificates`}
            </Link>
          </Button>
        )}
      </div>
    </Card>
  );
}
