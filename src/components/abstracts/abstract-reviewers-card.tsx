"use client";

/**
 * Per-abstract reviewer assignment card (admin/organizer only).
 *
 * Assign specific reviewers from the event pool to THIS abstract, with a
 * role (Primary/Secondary/Consulting) and a conflict-of-interest flag, and
 * see each reviewer's submission status. Backed by:
 *   GET/POST  /api/events/[id]/abstracts/[aid]/reviewers
 *   DELETE    /api/events/[id]/abstracts/[aid]/reviewers/[userId]
 *
 * Per-abstract assignment is additive to the event-wide reviewer pool
 * (pool reviewers can review every abstract); explicit assignment is for
 * workload distribution + COI tracking, and grants review access even to a
 * reviewer who isn't in the pool.
 */

import { useMemo } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { AlertTriangle, Check, Loader2, UserPlus, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useReviewers,
  useAbstractReviewers,
  useAssignAbstractReviewer,
  useUnassignAbstractReviewer,
  type AbstractReviewerRole,
  type AbstractReviewerRow,
} from "@/hooks/use-api";
import { ABSTRACT_REVIEWER_ROLE_OPTIONS } from "@/app/(dashboard)/events/[eventId]/abstracts/abstract-enums";

interface PoolReviewer {
  userId: string | null;
  firstName: string;
  lastName: string;
  email: string;
}

interface Entry {
  userId: string;
  name: string;
  email: string;
  assignment: AbstractReviewerRow | null;
}

const ADMIN_ROLES = new Set(["SUPER_ADMIN", "ADMIN", "ORGANIZER"]);

export function AbstractReviewersCard({
  eventId,
  abstractId,
}: {
  eventId: string;
  abstractId: string;
}) {
  const { data: session } = useSession();
  const isAdmin = ADMIN_ROLES.has(session?.user?.role ?? "");

  const { data: poolData } = useReviewers(eventId);
  const { data: assignedData, isLoading } = useAbstractReviewers(eventId, abstractId);
  const assign = useAssignAbstractReviewer(eventId, abstractId);
  const unassign = useUnassignAbstractReviewer(eventId, abstractId);

  const entries = useMemo<Entry[]>(() => {
    const assigned = assignedData?.reviewers ?? [];
    const byUser = new Map<string, AbstractReviewerRow>(
      assigned.map((a) => [a.user.id, a]),
    );
    const pool: PoolReviewer[] = (poolData?.reviewers ?? []) as PoolReviewer[];

    const seen = new Set<string>();
    const list: Entry[] = [];
    // Pool reviewers first (the common case — assign from the pool).
    for (const r of pool) {
      if (!r.userId || seen.has(r.userId)) continue;
      seen.add(r.userId);
      list.push({
        userId: r.userId,
        name: `${r.firstName} ${r.lastName}`.trim(),
        email: r.email,
        assignment: byUser.get(r.userId) ?? null,
      });
    }
    // Reviewers explicitly assigned but NOT in the pool (still valid).
    for (const a of assigned) {
      if (seen.has(a.user.id)) continue;
      seen.add(a.user.id);
      list.push({
        userId: a.user.id,
        name: `${a.user.firstName} ${a.user.lastName}`.trim(),
        email: a.user.email,
        assignment: a,
      });
    }
    // Assigned reviewers float to the top.
    return list.sort((x, y) => Number(!!y.assignment) - Number(!!x.assignment));
  }, [poolData, assignedData]);

  if (!isAdmin) return null;

  const busy = assign.isPending || unassign.isPending;
  const assignedCount = assignedData?.reviewers.length ?? 0;
  const poolEmpty = (poolData?.reviewers ?? []).filter((r: PoolReviewer) => r.userId).length === 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <UserPlus className="h-4 w-4" />
          Reviewers
          {assignedCount > 0 && (
            <Badge variant="secondary" className="ml-1 text-[10px]">
              {assignedCount} assigned
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="text-xs">
          Assign specific reviewers to this abstract with a role and conflict flag. Pool reviewers
          can review every abstract; explicit assignment is for workload + COI tracking.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : entries.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">
            {poolEmpty ? (
              <>
                No reviewers in the event pool yet.{" "}
                <Link href={`/events/${eventId}/reviewers`} className="text-primary underline">
                  Add reviewers
                </Link>{" "}
                first.
              </>
            ) : (
              "No reviewers available."
            )}
          </p>
        ) : (
          entries.map((e) => {
            const a = e.assignment;
            return (
              <div
                key={e.userId}
                className={`rounded-lg border p-2.5 ${a ? "border-primary/30 bg-primary/[0.03]" : "border-border"}`}
              >
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium truncate">{e.name || e.email}</span>
                      {a?.hasSubmitted ? (
                        <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-[10px]">
                          <Check className="h-2.5 w-2.5 mr-0.5" />
                          {a.submission?.overallScore != null ? `${a.submission.overallScore}/100` : "Submitted"}
                        </Badge>
                      ) : a ? (
                        <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300">
                          Pending
                        </Badge>
                      ) : null}
                      {a?.conflictFlag && (
                        <Badge variant="outline" className="text-[10px] text-red-600 border-red-300">
                          <AlertTriangle className="h-2.5 w-2.5 mr-0.5" /> COI
                        </Badge>
                      )}
                    </div>
                    {e.name && <p className="text-[11px] text-muted-foreground truncate">{e.email}</p>}
                  </div>

                  {a ? (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Select
                        value={a.role}
                        onValueChange={(role) =>
                          assign.mutate({ userId: e.userId, role: role as AbstractReviewerRole })
                        }
                        disabled={busy}
                      >
                        <SelectTrigger className="h-7 w-[110px] text-xs" aria-label="Reviewer role">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ABSTRACT_REVIEWER_ROLE_OPTIONS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                        disabled={busy}
                        onClick={() => unassign.mutate(e.userId)}
                        aria-label="Remove reviewer"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 shrink-0 text-xs"
                      disabled={busy}
                      onClick={() => assign.mutate({ userId: e.userId, role: "SECONDARY" })}
                    >
                      <UserPlus className="h-3 w-3 mr-1" /> Assign
                    </Button>
                  )}
                </div>

                {a && (
                  <label className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                    <Switch
                      checked={a.conflictFlag}
                      onCheckedChange={(checked) =>
                        assign.mutate({ userId: e.userId, conflictFlag: checked })
                      }
                      disabled={busy}
                      className="scale-75"
                    />
                    Conflict of interest
                  </label>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
