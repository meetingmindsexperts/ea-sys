"use client";

/**
 * The three things "activity" can mean, kept as sibling tabs rather than one feed.
 *
 * WHY NOT MERGE THEM
 * ------------------
 * They answer different questions from different tables and for different
 * audiences. "Changes" is the business audit trail (AuditLog — who edited what),
 * useful to any admin reconstructing how a record got into its current state.
 * "Sign-ins" is security data about colleagues (IP, approximate location, the
 * hours a named person was at their desk) drawn from LoginEvent + User.lastSeenAt.
 * Interleaving "Dina updated a registration" with "Dina signed in from Dubai"
 * into one stream would make the second impossible to scan and would put
 * surveillance-shaped data in front of anyone opening the audit trail.
 *
 * "HR" (Sep 3, 2026) is the same table as Changes but a different POPULATION
 * may read it. The HR module writes its audit rows (employees, attendance,
 * standing rules, leave-year rolls, holidays) into AuditLog like everything
 * else, and until this tab existed they rendered in Changes for every admin,
 * while HR itself is granted per person and ADMIN alone is not enough to read
 * a colleague's sick leave. So the Changes query now excludes those rows
 * server-side and this tab asks for them explicitly, behind `canViewHr`. The
 * exclusion is the load-bearing half; the tab is the convenience.
 *
 * ACCESS
 * ------
 * The page already gates to SUPER_ADMIN + ADMIN, which happens to equal
 * `canViewLoginActivity`. Each extra tab is nonetheless gated on its own
 * predicate rather than assuming they stay equal — if the page gate is ever
 * widened (say to ORGANIZER for the audit trail), neither the sign-ins tab nor
 * the HR tab must come with it. The API routes enforce the same boundaries
 * independently, so hiding a tab is a courtesy, not the control.
 *
 * HR_USER is not on this page at all: the page gate is ADMIN + SUPER_ADMIN and
 * an HR_USER lives under /hr. The tab serves super admins and admins holding
 * the per-person grant. Widening the page to HR_USER is a deliberate separate
 * decision, not a side effect of this one.
 */

import { useState } from "react";
import { CalendarClock, History, ShieldCheck } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GlobalActivityFeed } from "./global-activity-feed";
import { ActiveUsersCard } from "@/components/activity/active-users-card";
import { LoginActivityCard } from "@/components/activity/login-activity-card";

export function ActivityTabs({
  canViewSignIns,
  canViewHrActivity,
}: {
  canViewSignIns: boolean;
  canViewHrActivity: boolean;
}) {
  const [tab, setTab] = useState("changes");

  // With only the Changes tab there is nothing to switch between, so the
  // tab strip would be a control that does nothing.
  if (!canViewSignIns && !canViewHrActivity) return <GlobalActivityFeed />;

  return (
    <Tabs value={tab} onValueChange={setTab} className="space-y-6">
      <TabsList>
        <TabsTrigger value="changes" className="flex items-center gap-2">
          <History className="h-4 w-4" />
          Changes
        </TabsTrigger>
        {canViewHrActivity && (
          <TabsTrigger value="hr" className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4" />
            HR
          </TabsTrigger>
        )}
        {canViewSignIns && (
          <TabsTrigger value="sign-ins" className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            Sign-ins
          </TabsTrigger>
        )}
      </TabsList>

      <TabsContent value="changes">
        <GlobalActivityFeed />
      </TabsContent>

      {/* Its own instance, so filter state never bleeds between scopes. */}
      {canViewHrActivity && (
        <TabsContent value="hr">
          <GlobalActivityFeed scope="hr" />
        </TabsContent>
      )}

      {/* Two different questions, deliberately stacked: who is using the system
          RIGHT NOW (live presence), then the history of sign-in attempts
          (including failures). Someone can be online above with no row below —
          sessions last 48h, so they may have signed in yesterday. */}
      {canViewSignIns && (
        <TabsContent value="sign-ins" className="space-y-6">
          <ActiveUsersCard />
          <LoginActivityCard />
        </TabsContent>
      )}
    </Tabs>
  );
}
