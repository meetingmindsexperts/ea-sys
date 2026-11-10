import { headers } from "next/headers";
import { Award, FileText, Ticket } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { loadPublicBrandForHost } from "@/lib/public-brand-server";

// One sign-in door for everyone (owner, Nov 10, 2026): before sign-in nobody is
// known, so it shows the address's attendee-facing brand (public-brand.ts); staff
// see the organisation's own once inside. A separate staff address comes later
// (docs/HCP_PORTAL_AND_BRAND_PLAN.md, Stage 3).
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
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
