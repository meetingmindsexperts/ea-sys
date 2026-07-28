"use client";

/**
 * The two things "activity" can mean, kept as sibling tabs rather than one feed.
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
 * ACCESS
 * ------
 * The page already gates to SUPER_ADMIN + ADMIN, which happens to equal
 * `canViewLoginActivity`. The tab is nonetheless gated on its own predicate
 * rather than assuming the two stay equal — if the page gate is ever widened
 * (say to ORGANIZER for the audit trail), the sign-ins tab must not come with
 * it. The API routes enforce the same boundary independently.
 */

import { useState } from "react";
import { History, ShieldCheck } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GlobalActivityFeed } from "./global-activity-feed";
import { ActiveUsersCard } from "@/components/activity/active-users-card";
import { LoginActivityCard } from "@/components/activity/login-activity-card";

export function ActivityTabs({ canViewSignIns }: { canViewSignIns: boolean }) {
  const [tab, setTab] = useState("changes");

  // Without the sign-ins tab there is nothing to switch between, so the
  // tab strip would be a control that does nothing.
  if (!canViewSignIns) return <GlobalActivityFeed />;

  return (
    <Tabs value={tab} onValueChange={setTab} className="space-y-6">
      <TabsList>
        <TabsTrigger value="changes" className="flex items-center gap-2">
          <History className="h-4 w-4" />
          Changes
        </TabsTrigger>
        <TabsTrigger value="sign-ins" className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          Sign-ins
        </TabsTrigger>
      </TabsList>

      <TabsContent value="changes">
        <GlobalActivityFeed />
      </TabsContent>

      {/* Two different questions, deliberately stacked: who is using the system
          RIGHT NOW (live presence), then the history of sign-in attempts
          (including failures). Someone can be online above with no row below —
          sessions last 24h, so they may have signed in yesterday. */}
      <TabsContent value="sign-ins" className="space-y-6">
        <ActiveUsersCard />
        <LoginActivityCard />
      </TabsContent>
    </Tabs>
  );
}
