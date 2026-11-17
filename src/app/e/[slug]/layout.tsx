import type { Metadata } from "next";
import { buildEventMetadata, getPublicEventShell } from "@/lib/public-event-metadata";
import { brandPaletteCss } from "@/lib/org-color";
import { Suspense } from "react";
import { PageAnalytics } from "@/analytics/react/page-analytics";
import { PublicEventBrandingProvider } from "@/components/public/event-branding-context";

/**
 * Base per-event SEO metadata for the public `/e/[slug]` subtree. Each public
 * sub-route (register, agenda, session, …) has its own `layout.tsx` that
 * overrides this with a section-specific title; this base covers the bare
 * `/e/[slug]` entry and anything without its own section layout.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return buildEventMetadata({ slug });
}

/**
 * Applies the organiser's brand colour to the WHOLE public subtree.
 *
 * Server-rendered as a `:root` override rather than set from an effect, for
 * two reasons: an attendee never sees a flash of the default palette while
 * JS boots, and `:root` also reaches portalled UI (dialogs, tooltips, toasts)
 * which mounts outside this element and would otherwise stay unbranded.
 *
 * Scoping is by ROUTE, not by DOM — this layout only renders under
 * `/e/[slug]`, so the dashboard's own theme is untouched. Only the
 * brand-carrying tokens move (see `buildBrandPalette`); page backgrounds and
 * body text stay neutral so a sponsor reading an invoice page isn't fighting
 * a tinted surface.
 */
export default async function PublicEventLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const shell = await getPublicEventShell(slug);
  const css = brandPaletteCss(shell.brandColor);

  return (
    <>
      {css ? <style dangerouslySetInnerHTML={{ __html: css }} /> : null}
      {/*
        Mounted once for the WHOLE public subtree rather than per page.
        Remembering to add it to each new public page is exactly the thing that
        gets forgotten, and mounting it everywhere is safe because the
        allow-list means it sends nothing at all from a route we may not
        measure. It renders null and never causes a re-render.

        Not mounted when the slug has no event (a deleted event's old links):
        the ingest could only drop the hit and log it as unresolved.

        Suspense because it reads useSearchParams, which opts the subtree into
        client rendering without a boundary.
      */}
      {shell.exists ? (
        <Suspense fallback={null}>
          <PageAnalytics site={slug} />
        </Suspense>
      ) : null}
      {/*
        The event's banner, name, dates and footer for every page below, so a
        page that has only a message to show ("the agenda is not live yet", a
        closed form, a dead link) keeps the event's frame without asking for it
        again (src/components/public/event-notice.tsx). Null when the event's
        branding is not public.
      */}
      <PublicEventBrandingProvider branding={shell.branding}>{children}</PublicEventBrandingProvider>
    </>
  );
}
