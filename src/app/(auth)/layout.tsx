import { headers } from "next/headers";
import { Award, FileText, Ticket } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { loadPublicBrandForHost } from "@/lib/public-brand-server";

// The HCP doors: the attendee-facing brand (public-brand.ts), set in Settings.
// Staff sign in at /staff/login, under the organisation's own.
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
