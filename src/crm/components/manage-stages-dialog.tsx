"use client";

/**
 * Pipeline-stage management — the screen behind the "org-editable pipeline"
 * decision (CRM plan §9 d3). The APIs (create / rename / remap outcome /
 * reorder / delete) shipped in Week 1; this dialog is the form over them.
 *
 * Semantics worth knowing at the UI layer:
 *  - Renaming is SAFE: the deal state machine reads `terminalOutcome`, never the
 *    stage name (CRM review H3). The outcome select is what decides whether a
 *    terminal column closes deals WON or LOST.
 *  - The server refuses to delete a column that still holds deals
 *    (STAGE_HAS_DEALS), to delete/remap the last WON- or LOST-mapped column
 *    (LAST_TERMINAL_STAGE), and duplicate names (NAME_TAKEN) — the hooks toast
 *    those messages verbatim.
 *  - Delete is ADMIN/CRM_USER only (requireCrmDelete); the button hides for
 *    roles the server would 403 anyway.
 */
import { useState } from "react";
import { useSession } from "next-auth/react";
import { ArrowDown, ArrowUp, Check, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CrmStage } from "@/crm/lib/crm-types";
import { canDeleteCrm } from "@/crm/lib/crm-roles";
import {
  useCreateStage,
  useDeleteStage,
  useReorderStages,
  useUpdateStage,
} from "@/crm/hooks/use-crm-api";

/** Sentinel for "terminal but unmapped" in the outcome Select (no empty values allowed). */
const OUTCOME_NONE = "__none__";

export function ManageStagesDialog({
  stages,
  open,
  onOpenChange,
}: {
  stages: CrmStage[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: session } = useSession();
  const canDelete = canDeleteCrm(session?.user?.role);

  const createStage = useCreateStage();
  const updateStage = useUpdateStage();
  const reorderStages = useReorderStages();
  const deleteStage = useDeleteStage();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [newName, setNewName] = useState("");
  const [newTerminal, setNewTerminal] = useState(false);
  const [newOutcome, setNewOutcome] = useState<string>(OUTCOME_NONE);

  const busy =
    createStage.isPending || updateStage.isPending || reorderStages.isPending || deleteStage.isPending;

  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= stages.length) return;
    const ids = stages.map((s) => s.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorderStages.mutate(ids);
  }

  async function saveRename(stage: CrmStage) {
    const name = editName.trim();
    if (!name || name === stage.name) {
      setEditingId(null);
      return;
    }
    try {
      await updateStage.mutateAsync({ stageId: stage.id, name });
    } catch {
      return; // surfaced by the hook's onError toast; stay in edit mode for a retry
    }
    setEditingId(null);
  }

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    try {
      await createStage.mutateAsync({
        name,
        isTerminal: newTerminal,
        // The server also derives WON/LOST from a recognisable name; an explicit
        // pick here always wins.
        terminalOutcome: newTerminal && newOutcome !== OUTCOME_NONE ? (newOutcome as "WON" | "LOST") : undefined,
      });
    } catch {
      return; // hook toasts
    }
    setNewName("");
    setNewTerminal(false);
    setNewOutcome(OUTCOME_NONE);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Manage pipeline stages</DialogTitle>
          <DialogDescription asChild>
            <span>
              Rename, reorder, add or remove columns. Renaming never breaks closing — a terminal
              column&apos;s <em>Closes as</em> mapping is what marks deals Won or Lost.
            </span>
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-1.5">
          {stages.map((stage, i) => (
            <li key={stage.id} className="flex items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2">
              <div className="flex flex-col">
                <button
                  type="button"
                  aria-label={`Move ${stage.name} up`}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  disabled={busy || i === 0}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${stage.name} down`}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  disabled={busy || i === stages.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </div>

              {editingId === stage.id ? (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void saveRename(stage);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    autoFocus
                    className="h-8"
                  />
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void saveRename(stage)}>
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="truncate font-medium">{stage.name}</span>
                  <button
                    type="button"
                    aria-label={`Rename ${stage.name}`}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      setEditingId(stage.id);
                      setEditName(stage.name);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              {stage.isTerminal ? (
                <Select
                  value={stage.terminalOutcome ?? OUTCOME_NONE}
                  onValueChange={(v) =>
                    updateStage.mutate({
                      stageId: stage.id,
                      terminalOutcome: v === OUTCOME_NONE ? null : (v as "WON" | "LOST"),
                    })
                  }
                  disabled={busy}
                >
                  <SelectTrigger className="h-8 w-[10.5rem]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="WON">Closes as Won</SelectItem>
                    <SelectItem value="LOST">Closes as Lost</SelectItem>
                    <SelectItem value={OUTCOME_NONE}>Terminal, unmapped</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Badge variant="outline" className="text-[10px]">
                  open
                </Badge>
              )}

              {canDelete && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete ${stage.name}`}
                  className="text-muted-foreground hover:text-destructive"
                  disabled={busy}
                  onClick={() => deleteStage.mutate(stage.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>

        {/* ── Add a stage ─────────────────────────────────────────────────── */}
        <div className="space-y-2 rounded-lg border border-dashed p-3">
          <Label className="text-xs font-medium uppercase text-muted-foreground">Add a stage</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder='e.g. "Contract Review"'
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAdd();
              }}
              className="h-9 w-56"
            />
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={newTerminal} onCheckedChange={(v) => setNewTerminal(v === true)} />
              Terminal (closes deals)
            </label>
            {newTerminal && (
              <Select value={newOutcome} onValueChange={setNewOutcome}>
                <SelectTrigger className="h-9 w-[10.5rem]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="WON">Closes as Won</SelectItem>
                  <SelectItem value="LOST">Closes as Lost</SelectItem>
                  <SelectItem value={OUTCOME_NONE}>Unmapped</SelectItem>
                </SelectContent>
              </Select>
            )}
            <Button onClick={() => void handleAdd()} disabled={busy || !newName.trim()}>
              {createStage.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Add
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            New stages land at the end — use the arrows to slot them in. A column holding deals can&apos;t
            be deleted, and the last Won/Lost column can&apos;t be removed or unmapped.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
