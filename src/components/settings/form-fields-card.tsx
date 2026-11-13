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
import { useSaveSpecialtySettings, useSpecialtySettings, type SpecialtyAnswerRow } from "@/hooks/use-person-fields";
import { MAX_PERSON_FIELD_ANSWER, MAX_PERSON_FIELD_OPTIONS, OTHER_ANSWER } from "@/lib/person-fields";

/**
 * The organisation's Specialty answers (Nov 13, 2026; step 1 of
 * docs/ORG_FIELDS_PLAN.md). Saved to `Organization.settings.personFields` and
 * offered by every specialty picker: the registration forms, the dashboard
 * forms, an event's own topic.
 *
 * An answer's text is what is stored on everyone who chose it, so it is never
 * edited here: retire it and add another. One that people hold can be retired
 * and not removed; the server refuses the removal as well.
 */
export function FormFieldsCard() {
  const { data: saved, isLoading, isError, refetch } = useSpecialtySettings();
  const save = useSaveSpecialtySettings();
  // null = no unsaved edits; what is shown is then the saved list.
  const [edited, setEdited] = useState<{ answers: SpecialtyAnswerRow[]; allowOther: boolean } | null>(null);
  const [draft, setDraft] = useState("");
  const current = edited ?? (saved ? { answers: saved.answers, allowOther: saved.allowOther } : { answers: [], allowOther: true });
  // Editing only once the saved list is in hand: Save sends the whole list, so
  // editing one that failed to load would replace the real one.
  const canEdit = saved !== undefined;
  const dirty = saved !== undefined && edited !== null && JSON.stringify(strip(edited)) !== JSON.stringify(strip({ answers: saved.answers, allowOther: saved.allowOther }));
  const full = current.answers.length >= MAX_PERSON_FIELD_OPTIONS;
  const offered = current.answers.filter((a) => !a.retired).length;

  const setAnswers = (answers: SpecialtyAnswerRow[]) => setEdited({ ...current, answers });

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
    setAnswers([...current.answers, { answer, retired: false, people: 0 }]);
    setDraft("");
  };

  const move = (from: number, to: number) => {
    const next = [...current.answers];
    [next[from], next[to]] = [next[to], next[from]];
    setAnswers(next);
  };

  const onSave = async () => {
    try {
      await save.mutateAsync({ answers: current.answers.map(({ answer, retired }) => ({ answer, retired })), allowOther: current.allowOther });
      setEdited(null);
      toast.success("Specialty answers saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
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
          event&apos;s topic. A change shows the next time a form is opened; a form someone already has open keeps
          its list for up to five minutes. An answer&apos;s wording cannot be edited,
          because it is stored on everyone who chose it: retire it and add a new one. An answer people hold can be
          retired, not removed.
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
                {row.people > 0 && <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">{peopleLabel(row.people)}</span>}
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Move ${row.answer} up`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`Move ${row.answer} down`} disabled={i === current.answers.length - 1} onClick={() => move(i, i + 1)}>
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={row.retired ? `Offer ${row.answer} again` : `Retire ${row.answer}`}
                  title={row.retired ? "Offer again" : "Retire: no longer offered, still shown where it is stored"}
                  onClick={() => setAnswers(current.answers.map((a, j) => (j === i ? { ...a, retired: !a.retired } : a)))}
                >
                  {row.retired ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  aria-label={`Remove ${row.answer}`}
                  title={row.people > 0 ? `Held by ${peopleLabel(row.people)}: retire it instead` : "Remove"}
                  disabled={row.people > 0}
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
                  disabled={full}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    add();
                  }}
                />
                <Button variant="outline" onClick={add} disabled={full || !draft.trim()}>
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
              <Switch id="specialty-allow-other" checked={current.allowOther} onCheckedChange={(allowOther) => setEdited({ ...current, allowOther })} />
            </div>
            <div className="flex justify-end gap-2">
              {dirty && (
                <Button variant="ghost" onClick={() => setEdited(null)} disabled={save.isPending}>
                  Discard changes
                </Button>
              )}
              <Button onClick={onSave} disabled={!dirty || save.isPending}>
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

function strip(value: { answers: SpecialtyAnswerRow[]; allowOther: boolean }) {
  return { allowOther: value.allowOther, answers: value.answers.map(({ answer, retired }) => ({ answer, retired })) };
}

function peopleLabel(people: number): string {
  return people === 1 ? "1 person" : `${people.toLocaleString("en-US")} people`;
}
