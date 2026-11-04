import Link from "next/link";
import { Award, Calendar, LayoutList, MapPin } from "lucide-react";
import { formatEventDateRange } from "@/lib/event-time";
import { EVENT_TYPE_LABEL, topicHref, type TopicKind } from "@/lib/catalogue";
import type { CatalogueEvent } from "@/lib/catalogue-data";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/**
 * The pieces the catalogue and its topic pages share (Nov 4, 2026), so the
 * two always render an event the same way. Server components, no hooks.
 * Mobile first: one column of cards on a phone, two from `sm`, three from `lg`.
 */

export function CatalogueTopBar({ organization, signedIn }: { organization: { name: string; logo: string | null } | null; signedIn: boolean }) {
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
        <Link href="/catalogue" className="flex min-w-0 items-center gap-2.5">
          {organization?.logo && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={organization.logo} alt="" className="h-8 max-w-[56px] shrink-0 object-contain" />
          )}
          <span className="truncate text-sm font-semibold text-slate-800">{organization?.name ?? "Events"}</span>
        </Link>
        {signedIn ? (
          <Button asChild variant="outline" size="sm" className="shrink-0 border-primary/40 bg-primary/5 font-medium text-primary hover:bg-primary/10 hover:text-primary">
            <Link href="/my-registration">
              <LayoutList className="mr-1.5 h-4 w-4" />
              My events
            </Link>
          </Button>
        ) : (
          <Button asChild size="sm" className="shrink-0">
            <Link href="/login?callbackUrl=%2Fmy-registration">Sign in</Link>
          </Button>
        )}
      </div>
    </header>
  );
}

export function CatalogueFooter({ organization }: { organization: { name: string } | null }) {
  return (
    <footer className="border-t bg-white px-4 py-6 text-center text-sm text-slate-500">
      © {new Date().getFullYear()} {organization?.name ?? "Events"}
    </footer>
  );
}

export function WhenTabs({ when, hrefFor }: { when: "upcoming" | "past"; hrefFor: (when: "upcoming" | "past") => string }) {
  return (
    <nav className="inline-flex rounded-lg border bg-white p-1 text-sm" aria-label="Upcoming or past events">
      {(["upcoming", "past"] as const).map((w) => (
        <Link
          key={w}
          href={hrefFor(w)}
          aria-current={when === w ? "page" : undefined}
          className={when === w ? "rounded-md bg-primary px-4 py-1.5 font-medium text-primary-foreground" : "rounded-md px-4 py-1.5 text-slate-600 hover:text-slate-900"}
        >
          {w === "upcoming" ? "Upcoming" : "Past"}
        </Link>
      ))}
    </nav>
  );
}

export function EventGrid({ events, upcoming }: { events: CatalogueEvent[]; upcoming: boolean }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {events.map((event) => (
        <li key={event.id}>
          <EventCard event={event} upcoming={upcoming} />
        </li>
      ))}
    </ul>
  );
}

export function EmptyEvents({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-xl border bg-white px-6 py-14 text-center">
      <Calendar className="mx-auto h-10 w-10 text-slate-300" />
      <p className="mt-3 font-medium text-slate-800">{title}</p>
      <p className="mt-1 text-sm text-slate-500">{hint}</p>
    </div>
  );
}

export function Pager({ page, pages, hrefFor }: { page: number; pages: number; hrefFor: (page: number) => string }) {
  if (pages <= 1) return null;
  return (
    <nav className="flex items-center justify-center gap-3 pt-2 text-sm" aria-label="Pages">
      {page > 1 && (
        <Button asChild variant="outline" size="sm">
          <Link href={hrefFor(page - 1)}>Previous</Link>
        </Button>
      )}
      <span className="text-slate-500">
        Page {page} of {pages}
      </span>
      {page < pages && (
        <Button asChild variant="outline" size="sm">
          <Link href={hrefFor(page + 1)}>Next</Link>
        </Button>
      )}
    </nav>
  );
}

/**
 * Links to every topic page: how a person browses by subject, and the
 * internal links that let search engines find those pages.
 */
export function BrowseTopics({ specialties, countries, current }: { specialties: string[]; countries: string[]; current?: { kind: TopicKind; value: string } }) {
  if (specialties.length === 0 && countries.length === 0) return null;
  const group = (kind: TopicKind, title: string, values: string[]) =>
    values.length > 0 && (
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">{title}</h2>
        <ul className="mt-2.5 flex flex-wrap gap-2">
          {values.map((v) => {
            const active = current?.kind === kind && current.value === v;
            return (
              <li key={v}>
                <Link
                  href={topicHref(kind, v)}
                  aria-current={active ? "page" : undefined}
                  className={
                    active
                      ? "inline-flex h-9 items-center rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground"
                      : "inline-flex h-9 items-center rounded-full border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 transition-colors hover:border-primary/40 hover:text-primary"
                  }
                >
                  {v}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    );
  return (
    <section aria-label="Browse by topic" className="space-y-5 rounded-xl border bg-white p-5 sm:p-6">
      {group("specialty", "Browse by specialty", specialties)}
      {group("country", "Browse by country", countries)}
    </section>
  );
}

function EventCard({ event, upcoming }: { event: CatalogueEvent; upcoming: boolean }) {
  const where = [event.city, event.country].filter(Boolean).join(", ");
  return (
    <Link href={`/e/${event.slug}`} className="group flex h-full flex-col overflow-hidden rounded-xl border bg-white shadow-sm transition-shadow hover:shadow-md">
      <div className="relative aspect-[16/9] bg-gradient-primary">
        <CardImage event={event} />
        {event.cmeHours && (
          <span className="absolute left-3 top-3 flex items-center gap-1 rounded-full bg-white/95 px-2.5 py-1 text-xs font-semibold text-primary shadow-sm">
            <Award className="h-3.5 w-3.5" />
            {event.cmeHours.toString()} CME hours
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <h3 className="line-clamp-2 font-semibold leading-snug text-slate-900">{event.name}</h3>
        <div className="space-y-1 text-xs text-slate-500">
          <p className="flex items-start gap-1.5">
            <Calendar className="mt-px h-3.5 w-3.5 shrink-0 text-primary/70" />
            {/* Machine-readable start for crawlers, the event-local range for people. */}
            <time dateTime={event.startDate.toISOString()}>{formatEventDateRange(event.startDate, event.endDate, event.timezone)}</time>
          </p>
          {where && (
            <p className="flex items-start gap-1.5">
              <MapPin className="mt-px h-3.5 w-3.5 shrink-0 text-primary/70" />
              {where}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {event.eventType && <Badge variant="secondary">{EVENT_TYPE_LABEL[event.eventType]}</Badge>}
          {event.specialty && <Badge variant="outline">{event.specialty}</Badge>}
        </div>
        <span className="mt-auto inline-flex h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors group-hover:bg-primary/90 sm:h-9">
          {upcoming ? "View and register" : "View event"}
        </span>
      </div>
    </Link>
  );
}

/**
 * The card's picture. The mobile banner is about 16:9 and fills the card; the
 * desktop banner is a wide strip (about 4.7:1, logo on the left) that a 16:9
 * crop would cut to a sliver, so it is shown whole on white instead.
 */
function CardImage({ event }: { event: CatalogueEvent }) {
  if (event.bannerImageMobile) {
    /* eslint-disable-next-line @next/next/no-img-element */
    return <img src={event.bannerImageMobile} alt="" loading="lazy" className="h-full w-full object-cover" />;
  }
  if (event.bannerImage) {
    /* eslint-disable-next-line @next/next/no-img-element */
    return <img src={event.bannerImage} alt="" loading="lazy" className="h-full w-full bg-white object-contain" />;
  }
  return <div className="flex h-full items-center justify-center p-4 text-center text-sm font-semibold text-white/90">{event.name}</div>;
}
