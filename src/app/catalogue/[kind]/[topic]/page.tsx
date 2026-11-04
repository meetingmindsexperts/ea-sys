import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { ChevronRight } from "lucide-react";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { apiLogger } from "@/lib/logger";
import {
  CATALOGUE_PAGE_SIZE,
  TOPIC_KINDS,
  catalogueOrderBy,
  catalogueWhere,
  findTopic,
  parseCatalogueQuery,
  topicHref,
  topicIntro,
  topicTitle,
  type CatalogueQuery,
  type TopicKind,
} from "@/lib/catalogue";
import { CATALOGUE_EVENT_SELECT, listTopicValues, loadSiteContext } from "@/lib/catalogue-data";
import { absoluteUrl, catalogueJsonLd, jsonLdText, siteOrigin } from "@/lib/seo";
import { BrowseTopics, CatalogueFooter, CatalogueTopBar, EmptyEvents, EventGrid, Pager, WhenTabs } from "@/components/catalogue/catalogue-parts";

/**
 * A topic page of the catalogue (Nov 4, 2026, phase 3): every listed event in
 * one specialty (/catalogue/specialty/cardiology) or one country
 * (/catalogue/country/oman). Indexable, unlike the catalogue's filter URLs,
 * because these match how people search ("cardiology conference Dubai", "CME
 * events Oman"). A topic exists only while it has a listed event; any other
 * slug is a 404, so nothing thin is ever indexed. Rules: src/lib/catalogue.ts.
 */

type Props = {
  params: Promise<{ kind: string; topic: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** Resolve the URL to a real topic, once per request (metadata and the page both ask). */
const resolveTopic = cache(async (kind: string, slug: string) => {
  if (!(TOPIC_KINDS as readonly string[]).includes(kind)) return null;
  const host = (await headers()).get("host");
  const { orgScope, organization } = await loadSiteContext(host);
  const values = await listTopicValues(orgScope);
  const topic = findTopic(kind === "specialty" ? values.specialties : values.countries, slug);
  return topic ? { kind: kind as TopicKind, topic, value: topic.label, orgScope, organization, values } : null;
});

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ kind, topic }, sp, h] = await Promise.all([params, searchParams, headers()]);
  // A database error is thrown, never turned into a 404: a crawler that sees
  // a 404 for a real topic during a blip may drop it from its index.
  let resolved: Awaited<ReturnType<typeof resolveTopic>>;
  try {
    resolved = await resolveTopic(kind, topic);
  } catch (err) {
    apiLogger.error({ err, kind, topic, msg: "catalogue-topic:metadata-failed" });
    throw err;
  }
  // Here, not only in the page: crawlers get metadata before any HTML is
  // streamed, so a 404 thrown now is a real 404 rather than a 200 with a
  // "not found" body (a soft 404 to search engines).
  if (!resolved) notFound();
  const query = parseCatalogueQuery(sp);
  const origin = siteOrigin(h.get("host"), h.get("x-forwarded-proto"));
  const heading = topicTitle(resolved.kind, resolved.value);
  const title = `${query.when === "past" ? `Past ${heading.charAt(0).toLowerCase()}${heading.slice(1)}` : heading}${resolved.organization ? ` | ${resolved.organization.name}` : ""}`;
  const description = `${heading}: browse ${query.when === "past" ? "past" : "upcoming"} events, register online and download your CME certificates.`;
  const canonical = `${origin}${topicHref(resolved.kind, resolved.value, query)}`;
  return {
    title,
    description,
    alternates: { canonical },
    robots: { index: true, follow: true },
    openGraph: {
      title,
      description,
      url: canonical,
      type: "website",
      ...(resolved.organization && { siteName: resolved.organization.name }),
      ...(resolved.organization?.logo && { images: [{ url: absoluteUrl(origin, resolved.organization.logo) }] }),
    },
    twitter: { card: "summary", title, description },
  };
}

async function loadTopicEvents(
  orgScope: { organizationId?: string },
  query: CatalogueQuery,
  variants: { country?: readonly string[]; specialty?: readonly string[] },
  now: Date,
) {
  const where = catalogueWhere(orgScope, query, now, variants);
  const upcomingWhere = catalogueWhere(orgScope, { ...query, when: "upcoming", page: 1 }, now, variants);
  const [events, total, upcomingCount, upcomingFacts] = await Promise.all([
    db.event.findMany({ where, orderBy: catalogueOrderBy(query), skip: (query.page - 1) * CATALOGUE_PAGE_SIZE, take: CATALOGUE_PAGE_SIZE, select: CATALOGUE_EVENT_SELECT }),
    db.event.count({ where }),
    // The intro speaks about upcoming events, whichever tab is open: counted
    // exactly, described from a sample.
    db.event.count({ where: upcomingWhere }),
    db.event.findMany({ where: upcomingWhere, take: 200, select: { city: true, country: true, specialty: true, cmeHours: true } }),
  ]);
  return { events, total, upcomingCount, upcomingFacts };
}

export default async function CatalogueTopicPage({ params, searchParams }: Props) {
  const [{ kind, topic }, sp, session, h] = await Promise.all([params, searchParams, auth(), headers()]);
  const origin = siteOrigin(h.get("host"), h.get("x-forwarded-proto"));

  let resolved: Awaited<ReturnType<typeof resolveTopic>>;
  try {
    resolved = await resolveTopic(kind, topic);
  } catch (err) {
    apiLogger.error({ err, kind, topic, msg: "catalogue-topic:resolve-failed" });
    throw err;
  }
  if (!resolved) {
    apiLogger.info({ kind, topic, msg: "catalogue-topic:not-found" });
    notFound();
  }

  // The topic IS the filter; the URL carries only the tab and the page.
  const base = parseCatalogueQuery(sp);
  const query: CatalogueQuery = {
    ...base,
    q: "",
    type: null,
    country: resolved.kind === "country" ? resolved.value : "",
    specialty: resolved.kind === "specialty" ? resolved.value : "",
  };

  let data: Awaited<ReturnType<typeof loadTopicEvents>>;
  try {
    data = await loadTopicEvents(
      resolved.orgScope,
      query,
      resolved.kind === "country" ? { country: resolved.topic.variants } : { specialty: resolved.topic.variants },
      new Date(),
    );
  } catch (err) {
    apiLogger.error({ err, kind, topic, msg: "catalogue-topic:load-failed" });
    throw err;
  }
  const { events, total, upcomingCount, upcomingFacts } = data;
  const pages = Math.max(1, Math.ceil(total / CATALOGUE_PAGE_SIZE));
  if (query.page > pages) redirect(topicHref(resolved.kind, resolved.value, { when: query.when, page: pages }));

  const heading = topicTitle(resolved.kind, resolved.value);
  const intro = topicIntro(resolved.kind, resolved.value, upcomingFacts, upcomingCount);
  const path = topicHref(resolved.kind, resolved.value);

  return (
    <div className="flex min-h-screen flex-col bg-[#f8f9fb]">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdText(catalogueJsonLd(events, origin, resolved.organization, { name: heading, path })) }}
      />
      <CatalogueTopBar organization={resolved.organization} signedIn={!!session?.user} />

      <section className="bg-gradient-primary text-white">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">
          <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs font-medium text-white/80">
            <Link href="/catalogue" className="hover:text-white">
              Event catalogue
            </Link>
            <ChevronRight className="h-3.5 w-3.5" />
            <span aria-current="page" className="text-white">
              {resolved.value}
            </span>
          </nav>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{heading}</h1>
          <p className="mt-2 max-w-2xl text-sm text-white/90 sm:text-base">{intro}</p>
        </div>
      </section>

      <main className="mx-auto w-full max-w-6xl flex-1 space-y-5 px-4 py-6 sm:px-6 sm:py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <WhenTabs when={query.when} hrefFor={(when) => topicHref(resolved.kind, resolved.value, { when, page: 1 })} />
          <p className="text-sm text-slate-500">
            {total} {total === 1 ? "event" : "events"}
          </p>
        </div>

        <h2 className="sr-only">{query.when === "upcoming" ? `Upcoming ${resolved.value} events` : `Past ${resolved.value} events`}</h2>
        {events.length === 0 ? (
          <EmptyEvents
            title={`No ${query.when} events here right now`}
            hint={query.when === "upcoming" ? "See the Past tab, or browse another topic below." : "Past events appear here once they end."}
          />
        ) : (
          <EventGrid events={events} upcoming={query.when === "upcoming"} />
        )}

        <Pager page={query.page} pages={pages} hrefFor={(page) => topicHref(resolved.kind, resolved.value, { when: query.when, page })} />

        <BrowseTopics specialties={resolved.values.specialties} countries={resolved.values.countries} current={{ kind: resolved.kind, slug: resolved.topic.slug }} />
      </main>

      <CatalogueFooter organization={resolved.organization} />
    </div>
  );
}
