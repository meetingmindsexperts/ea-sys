import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Search } from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import { normalizeHost, resolveTenantOrg } from "@/lib/tenant/resolver";
import { CATALOGUE_EVENT_SELECT, listTopicValues, loadSiteContext } from "@/lib/catalogue-data";
import { BrowseTopics, CatalogueFooter, CatalogueTopBar, EmptyEvents, EventGrid, Pager, WhenTabs } from "@/components/catalogue/catalogue-parts";
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

async function loadCatalogue(host: string | null, query: CatalogueQuery) {
  const { orgScope, organization } = await loadSiteContext(host);
  const where = catalogueWhere(orgScope, query, new Date());
  const [events, total, facets, topics] = await Promise.all([
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
    listTopicValues(orgScope),
  ]);
  const types = [...new Set(facets.map((f) => f.eventType).filter((t): t is keyof typeof EVENT_TYPE_LABEL => !!t))].sort();
  return { events, total, types, organization, ...topics };
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
      <CatalogueTopBar organization={organization} signedIn={!!session?.user} />

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
          <WhenTabs when={query.when} hrefFor={(when) => catalogueHref(query, { when })} />
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

        <h2 className="sr-only">{query.when === "upcoming" ? "Upcoming events" : "Past events"}</h2>
        {events.length === 0 ? (
          <EmptyEvents
            title={`No ${query.when} events${filtered ? " match these filters" : " yet"}`}
            hint={query.when === "upcoming" ? "New events are added as they open for registration." : "Past events appear here once they end."}
          />
        ) : (
          <EventGrid events={events} upcoming={query.when === "upcoming"} />
        )}

        <Pager page={query.page} pages={pages} hrefFor={(page) => catalogueHref(query, { page })} />

        <BrowseTopics specialties={specialties} countries={countries} />
      </main>

      <CatalogueFooter organization={organization} />
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
