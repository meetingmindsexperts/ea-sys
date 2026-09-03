import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Activity } from "lucide-react";
import { canViewLoginActivity } from "@/lib/login-visibility";
import { canViewHr } from "@/lib/hr-visibility";
import { isHrModuleEnabled } from "@/lib/module-flags";
import { ActivityTabs } from "./activity-tabs";

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

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <Activity className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Activity</h1>
          <p className="text-muted-foreground">
            Every change made across your events
            {canViewHrActivity ? ", HR changes on their own tab," : ","} and who has been signing in.
          </p>
        </div>
      </div>

      <ActivityTabs
        canViewSignIns={canViewLoginActivity(session.user.role)}
        canViewHrActivity={canViewHrActivity}
      />
    </div>
  );
}
