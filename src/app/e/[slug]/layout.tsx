import type { Metadata } from "next";
import { buildEventMetadata, getPublicEventBrandColor } from "@/lib/public-event-metadata";
import { brandPaletteCss } from "@/lib/org-color";

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
  const css = brandPaletteCss(await getPublicEventBrandColor(slug));

  return (
    <>
      {css ? <style dangerouslySetInnerHTML={{ __html: css }} /> : null}
      {children}
    </>
  );
}
