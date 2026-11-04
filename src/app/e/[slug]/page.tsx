import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import type { SessionType } from "@prisma/client";
import {
  ArrowRight,
  Award,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  Clock,
  LayoutList,
  MapPin,
  MonitorPlay,
  Navigation,
  ShieldCheck,
  Users,
} from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { runWithTenant } from "@/lib/tenant-context";
import { publicEventWhereForHost } from "@/lib/public-event";
import { eventIsFull } from "@/lib/public-availability";
import { buildEventMetadata, toPlainText, truncate } from "@/lib/public-event-metadata";
import { formatEventDateRange, localDateInTz } from "@/lib/event-time";
import { BREAK_SESSION_TYPES } from "@/lib/session-enums";
import { EVENT_TYPE_LABEL } from "@/lib/catalogue";
import { eventSummary, jsonLdText, siteOrigin } from "@/lib/seo";
import { sanitizeHtml } from "@/lib/sanitize";
import { formatPersonName } from "@/lib/utils";
import {
  accreditorLabel,
  buildFaq,
  eventPageJsonLd,
  mapsUrl,
  offerLabel,
  publicRegistration,
  readAccreditations,
  type OverviewFacts,
  type RegistrationState,
} from "@/lib/event-overview";
import { editorialDisplay } from "@/app/fonts";
import { Button } from "@/components/ui/button";
import { EventBannerBand } from "@/components/public/event-banner";

/**
 * The public page of one event (Nov 4, 2026, catalogue phase 2).
 *
 * Server-rendered so that everything a person, a search engine or an AI
 * assistant needs is in the HTML: what the event is, when and where, the CME
 * hours and who accredits them, who it is for, the price, the faculty, the
 * programme, and the common questions. The registration form stays where it
 * was, one tap away at /e/{slug}/register. The rules: src/lib/event-overview.ts.
 *
 * An event that is not public (DRAFT, CANCELLED, another organisation's)
 * still goes to the form, which has always answered it with its own
 * "not found", so nothing that worked before stops working.
 *
 * Mobile first: one column with a fixed bottom bar holding the price and
 * Register; from `lg` a two-column layout with a sticky registration card.
 */

interface Props {
  params: Promise<{ slug: string }>;
}

const PUBLIC_STATUSES = ["PUBLISHED", "LIVE", "COMPLETED"] as const;

/** Once per request: metadata and the page both ask. */
const findScope = cache(async (slug: string) => {
  const host = (await headers()).get("host");
  return db.event.findFirst({
    where: await publicEventWhereForHost(host, slug, { allowIdFallback: true, statuses: [...PUBLIC_STATUSES] }),
    select: { id: true, organizationId: true, slug: true, settings: true },
  });
});

function isListed(settings: unknown): boolean {
  return (settings as { showInCatalogue?: unknown } | null)?.showInCatalogue === true;
}

/**
 * Indexed only when an organiser listed it in the catalogue: an unlisted
 * public event is usually a closed or invite-only meeting, reachable by its
 * link but not something to advertise in search results.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const [base, scope, h] = await Promise.all([
    buildEventMetadata({ slug }),
    findScope(slug).catch((err) => {
      apiLogger.warn({ err, slug, msg: "event-overview:metadata-scope-failed" });
      return null;
    }),
    headers(),
  ]);
  if (!scope) return base;
  const origin = siteOrigin(h.get("host"), h.get("x-forwarded-proto"));
  const canonical = `${origin}/e/${scope.slug}`;
  return {
    ...base,
    alternates: { canonical },
    robots: isListed(scope.settings) ? { index: true, follow: true } : { index: false, follow: true },
    openGraph: { ...base.openGraph, url: canonical },
  };
}

async function loadEvent(id: string) {
  const [event, sessions] = await Promise.all([
    db.event.findFirst({
      where: { id },
      select: {
        id: true, slug: true, name: true, description: true, startDate: true, endDate: true, timezone: true,
        venue: true, address: true, city: true, country: true, eventType: true, specialty: true, status: true,
        bannerImage: true, bannerImageMobile: true, cmeHours: true, settings: true, supportEmail: true,
        maxAttendees: true, seatCount: true,
        organization: { select: { name: true, logo: true } },
        ticketTypes: {
          // What the public form sells: active, never the hidden Faculty type.
          where: { isActive: true, isFaculty: false },
          orderBy: { sortOrder: "asc" },
          select: {
            name: true, quantity: true, soldCount: true,
            pricingTiers: {
              where: { isActive: true },
              select: { name: true, sortOrder: true, price: true, currency: true, quantity: true, soldCount: true, salesStart: true, salesEnd: true },
            },
          },
        },
        tracks: { select: { name: true }, orderBy: { sortOrder: "asc" } },
      },
    }),
    db.eventSession.findMany({
      where: { eventId: id, status: { in: ["SCHEDULED", "LIVE", "COMPLETED"] }, type: { notIn: [...BREAK_SESSION_TYPES] as SessionType[] } },
      orderBy: { startTime: "asc" },
      select: {
        startTime: true,
        speakers: { select: { speaker: { select: { id: true, title: true, firstName: true, lastName: true, jobTitle: true, organization: true, photo: true } } } },
        topics: { select: { speakers: { select: { speaker: { select: { id: true, title: true, firstName: true, lastName: true, jobTitle: true, organization: true, photo: true } } } } } },
      },
    }),
  ]);
  // A webinar's real clock is its anchor session (a console retime moves the
  // session, not Event.startDate), as the public API and calendar links use.
  const anchorId = event?.eventType === "WEBINAR" ? (event.settings as { webinar?: { sessionId?: string } } | null)?.webinar?.sessionId : undefined;
  const anchor = anchorId
    ? await db.eventSession.findFirst({ where: { id: anchorId, eventId: id }, select: { startTime: true, endTime: true } })
    : null;
  return { event: event && anchor ? { ...event, startDate: anchor.startTime, endDate: anchor.endTime } : event, sessions };
}

type Speaker = { id: string; name: string; jobTitle: string | null; organization: string | null; photo: string | null };

export default async function EventOverviewPage({ params }: Props) {
  const [{ slug }, session, h] = await Promise.all([params, auth(), headers()]);
  const origin = siteOrigin(h.get("host"), h.get("x-forwarded-proto"));

  let scope: Awaited<ReturnType<typeof findScope>>;
  try {
    scope = await findScope(slug);
  } catch (err) {
    apiLogger.error({ err, slug, msg: "event-overview:scope-failed" });
    throw err;
  }
  // Not public here: the form answers it as it always has.
  if (!scope) redirect(`/e/${slug}/register`);
  // Reached by its id: one address per event.
  if (scope.slug !== slug) redirect(`/e/${scope.slug}`);

  let loaded: Awaited<ReturnType<typeof loadEvent>>;
  try {
    // Ticket types and sessions are behind row-level security on the platform.
    loaded = await runWithTenant(scope.organizationId, () => loadEvent(scope.id));
  } catch (err) {
    apiLogger.error({ err, slug, eventId: scope.id, msg: "event-overview:load-failed" });
    throw err;
  }
  const { event } = loaded;
  if (!event) {
    apiLogger.warn({ slug, eventId: scope.id, msg: "event-overview:event-vanished" });
    notFound();
  }

  const now = new Date();
  const settings = (event.settings ?? {}) as Record<string, unknown>;
  const listed = isListed(settings);
  const agendaPublished = !!(settings.agendaPublished || settings.programmePublished);
  // The rule the API and the register page share, so this page never says
  // Register when the form would say closed or full.
  const { state, offer } = publicRegistration(
    {
      endDate: event.endDate,
      registrationOpen: settings.registrationOpen !== false,
      eventFull: eventIsFull(event),
      eventType: event.eventType,
      settings,
      ticketTypes: event.ticketTypes,
    },
    now,
  );
  // The public agenda serves PUBLISHED and LIVE events only, so a past
  // event's programme is summarised here without a link to a page that 404s.
  const agendaLinked = event.status !== "COMPLETED";
  const dates = formatEventDateRange(event.startDate, event.endDate, event.timezone);
  const accreditations = readAccreditations(settings);
  const accreditors = [...new Set(accreditations.map(accreditorLabel).filter((a): a is string => !!a))];
  const audiences = [...new Set(event.ticketTypes.map((t) => t.name.trim()).filter(Boolean))];

  // Faculty and programme only once the organiser has published the agenda,
  // the same rule the public agenda follows.
  const sessions = agendaPublished ? loaded.sessions : [];
  const speakerMap = new Map<string, Speaker>();
  for (const s of sessions) {
    for (const { speaker } of [...s.speakers, ...s.topics.flatMap((t) => t.speakers)]) {
      if (speakerMap.has(speaker.id)) continue;
      speakerMap.set(speaker.id, {
        id: speaker.id,
        name: formatPersonName(speaker.title, speaker.firstName, speaker.lastName),
        jobTitle: speaker.jobTitle,
        organization: speaker.organization,
        photo: speaker.photo,
      });
    }
  }
  const speakers = [...speakerMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const programmeDays = new Set(sessions.map((s) => localDateInTz(s.startTime, event.timezone))).size;

  const descriptionHtml = event.description?.trim() ? sanitizeHtml(event.description) : null;
  const summary = eventSummary(event);
  const facts: OverviewFacts = { event, dates, accreditors, audiences, offer, state, origin };
  const faq = buildFaq(facts);
  const jsonLd = eventPageJsonLd({
    ...facts,
    description: truncate(descriptionHtml ? toPlainText(descriptionHtml) : summary, 600),
    organization: event.organization,
    speakers: speakers.slice(0, 30),
    listed,
  });

  const registerHref = `/e/${event.slug}/register`;
  const online = event.eventType === "WEBINAR";
  const place = [event.venue, event.city, event.country].filter(Boolean).join(", ");
  const map = online ? null : mapsUrl(event);

  return (
    <div className={`${editorialDisplay.variable} min-h-screen bg-[#f7f8fa] pb-24 lg:pb-0`}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(jsonLd) }} />

      <TopBar
        organization={event.organization}
        listed={listed}
        signedIn={!!session?.user}
        loginHref={`/e/${event.slug}/login?redirect=registration`}
      />

      {/* The organiser's banner is designed art: shown whole through the one
          band every public page uses (natural aspect, capped width). */}
      <EventBannerBand banner={event.bannerImage} bannerMobile={event.bannerImageMobile} name={event.name} className="border-b border-slate-200" />

      {/* Headline block: a faint dot grid gives the page its clinical, printed feel. */}
      <header className="relative overflow-hidden border-b border-slate-200 bg-white">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-60 [background-image:radial-gradient(circle_at_1px_1px,var(--color-slate-200)_1px,transparent_0)] [background-size:22px_22px] [mask-image:linear-gradient(to_bottom,black,transparent_85%)]"
        />
        <div className="relative mx-auto max-w-6xl px-4 pb-8 pt-7 sm:px-6 sm:pb-12 sm:pt-10">
          <div className="flex flex-wrap items-center gap-2 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-500">
            {event.eventType && <Eyebrow>{EVENT_TYPE_LABEL[event.eventType]}</Eyebrow>}
            {event.specialty && <Eyebrow>{event.specialty}</Eyebrow>}
            {state === "ended" && <Eyebrow tone="muted">Past event</Eyebrow>}
          </div>
          <h1 className="mt-4 max-w-4xl font-[family-name:var(--font-api-display)] text-[2rem] font-semibold leading-[1.08] tracking-[-0.01em] text-slate-900 text-balance motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-700 sm:text-5xl">
            {event.name}
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-slate-600 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-700 motion-safe:delay-100 sm:text-lg">
            {summary}
          </p>

          <dl
            className={`mt-7 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-slate-200 bg-slate-200 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-4 motion-safe:duration-700 motion-safe:delay-200 ${
              event.cmeHours ? "md:grid-cols-4" : "[&>div:last-child]:col-span-2 md:grid-cols-3 md:[&>div:last-child]:col-span-1"
            }`}
          >
            <Fact icon={CalendarDays} label="Dates">
              <time dateTime={event.startDate.toISOString()}>{dates}</time>
            </Fact>
            <Fact icon={online ? MonitorPlay : MapPin} label={online ? "Where" : "Venue"}>
              {online ? "Online" : event.venue || [event.city, event.country].filter(Boolean).join(", ") || "To be announced"}
              {!online && event.venue && (event.city || event.country) && (
                <span className="block text-xs font-normal text-slate-500">{[event.city, event.country].filter(Boolean).join(", ")}</span>
              )}
            </Fact>
            {/* Only when there are hours: no hours may mean "not entered", so
                the page never claims an event is unaccredited. */}
            {event.cmeHours && (
              <Fact icon={Award} label="CME">
                {`${event.cmeHours.toString()} hours`}
                {accreditors[0] && <span className="block text-xs font-normal text-slate-500">{accreditors.join(" · ")}</span>}
              </Fact>
            )}
            <Fact icon={Users} label="Format">
              {event.eventType ? EVENT_TYPE_LABEL[event.eventType] : "Event"}
              {event.eventType === "HYBRID" && <span className="block text-xs font-normal text-slate-500">In person or online</span>}
            </Fact>
          </dl>
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-8 sm:px-6 sm:py-12 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-12">
        <main className="min-w-0 space-y-12">
          {/* Only the organiser's own description: without one, the summary
              under the headline already says it, and repeating it adds nothing. */}
          {descriptionHtml && (
            <Section id="about" eyebrow="About" title={`About ${event.name}`}>
              <div
                className="prose prose-slate max-w-none prose-headings:font-semibold prose-a:text-primary prose-p:leading-relaxed"
                dangerouslySetInnerHTML={{ __html: descriptionHtml }}
              />
            </Section>
          )}

          {(event.cmeHours || accreditations.length > 0) && (
            <Section id="accreditation" eyebrow="Accreditation" title="CME credits">
              <div className="flex flex-col gap-4 rounded-2xl border border-primary/20 bg-primary/[0.04] p-5 sm:flex-row sm:items-center sm:p-6">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-white text-primary shadow-sm ring-1 ring-primary/15">
                  <Award className="h-7 w-7" />
                </div>
                <div className="space-y-1">
                  {event.cmeHours && (
                    <p className="font-[family-name:var(--font-api-display)] text-2xl font-semibold text-slate-900">
                      {event.cmeHours.toString()} CME hours
                    </p>
                  )}
                  <p className="text-sm leading-relaxed text-slate-600">
                    {accreditors.length > 0 ? `Accredited by ${accreditors.join(" and ")}. ` : ""}
                    Certificates are issued after the event and can be downloaded any time from My events.
                  </p>
                  {accreditations.some((a) => a.reference) && (
                    <p className="text-xs text-slate-500">
                      {accreditations
                        .filter((a) => a.reference && accreditorLabel(a))
                        .map((a) => `${accreditorLabel(a)}: ${a.reference}`)
                        .join(" · ")}
                    </p>
                  )}
                </div>
              </div>
            </Section>
          )}

          {audiences.length > 0 && (
            <Section id="who" eyebrow="Who can register" title="Registration types">
              <ul className="grid gap-2 sm:grid-cols-2">
                {audiences.map((a) => (
                  <li key={a} className="flex items-center gap-2.5 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-800">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
                    {a}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {speakers.length > 0 && (
            <Section id="faculty" eyebrow="Faculty" title={`${speakers.length} ${speakers.length === 1 ? "speaker" : "speakers"}`}>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {speakers.slice(0, 12).map((s) => (
                  <li key={s.id} className="flex flex-col items-center rounded-2xl border border-slate-200 bg-white p-4 text-center">
                    <SpeakerPhoto speaker={s} />
                    <p className="mt-3 text-sm font-semibold leading-snug text-slate-900">{s.name}</p>
                    {(s.jobTitle || s.organization) && (
                      <p className="mt-1 line-clamp-2 text-xs leading-snug text-slate-500">{[s.jobTitle, s.organization].filter(Boolean).join(", ")}</p>
                    )}
                  </li>
                ))}
              </ul>
              {speakers.length > 12 && (
                <p className="mt-3 text-sm text-slate-500">
                  And {speakers.length - 12} more.
                  {agendaLinked && (
                    <>
                      {" "}
                      <Link href={`/e/${event.slug}/agenda`} className="font-medium text-primary hover:underline">
                        See everyone in the programme
                      </Link>
                    </>
                  )}
                </p>
              )}
            </Section>
          )}

          {sessions.length > 0 && (
            <Section id="programme" eyebrow="Programme" title="Scientific programme">
              <ProgrammeSummary
                href={agendaLinked ? `/e/${event.slug}/agenda` : null}
                sessions={sessions.length}
                days={programmeDays}
                tracks={event.tracks.length}
              />
            </Section>
          )}

          {!online && place && (
            <Section id="venue" eyebrow="Venue" title={event.venue || "Location"}>
              <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
                <address className="not-italic leading-relaxed text-slate-700">
                  {event.address && <span className="block">{event.address}</span>}
                  {[event.city, event.country].filter(Boolean).join(", ")}
                </address>
                {map && (
                  <Button asChild variant="outline" className="h-11 w-full sm:h-9 sm:w-auto">
                    <a href={map} target="_blank" rel="noopener noreferrer">
                      <Navigation className="mr-1.5 h-4 w-4" />
                      Open in Maps
                    </a>
                  </Button>
                )}
              </div>
            </Section>
          )}

          {faq.length > 0 && (
            <Section id="questions" eyebrow="Questions" title="Frequently asked">
              <div className="divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white">
                {faq.map((item, i) => (
                  // Native <details>: every answer is in the HTML for crawlers,
                  // and it opens without any script.
                  <details key={item.question} className="group" open={i === 0}>
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-left font-medium text-slate-900 [&::-webkit-details-marker]:hidden">
                      <span className="text-[15px] leading-snug">{item.question}</span>
                      <ChevronDown className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" />
                    </summary>
                    <p className="px-5 pb-5 text-sm leading-relaxed text-slate-600">{item.answer}</p>
                  </details>
                ))}
              </div>
            </Section>
          )}
        </main>

        <aside className="hidden lg:block">
          <div className="sticky top-6">
            <RegistrationCard state={state} offerText={offer ? offerLabel(offer) : null} registerHref={registerHref} dates={dates} />
          </div>
        </aside>
      </div>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-8 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p>
            © {now.getFullYear()} {event.organization.name}
            {event.supportEmail && (
              <>
                {" · "}
                <a href={`mailto:${event.supportEmail}`} className="hover:text-slate-700">
                  {event.supportEmail}
                </a>
              </>
            )}
          </p>
          {listed && (
            <Link href="/catalogue" className="font-medium text-primary hover:underline">
              Browse all events
            </Link>
          )}
        </div>
      </footer>

      {/* Phone: the price and the one action, always within reach. */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-4px_20px_rgba(15,23,42,0.06)] backdrop-blur supports-[backdrop-filter]:bg-white/80 lg:hidden">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-slate-900">{offer && state !== "ended" ? offerLabel(offer) : event.name}</p>
            <p className="truncate text-xs text-slate-500">{STATE_NOTE[state] ?? dates}</p>
          </div>
          <CallToAction state={state} registerHref={registerHref} className="h-11 shrink-0 px-5" />
        </div>
      </div>
    </div>
  );
}

const STATE_NOTE: Partial<Record<RegistrationState, string>> = {
  closed: "Registration is closed",
  "sold-out": "Fully booked",
  ended: "This event has ended",
};

function TopBar({
  organization,
  listed,
  signedIn,
  loginHref,
}: {
  organization: { name: string; logo: string | null };
  listed: boolean;
  signedIn: boolean;
  loginHref: string;
}) {
  return (
    <div className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <OrgMark organization={organization} href={listed ? "/catalogue" : null} />
        <div className="flex shrink-0 items-center gap-2">
          {listed && (
            <Link href="/catalogue" className="hidden text-sm font-medium text-slate-600 hover:text-slate-900 sm:inline">
              All events
            </Link>
          )}
          {signedIn ? (
            <Button asChild variant="outline" size="sm" className="border-primary/40 bg-primary/5 font-medium text-primary hover:bg-primary/10 hover:text-primary">
              <Link href="/my-registration">
                <LayoutList className="mr-1.5 h-4 w-4" />
                My events
              </Link>
            </Button>
          ) : (
            <Button asChild variant="ghost" size="sm">
              <Link href={loginHref}>Sign in</Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function CallToAction({ state, registerHref, className = "" }: { state: RegistrationState; registerHref: string; className?: string }) {
  if (state === "open") {
    return (
      <Button asChild className={`btn-gradient font-semibold ${className}`}>
        <Link href={registerHref}>
          Register
          <ArrowRight className="ml-1.5 h-4 w-4" />
        </Link>
      </Button>
    );
  }
  if (state === "ended") {
    return (
      <Button asChild variant="outline" className={className}>
        <Link href="/my-registration">My events</Link>
      </Button>
    );
  }
  return (
    <Button disabled variant="outline" className={className}>
      {state === "sold-out" ? "Fully booked" : "Closed"}
    </Button>
  );
}

function RegistrationCard({ state, offerText, registerHref, dates }: { state: RegistrationState; offerText: string | null; registerHref: string; dates: string }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.06),0_12px_32px_-12px_rgba(15,23,42,0.18)]">
      <div className="h-1.5 bg-gradient-primary" />
      <div className="space-y-5 p-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Registration</p>
          {offerText && state !== "ended" ? (
            <p className="mt-1.5 font-[family-name:var(--font-api-display)] text-3xl font-semibold text-slate-900">{offerText}</p>
          ) : (
            <p className="mt-1.5 text-lg font-semibold text-slate-900">{STATE_NOTE[state] ?? "Register online"}</p>
          )}
          {offerText && state !== "ended" && STATE_NOTE[state] && <p className="mt-1 text-sm font-medium text-amber-700">{STATE_NOTE[state]}</p>}
        </div>
        <CallToAction state={state} registerHref={registerHref} className="h-12 w-full text-base" />
        <ul className="space-y-2.5 text-sm text-slate-600">
          <li className="flex items-start gap-2.5">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
            {dates}
          </li>
          <li className="flex items-start gap-2.5">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
            Confirmation by email, and your registration and certificates in My events
          </li>
        </ul>
      </div>
    </div>
  );
}

function Eyebrow({ children, tone = "brand" }: { children: React.ReactNode; tone?: "brand" | "muted" }) {
  return (
    <span
      className={
        tone === "brand"
          ? "rounded-full border border-primary/25 bg-primary/[0.06] px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-primary"
          : "rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500"
      }
    >
      {children}
    </span>
  );
}

function Fact({ icon: Icon, label, children }: { icon: React.ComponentType<{ className?: string }>; label: string; children: React.ReactNode }) {
  return (
    <div className="bg-white p-4 sm:p-5">
      <dt className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
        <Icon className="h-3.5 w-3.5 text-primary" />
        {label}
      </dt>
      <dd className="mt-2 text-sm font-semibold leading-snug text-slate-900 sm:text-[15px]">{children}</dd>
    </div>
  );
}

function Section({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-6">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">{eyebrow}</p>
      <h2 id={`${id}-title`} className="mb-5 mt-1.5 font-[family-name:var(--font-api-display)] text-2xl font-semibold tracking-[-0.01em] text-slate-900 sm:text-[1.7rem]">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <p className="font-[family-name:var(--font-api-display)] text-3xl font-semibold tabular-nums text-slate-900">{value}</p>
      <p className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">{label}</p>
    </div>
  );
}

function SpeakerPhoto({ speaker }: { speaker: Speaker }) {
  if (speaker.photo) {
    /* eslint-disable-next-line @next/next/no-img-element */
    return <img src={speaker.photo} alt="" loading="lazy" className="h-20 w-20 rounded-full object-cover ring-4 ring-slate-50" />;
  }
  const initials = speaker.name
    .replace(/^(Dr|Prof|Mr|Mrs|Ms|Miss)\.?\s+/i, "")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <div aria-hidden className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/10 font-[family-name:var(--font-api-display)] text-xl font-semibold text-primary ring-4 ring-slate-50">
      {initials}
    </div>
  );
}


/** The organiser's logo and name; a link to the catalogue only when the event is in it. */
function OrgMark({ organization, href }: { organization: { name: string; logo: string | null }; href: string | null }) {
  const inner = (
    <>
      {organization.logo && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={organization.logo} alt="" className="h-8 max-w-[56px] shrink-0 object-contain" />
      )}
      <span className="truncate text-sm font-semibold text-slate-800">{organization.name}</span>
    </>
  );
  if (!href) return <div className="flex min-w-0 items-center gap-2.5">{inner}</div>;
  return (
    <Link href={href} className="flex min-w-0 items-center gap-2.5">
      {inner}
    </Link>
  );
}

function ProgrammeSummary({ href, sessions, days, tracks }: { href: string | null; sessions: number; days: number; tracks: number }) {
  const stats = (
    <div className="flex flex-wrap gap-x-8 gap-y-3">
      <Stat value={sessions} label={sessions === 1 ? "session" : "sessions"} />
      <Stat value={days} label={days === 1 ? "day" : "days"} />
      {tracks > 0 && <Stat value={tracks} label={tracks === 1 ? "track" : "tracks"} />}
    </div>
  );
  if (!href) return <div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">{stats}</div>;
  return (
    <Link
      href={href}
      className="group flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 transition-shadow hover:shadow-md sm:flex-row sm:items-center sm:justify-between sm:p-6"
    >
      {stats}
      <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
        View the full programme
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
