"use client";

/**
 * Paste the committee chair's sheet: "abstract number, reviewer" per row
 * (Nov 12, 2026). Three steps in one dialog:
 *
 *   1. Paste. Copy the two (or three) columns from the spreadsheet.
 *   2. Check. Each distinct NAME in the sheet is shown against the person on
 *      the event's reviewer pool it was matched to. A name with no match, or
 *      with several, is never guessed: the organiser picks the person or leaves
 *      the name out. Unknown abstract numbers are listed, and so is every
 *      abstract with who it will go to, row by row (review of 87d819ee: the
 *      names alone did not show a wrong column being read).
 *   3. Result. What was assigned, what already was, what was skipped and why.
 *
 * Nothing is saved before step 2's button. The sheet only ADDS assignments: it
 * never removes one the sheet leaves out. The reading and matching live in
 * src/lib/abstract-reviewer-sheet.ts; the write is the same bulk route the
 * tick boxes use, so the same rules hold (no email, no own abstract, nothing on
 * a draft or withdrawn abstract).
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { ClipboardPaste, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useReviewers, useBulkAssignAbstractReviewers } from "@/hooks/use-api";
import {
  buildSheetPlan,
  initialChoices,
  parseReviewerSheet,
  sheetReviewerNames,
  type ParsedSheet,
  type SheetAbstract,
  type SheetReviewerName,
} from "@/lib/abstract-reviewer-sheet";
import { assignHeadline, describeBulkReviewerSkips, type SkipLine } from "@/lib/abstract-bulk-reviewer-outcome";
import { formatAbstractSerial } from "@/lib/abstract-serial";
import { BulkReviewerOutcome } from "./bulk-reviewer-outcome";
import { poolPeopleFrom, type PoolPerson } from "./reviewer-pool-people";

/** The Select's value for "leave this name out". */
const LEAVE_OUT = "__leave_out__";

const SAMPLE = "012\tDr Rahman\n015\tDr Rahman\tProf Haddad\nA-040\tProf Haddad";

interface Outcome {
  headline: string;
  lines: SkipLine[];
}

/** How a name stands, given the organiser's current choice for it. */
function nameStatus(name: SheetReviewerName, choice: string | null): { label: string; className: string } {
  if (choice && name.match.kind === "matched" && name.match.userId === choice) {
    return { label: "Matched", className: "border-emerald-300 text-emerald-700" };
  }
  if (choice) return { label: "Picked by you", className: "border-sky-300 text-sky-700" };
  // One word beside another one-word name: it may be half of one person's name.
  if (name.held) return { label: "One word, beside another name: pick who", className: "border-amber-300 text-amber-700" };
  if (name.match.kind === "ambiguous") return { label: "Several fit: pick one", className: "border-amber-300 text-amber-700" };
  return { label: "Not on the pool", className: "border-red-300 text-red-600" };
}

/** Who on the pool the written name fits: one person, several, or nobody. */
function fittingPeople(name: SheetReviewerName): string[] {
  if (name.match.kind === "matched") return [name.match.userId];
  return name.match.kind === "ambiguous" ? name.match.candidates : [];
}

function NameRow({
  name,
  choice,
  pool,
  onChoose,
  disabled,
}: {
  name: SheetReviewerName;
  choice: string | null;
  pool: PoolPerson[];
  onChoose: (userId: string | null) => void;
  disabled: boolean;
}) {
  const status = nameStatus(name, choice);
  // The people who fit come first in the list.
  const candidates = fittingPeople(name);
  const ordered = [...pool].sort((a, b) => Number(candidates.includes(b.userId)) - Number(candidates.includes(a.userId)));

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border p-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{name.written}</p>
        <p className="text-xs text-muted-foreground">
          {name.pairCount} abstract{name.pairCount === 1 ? "" : "s"}
        </p>
      </div>
      <Badge variant="outline" className={`shrink-0 text-[10px] ${status.className}`}>
        {status.label}
      </Badge>
      <Select
        value={choice ?? LEAVE_OUT}
        onValueChange={(value) => onChoose(value === LEAVE_OUT ? null : value)}
        disabled={disabled}
      >
        <SelectTrigger className="h-8 w-[220px] text-xs" aria-label={`Reviewer for ${name.written}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={LEAVE_OUT}>Leave out</SelectItem>
          {ordered.map((person) => (
            <SelectItem key={person.userId} value={person.userId}>
              {person.name}
              {person.name !== person.email && ` (${person.email})`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** The parts of the sheet that will NOT be assigned, each said once. */
function SheetWarnings({
  sheet,
  unknownAbstracts,
  rowsWithoutReviewer,
  unresolvedNames,
}: {
  sheet: ParsedSheet;
  unknownAbstracts: string[];
  rowsWithoutReviewer: number[];
  unresolvedNames: number;
}) {
  const warnings: string[] = [];
  if (unresolvedNames > 0) {
    warnings.push(
      `${unresolvedNames} name${unresolvedNames === 1 ? " has" : "s have"} nobody picked, so ${unresolvedNames === 1 ? "its" : "their"} rows will be left out.`,
    );
  }
  if (unknownAbstracts.length > 0) {
    warnings.push(
      `Abstract numbers this event does not have: ${unknownAbstracts.slice(0, 30).join(", ")}${unknownAbstracts.length > 30 ? ` and ${unknownAbstracts.length - 30} more` : ""}.`,
    );
  }
  if (sheet.extraNumbers.length > 0) {
    warnings.push(
      `A number outside the abstract number column was left out: ${sheet.extraNumbers.slice(0, 20).map((n) => `"${n.text}" on line ${n.line}`).join(", ")}.`,
    );
  }
  if (rowsWithoutReviewer.length > 0) {
    warnings.push(`Rows with an abstract number and no reviewer: line ${rowsWithoutReviewer.slice(0, 20).join(", ")}.`);
  }
  if (sheet.ignoredLines.length > 0) {
    warnings.push(
      `${sheet.ignoredLines.length} line${sheet.ignoredLines.length === 1 ? "" : "s"} had no abstract number and ${sheet.ignoredLines.length === 1 ? "was" : "were"} left out (a header row is fine): "${sheet.ignoredLines[0].text}".`,
    );
  }
  if (warnings.length === 0) return null;
  return (
    <ul className="list-disc space-y-1 rounded-md border border-amber-200 bg-amber-50 py-2.5 pl-7 pr-3 text-xs text-amber-900">
      {warnings.map((warning) => (
        <li key={warning}>{warning}</li>
      ))}
    </ul>
  );
}

/** Every abstract the sheet will touch and who it goes to: the check a list of names cannot give. */
function AssignmentsByAbstract({
  byAbstract,
  abstracts,
  pool,
}: {
  byAbstract: { abstractId: string; reviewerUserIds: string[] }[];
  abstracts: SheetAbstract[];
  pool: PoolPerson[];
}) {
  if (byAbstract.length === 0) return null;
  const serialOf = (id: string) => abstracts.find((a) => a.id === id)?.serialId ?? null;
  const nameOf = (id: string) => pool.find((p) => p.userId === id)?.name ?? "a reviewer";
  const rows = [...byAbstract].sort((a, b) => (serialOf(a.abstractId) ?? 0) - (serialOf(b.abstractId) ?? 0));
  return (
    <details className="rounded-md border p-2.5 text-sm" open={rows.length <= 12}>
      <summary className="cursor-pointer font-medium">
        Abstract by abstract ({rows.length})
      </summary>
      <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto pr-1 text-xs">
        {rows.map((row) => (
          <li key={row.abstractId} className="flex gap-2">
            <span className="w-14 shrink-0 font-mono text-muted-foreground">{formatAbstractSerial(serialOf(row.abstractId))}</span>
            <span>{row.reviewerUserIds.map(nameOf).join(", ")}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ReviewerSheetBody({
  eventId,
  abstracts,
  onClose,
}: {
  eventId: string;
  abstracts: SheetAbstract[];
  onClose: () => void;
}) {
  const { data, isLoading } = useReviewers(eventId);
  const assign = useBulkAssignAbstractReviewers(eventId);
  const { pool } = useMemo(() => poolPeopleFrom(data), [data]);

  const [text, setText] = useState("");
  // Set by "Read the sheet": the parsed rows and the organiser's choice per name.
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [choices, setChoices] = useState<Record<string, string | null>>({});
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const plan = useMemo(
    () => (sheet ? buildSheetPlan(sheet, abstracts, pool, choices) : null),
    [sheet, abstracts, pool, choices],
  );

  const readSheet = () => {
    const parsed = parseReviewerSheet(text);
    if (parsed.problem) {
      toast.error(parsed.problem);
      return;
    }
    if (parsed.rows.length === 0) {
      toast.error("No abstract numbers found. Each row needs an abstract number and a reviewer.");
      return;
    }
    setSheet(parsed);
    setChoices(initialChoices(sheetReviewerNames(parsed, pool)));
  };

  const apply = async () => {
    if (!plan || plan.pairCount === 0) return;
    try {
      const result = await assign.mutateAsync(plan.groups);
      setOutcome({
        headline: assignHeadline(result),
        lines: describeBulkReviewerSkips(result.skipped, {
          abstractSerial: (id) => abstracts.find((a) => a.id === id)?.serialId,
          reviewerName: (id) => pool.find((p) => p.userId === id)?.name,
        }),
      });
    } catch (err) {
      console.error("abstracts:reviewer-sheet-failed", err);
      toast.error(err instanceof Error && err.message ? err.message : "Could not assign the reviewers");
    }
  };

  if (outcome) {
    return (
      <>
        <BulkReviewerOutcome
          headline={outcome.headline}
          lines={outcome.lines}
          note="No email was sent. Send the invitation from the Reviewers page when you are ready."
        />
        <DialogFooter>
          <Button variant="outline" asChild>
            <Link href={`/events/${eventId}/reviewers`}>Go to Reviewers</Link>
          </Button>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </>
    );
  }

  if (sheet && plan) {
    return (
      <>
        <div className="space-y-3">
          <p className="text-sm">
            <span className="font-medium">
              {plan.pairCount} assignment{plan.pairCount === 1 ? "" : "s"}
            </span>{" "}
            <span className="text-muted-foreground">
              from {sheet.rows.length} row{sheet.rows.length === 1 ? "" : "s"}, to {plan.groups.length} reviewer{plan.groups.length === 1 ? "" : "s"}. Check each name is the right person.
            </span>
          </p>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {plan.names.map((name) => (
              <NameRow
                key={name.key}
                name={name}
                choice={choices[name.key] ?? null}
                pool={pool}
                onChoose={(userId) => setChoices((prev) => ({ ...prev, [name.key]: userId }))}
                disabled={assign.isPending}
              />
            ))}
          </div>
          <AssignmentsByAbstract byAbstract={plan.byAbstract} abstracts={abstracts} pool={pool} />
          <SheetWarnings
            sheet={sheet}
            unknownAbstracts={plan.unknownAbstracts}
            rowsWithoutReviewer={plan.rowsWithoutReviewer}
            unresolvedNames={plan.unresolvedNames}
          />
          <p className="text-xs text-muted-foreground">
            This only adds assignments; it removes none. No email is sent. Someone missing from the list has to be{" "}
            <Link href={`/events/${eventId}/reviewers`} className="text-primary underline">
              added on the Reviewers page
            </Link>{" "}
            first.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setSheet(null)} disabled={assign.isPending}>
            Back
          </Button>
          <Button onClick={() => void apply()} disabled={assign.isPending || plan.pairCount === 0}>
            {assign.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Assign{plan.pairCount > 0 ? ` (${plan.pairCount})` : ""}
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="reviewer-sheet">Abstract number and reviewer, one row per line</Label>
          <Textarea
            id="reviewer-sheet"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={SAMPLE}
            rows={9}
            // The shared Textarea grows with its content, so cap it and scroll inside.
            className="max-h-72 overflow-y-auto font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Copy the abstract number column and the reviewer column from the spreadsheet and paste them here. A
            second reviewer column works. Leave out every other column: title, author, row numbers, scores. Names
            are matched to the event&apos;s reviewer pool, and you check every match before anything is saved.
          </p>
        </div>
        {!isLoading && pool.length === 0 && (
          <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            No reviewers on this event&apos;s pool yet.{" "}
            <Link href={`/events/${eventId}/reviewers`} className="text-primary underline">
              Add the committee on the Reviewers page
            </Link>{" "}
            first: a name can only be matched to someone on the pool.
          </p>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={readSheet} disabled={!text.trim() || isLoading}>
          Read the sheet
        </Button>
      </DialogFooter>
    </>
  );
}

export function ReviewerSheetDialog({
  eventId,
  abstracts,
  open,
  onOpenChange,
}: {
  eventId: string;
  /** Every abstract on the event (not only the ones the page's filters show). */
  abstracts: SheetAbstract[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardPaste className="h-5 w-5" />
            Paste reviewer sheet
          </DialogTitle>
          <DialogDescription>
            For a list that says which abstract goes to which reviewer.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so each opening starts empty. */}
        {open && <ReviewerSheetBody eventId={eventId} abstracts={abstracts} onClose={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}
