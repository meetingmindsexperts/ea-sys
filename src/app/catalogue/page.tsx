import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Award, Calendar, LayoutList, MapPin, Search } from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { normalizeHost, resolveTenantOrg } from "@/lib/tenant/resolver";
import { publicOrgScopeForHost } from "@/lib/public-event";
import { formatEventDateRange } from "@/lib/event-time";
import { absoluteUrl, catalogueJsonLd, jsonLdText, siteOrigin } from "@/lib/seo";
import {
  CATALOGUE_PAGE_SIZE,
  EVENT_TYPE_LABEL,
  catalogueBaseWhere,
  catalogueHref,
  catalogueOrderBy,
  catalogueWhere,
  parseCatalogueQuery,
  type CatalogueQuery,
} from "@/lib/catalogue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/**
 * The public event catalogue (Nov 4, 2026): every event an organiser switched
 * on, searchable, each opening its own /e/{slug} page where people register.
 * Which events and which filters: src/lib/catalogue.ts.
 *
 * Server-rendered, with the filters as a plain GET form, so search engines can
 * read it and it works before any script has loaded. Mobile first: one column
 * of cards on a phone, two from `sm`, three from `lg`.
 */

const DESCRIPTION = "Medical conferences, workshops and webinars: browse upcoming events, register online and download your CME certificates.";

/**
 * Per site address: the organisation's name in the title, the catalogue as
 * the canonical page, and a filtered or searched view kept out of indexes
 * (followed, not indexed) so search engines index one catalogue, not every
 * combination of filters. Pages 2 and on stay indexable and canonical to
 * themselves.
 */
export async function generateMetadata({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<Metadata> {
  const [sp, h] = await Promise.all([searchParams, headers()]);
  const query = parseCatalogueQuery(sp);
  const host = h.get("host");
  const origin = siteOrigin(host, h.get("x-forwarded-proto"));
  const tenant = await resolveTenantOrg(normalizeHost(host)).catch(() => null);
  const organization = tenant?.orgId
    ? await db.organization.findUnique({ where: { id: tenant.orgId }, select: { name: true, logo: true } }).catch((err) => {
        apiLogger.warn({ err, msg: "catalogue:metadata-org-failed" });
        return null;
      })
    : null;
  const filtered = !!(query.q || query.country || query.type || query.specialty);
  const title = `${query.when === "past" ? "Past events" : "Upcoming medical events and conferences"}${organization ? ` | ${organization.name}` : ""}`;
  const canonical = `${origin}${catalogueHref({ ...query, q: "", country: "", type: null, specialty: "" }, { page: query.page })}`;
  return {
    title,
    description: DESCRIPTION,
    alternates: { canonical },
    robots: filtered ? { index: false, follow: true } : { index: true, follow: true },
    openGraph: {
      title,
      description: DESCRIPTION,
      url: canonical,
      type: "website",
      ...(organization && { siteName: organization.name }),
      ...(organization?.logo && { images: [{ url: absoluteUrl(origin, organization.logo) }] }),
    },
    twitter: { card: "summary", title, description: DESCRIPTION },
  };
}

type CatalogueEvent = {
  id: string;
  slug: string;
  name: string;
  startDate: Date;
  endDate: Date;
  timezone: string;
  venue: string | null;
  city: string | null;
  country: string | null;
  eventType: keyof typeof EVENT_TYPE_LABEL | null;
  specialty: string | null;
  bannerImage: string | null;
  bannerImageMobile: string | null;
  cmeHours: { toString(): string } | null;
};

async function loadCatalogue(host: string | null, query: CatalogueQuery) {
  const [orgScope, tenant] = await Promise.all([publicOrgScopeForHost(host), resolveTenantOrg(normalizeHost(host))]);
  const where = catalogueWhere(orgScope, query, new Date());
  const [events, total, facets, organization] = await Promise.all([
    db.event.findMany({
      where,
      orderBy: catalogueOrderBy(query),
      skip: (query.page - 1) * CATALOGUE_PAGE_SIZE,
      take: CATALOGUE_PAGE_SIZE,
      select: {
        id: true, slug: true, name: true, startDate: true, endDate: true, timezone: true,
        venue: true, city: true, country: true, eventType: true, specialty: true, bannerImage: true, bannerImageMobile: true, cmeHours: true,
      },
    }),
    db.event.count({ where }),
    // What the filter menus offer: every listed event's values, whatever is
    // filtered now. Distinct per column, so the cost is the number of values.
    Promise.all([
      db.event.findMany({ where: catalogueBaseWhere(orgScope), distinct: ["country"], select: { country: true } }),
      db.event.findMany({ where: catalogueBaseWhere(orgScope), distinct: ["specialty"], select: { specialty: true } }),
      db.event.findMany({ where: catalogueBaseWhere(orgScope), distinct: ["eventType"], select: { eventType: true } }),
    ]),
    tenant.orgId ? db.organization.findUnique({ where: { id: tenant.orgId }, select: { name: true, logo: true } }) : null,
  ]);
  const distinct = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => !!v))].sort();
  return {
    events: events as CatalogueEvent[],
    total,
    countries: distinct(facets[0].map((f) => f.country)),
    specialties: distinct(facets[1].map((f) => f.specialty)),
    types: distinct(facets[2].map((f) => f.eventType)) as (keyof typeof EVENT_TYPE_LABEL)[],
    organization,
  };
}

export default async function CataloguePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [sp, session, h] = await Promise.all([searchParams, auth(), headers()]);
  const query = parseCatalogueQuery(sp);
  const origin = siteOrigin(h.get("host"), h.get("x-forwarded-proto"));

  let data: Awaited<ReturnType<typeof loadCatalogue>>;
  try {
    data = await loadCatalogue(h.get("host"), query);
  } catch (err) {
    apiLogger.error({ err, msg: "catalogue:load-failed" });
    throw err;
  }
  const { events, total, countries, specialties, types, organization } = data;
  const pages = Math.max(1, Math.ceil(total / CATALOGUE_PAGE_SIZE));
  // A page past the end (an old link, a hand-typed number) goes to the last
  // real one rather than an empty list under a count that says otherwise.
  if (query.page > pages) redirect(catalogueHref(query, { page: pages }));
  const filtered = !!(query.q || query.country || query.type || query.specialty);

  return (
    <div className="flex min-h-screen flex-col bg-[#f8f9fb]">
      {/* Structured data for search engines and AI assistants: the
          organisation, the breadcrumb and the events on this page. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(catalogueJsonLd(events, origin, organization)) }} />
      {/* Top bar: who runs these events, and the way into the person's own. */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <Link href="/catalogue" className="flex min-w-0 items-center gap-2.5">
            {organization?.logo && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={organization.logo} alt="" className="h-8 max-w-[56px] shrink-0 object-contain" />
            )}
            <span className="truncate text-sm font-semibold text-slate-800">{organization?.name ?? "Events"}</span>
          </Link>
          {session?.user ? (
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

      <section className="bg-gradient-primary text-white">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Medical events and conferences</h1>
          <p className="mt-2 max-w-2xl text-sm text-white/85 sm:text-base">
            Browse upcoming conferences, workshops and webinars, register in a few steps, and download your CME
            certificates afterwards from My events.
          </p>
        </div>
      </section>

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-5 px-4 py-6 sm:px-6 sm:py-8">
        {/* A plain GET form: works before any script loads, and the URL is shareable. */}
        <form action="/catalogue" method="get" className="grid gap-3 rounded-xl border bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto]">
          {query.when === "past" && <input type="hidden" name="when" value="past" />}
          <label className="relative block sm:col-span-2 lg:col-span-1">
            <span className="sr-only">Search events</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              name="q"
              defaultValue={query.q}
              placeholder="Search by name, city or specialty"
              className="h-11 w-full rounded-md border border-input bg-white pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-10"
            />
          </label>
          <FilterSelect name="country" label="Country" allLabel="All countries" value={query.country} options={countries.map((c) => [c, c])} />
          <FilterSelect name="type" label="Type" allLabel="All types" value={query.type ?? ""} options={types.map((t) => [t, EVENT_TYPE_LABEL[t]])} />
          <FilterSelect name="specialty" label="Specialty" allLabel="All specialties" value={query.specialty} options={specialties.map((s) => [s, s])} />
          <Button type="submit" className="h-11 sm:h-10">Search</Button>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <nav className="inline-flex rounded-lg border bg-white p-1 text-sm" aria-label="Upcoming or past events">
            {(["upcoming", "past"] as const).map((when) => (
              <Link
                key={when}
                href={catalogueHref(query, { when })}
                aria-current={query.when === when ? "page" : undefined}
                className={
                  query.when === when
                    ? "rounded-md bg-primary px-4 py-1.5 font-medium text-primary-foreground"
                    : "rounded-md px-4 py-1.5 text-slate-600 hover:text-slate-900"
                }
              >
                {when === "upcoming" ? "Upcoming" : "Past"}
              </Link>
            ))}
          </nav>
          <p className="text-sm text-slate-500">
            {total} {total === 1 ? "event" : "events"}
            {filtered && (
              <>
                {" · "}
                <Link href={catalogueHref({ ...query, q: "", country: "", type: null, specialty: "" }, {})} className="text-primary hover:underline">
                  Clear filters
                </Link>
              </>
            )}
          </p>
        </div>

        {events.length === 0 ? (
          <div className="rounded-xl border bg-white px-6 py-14 text-center">
            <Calendar className="mx-auto h-10 w-10 text-slate-300" />
            <p className="mt-3 font-medium text-slate-800">No {query.when} events{filtered ? " match these filters" : " yet"}</p>
            <p className="mt-1 text-sm text-slate-500">
              {query.when === "upcoming" ? "New events are added as they open for registration." : "Past events appear here once they end."}
            </p>
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {events.map((event) => (
              <li key={event.id}>
                <EventCard event={event} upcoming={query.when === "upcoming"} />
              </li>
            ))}
          </ul>
        )}

        {pages > 1 && (
          <nav className="flex items-center justify-center gap-3 pt-2 text-sm" aria-label="Pages">
            {query.page > 1 && (
              <Button asChild variant="outline" size="sm">
                <Link href={catalogueHref(query, { page: query.page - 1 })}>Previous</Link>
              </Button>
            )}
            <span className="text-slate-500">
              Page {query.page} of {pages}
            </span>
            {query.page < pages && (
              <Button asChild variant="outline" size="sm">
                <Link href={catalogueHref(query, { page: query.page + 1 })}>Next</Link>
              </Button>
            )}
          </nav>
        )}
      </main>

      <footer className="border-t bg-white px-4 py-6 text-center text-sm text-slate-500">
        © {new Date().getFullYear()} {organization?.name ?? "Events"}
      </footer>
    </div>
  );
}

function FilterSelect({ name, label, allLabel, value, options }: { name: string; label: string; allLabel: string; value: string; options: [string, string][] }) {
  return (
    <label className="block">
      <span className="sr-only">{label}</span>
      <select
        name={name}
        defaultValue={value}
        className="h-11 w-full rounded-md border border-input bg-white px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-10"
      >
        <option value="">{allLabel}</option>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function EventCard({ event, upcoming }: { event: CatalogueEvent; upcoming: boolean }) {
  const where = [event.city, event.country].filter(Boolean).join(", ");
  return (
    <Link
      href={`/e/${event.slug}`}
      className="group flex h-full flex-col overflow-hidden rounded-xl border bg-white shadow-sm transition-shadow hover:shadow-md"
    >
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
        <h2 className="line-clamp-2 font-semibold leading-snug text-slate-900">{event.name}</h2>
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
