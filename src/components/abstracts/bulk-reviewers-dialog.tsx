"use client";

/**
 * Assign reviewers to, or remove a reviewer from, the ticked abstracts
 * (Nov 12, 2026). Backed by POST / DELETE
 * /api/events/[id]/abstracts/reviewer-assignments.
 *
 * Same rules as the per-abstract Reviewers card: no email is sent (the
 * invitation goes from the Reviewers page), an author is never given their own
 * abstract, and a draft or withdrawn abstract takes nobody. Assign picks from
 * the event's reviewer pool only; everyone is added with the default role, and
 * the role or a conflict flag is still set on the abstract's own card.
 *
 * Remove is the undo for a wrong bulk assign. It never takes an assignment
 * whose reviewer has already submitted a review.
 */
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Search, UserMinus, UserPlus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  useReviewers,
  useBulkAssignAbstractReviewers,
  useBulkUnassignAbstractReviewers,
  type BulkReviewerSkip,
} from "@/hooks/use-api";
import { REVIEWABLE_ABSTRACT_STATUSES } from "@/lib/abstract-reviewer-access";
import {
  assignHeadline,
  describeBulkReviewerSkips,
  unassignHeadline,
  type SkipLine,
} from "@/lib/abstract-bulk-reviewer-outcome";
import { BulkReviewerOutcome } from "./bulk-reviewer-outcome";
import { poolPeopleFrom, type PoolPerson } from "./reviewer-pool-people";

export type BulkReviewerMode = "assign" | "remove";

/** What the dialog needs to know about a ticked abstract. */
export interface BulkAbstract {
  id: string;
  serialId: number | null;
  status: string;
}

interface Outcome {
  headline: string;
  lines: SkipLine[];
}

const WORDING: Record<BulkReviewerMode, { title: string; verb: string; pick: string }> = {
  assign: { title: "Assign reviewers", verb: "Assign", pick: "Each ticked abstract gets every reviewer you pick." },
  remove: { title: "Remove reviewer", verb: "Remove", pick: "Each reviewer you pick is taken off every ticked abstract." },
};

/** Lower case, no accents: "jorg" finds "Jörg". */
const searchable = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The people whose name or email contains every word typed. */
function searchPeople(people: PoolPerson[], query: string): PoolPerson[] {
  const words = searchable(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return people;
  return people.filter((person) => {
    const haystack = searchable(`${person.name} ${person.email}`);
    return words.every((word) => haystack.includes(word));
  });
}

const isReviewable = (status: string) => (REVIEWABLE_ABSTRACT_STATUSES as readonly string[]).includes(status);

function PersonRow({ person, checked, onToggle, disabled }: { person: PoolPerson; checked: boolean; onToggle: () => void; disabled: boolean }) {
  const id = `bulk-reviewer-${person.userId}`;
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-3 rounded-md border p-2.5 hover:bg-muted/40">
      <Checkbox id={id} checked={checked} onCheckedChange={onToggle} disabled={disabled} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{person.name}</span>
        {person.name !== person.email && <span className="block truncate text-xs text-muted-foreground">{person.email}</span>}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        holds {person.assigned}
      </span>
    </label>
  );
}

function BulkReviewersBody({
  eventId,
  mode,
  abstracts,
  onClose,
  onChanged,
  onBusy,
}: {
  eventId: string;
  mode: BulkReviewerMode;
  abstracts: BulkAbstract[];
  onClose: () => void;
  /** The change went through: the page clears its selection when the dialog closes. */
  onChanged: () => void;
  /** A request is in flight: the dialog must not close under it. */
  onBusy: (busy: boolean) => void;
}) {
  const { data, isLoading, isError } = useReviewers(eventId);
  const assign = useBulkAssignAbstractReviewers(eventId);
  const unassign = useBulkUnassignAbstractReviewers(eventId);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [query, setQuery] = useState("");

  const { pool, offPool } = useMemo(() => poolPeopleFrom(data), [data]);
  // Remove may name anyone who holds an assignment here; assign only the pool.
  const people = mode === "remove" ? [...pool, ...offPool] : pool;
  // Searching narrows the LIST only: someone picked and then searched away stays picked.
  const shownPeople = searchPeople(people, query);
  const busy = assign.isPending || unassign.isPending;
  const words = WORDING[mode];

  const notReviewable = mode === "assign" ? abstracts.filter((a) => !isReviewable(a.status)).length : 0;
  const pairCount = abstracts.length * chosen.size;

  const toggle = (userId: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });

  const describe = (skipped: BulkReviewerSkip[]) =>
    describeBulkReviewerSkips(skipped, {
      abstractSerial: (id) => abstracts.find((a) => a.id === id)?.serialId,
      reviewerName: (id) => people.find((p) => p.userId === id)?.name,
    });

  const run = async () => {
    const abstractIds = abstracts.map((a) => a.id);
    const groups = [...chosen].map((reviewerUserId) => ({ reviewerUserId, abstractIds }));
    onBusy(true);
    try {
      if (mode === "assign") {
        const result = await assign.mutateAsync(groups);
        setOutcome({ headline: assignHeadline(result), lines: describe(result.skipped) });
      } else {
        const result = await unassign.mutateAsync(groups);
        setOutcome({ headline: unassignHeadline(result), lines: describe(result.skipped) });
      }
      onChanged();
    } catch (err) {
      console.error("abstracts:bulk-reviewers-failed", mode, err);
      toast.error(err instanceof Error && err.message ? err.message : "Could not update the reviewers");
    } finally {
      onBusy(false);
    }
  };

  if (outcome) {
    return (
      <>
        <BulkReviewerOutcome
          headline={outcome.headline}
          lines={outcome.lines}
          note={mode === "assign" ? "No email was sent. Send the invitation from the Reviewers page when you are ready." : undefined}
        />
        <DialogFooter>
          {mode === "assign" && (
            <Button variant="outline" asChild>
              <Link href={`/events/${eventId}/reviewers`}>Go to Reviewers</Link>
            </Button>
          )}
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{words.pick}</p>
        {isLoading && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {isError && (
          <p className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            The reviewer pool could not be loaded. Close this and try again; if it keeps happening, your role may
            not include the Reviewers page.
          </p>
        )}
        {!isLoading && !isError && people.length === 0 && (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No reviewers on this event&apos;s pool yet.{" "}
            <Link href={`/events/${eventId}/reviewers`} className="text-primary underline">
              Add the committee on the Reviewers page
            </Link>{" "}
            first, then come back.
          </p>
        )}
        {people.length > 0 && (
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search reviewers by name or email"
                aria-label="Search reviewers"
                className="h-9 pl-8"
                autoFocus
              />
            </div>
            <span className="shrink-0 text-xs text-muted-foreground">{chosen.size} picked</span>
          </div>
        )}
        {people.length > 0 && shownPeople.length === 0 && (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            No reviewer on the pool matches &quot;{query.trim()}&quot;.
          </p>
        )}
        {shownPeople.length > 0 && (
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {shownPeople.map((person) => (
              <PersonRow
                key={person.userId}
                person={person}
                checked={chosen.has(person.userId)}
                onToggle={() => toggle(person.userId)}
                disabled={busy}
              />
            ))}
          </div>
        )}
        {notReviewable > 0 && (
          <p className="text-xs text-amber-700">
            {notReviewable} of the ticked abstracts {notReviewable === 1 ? "is a draft, withdrawn or already decided and will be skipped" : "are drafts, withdrawn or already decided and will be skipped"}.
          </p>
        )}
        {mode === "assign" && (
          <p className="text-xs text-muted-foreground">
            No email is sent. Everyone is added with the default role; set a role or a conflict flag on the
            abstract&apos;s own Reviewers card.
          </p>
        )}
        {mode === "remove" && (
          <p className="text-xs text-muted-foreground">
            An assignment with a review already submitted is kept.
          </p>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void run()} disabled={busy || chosen.size === 0} variant={mode === "remove" ? "destructive" : "default"}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {words.verb}
          {pairCount > 0 && ` (${pairCount})`}
        </Button>
      </DialogFooter>
    </>
  );
}

export function BulkReviewersDialog({
  eventId,
  mode,
  abstracts,
  open,
  onOpenChange,
  onDone,
}: {
  eventId: string;
  mode: BulkReviewerMode;
  /** The ticked abstracts. */
  abstracts: BulkAbstract[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once the change went through (the page clears its selection). */
  onDone: () => void;
}) {
  const Icon = mode === "assign" ? UserPlus : UserMinus;
  // The selection is cleared on CLOSE, not on success: the result is read with
  // the ticked count still in the heading.
  const changed = useRef(false);
  // Esc or a click outside while the request runs used to close the dialog:
  // the result line was never shown, and the next opening cleared the ticks.
  const inFlight = useRef(false);
  const handleOpenChange = (next: boolean) => {
    if (!next && inFlight.current) return;
    if (!next && changed.current) {
      changed.current = false;
      onDone();
    }
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="h-5 w-5" />
            {WORDING[mode].title}
          </DialogTitle>
          <DialogDescription>
            {abstracts.length} abstract{abstracts.length === 1 ? "" : "s"} ticked.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so each opening starts with nobody picked. */}
        {open && (
          <BulkReviewersBody
            eventId={eventId}
            mode={mode}
            abstracts={abstracts}
            onClose={() => handleOpenChange(false)}
            onChanged={() => {
              changed.current = true;
            }}
            onBusy={(busy) => {
              inFlight.current = busy;
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
