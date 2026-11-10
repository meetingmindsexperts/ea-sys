import { headers } from "next/headers";
import { MapPin, Ticket, Users } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { loadStaffBrandForHost } from "@/lib/public-brand-server";

// The staff door: the organisation's own name and logo, as the dashboard shows.
export default async function StaffAuthLayout({ children }: { children: React.ReactNode }) {
  const brand = await loadStaffBrandForHost((await headers()).get("host"));
  return (
    <AuthShell
      brand={brand}
      tagline="The event management platform for conferences, meetings and events."
      tiles={[
        { icon: Users, label: "Speakers" },
        { icon: Ticket, label: "Tickets" },
        { icon: MapPin, label: "Venues" },
      ]}
    >
      {children}
    </AuthShell>
  );
}
