"use client";

import { useState } from "react";
import { Archive, ArrowDown, ArrowUp, Briefcase, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useRoleSettings, useSaveRoleAnswers, type RoleAnswerRow } from "@/hooks/use-person-fields";
import { ApiError } from "@/lib/api-fetch";
import { MAX_PERSON_FIELD_ANSWER, MAX_PERSON_FIELD_OPTIONS, looseForm } from "@/lib/person-fields";
import { FieldNameEditor } from "./field-name-editor";

type Row = RoleAnswerRow;

/** The list as it is sent and compared: keys, labels and retired, without the counts. */
function strip(rows: Row[]) {
  return rows.map(({ key, label, retired }) => ({ ...(key ? { key } : {}), label: label.trim(), retired }));
}

/** Records, not people: one person can be a contact, a speaker and two registrations. */
function recordsLabel(records: number): string {
  return records === 1 ? "1 record" : `${records.toLocaleString("en-US")} records`;
}

/**
 * The organisation's own Role answers (step 1d of docs/ORG_FIELDS_PLAN.md).
 * Role stores a key and shows a label, so, unlike Specialty, an answer can be
 * RENAMED here without touching a record. Every rule is the server's
 * (`saveRoleAnswers`); this screen only says them early.
 */
export function RoleAnswersCard() {
  const { data: saved, isLoading, isError, refetch } = useRoleSettings();
  const save = useSaveRoleAnswers();
  // null = no unsaved edits. `base` is the saved list the edits started from,
  // sent with the save so a stale one is refused (as the Specialty card).
  const [edited, setEdited] = useState<{ rows: Row[]; base: Row[] } | null>(null);
  const [draft, setDraft] = useState("");
  const savedRows: Row[] = saved?.answers ?? [];
  const rows = edited?.rows ?? savedRows;
  const base = edited?.base ?? savedRows;
  const canEdit = saved !== undefined;
  // While the contacts feed (Mailchimp) is connected, existing answers keep
  // their names (review of a7e87df6): it would hold the old name for good.
  const renameAllowed = saved?.renameAllowed === true;
  const busy = save.isPending;
  const dirty = canEdit && edited !== null && JSON.stringify(strip(rows)) !== JSON.stringify(strip(base));
  const full = rows.length >= MAX_PERSON_FIELD_OPTIONS;
  const offered = rows.filter((r) => !r.retired).length;
  const relabelled = rows.filter((r) => r.key && base.find((b) => b.key === r.key)?.label !== r.label.trim());
  const relabelledRecords = relabelled.reduce((n, r) => n + r.records, 0);
  const blank = rows.some((r) => !r.label.trim());

  const setRows = (next: Row[]) => setEdited({ rows: next, base });
  const clash = (label: string, except?: Row) =>
    rows.some((r) => r !== except && (looseForm(r.label) === looseForm(label) || (r.key && looseForm(r.key) === looseForm(label))));

  const add = () => {
    const label = draft.trim();
    if (!label || !looseForm(label)) return;
    if (clash(label)) {
      toast.error(`"${label}" reads the same as an answer already on the list`);
      return;
    }
    setRows([...rows, { label, retired: false, records: 0 }]);
    setDraft("");
  };

  const move = (from: number, to: number) => {
    const next = [...rows];
    [next[from], next[to]] = [next[to], next[from]];
    setRows(next);
  };

  const onSave = async () => {
    try {
      await save.mutateAsync({
        answers: strip(rows),
        expected: { answers: strip(base).map((r) => ({ key: r.key ?? "", label: r.label, retired: r.retired })) },
      });
      setEdited(null);
      toast.success("Role answers saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
      if (e instanceof ApiError && e.code === "LIST_CHANGED") {
        setEdited(null);
        refetch();
      }
    }
  };

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
            <Briefcase className="h-4 w-4" />
          </div>
          Role
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* The name first, on the same line as Specialty's beside it; then what the answers are. */}
        <FieldNameEditor field="role" />
        <div className="space-y-1 border-t pt-4">
          <p className="text-sm font-medium">Answers</p>
          <p className="text-sm text-muted-foreground">
            The answers every Role picker offers, on the registration forms and in the dashboard. An answer held by records can
            be retired, not removed. A change shows the next time a form is opened.
          </p>
        </div>
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {isError && saved === undefined && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
            <p className="text-sm text-destructive">The list could not be loaded, so it cannot be edited yet.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          </div>
        )}
        {canEdit && (
          <p className="text-sm text-muted-foreground">
            {offered} offered{rows.length > offered ? `, ${rows.length - offered} retired` : ""}.
          </p>
        )}
        {canEdit && !renameAllowed && (
          <p className="rounded-lg border px-3 py-2 text-sm text-muted-foreground">
            Existing answers cannot be renamed while the contacts feed (Mailchimp) is connected: it keeps the name it already
            holds for everyone, so lists built on it would split. To change a name, add the new answer and retire the old one.
          </p>
        )}
        {rows.length > 0 && (
          <ol className="divide-y rounded-lg border max-h-[28rem] overflow-y-auto">
            {rows.map((row, i) => (
              <li key={row.key ?? `new-${i}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="w-7 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                <Input
                  aria-label={`Answer ${i + 1}`}
                  className={`h-8 min-w-[9rem] flex-1 ${row.retired ? "text-muted-foreground line-through" : ""}`}
                  value={row.label}
                  maxLength={MAX_PERSON_FIELD_ANSWER}
                  // A saved answer's name is fixed while the feed is connected; a new one is still being written.
                  readOnly={!renameAllowed && !!row.key}
                  disabled={busy}
                  onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)))}
                />
                {row.retired && <Badge variant="secondary">Retired</Badge>}
                {!row.key && <Badge variant="outline">New</Badge>}
                {row.records > 0 && <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">{recordsLabel(row.records)}</span>}
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Move ${row.label} up`} disabled={busy || i === 0} onClick={() => move(i, i - 1)}>
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Move ${row.label} down`} disabled={busy || i === rows.length - 1} onClick={() => move(i, i + 1)}>
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={row.retired ? `Offer ${row.label} again` : `Retire ${row.label}`}
                  title={row.retired ? "Offer again" : "Retire: no longer offered, still shown where it is held"}
                  disabled={busy}
                  onClick={() => setRows(rows.map((r, j) => (j === i ? { ...r, retired: !r.retired } : r)))}
                >
                  {row.retired ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  aria-label={row.records > 0 ? `Remove ${row.label}: not possible, it is held by ${recordsLabel(row.records)}. Retire it instead` : `Remove ${row.label}`}
                  title={row.records > 0 ? `Held by ${recordsLabel(row.records)}: retire it instead` : "Remove"}
                  disabled={busy || row.records > 0}
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ol>
        )}

        {canEdit && (
          <>
            <div className="space-y-2">
              <Label htmlFor="new-role-answer">Add an answer</Label>
              <div className="flex gap-2">
                <Input
                  id="new-role-answer"
                  value={draft}
                  maxLength={MAX_PERSON_FIELD_ANSWER}
                  placeholder={full ? `At most ${MAX_PERSON_FIELD_OPTIONS} answers` : "e.g. Nurse"}
                  disabled={full || busy}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    add();
                  }}
                />
                <Button variant="outline" onClick={add} disabled={full || busy || !draft.trim()}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add
                </Button>
              </div>
            </div>
            {relabelled.length > 0 && (
              <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
                Renaming {relabelled.length === 1 ? "this answer" : `${relabelled.length} answers`} changes how{" "}
                {relabelledRecords === 1 ? "1 record reads" : `${relabelledRecords.toLocaleString("en-US")} records read`} on every form, screen and export.
              </p>
            )}
            {canEdit && offered === 0 && (
              <p role="alert" className="text-sm text-destructive">
                Nothing would be offered: keep at least one answer on offer.
              </p>
            )}
            <div className="flex justify-end gap-2">
              {dirty && (
                <Button variant="ghost" onClick={() => setEdited(null)} disabled={busy}>
                  Discard changes
                </Button>
              )}
              <Button onClick={onSave} disabled={!dirty || busy || offered === 0 || blank}>
                <Save className="mr-2 h-4 w-4" />
                {busy ? "Saving..." : "Save answers"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
