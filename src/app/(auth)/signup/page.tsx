import type { Metadata } from "next";
import { headers } from "next/headers";
import { loadSiteContext } from "@/lib/catalogue-data";
import { apiLogger } from "@/lib/logger";
import { SignupForm } from "@/components/auth/signup-form";

export const metadata: Metadata = {
  title: "Create an account",
  robots: { index: false, follow: true },
};

/**
 * Create an account without registering for an event (Nov 5, 2026; phase 2
 * of docs/ACCOUNT_CONFIRMATION_PLAN.md). Linked from the catalogue and the
 * sign-in page. The terms and privacy links are the host organisation's, set
 * in Settings, Catalogue; registration terms stay per event.
 */
export default async function SignupPage() {
  const h = await headers();
  // The form works without them: a failed read only drops the links.
  const organization = await loadSiteContext(h.get("host"))
    .then((ctx) => ctx.organization)
    .catch((err) => {
      apiLogger.error({ err, msg: "signup:site-context-failed" });
      return null;
    });

  return (
    <SignupForm
      organizationName={organization?.name ?? null}
      termsUrl={organization?.catalogue.termsUrl ?? null}
      privacyUrl={organization?.catalogue.privacyUrl ?? null}
    />
  );
}
