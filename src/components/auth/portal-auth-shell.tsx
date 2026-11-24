import { headers } from "next/headers";
import { Award, FileText, Ticket } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { loadPublicBrandForHost } from "@/lib/public-brand-server";

/**
 * The frame every signed-out account page wears: the sign-in pages, and the
 * page a confirmation link opens (Nov 24, 2026: that page stood alone with no
 * logo, so someone arriving from an email could not tell whose page it was).
 *
 * Before sign-in nobody is known, so it shows the address's attendee-facing
 * brand (public-brand.ts); staff see the organisation's own once inside. A
 * separate staff address comes later (docs/HCP_PORTAL_AND_BRAND_PLAN.md,
 * Stage 3). One place for the tagline and the tiles, so the pages cannot drift.
 */
export async function PortalAuthShell({ children }: { children: React.ReactNode }) {
  const brand = await loadPublicBrandForHost((await headers()).get("host"));
  return (
    <AuthShell
      brand={brand}
      tagline="Your registrations, abstracts and certificates for every event, in one place."
      tiles={[
        { icon: Ticket, label: "Registrations" },
        { icon: FileText, label: "Abstracts" },
        { icon: Award, label: "Certificates" },
      ]}
    >
      {children}
    </AuthShell>
  );
}
