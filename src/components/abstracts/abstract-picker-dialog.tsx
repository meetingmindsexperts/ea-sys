"use client";

/**
 * "Select abstracts" (Sep 9, 2026): the abstracts audience is chosen BEFORE
 * the send dialog opens, the way the registrations card's Select-by-IDs
 * works, rather than inside it. Owner: "filter recipients for abstracts
 * similar to the registration id lookup, and before clicking Send email".
 *
 * Three ways to pick, all over the rows the Communications page already holds:
 * a status filter, a paste box for numbers or emails (matched, never guessed),
 * and a searchable tick list. Leaving everything unticked means "everyone in
 * the chosen status"; the send dialog then counts the real audience on the
 * server, drafts included, so the number it shows is the number it mails.
 */
import { useState } from "react";
import { ListChecks } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatAbstractSerial } from "@/lib/abstract-serial";
import {
  ABSTRACT_PICKER_FETCH_LIMIT,
  abstractStatusLabel,
  filterAbstractOptions,
  matchPastedAbstractIdentifiers,
  type AbstractPickerOption,
} from "@/lib/bulk-email-abstract-picker";

/** Staff never see drafts, so a draft filter here would only ever show nothing. */
const PICKABLE_STATUSES = [
  "SUBMITTED",
  "UNDER_REVIEW",
  "ACCEPTED",
  "REJECTED",
  "REVISION_REQUESTED",
  "WITHDRAWN",
] as const;

export interface AbstractSelection {
  /** Abstract ids; empty means "everyone in `status`". */
  ids: string[];
  /** An AbstractStatus, or "all". */
  status: string;
}

interface AbstractPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: AbstractPickerOption[];
  /** True when the host's fetch hit the list cap, so the list is incomplete. */
  truncated: boolean;
  /** The selection the card currently holds; edited here, applied on confirm. */
  selection: AbstractSelection;
  onApply: (selection: AbstractSelection) => void;
}

export function AbstractPickerDialog({
  open,
  onOpenChange,
  options,
  truncated,
  selection,
  onApply,
}: AbstractPickerDialogProps) {
  const [ids, setIds] = useState<Set<string>>(new Set(selection.ids));
  const [status, setStatus] = useState(selection.status);
  const [search, setSearch] = useState("");
  const [paste, setPaste] = useState("");
  const [matchResult, setMatchResult] = useState<{ matched: number; unmatched: string[] } | null>(null);

  // Re-seed from the card's selection on every closed -> open transition (the
  // React 19 previous-render pattern: no effect, no flash of stale ticks).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setIds(new Set(selection.ids));
      setStatus(selection.status);
      setSearch("");
      setPaste("");
      setMatchResult(null);
    }
  }

  // The picker has no email type yet, so the scope is the explicit status
  // only ("custom" has no default narrowing).
  const visible = filterAbstractOptions(options, { emailType: "custom", status, search });
  const visibleTicked = visible.filter((o) => ids.has(o.id)).length;

  const toggle = (id: string, on: boolean) =>
    setIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  // Select-all works on the rows the search is SHOWING and never touches a
  // selection the search is hiding, so tick, search, tick accumulates.
  const toggleAllVisible = (on: boolean) =>
    setIds((prev) => {
      const next = new Set(prev);
      for (const o of visible) {
        if (on) next.add(o.id);
        else next.delete(o.id);
      }
      return next;
    });

  const applyPaste = () => {
    const result = matchPastedAbstractIdentifiers(paste, options);
    setIds((prev) => new Set([...prev, ...result.matched]));
    setMatchResult({ matched: result.matched.length, unmatched: result.unmatched });
  };

  const confirm = () => {
    onApply({ ids: [...ids], status });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Capped at the viewport and scrollable: with a status filter, a paste
          box and the list, the content is taller than a laptop screen, and a
          footer below the fold cannot be clicked (found in the local render check). */}
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[660px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="h-5 w-5" />
            Select abstracts
          </DialogTitle>
          <DialogDescription>
            Choose who this email goes to before composing it. Filter by status, paste numbers or
            emails, or tick abstracts. Leave everything unticked to email everyone in the chosen
            status.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-2">
            <Label htmlFor="abstract-picker-status">Abstract status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger id="abstract-picker-status" aria-label="Abstract status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {PICKABLE_STATUSES.map((st) => (
                  <SelectItem key={st} value={st}>
                    {abstractStatusLabel(st)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Each email type keeps its own scope on top of this: a confirmation never goes to a
              withdrawn abstract, a decision only to decided ones, a reminder only to drafts.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="abstract-picker-paste">Numbers or emails</Label>
            <Textarea
              id="abstract-picker-paste"
              value={paste}
              onChange={(e) => {
                setPaste(e.target.value);
                setMatchResult(null);
              }}
              placeholder={"A-007\n12\nauthor@example.com"}
              rows={3}
              className="font-mono text-sm"
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                One per line or comma-separated. An email selects every abstract that author
                submitted.
              </p>
              <Button type="button" variant="secondary" size="sm" onClick={applyPaste} disabled={!paste.trim()}>
                Match
              </Button>
            </div>
            {matchResult && (
              <p className="text-xs">
                <span className="font-medium">{matchResult.matched} matched</span>
                {matchResult.unmatched.length > 0 && (
                  <span className="text-muted-foreground">
                    {" "}· {matchResult.unmatched.length} not found: {matchResult.unmatched.slice(0, 20).join(", ")}
                    {matchResult.unmatched.length > 20 ? ` … (+${matchResult.unmatched.length - 20})` : ""}
                  </span>
                )}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="abstract-picker-search">Pick abstracts</Label>
            <Input
              id="abstract-picker-search"
              placeholder="Search by number (A-007), title, author email or name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="max-h-52 overflow-y-auto rounded-md border">
              {visible.length > 0 && (
                <label className="sticky top-0 flex cursor-pointer items-center gap-2 border-b bg-muted/60 px-2.5 py-2 text-xs font-medium">
                  <Checkbox
                    checked={
                      visibleTicked === 0 ? false : visibleTicked === visible.length ? true : "indeterminate"
                    }
                    onCheckedChange={(c) => toggleAllVisible(c === true)}
                    aria-label="Select all matching abstracts"
                  />
                  <span>{search.trim() ? `Select all matching (${visible.length})` : `Select all (${visible.length})`}</span>
                </label>
              )}
              {visible.map((o) => (
                <label
                  key={o.id}
                  className="flex cursor-pointer items-center gap-2.5 border-b px-2.5 py-1.5 text-sm last:border-b-0 hover:bg-muted/40"
                >
                  <Checkbox
                    checked={ids.has(o.id)}
                    onCheckedChange={(c) => toggle(o.id, c === true)}
                    aria-label={`Select ${formatAbstractSerial(o.serialId)} ${o.title}`}
                  />
                  <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">
                    {formatAbstractSerial(o.serialId)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{o.title}</span>
                  <span className="hidden max-w-[40%] truncate text-xs text-muted-foreground sm:block">
                    {o.email || o.authorName}
                  </span>
                </label>
              ))}
              {visible.length === 0 && <p className="p-3 text-xs text-muted-foreground">No abstracts match.</p>}
            </div>
            {truncated && (
              <p className="text-xs text-amber-700">
                Showing the newest {ABSTRACT_PICKER_FETCH_LIMIT} abstracts; older ones cannot be ticked here.
                Emailing everyone in a status still reaches them.
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-sm text-muted-foreground">
            {ids.size > 0 ? `${ids.size} abstract${ids.size === 1 ? "" : "s"} selected` : "Nothing ticked: everyone in scope"}
            {ids.size > 0 && (
              <button type="button" className="ml-2 underline underline-offset-2" onClick={() => setIds(new Set())}>
                Clear
              </button>
            )}
          </span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={confirm}>
              {ids.size > 0 ? `Use ${ids.size} selected` : "Use everyone in scope"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
