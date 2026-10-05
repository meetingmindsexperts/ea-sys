import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can } from "@/lib/permissions/can";
import { principalFromSession } from "@/lib/permissions/require-permission";
import { NoAccess } from "@/components/permissions/no-access";
import OrgInvoicesClient from "./invoices-client";

/**
 * Server-side finance guard (review M3): the org Invoices hub shows financial
 * data, so a non-finance role must not even render the page chrome. The API is
 * already finance-gated (denyFinance) so no amounts can leak, but this bounces
 * the route before the client mounts — matching the per-event invoices page and
 * hiding it behind more than just the sidebar's `financeOnly` nav filter.
 */
export default async function InvoicesPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // The organisation's invoice book: the key its API asks (Onsite is
  // finance-capable on its events but does not hold the book).
  if (!can(principalFromSession(session), "invoices.ledger")) {
    return <NoAccess what="the organisation's invoices" back={{ href: "/dashboard", label: "Back to Dashboard" }} />;
  }
  return <OrgInvoicesClient />;
}
