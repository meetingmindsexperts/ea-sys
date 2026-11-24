"use client";

/**
 * Presentation types, on the event's Content page (Nov 24, 2026; step 3 of
 * docs/ABSTRACT_PRESENTATION_TYPES_PLAN.md). Two things in one place, as the
 * owner asked: which types THIS event's forms offer (a tick per type, saved
 * with the page), and the organisation's list itself (add, rename, retire,
 * restore, delete), which shows on every event and needs
 * `abstracts.types.manage`.
 *
 * A type added here is ticked on this event at once (`onAdded` saves the
 * ticks): it appears on no other event until someone ticks it there.
 */
import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { useChangePresentationType, useOrgPresentationTypes, usePresentationTypes } from "@/hooks/use-api";
import {
  EITHER_WAY_TYPE_KEY,
  MAX_PRESENTATION_TYPE_LABEL,
  MAX_PRESENTATION_TYPES,
  POSTER_TYPE_KEY,
  type PresentationTypeChange,
} from "@/lib/abstract-presentation-types";

/** What a built-in does, by key: the behaviour follows the type, whatever it is called. */
function behaviourOf(key: string): string | null {
  if (key === EITHER_WAY_TYPE_KEY) return "The author's either-way choice: a reviewer recommends one of the two.";
  if (key === POSTER_TYPE_KEY) return "Gets the poster certificate.";
  return null;
}

function heldText(n: number): string {
  return n === 0 ? "Not used yet" : `Held by ${n} abstract${n === 1 ? "" : "s"} or review${n === 1 ? "" : "s"}`;
}

export function PresentationTypesCard({
  eventId,
  ticked,
  onTickedChange,
  onAdded,
  canTick,
  canManage,
}: {
  eventId: string;
  /** The keys this event offers, as the page holds them (saved with the page's Save). */
  ticked: string[];
  onTickedChange: (next: string[]) => void;
  /** Saves the ticks with a newly added type among them, at once; false when it could not. */
  onAdded: (ticks: string[]) => Promise<boolean>;
  /** May edit this event's settings. */
  canTick: boolean;
  /** Holds `abstracts.types.manage`: may change the organisation's list. */
  canManage: boolean;
}) {
  const { data: eventTypes, isError: eventFailed } = usePresentationTypes(eventId);
  const { data: orgTypes } = useOrgPresentationTypes(canManage);
  const change = useChangePresentationType();
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ key: string; label: string } | null>(null);
  const [showRetired, setShowRetired] = useState(false);

  // The editor's list carries what holds each type; without the key, the event's list is enough.
  const types = (orgTypes ?? eventTypes ?? []).map((t) => ({ ...t, inUse: "inUse" in t ? (t.inUse as number) : 0 }));
  const live = types.filter((t) => !t.retired);
  const retired = types.filter((t) => t.retired);
  const [saving, setSaving] = useState(false);
  const busy = change.isPending || saving;
  // Ticks and Add wait for THIS event's list (review of 6e04916ec): until it is
  // there the ticks read as none, and saving them would drop what the event offers.
  const ticksReady = eventTypes !== undefined;
  // Delete is offered only once the counts are known: until then every type reads as unused.
  const countsKnown = orgTypes !== undefined;
  // Adding offers the type on this event, so it needs both keys (a type nobody can tick is offered nowhere).
  const canAdd = canManage && canTick;

  const run = async (next: PresentationTypeChange, done: string | null) => {
    try {
      const result = await change.mutateAsync(next);
      if (done) toast.success(done);
      return result;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the presentation types");
      return null;
    }
  };

  const toggle = (key: string, on: boolean) => {
    if (on) return onTickedChange([...ticked, key]);
    // The type is required to submit, so an event never offers none.
    if (ticked.filter((k) => k !== key && live.some((t) => t.key === k)).length === 0) {
      toast.error("At least one presentation type must stay offered");
      return;
    }
    onTickedChange(ticked.filter((k) => k !== key));
  };

  const add = async () => {
    const label = newName.trim();
    if (!label || busy || !ticksReady) return;
    setSaving(true);
    try {
      const result = await run({ action: "add", label }, null);
      if (!result) return;
      setNewName("");
      // Offered on this event at once, and on no other. Said only once both saves are done.
      const ticks = [...ticked, result.key];
      onTickedChange(ticks);
      if (await onAdded(ticks)) toast.success(`"${label}" added and offered on this event`);
    } finally {
      setSaving(false);
    }
  };

  const saveRename = async () => {
    if (!renaming || busy) return;
    const label = renaming.label.trim();
    const current = types.find((t) => t.key === renaming.key)?.label;
    // Nothing to send for the same name: just close the editor.
    if (!label || label === current) {
      setRenaming(null);
      return;
    }
    const done = await run({ action: "rename", key: renaming.key, label }, `Renamed to "${label}" on every event`);
    if (done) setRenaming(null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Presentation Types</CardTitle>
        <CardDescription>
          Tick the types this event&apos;s abstract form offers. The list belongs to the organisation: a type added or
          renamed here shows on every event, and a new one is offered only where it is ticked. Existing abstracts keep
          their type even when an event stops offering it.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {eventFailed && !eventTypes && (
          <p className="text-sm text-destructive">The presentation types could not be loaded. Reload the page to change them.</p>
        )}
        <ul className="grid gap-3 md:grid-cols-2">
          {live.map((t) => {
            const behaviour = behaviourOf(t.key);
            const isRenaming = renaming?.key === t.key;
            return (
              <li key={t.key} className="flex flex-col justify-between gap-3 rounded-md border p-3">
                <div className="flex min-w-0 items-start gap-3">
                  <Checkbox
                    id={`ptype-${t.key}`}
                    className="mt-0.5"
                    checked={ticked.includes(t.key)}
                    disabled={!canTick || !ticksReady}
                    onCheckedChange={(next) => toggle(t.key, next === true)}
                    aria-label={`Offer ${t.label} on this event`}
                  />
                  <div className="min-w-0 space-y-1">
                    {isRenaming ? (
                      <Input
                        value={renaming.label}
                        maxLength={MAX_PRESENTATION_TYPE_LABEL}
                        disabled={busy}
                        autoFocus
                        className="h-8"
                        aria-label={`New name for ${t.label}`}
                        onChange={(e) => setRenaming({ key: t.key, label: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveRename();
                          if (e.key === "Escape") setRenaming(null);
                        }}
                      />
                    ) : (
                      <Label htmlFor={`ptype-${t.key}`} className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {t.label}
                        {t.builtIn && <Badge variant="secondary" className="text-[10px] font-normal">Built-in</Badge>}
                      </Label>
                    )}
                    {behaviour && <p className="text-xs text-muted-foreground">{behaviour}</p>}
                    {canManage && <p className="text-xs text-muted-foreground">{heldText(t.inUse)}</p>}
                  </div>
                </div>
                {canManage && (
                  <div className="flex flex-wrap gap-2 pl-7">
                    {isRenaming ? (
                      <>
                        <Button size="sm" onClick={() => void saveRename()} disabled={busy || !renaming.label.trim()}>Save name</Button>
                        <Button size="sm" variant="ghost" onClick={() => setRenaming(null)} disabled={busy}>Cancel</Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" variant="outline" onClick={() => setRenaming({ key: t.key, label: t.label })} disabled={busy}>Rename</Button>
                        {!t.builtIn && countsKnown && t.inUse === 0 ? (
                          <Button size="sm" variant="outline" onClick={() => void run({ action: "delete", key: t.key }, `"${t.label}" deleted`)} disabled={busy}>Delete</Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void run(
                                { action: "retire", key: t.key },
                                `"${t.label}" retired: no event offers it now. An event that offered only it now offers the built-in types.`,
                              )
                            }
                            disabled={busy}
                          >
                            Retire
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        {canAdd && (
          <div className="space-y-2">
            <Label htmlFor="new-presentation-type">Add a type</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="new-presentation-type"
                value={newName}
                maxLength={MAX_PRESENTATION_TYPE_LABEL}
                placeholder="For example: E-poster, Case report, Symposium"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void add();
                }}
                disabled={busy || !ticksReady || types.length >= MAX_PRESENTATION_TYPES}
              />
              <Button onClick={() => void add()} disabled={busy || !ticksReady || !newName.trim() || types.length >= MAX_PRESENTATION_TYPES}>
                Add
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              It is offered on this event at once. A type you add has no special behaviour: authors can choose it and
              staff can set it. Renaming a built-in keeps what it does.
            </p>
          </div>
        )}

        {canManage && retired.length > 0 && (
          <div className="space-y-2">
            <Button variant="ghost" size="sm" className="px-0" onClick={() => setShowRetired((v) => !v)}>
              {showRetired ? "Hide" : "Show"} retired types ({retired.length})
            </Button>
            {showRetired && (
              <ul className="grid gap-3 md:grid-cols-2">
                {retired.map((t) => (
                  <li key={t.key} className="flex flex-col justify-between gap-3 rounded-md border bg-muted/30 p-3">
                    <div className="space-y-1">
                      <p className="text-sm text-muted-foreground">{t.label}</p>
                      <p className="text-xs text-muted-foreground">{heldText(t.inUse)}. Offered on no event.</p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => void run({ action: "restore", key: t.key }, `"${t.label}" restored`)} disabled={busy}>Restore</Button>
                      {!t.builtIn && countsKnown && t.inUse === 0 && (
                        <Button size="sm" variant="outline" onClick={() => void run({ action: "delete", key: t.key }, `"${t.label}" deleted`)} disabled={busy}>Delete</Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
