"use client";

/**
 * The event's public branding, handed from the public `[slug]` layout to every
 * page below it (src/lib/public-event-branding.ts).
 *
 * In its own file on purpose: the layout imports the provider, and a client
 * module the layout imports is loaded by every public page. Kept apart from
 * `event-notice.tsx`, it costs those pages a context and nothing else; the
 * notice (with the HTML sanitiser it needs for the footer) loads only on a
 * page that can show one.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { PublicEventBranding } from "@/lib/public-event-branding";

const BrandingContext = createContext<PublicEventBranding | null>(null);

export function PublicEventBrandingProvider({
  branding,
  children,
}: {
  branding: PublicEventBranding | null;
  children?: ReactNode;
}) {
  return <BrandingContext.Provider value={branding}>{children}</BrandingContext.Provider>;
}

/** The event's public branding, or null when there is none to show. */
export function usePublicEventBranding(): PublicEventBranding | null {
  return useContext(BrandingContext);
}
