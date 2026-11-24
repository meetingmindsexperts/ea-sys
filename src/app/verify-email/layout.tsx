import type { Metadata } from "next";
import { PortalAuthShell } from "@/components/auth/portal-auth-shell";

export const metadata: Metadata = { title: "Confirm your email" };

// The same frame as the sign-in pages (owner, Nov 24, 2026: "put logo on
// verify-email"): the attendee-facing brand's logo above the card and its
// panel beside it. The link in an email is the first page many people see.
export default function VerifyEmailLayout({ children }: { children: React.ReactNode }) {
  return <PortalAuthShell>{children}</PortalAuthShell>;
}
