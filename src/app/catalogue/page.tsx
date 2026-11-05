import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Search } from "lucide-react";
import { editorialDisplay } from "@/app/fonts";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { normalizeHost, resolveTenantOrg } from "@/lib/tenant/resolver";
import { CATALOGUE_EVENT_SELECT, listTopicValues, loadCardRegistration, loadSiteContext, loadSiteStats, type CatalogueEvent } from "@/lib/catalogue-data";
import {
  BrowseTopics,
  CatalogueFooter,
  CatalogueHero,
  EmptyEvents,
  EventGrid,
  HeroEyebrow,
  HeroLede,
  HeroStats,
  HeroTitle,
  HowItWorks,
  NextUp,
  Pager,
  SectionHead,
  WhenTabs,
} from "@/components/catalogue/catalogue-parts";
import { BannerFan, type FanItem } from "@/components/catalogue/banner-fan";
import { absoluteUrl, catalogueJsonLd, jsonLdText, siteOrigin } from "@/lib/seo";
import {
  CATALOGUE_PAGE_SIZE,
  EVENT_TYPE_LABEL,
  catalogueBaseWhere,
  catalogueHref,
  catalogueOrderBy,
  catalogueWhere,
  parseCatalogueQuery,
  topicForValue,
  type CatalogueQuery,
} from "@/lib/catalogue";

/**
 * The public event catalogue (Nov 4, 2026): every event an organiser switched
 * on, searchable, each opening its own /e/{slug} page where people register.
 * Which events and which filters: src/lib/catalogue.ts.
 *
 * Server-rendered, with the filters as a plain GET form, so search engines can
 * read it and it works before any script has loaded. Mobile first: one column
 * of cards on a phone, two from `sm`, three from `lg`.
 *
 * Redesigned Nov 5, 2026: a navy hero with the organisation's photo (or an
 * ECG-paper pattern) and the next events' banners fanned on top, the real
 * track record, the next event large with today's rates, and cards that say
 * whether registration is open and from what price.
 */

/** How many of the next events the hero fans out. */
const FAN_SIZE = 3;

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

async function loadCatalogue(host: string | null, query: CatalogueQuery, now: Date) {
  const { orgScope, organization } = await loadSiteContext(host);
  // The menus send a topic's label; the filter matches every stored spelling.
  const topics = await listTopicValues(orgScope);
  const where = catalogueWhere(orgScope, query, now, {
    country: topicForValue(topics.countries, query.country)?.variants,
    specialty: topicForValue(topics.specialties, query.specialty)?.variants,
  });
  const nextWhere = catalogueWhere(orgScope, { q: "", country: "", type: null, specialty: "", when: "upcoming", page: 1 }, now);
  const [events, total, facets, next, stats] = await Promise.all([
    db.event.findMany({
      where,
      orderBy: catalogueOrderBy(query),
      skip: (query.page - 1) * CATALOGUE_PAGE_SIZE,
      take: CATALOGUE_PAGE_SIZE,
      select: CATALOGUE_EVENT_SELECT,
    }),
    db.event.count({ where }),
    // The type menu's values; country and specialty come with the topics.
    db.event.findMany({ where: catalogueBaseWhere(orgScope), distinct: ["eventType"], select: { eventType: true } }),
    // The hero's fan and the next-event panel: the soonest listed events, whatever the filters.
    db.event.findMany({ where: nextWhere, orderBy: catalogueOrderBy({ ...query, when: "upcoming" }), take: FAN_SIZE, select: CATALOGUE_EVENT_SELECT }),
    loadSiteStats(orgScope),
  ]);
  const registration = await loadCardRegistration([...new Set([...events, ...next.slice(0, 1)].map((e) => e.id))], now);
  const types = [...new Set(facets.map((f) => f.eventType).filter((t): t is keyof typeof EVENT_TYPE_LABEL => !!t))].sort();
  return { events, total, types, organization, next, stats, registration, ...topics };
}

/** "15–17 Jan · Dubai", in the event's own timezone. */
function fanCaption(event: CatalogueEvent): string {
  const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: event.timezone, ...o }).format(d);
  const [sd, ed, sm, em] = [fmt(event.startDate, { day: "numeric" }), fmt(event.endDate, { day: "numeric" }), fmt(event.startDate, { month: "short" }), fmt(event.endDate, { month: "short" })];
  const place = event.eventType === "WEBINAR" ? "Online" : event.city ?? event.country;
  const dates = spanText(sd, sm, ed, em);
  return place ? `${dates} · ${place}` : dates;
}

function spanText(sd: string, sm: string, ed: string, em: string): string {
  if (sm !== em) return `${sd} ${sm} – ${ed} ${em}`;
  return sd === ed ? `${sd} ${sm}` : `${sd}–${ed} ${sm}`;
}

function listingTitle(query: CatalogueQuery, filtered: boolean): string {
  if (query.when === "past") return "Past events";
  return filtered ? "Matching events" : "All upcoming events";
}

/** "from Dubai to Muscat", "in Dubai", or nothing: where the next meetings are, in date order. */
function placesPhrase(next: CatalogueEvent[]) {
  const cities = [...new Set(next.filter((e) => e.eventType !== "WEBINAR" && e.city).map((e) => e.city!.trim()))];
  if (cities.length === 0) return null;
  if (cities.length === 1) return <> in <em>{cities[0]}</em></>;
  return <>, from <em>{cities[0]}</em> to <em>{cities[cities.length - 1]}</em></>;
}

export default async function CataloguePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [sp, session, h] = await Promise.all([searchParams, auth(), headers()]);
  const query = parseCatalogueQuery(sp);
  const origin = siteOrigin(h.get("host"), h.get("x-forwarded-proto"));
  const now = new Date();

  let data: Awaited<ReturnType<typeof loadCatalogue>>;
  try {
    data = await loadCatalogue(h.get("host"), query, now);
  } catch (err) {
    apiLogger.error({ err, msg: "catalogue:load-failed" });
    throw err;
  }
  const { events, total, countries, specialties, types, organization, next, stats, registration } = data;
  const pages = Math.max(1, Math.ceil(total / CATALOGUE_PAGE_SIZE));
  // A page past the end (an old link, a hand-typed number) goes to the last
  // real one rather than an empty list under a count that says otherwise.
  if (query.page > pages) redirect(catalogueHref(query, { page: pages }));
  const filtered = !!(query.q || query.country || query.type || query.specialty);
  const showNext = !filtered && query.when === "upcoming" && query.page === 1 && next.length > 0;
  const fan: FanItem[] = next.flatMap((e) => {
    const image = e.bannerImageMobile ?? e.bannerImage;
    return image ? [{ slug: e.slug, name: e.name, image, caption: fanCaption(e) }] : [];
  });
  // Quick filters: one tap for a specialty or a type, the rest in the form.
  const chip = (active: boolean) =>
    `inline-flex h-9 shrink-0 items-center rounded-full px-3.5 text-sm transition-colors ${active ? "bg-[#0a1c2e] text-white" : "bg-white text-[#13222f] ring-1 ring-[#dbe4eb] hover:ring-[#0083ad]"}`;

  return (
    <div className={`${editorialDisplay.variable} flex min-h-screen flex-col bg-[#f3f7fa] text-[#13222f]`}>
      {/* Structured data for search engines and AI assistants: the
          organisation, the breadcrumb and the events on this page. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(catalogueJsonLd(events, origin, organization)) }} />

      <CatalogueHero
        organization={organization}
        signedIn={!!session?.user}
        overlap
        aside={fan.length >= 2 ? <BannerFan items={fan} /> : undefined}
      >
        {organization && <HeroEyebrow>{organization.name}</HeroEyebrow>}
        <HeroTitle>Medical conferences and CME{placesPhrase(next)}.</HeroTitle>
        <HeroLede>
          Browse upcoming conferences, workshops and webinars, register in a few minutes, and download your certificates
          from My events afterwards.
        </HeroLede>
        <HeroStats stats={stats} />
      </CatalogueHero>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 sm:px-6">
        {/* A plain GET form: works before any script loads, and the URL is shareable. */}
        <form
          action="/catalogue"
          method="get"
          role="search"
          className="relative z-[4] -mt-16 grid gap-3 rounded-2xl bg-white p-3.5 shadow-[0_18px_40px_-22px_rgb(10_28_46/0.45)] ring-1 ring-[#dbe4eb] sm:p-4"
        >
          {query.when === "past" && <input type="hidden" name="when" value="past" />}
          <div className="grid gap-2.5 md:grid-cols-[1fr_180px_160px_auto]">
            <label className="relative block">
              <span className="sr-only">Search events</span>
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5a6b7b]" />
              <input
                name="q"
                defaultValue={query.q}
                placeholder="Search by name, city or specialty"
                className="h-12 w-full rounded-xl border border-[#dbe4eb] bg-white pl-10 pr-3 text-[15px] outline-none placeholder:text-[#8796a3] focus-visible:border-[#00aade] focus-visible:ring-2 focus-visible:ring-[#00aade]/30"
              />
            </label>
            <FilterSelect name="country" label="Country" allLabel="All countries" value={query.country} options={countries.map((c) => [c.label, c.label])} />
            <FilterSelect name="type" label="Type" allLabel="All types" value={query.type ?? ""} options={types.map((t) => [t, EVENT_TYPE_LABEL[t]])} />
            {/* The specialty chips below set this; kept so a search keeps it. */}
            {query.specialty && <input type="hidden" name="specialty" value={query.specialty} />}
            <button type="submit" className="h-12 rounded-xl bg-[#0a1c2e] px-6 font-semibold text-white transition-colors hover:bg-[#12304a]">
              Search
            </button>
          </div>
          {specialties.length > 0 && (
            <nav aria-label="Specialties" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]">
              <Link href={catalogueHref({ ...query, specialty: "" }, { page: 1 })} aria-current={!query.specialty ? "true" : undefined} className={chip(!query.specialty)}>
                All specialties
              </Link>
              {specialties.map((s) => {
                const active = topicForValue(specialties, query.specialty)?.slug === s.slug;
                return (
                  <Link key={s.slug} href={catalogueHref({ ...query, specialty: s.label }, { page: 1 })} aria-current={active ? "true" : undefined} className={chip(active)}>
                    {s.label}
                  </Link>
                );
              })}
            </nav>
          )}
        </form>

        {showNext && (
          <section aria-labelledby="next-up" className="pt-10 sm:pt-12">
            <SectionHead id="next-up" title="Next up" />
            <NextUp event={next[0]} reg={registration.get(next[0].id)} now={now} />
          </section>
        )}

        <section id="events" aria-labelledby="events-title" className="scroll-mt-6 pt-10 sm:pt-12">
          <SectionHead id="events-title" title={listingTitle(query, filtered)}>
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-[#5a6b7b]">
                {total} {total === 1 ? "event" : "events"}
                {filtered && (
                  <>
                    {" · "}
                    <Link href={catalogueHref({ ...query, q: "", country: "", type: null, specialty: "" }, {})} className="font-medium text-[#0083ad] hover:underline">
                      Clear filters
                    </Link>
                  </>
                )}
              </p>
              <WhenTabs when={query.when} hrefFor={(when) => catalogueHref(query, { when })} />
            </div>
          </SectionHead>
          {events.length === 0 ? (
            <EmptyEvents
              title={`No ${query.when} events${filtered ? " match these filters" : " yet"}`}
              hint={query.when === "upcoming" ? "New events are added as they open for registration." : "Past events appear here once they end."}
            />
          ) : (
            <EventGrid events={events} registration={registration} upcoming={query.when === "upcoming"} />
          )}
          <Pager page={query.page} pages={pages} hrefFor={(page) => catalogueHref(query, { page })} />
        </section>

        <section id="how" aria-labelledby="how-title" className="scroll-mt-6 pt-12">
          <SectionHead id="how-title" title="How registering works" />
          <HowItWorks />
        </section>

        {(specialties.length > 0 || countries.length > 0) && (
          <section id="topics" aria-labelledby="topics-title" className="scroll-mt-6 pt-12">
            <SectionHead id="topics-title" title="Browse by specialty and country" />
            <BrowseTopics specialties={specialties} countries={countries} />
          </section>
        )}
      </main>

      <CatalogueFooter organization={organization} specialties={specialties} />
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
        className="h-12 w-full rounded-xl border border-[#dbe4eb] bg-white px-3 text-[15px] outline-none focus-visible:border-[#00aade] focus-visible:ring-2 focus-visible:ring-[#00aade]/30"
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
