import { PortalAuthShell } from "@/components/auth/portal-auth-shell";

// One sign-in door for everyone (owner, Nov 10, 2026): the brand, the tagline
// and the tiles are in PortalAuthShell, shared with the confirmation page.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <PortalAuthShell>{children}</PortalAuthShell>;
}
