"use client";

/**
 * The four things "activity" can mean, kept as sibling tabs rather than one feed.
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
 * "Budget" (Sep 15, 2026, owner: "keep budget activity separate from event
 * activity") is the same table again, a different SUBJECT. The Budget &
 * Procurement module writes budgets, lines, spend requests, purchase orders,
 * suppliers and catalogue changes into AuditLog, and between two hundred
 * registration edits they read as noise on both sides, in raw "CREATE
 * EventBudget" form. The Changes query excludes them server-side and this tab
 * asks for them with their subjects resolved and their sentences written,
 * behind the module flag and `canViewProcurement`.
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
 * decision, not a side effect of this one. The same holds for the wider
 * procurement population (an organiser, a grant holder): they read budgets
 * under /procurement, and an Activity page there is a separate decision.
 */

import { useState } from "react";
import { CalendarClock, History, ShieldCheck, Wallet } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GlobalActivityFeed } from "./global-activity-feed";
import { ActiveUsersCard } from "@/components/activity/active-users-card";
import { LoginActivityCard } from "@/components/activity/login-activity-card";

export function ActivityTabs({
  canViewSignIns,
  canViewHrActivity,
  canViewBudgetActivity = false,
}: {
  canViewSignIns: boolean;
  canViewHrActivity: boolean;
  canViewBudgetActivity?: boolean;
}) {
  const [tab, setTab] = useState("changes");

  // With only the Changes tab there is nothing to switch between, so the
  // tab strip would be a control that does nothing.
  if (!canViewSignIns && !canViewHrActivity && !canViewBudgetActivity) return <GlobalActivityFeed />;

  return (
    <Tabs value={tab} onValueChange={setTab} className="space-y-6">
      <TabsList>
        <TabsTrigger value="changes" className="flex items-center gap-2">
          <History className="h-4 w-4" />
          Changes
        </TabsTrigger>
        {canViewBudgetActivity && (
          <TabsTrigger value="budget" className="flex items-center gap-2">
            <Wallet className="h-4 w-4" />
            Budget
          </TabsTrigger>
        )}
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

      {/* Each scope is its own instance, so filter state never bleeds between them. */}
      {canViewBudgetActivity && (
        <TabsContent value="budget">
          <GlobalActivityFeed scope="procurement" />
        </TabsContent>
      )}

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
