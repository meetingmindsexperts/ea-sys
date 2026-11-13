"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, ListChecks, Plus, RotateCcw, Save, Trash2, Archive } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  useFieldSwitches,
  useSaveFieldSwitches,
  useSaveSpecialtySettings,
  useSpecialtySettings,
  type FieldSwitches,
  type SpecialtyAnswerRow,
  type SpecialtyListInput,
} from "@/hooks/use-person-fields";
import { ApiError } from "@/lib/api-fetch";
import { MAX_PERSON_FIELD_ANSWER, MAX_PERSON_FIELD_OPTIONS, OTHER_ANSWER, type ConfigurablePersonField } from "@/lib/person-fields";

const FIELD_ROWS: { key: ConfigurablePersonField; name: string; note: string }[] = [
  { key: "title", name: "Title", note: "Dr., Mr., Mrs., Ms., Prof." },
  { key: "role", name: "Role", note: "The person's profession" },
  { key: "specialty", name: "Specialty", note: "The list below" },
];

/**
 * Whether the organisation's forms ask Title, Role and Specialty at all, and
 * whether an answer is demanded (Nov 13, 2026; step 2 of
 * docs/ORG_FIELDS_PLAN.md). Every form and every server door reads these
 * through one rule, so a field switched off here is neither shown nor demanded
 * anywhere.
 */
export function FieldSwitchesCard() {
  const { data: saved, isLoading, isError, refetch } = useFieldSwitches();
  const save = useSaveFieldSwitches();
  // null = no unsaved edits. `base` is what the edits started from (see FormFieldsCard).
  const [edited, setEdited] = useState<{ switches: FieldSwitches; base: FieldSwitches } | null>(null);
  const current = edited?.switches ?? saved;
  const busy = save.isPending;
  const dirty = saved !== undefined && edited !== null && JSON.stringify(edited.switches) !== JSON.stringify(edited.base);

  const set = (key: ConfigurablePersonField, change: Partial<{ enabled: boolean; required: boolean }>) => {
    if (!saved || !current) return;
    setEdited({ switches: { ...current, [key]: { ...current[key], ...change } }, base: edited?.base ?? saved });
  };

  const onSave = async () => {
    if (!edited) return;
    try {
      await save.mutateAsync({ switches: edited.switches, expected: edited.base });
      setEdited(null);
      toast.success("Form fields saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
      if (e instanceof ApiError && e.code === "SWITCHES_CHANGED") {
        setEdited(null);
        refetch();
      }
    }
  };

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
            <ListChecks className="h-4 w-4" />
          </div>
          Fields
        </CardTitle>
        <CardDescription>
          Whether the forms people fill in ask these three fields, and whether an answer is required. This applies to every
          event: registration, completing a registration, group registration, the desk walk-in, sign-up, My Details, and
          abstract and proposal sign-up. A field that is switched off is not shown and never asked for; what people already
          answered stays stored. Staff screens in the dashboard (Add Registration, a registration or speaker&apos;s details,
          Contacts) still show all three.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {isError && saved === undefined && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
            <p className="text-sm text-destructive">The switches could not be loaded, so they cannot be changed yet.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          </div>
        )}
        {current && (
          <>
            <ul className="divide-y rounded-lg border">
              {FIELD_ROWS.map(({ key, name, note }) => (
                <li key={key} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-3">
                  <div className="min-w-40 flex-1">
                    <p className="text-sm font-medium">{name}</p>
                    <p className="text-xs text-muted-foreground">{note}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch id={`field-${key}-ask`} checked={current[key].enabled} disabled={busy} onCheckedChange={(enabled) => set(key, { enabled })} />
                    <Label htmlFor={`field-${key}-ask`}>Ask</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`field-${key}-required`}
                      checked={current[key].enabled && current[key].required}
                      disabled={busy || !current[key].enabled}
                      onCheckedChange={(required) => set(key, { required })}
                    />
                    <Label htmlFor={`field-${key}-required`} className={current[key].enabled ? "" : "text-muted-foreground"}>
                      Required
                    </Label>
                  </div>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              {dirty && (
                <Button variant="ghost" onClick={() => setEdited(null)} disabled={busy}>
                  Discard changes
                </Button>
              )}
              <Button onClick={onSave} disabled={!dirty || busy}>
                <Save className="mr-2 h-4 w-4" />
                {busy ? "Saving..." : "Save fields"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The organisation's Specialty answers (Nov 13, 2026; step 1 of
 * docs/ORG_FIELDS_PLAN.md). Saved to `Organization.settings.personFields` and
 * offered by every specialty picker: the registration forms, the dashboard
 * forms, an event's own topic.
 *
 * An answer's text is what is stored on everyone who chose it, so it is never
 * edited here: retire it and add another. One stored on records can be retired
 * and not removed; the server refuses the removal as well. The server also
 * refuses a save that would offer nothing, and one made from a list somebody
 * else has changed since this screen loaded it.
 */
export function FormFieldsCard() {
  const { data: saved, isLoading, isError, refetch } = useSpecialtySettings();
  const save = useSaveSpecialtySettings();
  // null = no unsaved edits; what is shown is then the saved list. `base` is
  // the saved list the edits STARTED from: a refetch while editing (the window
  // regaining focus) updates `saved`, and the save must still say what these
  // edits were made against, so the server can refuse a stale one.
  const [edited, setEdited] = useState<{ answers: SpecialtyAnswerRow[]; allowOther: boolean; base: SpecialtyListInput } | null>(null);
  const [draft, setDraft] = useState("");
  const savedList = saved ? { answers: saved.answers, allowOther: saved.allowOther } : { answers: [], allowOther: true };
  const current = edited ?? savedList;
  const base = edited?.base ?? strip(savedList);
  // Editing only once the saved list is in hand: Save sends the whole list, so
  // editing one that failed to load would replace the real one. And not while
  // a save is on its way: those edits would be thrown away when it lands.
  const canEdit = saved !== undefined;
  const busy = save.isPending;
  const dirty = saved !== undefined && edited !== null && JSON.stringify(strip(edited)) !== JSON.stringify(base);
  const full = current.answers.length >= MAX_PERSON_FIELD_OPTIONS;
  const offered = current.answers.filter((a) => !a.retired).length;
  // A required picker with nothing in it cannot be answered; the server refuses this too.
  const nothingOffered = canEdit && offered === 0 && !current.allowOther;

  const edit = (next: { answers?: SpecialtyAnswerRow[]; allowOther?: boolean }) =>
    setEdited({ answers: next.answers ?? current.answers, allowOther: next.allowOther ?? current.allowOther, base });
  const setAnswers = (answers: SpecialtyAnswerRow[]) => edit({ answers });

  const add = () => {
    const answer = draft.trim();
    if (!answer) return;
    if (answer.toLowerCase() === OTHER_ANSWER.toLowerCase()) {
      toast.error(`"${OTHER_ANSWER}" is not an answer on the list. Use the switch below to let people type their own.`);
      return;
    }
    if (current.answers.some((a) => a.answer.toLowerCase() === answer.toLowerCase())) {
      toast.error(`"${answer}" is already in the list`);
      return;
    }
    setAnswers([...current.answers, { answer, retired: false, records: 0 }]);
    setDraft("");
  };

  const move = (from: number, to: number) => {
    const next = [...current.answers];
    [next[from], next[to]] = [next[to], next[from]];
    setAnswers(next);
  };

  const onSave = async () => {
    try {
      await save.mutateAsync({ ...strip(current), expected: base });
      setEdited(null);
      toast.success("Specialty answers saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
      // Somebody else saved first: show their list, on which the change can be made again.
      if (e instanceof ApiError && e.code === "LIST_CHANGED") {
        setEdited(null);
        refetch();
      }
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
            <ListChecks className="h-4 w-4" />
          </div>
          Specialty
        </CardTitle>
        <CardDescription>
          The answers every Specialty picker offers: on the registration forms, in the dashboard and for an
          event&apos;s topic. A change shows the next time a form is opened; a form that is already open keeps the
          list it loaded. An answer&apos;s wording cannot be edited, because it is stored on everyone who chose it:
          retire it and add a new one. An answer stored on records can be retired, not removed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
            {offered} offered
            {current.answers.length > offered ? `, ${current.answers.length - offered} retired` : ""}
            {current.allowOther ? `, plus "${OTHER_ANSWER}"` : ""}.
          </p>
        )}
        {current.answers.length > 0 && (
          <ol className="divide-y rounded-lg border max-h-[28rem] overflow-y-auto">
            {current.answers.map((row, i) => (
              <li key={row.answer} className="flex items-center gap-2 px-3 py-2">
                <span className="w-7 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                <span className={`flex-1 truncate text-sm ${row.retired ? "text-muted-foreground line-through" : ""}`}>{row.answer}</span>
                {row.retired && <Badge variant="secondary">Retired</Badge>}
                {row.records > 0 && <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">{recordsLabel(row.records)}</span>}
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Move ${row.answer} up`} disabled={busy || i === 0} onClick={() => move(i, i - 1)}>
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Move ${row.answer} down`} disabled={busy || i === current.answers.length - 1} onClick={() => move(i, i + 1)}>
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={row.retired ? `Offer ${row.answer} again` : `Retire ${row.answer}`}
                  title={row.retired ? "Offer again" : "Retire: no longer offered, still shown where it is stored"}
                  disabled={busy}
                  onClick={() => setAnswers(current.answers.map((a, j) => (j === i ? { ...a, retired: !a.retired } : a)))}
                >
                  {row.retired ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  // The reason is in the name as well as the tooltip: a disabled
                  // button shows no tooltip to a keyboard or a screen reader.
                  aria-label={row.records > 0 ? `Remove ${row.answer}: not possible, it is stored on ${recordsLabel(row.records)}. Retire it instead` : `Remove ${row.answer}`}
                  title={row.records > 0 ? `Stored on ${recordsLabel(row.records)}: retire it instead` : "Remove"}
                  disabled={busy || row.records > 0}
                  onClick={() => setAnswers(current.answers.filter((_, j) => j !== i))}
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
              <Label htmlFor="new-specialty-answer">Add an answer</Label>
              <div className="flex gap-2">
                <Input
                  id="new-specialty-answer"
                  value={draft}
                  maxLength={MAX_PERSON_FIELD_ANSWER}
                  placeholder={full ? `At most ${MAX_PERSON_FIELD_OPTIONS} answers` : "e.g. Sleep Medicine"}
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
            <div className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2">
              <div>
                <Label htmlFor="specialty-allow-other">Offer &quot;{OTHER_ANSWER}&quot;</Label>
                <p className="text-xs text-muted-foreground">Last on the list. Choosing it asks the person to type their specialty.</p>
              </div>
              <Switch id="specialty-allow-other" checked={current.allowOther} disabled={busy} onCheckedChange={(allowOther) => edit({ allowOther })} />
            </div>
            {nothingOffered && (
              <p role="alert" className="text-sm text-destructive">
                Nothing would be offered: the forms require a specialty, so the picker cannot be left empty. Keep at least one answer
                on offer, or switch &quot;{OTHER_ANSWER}&quot; on.
              </p>
            )}
            <div className="flex justify-end gap-2">
              {dirty && (
                <Button variant="ghost" onClick={() => setEdited(null)} disabled={save.isPending}>
                  Discard changes
                </Button>
              )}
              <Button onClick={onSave} disabled={!dirty || busy || nothingOffered}>
                <Save className="mr-2 h-4 w-4" />
                {save.isPending ? "Saving..." : "Save answers"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** The list as it is sent and compared: the answers and the switch, without the counts. */
function strip(value: { answers: { answer: string; retired: boolean }[]; allowOther: boolean }): SpecialtyListInput {
  return { answers: value.answers.map(({ answer, retired }) => ({ answer, retired })), allowOther: value.allowOther };
}

/** Records, not people: one person can be a contact, a speaker and two registrations. */
function recordsLabel(records: number): string {
  return records === 1 ? "1 record" : `${records.toLocaleString("en-US")} records`;
}
