import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { canViewFinance } from "@/lib/finance-visibility";
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
  if (!canViewFinance(session.user.role)) redirect("/dashboard");
  return <OrgInvoicesClient />;
}
