/**
 * SERVER-SIDE GATE ON EVERY /crm PAGE: the organisation must have the CRM
 * (module-entitlements.ts). Same answer as requireCrmRead, which is the real
 * gate: notFound(), because a module the organisation lacks does not announce
 * itself. Who may read the board inside an organisation that has it stays the
 * API's question (and the shell hides what the person may not open).
 */
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiLogger } from "@/lib/logger";
import { orgModuleState } from "@/lib/module-entitlements";
import { CrmShell } from "@/crm/components/crm-shell";

export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const organizationId = session?.user?.organizationId;
  const state = organizationId ? await orgModuleState(organizationId, "crm") : "off";
  // Could not tell (logged at error where it failed): an error page, never a
  // "not found" that is not true. requireCrmRead answers 503 the same way.
  if (state === "unknown") throw new Error("Could not check whether this organisation has the CRM");
  if (state === "off") {
    apiLogger.warn({ msg: "crm-page:module-not-enabled", organizationId: organizationId ?? null });
    notFound();
  }
  return <CrmShell>{children}</CrmShell>;
}
