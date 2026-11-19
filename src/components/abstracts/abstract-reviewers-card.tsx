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
 * The assignment IS the review right (Nov 10, 2026): a reviewer sees and
 * scores only the abstracts assigned to them; the event's reviewer pool is the
 * list to assign from. It also carries the role and the conflict flag, and
 * works for someone who isn't in the pool.
 */

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, Check, Loader2, Search, UserPlus, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
import { useCan } from "@/hooks/use-can";
import { formatPersonName } from "@/lib/utils";
import { toast } from "sonner";

/**
 * A refused action says why (review of 428991e8, Nov 10, 2026): assigning an
 * abstract to its own author is refused, and the button used to do nothing.
 */
const showError = (error: Error) => toast.error(error.message || "Could not update the reviewer");

interface PoolReviewer {
  userId: string | null;
  title?: string | null;
  firstName: string;
  lastName: string;
  email: string;
  /** Abstracts they hold across the event: what to weigh before giving them one more. */
  assignments?: { assigned: number };
}

interface Entry {
  userId: string;
  name: string;
  email: string;
  /** Null for someone assigned here who is not on the event's pool. */
  workload: number | null;
  assignment: AbstractReviewerRow | null;
}

/** A pool this long gets a search box. */
const SEARCH_FROM = 8;

const INTRO =
  "A reviewer sees and scores only the abstracts assigned to them: nobody can review this one until it is assigned. " +
  "Assigning sends no email; they find it in My Reviews. Send the invitation from the Reviewers page.";

function workloadLabel(count: number | null): string | null {
  if (count === null) return null;
  if (count === 0) return "None assigned yet";
  return `${count} assigned`;
}

function matchesSearch(e: Entry, query: string): boolean {
  return `${e.name} ${e.email}`.toLowerCase().includes(query);
}

/** The pool first, then anyone assigned here who is not on it, one row per person. */
function buildEntries(pool: PoolReviewer[], assigned: AbstractReviewerRow[]): Entry[] {
  const byUser = new Map<string, AbstractReviewerRow>(assigned.map((a) => [a.user.id, a]));
  const seen = new Set<string>();
  const list: Entry[] = [];
  for (const r of pool) {
    if (!r.userId || seen.has(r.userId)) continue;
    seen.add(r.userId);
    list.push({
      userId: r.userId,
      name: formatPersonName(r.title, r.firstName, r.lastName).trim(),
      email: r.email,
      workload: r.assignments?.assigned ?? 0,
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
      workload: null,
      assignment: a,
    });
  }
  return list;
}

/** What an assigned reviewer has done with this abstract. */
function ReviewState({ a }: { a: AbstractReviewerRow }) {
  if (a.hasSubmitted) {
    return (
      <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-[10px]">
        <Check className="h-2.5 w-2.5 mr-0.5" />
        {a.submission?.overallScore != null ? `${a.submission.overallScore}/100` : "Submitted"}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] text-amber-700 border-amber-300">
      Pending
    </Badge>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{children}</p>;
}

export function AbstractReviewersCard({
  eventId,
  abstractId,
  embedded = false,
}: {
  eventId: string;
  abstractId: string;
  /** Inside a dialog that has its own title: no card frame or heading around the list. */
  embedded?: boolean;
}) {
  // The reviewers route's own key, so the card and the route cannot drift.
  const isAdmin = useCan("abstracts.reviewers.assign", eventId) === "allowed";

  // Gated on the role, not just on the ids: this card renders inside the
  // abstract edit page, which submitters and reviewers legitimately open, and
  // both endpoints are staff-only. Hooks cannot sit below the `!isAdmin` early
  // return, so the role has to gate the FETCH. Until Aug 24, 2026 it did not,
  // and every submitter page view fired two requests that 403'd and were then
  // discarded (four warn lines, since the QueryClient retries once). Costs an
  // admin one render cycle: `useSession` has to resolve before these start.
  const { data: poolData } = useReviewers(eventId, { enabled: isAdmin });
  const { data: assignedData, isLoading } = useAbstractReviewers(eventId, abstractId, {
    enabled: isAdmin,
  });
  const assign = useAssignAbstractReviewer(eventId, abstractId);
  const unassign = useUnassignAbstractReviewer(eventId, abstractId);
  const [search, setSearch] = useState("");

  const entries = useMemo<Entry[]>(
    () => buildEntries((poolData?.reviewers ?? []) as PoolReviewer[], assignedData?.reviewers ?? []),
    [poolData, assignedData],
  );

  if (!isAdmin) return null;

  const busy = assign.isPending || unassign.isPending;
  const assignedEntries = entries.filter((e) => e.assignment);
  const query = search.trim().toLowerCase();
  const availableAll = entries.filter((e) => !e.assignment);
  // The lightest load first: the person an organiser is most likely looking for.
  const available = (query ? availableAll.filter((e) => matchesSearch(e, query)) : availableAll)
    .slice()
    .sort((x, y) => (x.workload ?? 0) - (y.workload ?? 0));
  const poolEmpty = (poolData?.reviewers ?? []).filter((r: PoolReviewer) => r.userId).length === 0;

  const emptyState = (
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
  );

  const lists = (
    <div className="space-y-4">
      {assignedEntries.length > 0 && (
        <div className="space-y-1.5">
          <SectionLabel>Assigned to this abstract ({assignedEntries.length})</SectionLabel>
          <ul className="divide-y divide-primary/15 rounded-lg border border-primary/30 bg-primary/[0.03]">
            {assignedEntries.map((e) => {
              const a = e.assignment!;
              return (
                <li key={e.userId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1 basis-40">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{e.name || e.email}</span>
                      <ReviewState a={a} />
                      {a.conflictFlag && (
                        <Badge variant="outline" className="text-[10px] text-red-600 border-red-300">
                          <AlertTriangle className="h-2.5 w-2.5 mr-0.5" /> COI
                        </Badge>
                      )}
                    </div>
                    {e.name && <p className="truncate text-xs text-muted-foreground">{e.email}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground" title="Conflict of interest">
                      <Switch
                        checked={a.conflictFlag}
                        onCheckedChange={(checked) =>
                          assign.mutate({ userId: e.userId, conflictFlag: checked }, { onError: showError })
                        }
                        disabled={busy}
                        className="scale-75"
                        aria-label={`Conflict of interest: ${e.name || e.email}`}
                      />
                      Conflict
                    </label>
                    <Select
                      value={a.role}
                      onValueChange={(role) =>
                        assign.mutate({ userId: e.userId, role: role as AbstractReviewerRole }, { onError: showError })
                      }
                      disabled={busy}
                    >
                      <SelectTrigger className="h-8 w-[118px] text-xs" aria-label="Reviewer role">
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
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                      disabled={busy}
                      onClick={() => unassign.mutate(e.userId, { onError: showError })}
                      aria-label={`Remove ${e.name || e.email} from this abstract`}
                      title="Remove from this abstract"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {availableAll.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionLabel>Available reviewers ({availableAll.length})</SectionLabel>
            {/* Also while a search is typed: assigning the eighth person must
                not take the box away and leave the list filtered. */}
            {(availableAll.length >= SEARCH_FROM || search !== "") && (
              <div className="relative w-full sm:w-56">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(ev) => setSearch(ev.target.value)}
                  placeholder="Search name or email"
                  aria-label="Search available reviewers"
                  className="h-8 pl-7 text-xs"
                />
              </div>
            )}
          </div>
          {/* Its own scroll: a committee of sixteen made the dialog taller than the screen. */}
          <ul className="max-h-[min(22rem,45vh)] divide-y overflow-y-auto rounded-lg border">
            {available.length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-muted-foreground">No reviewer matches &ldquo;{search.trim()}&rdquo;.</li>
            )}
            {available.map((e) => (
              <li key={e.userId} className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{e.name || e.email}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[e.name ? e.email : null, workloadLabel(e.workload)].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 text-xs"
                  disabled={busy}
                  onClick={() => assign.mutate({ userId: e.userId, role: "SECONDARY" }, { onError: showError })}
                  aria-label={`Assign ${e.name || e.email}`}
                >
                  <UserPlus className="h-3.5 w-3.5 mr-1" /> Assign
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );

  const body = (
    <>
      {isLoading && (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}
      {!isLoading && (entries.length === 0 ? emptyState : lists)}
    </>
  );

  if (embedded) {
    return (
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">{INTRO}</p>
        {body}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <UserPlus className="h-4 w-4" />
          Reviewers
          {assignedEntries.length > 0 && (
            <Badge variant="secondary" className="ml-1 text-[10px]">
              {assignedEntries.length} assigned
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="text-xs">
          Assign reviewers to this abstract with a role and conflict flag. {INTRO}
        </CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
