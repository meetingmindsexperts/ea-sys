"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, ListChecks, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useDefaultRegistrationTypes, useUpdateDefaultRegistrationTypes } from "@/hooks/use-api";
import { MAX_DEFAULT_REG_TYPES, MAX_DEFAULT_REG_TYPE_NAME } from "@/lib/default-registration-types";

/**
 * The registration types a NEW event starts with, per organisation. Saved to
 * `Organization.settings.defaultRegistrationTypes` and read only by the event
 * service at creation, so no existing event or registration form changes.
 */
export function NewEventDefaultsCard({ readOnly = false }: { readOnly?: boolean }) {
  const { data: saved, isLoading, isError, refetch } = useDefaultRegistrationTypes();
  const update = useUpdateDefaultRegistrationTypes();
  // null = no unsaved edits; the list shown is then the saved one.
  const [edited, setNames] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const names = edited ?? saved ?? [];
  // Editing only once the saved list is in hand: Save sends the whole list, so
  // editing a list that failed to load would replace the real one (review M1).
  const canEdit = !readOnly && saved !== undefined;

  const dirty = JSON.stringify(names) !== JSON.stringify(saved ?? []);
  const full = names.length >= MAX_DEFAULT_REG_TYPES;

  const add = () => {
    const name = draft.trim();
    if (!name) return;
    if (names.some((n) => n.toLowerCase() === name.toLowerCase())) {
      toast.error(`"${name}" is already in the list`);
      return;
    }
    setNames([...names, name]);
    setDraft("");
  };

  const move = (from: number, to: number) => {
    const next = [...names];
    [next[from], next[to]] = [next[to], next[from]];
    setNames(next);
  };

  const save = async () => {
    try {
      await update.mutateAsync(names);
      setNames(null);
      toast.success("New event defaults saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    }
  };

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
            <ListChecks className="h-4 w-4" />
          </div>
          New event defaults
        </CardTitle>
        <CardDescription>
          The registration types every new event starts with. Changes apply only to events created
          afterwards; existing events and their registration forms are not touched.
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
        {saved !== undefined && names.length === 0 && (
          <p className="text-sm text-muted-foreground">New events start with no registration types.</p>
        )}
        {names.length > 0 && (
          <ol className="divide-y rounded-lg border">
            {names.map((name, i) => (
              <li key={name} className="flex items-center gap-2 px-3 py-2">
                <span className="w-6 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                <span className="flex-1 truncate text-sm">{name}</span>
                {canEdit && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={`Move ${name} up`}
                      disabled={i === 0}
                      onClick={() => move(i, i - 1)}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={`Move ${name} down`}
                      disabled={i === names.length - 1}
                      onClick={() => move(i, i + 1)}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      aria-label={`Remove ${name}`}
                      onClick={() => setNames(names.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ol>
        )}

        {canEdit && (
          <>
            <div className="space-y-2">
              <Label htmlFor="new-reg-type">Add a registration type</Label>
              <div className="flex gap-2">
                <Input
                  id="new-reg-type"
                  value={draft}
                  maxLength={MAX_DEFAULT_REG_TYPE_NAME}
                  placeholder={full ? `At most ${MAX_DEFAULT_REG_TYPES} types` : "e.g. Delegate"}
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
            <div className="flex justify-end">
              <Button onClick={save} disabled={!dirty || update.isPending}>
                <Save className="mr-2 h-4 w-4" />
                {update.isPending ? "Saving..." : "Save defaults"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
