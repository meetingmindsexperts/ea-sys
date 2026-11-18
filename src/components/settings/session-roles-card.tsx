"use client";

import { useState } from "react";
import { Archive, ArrowDown, ArrowUp, Plus, RotateCcw, Save, Trash2, UsersRound } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSaveSessionRoles, useSessionRoles, type SessionRoleRow } from "@/hooks/use-session-roles";
import { MAX_SESSION_ROLE_LABEL, MAX_SESSION_ROLES, type SessionRoleDuty } from "@/lib/session-roles";

const DUTY_LABELS: Record<SessionRoleDuty, string> = {
  RUNS: "Runs the session",
  PRESENTS: "Presents",
};

/** What each duty means for the person, in the speaker emails. */
const DUTY_HELP: Record<SessionRoleDuty, string> = {
  RUNS: "gets the moderation run-sheet",
  PRESENTS: "gets the presentation details",
};

/** A role as the card edits it: an unsaved one has no key yet. */
type Row = Omit<SessionRoleRow, "key"> & { key?: string };

function strip(rows: Row[]) {
  return rows.map(({ key, label, duty, hidden }) => ({ ...(key ? { key } : {}), label: label.trim(), duty, hidden }));
}

function sessionsLabel(n: number): string {
  return n === 1 ? "1 session" : `${n.toLocaleString("en-US")} sessions`;
}

/** Why the delete button is off, or what it does. */
function deleteHint(row: Row): string {
  if (row.builtIn) return "A built-in role can be renamed or hidden, not deleted";
  if (row.assignments > 0) return `Held in ${sessionsLabel(row.assignments)}: hide it instead`;
  return "Delete";
}

/**
 * The organisation's session roles (Nov 18, 2026; docs/SESSION_ROLES_PLAN.md).
 * Every role either runs the session or presents in it, which decides which
 * part of the speaker emails the person gets. The four built-ins can be
 * renamed and hidden; a role somebody holds can be hidden, not deleted, and
 * keeps its duty. Every rule is the server's (`saveSessionRoles`); this card
 * only says them early.
 */
export function SessionRolesCard({ readOnly = false }: { readOnly?: boolean }) {
  const { data: saved, isLoading, isError, refetch } = useSessionRoles();
  const save = useSaveSessionRoles();
  const [edited, setEdited] = useState<Row[] | null>(null);
  const [draft, setDraft] = useState("");
  const [draftDuty, setDraftDuty] = useState<SessionRoleDuty>("PRESENTS");
  const savedRows: Row[] = saved ?? [];
  const rows = edited ?? savedRows;
  const canEdit = saved !== undefined && !readOnly;
  const busy = save.isPending;
  const dirty = edited !== null && JSON.stringify(strip(rows)) !== JSON.stringify(strip(savedRows));
  const blank = rows.some((r) => !r.label.trim());
  const full = rows.length >= MAX_SESSION_ROLES;

  const setRow = (i: number, patch: Partial<Row>) => setEdited(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (from: number, to: number) => {
    const next = [...rows];
    [next[from], next[to]] = [next[to], next[from]];
    setEdited(next);
  };
  const add = () => {
    const label = draft.trim();
    if (!label) return;
    if (rows.some((r) => r.label.trim().toLowerCase() === label.toLowerCase())) {
      toast.error(`There is already a role called "${label}"`);
      return;
    }
    setEdited([...rows, { label, duty: draftDuty, builtIn: false, hidden: false, assignments: 0 }]);
    setDraft("");
  };

  const onSave = async () => {
    try {
      await save.mutateAsync(strip(rows));
      setEdited(null);
      toast.success("Session roles saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
            <UsersRound className="h-4 w-4" />
          </div>
          Session roles
        </CardTitle>
        <CardDescription>
          The roles the agenda offers when you put someone on a session. A role that runs the session gets the moderation
          run-sheet in the speaker emails; a role that presents gets the presentation details. Each event chooses which of these
          it offers, in its own settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {isError && saved === undefined && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
            <p className="text-sm text-destructive">The roles could not be loaded.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          </div>
        )}
        {rows.length > 0 && (
          <ol className="divide-y rounded-lg border">
            {rows.map((row, i) => {
              const dutyLocked = row.builtIn || row.assignments > 0;
              return (
                <li key={row.key ?? `new-${i}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <Input
                    aria-label={`Role ${i + 1} name`}
                    className={`h-8 min-w-[9rem] flex-1 ${row.hidden ? "text-muted-foreground line-through" : ""}`}
                    value={row.label}
                    maxLength={MAX_SESSION_ROLE_LABEL}
                    disabled={!canEdit || busy}
                    onChange={(e) => setRow(i, { label: e.target.value })}
                  />
                  {dutyLocked ? (
                    <span
                      className="w-40 text-sm text-muted-foreground"
                      title={row.builtIn ? "A built-in role keeps its duty" : `Held in ${sessionsLabel(row.assignments)}: its duty stays`}
                    >
                      {DUTY_LABELS[row.duty]}
                    </span>
                  ) : (
                    <Select value={row.duty} disabled={!canEdit || busy} onValueChange={(v) => setRow(i, { duty: v as SessionRoleDuty })}>
                      <SelectTrigger className="h-8 w-40" aria-label={`What ${row.label || "this role"} does`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="RUNS">{DUTY_LABELS.RUNS}</SelectItem>
                        <SelectItem value="PRESENTS">{DUTY_LABELS.PRESENTS}</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                  {row.builtIn && <Badge variant="secondary">Built in</Badge>}
                  {row.hidden && <Badge variant="secondary">Hidden</Badge>}
                  {!row.key && <Badge variant="outline">New</Badge>}
                  {row.assignments > 0 && (
                    <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">{sessionsLabel(row.assignments)}</span>
                  )}
                  {canEdit && (
                    <>
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
                        aria-label={row.hidden ? `Offer ${row.label} again` : `Hide ${row.label}`}
                        title={row.hidden ? "Offer again" : "Hide: no longer offered, kept by the people who hold it"}
                        disabled={busy}
                        onClick={() => setRow(i, { hidden: !row.hidden })}
                      >
                        {row.hidden ? <RotateCcw className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive"
                        aria-label={`Delete ${row.label}`}
                        title={deleteHint(row)}
                        disabled={busy || row.builtIn || row.assignments > 0}
                        onClick={() => setEdited(rows.filter((_, j) => j !== i))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {canEdit && (
          <>
            <div className="space-y-2">
              <Label htmlFor="new-session-role">Add a role</Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="new-session-role"
                  className="min-w-[10rem] flex-1"
                  value={draft}
                  maxLength={MAX_SESSION_ROLE_LABEL}
                  placeholder={full ? `At most ${MAX_SESSION_ROLES} roles` : "e.g. Host"}
                  disabled={full || busy}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    add();
                  }}
                />
                <Select value={draftDuty} disabled={full || busy} onValueChange={(v) => setDraftDuty(v as SessionRoleDuty)}>
                  <SelectTrigger className="w-44" aria-label="What the new role does">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="RUNS">{DUTY_LABELS.RUNS}</SelectItem>
                    <SelectItem value="PRESENTS">{DUTY_LABELS.PRESENTS}</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" onClick={add} disabled={full || busy || !draft.trim()}>
                  <Plus className="mr-2 h-4 w-4" />
                  Add
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {draft.trim() || "The new role"} {DUTY_HELP[draftDuty]}. Its duty is fixed once someone holds it.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              {dirty && (
                <Button variant="ghost" onClick={() => setEdited(null)} disabled={busy}>
                  Discard changes
                </Button>
              )}
              <Button onClick={onSave} disabled={!dirty || busy || blank}>
                <Save className="mr-2 h-4 w-4" />
                {busy ? "Saving..." : "Save roles"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
