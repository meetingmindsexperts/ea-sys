import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Activity } from "lucide-react";
import { canViewLoginActivity } from "@/lib/login-visibility";
import { canViewHr } from "@/lib/hr-visibility";
import { canViewProcurement } from "@/lib/procurement-visibility";
import { isHrModuleEnabled, isProcurementModuleEnabled } from "@/lib/module-flags";
import { ActivityTabs } from "./activity-tabs";

/** "Every change made across your events, with budgets and HR changes on their own tabs, and who has been signing in." */
function describePage(tabs: string[]): string {
  if (tabs.length === 0) return "Every change made across your events, and who has been signing in.";
  const list = tabs.length === 1 ? tabs[0] : `${tabs.slice(0, -1).join(", ")} and ${tabs[tabs.length - 1]}`;
  return `Every change made across your events, with ${list} on ${tabs.length === 1 ? "its own tab" : "their own tabs"}, and who has been signing in.`;
}

export default async function ActivityPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  const allowedRoles = ["SUPER_ADMIN", "ADMIN"];
  if (!allowedRoles.includes(session.user.role)) {
    redirect("/dashboard");
  }

  // Two walls, same as every HR route: the module must be switched on for
  // this deployment, AND this person must hold HR access. The API enforces
  // both again on `?scope=hr`; this only decides whether to draw the tab.
  const canViewHrActivity = isHrModuleEnabled() && canViewHr(session.user);
  // The same pair for the Budget tab, against the procurement flag and predicate.
  const canViewBudgetActivity = isProcurementModuleEnabled() && canViewProcurement(session.user);

  const ownTabs = [...(canViewBudgetActivity ? ["budgets"] : []), ...(canViewHrActivity ? ["HR changes"] : [])];

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Activity className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Activity</h1>
          <p className="text-muted-foreground">{describePage(ownTabs)}</p>
        </div>
      </div>

      <ActivityTabs
        canViewSignIns={canViewLoginActivity(session.user.role)}
        canViewHrActivity={canViewHrActivity}
        canViewBudgetActivity={canViewBudgetActivity}
      />
    </div>
  );
}
