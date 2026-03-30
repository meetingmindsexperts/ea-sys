import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { GlobalActivityFeed } from "./global-activity-feed";

export default async function ActivityPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  const allowedRoles = ["SUPER_ADMIN", "ADMIN"];
  if (!allowedRoles.includes(session.user.role)) {
    redirect("/dashboard");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Activity</h1>
        <p className="text-muted-foreground">
          Recent activity across all events in your organization.
        </p>
      </div>

      <GlobalActivityFeed />
    </div>
  );
}
