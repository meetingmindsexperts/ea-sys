"use client";

/**
 * Manage the org's deal TYPES — the admin-editable business-line list ("Conference
 * Management", "Sponsorship Inquiry", …) shown as a dropdown on the deal.
 *
 * Mirrors ManageStagesDialog (up/down reorder, inline rename, add) but "remove" is
 * a SOFT delete (archive): archived types drop out of the deal picker + the board
 * filter, but a deal that already references one keeps rendering its name. A
 * "Show archived" toggle restores. Opened from the Deals board, next to
 * "Manage stages".
 */
import { useState } from "react";
import { toast } from "sonner";
import { Archive, ArrowDown, ArrowUp, ArchiveRestore, Check, Loader2, Pencil, Plus, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useCrmDealTypes,
  useCreateDealType,
  useReorderDealTypes,
  useUpdateDealType,
} from "@/crm/hooks/use-crm-api";
import type { CrmDealType } from "@/crm/lib/crm-types";

export function ManageDealTypesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  // Full list incl. archived — the management view.
  const { data: dealTypes = [], isLoading } = useCrmDealTypes(true);
  const create = useCreateDealType();
  const update = useUpdateDealType();
  const reorder = useReorderDealTypes();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [newName, setNewName] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  const active = dealTypes.filter((t) => !t.archivedAt);
  const archived = dealTypes.filter((t) => t.archivedAt);
  const busy = create.isPending || update.isPending || reorder.isPending;

  function move(index: number, dir: -1 | 1) {
    const next = [...active];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    reorder.mutate(next.map((t) => t.id));
  }

  async function saveRename(t: CrmDealType) {
    const name = editName.trim();
    if (!name || name === t.name) {
      setEditingId(null);
      return;
    }
    try {
      await update.mutateAsync({ dealTypeId: t.id, name });
      setEditingId(null);
    } catch {
      // hook toasts on error; keep the editor open for a retry
    }
  }

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    try {
      await create.mutateAsync({ name });
      setNewName("");
    } catch {
      return;
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Deal types</DialogTitle>
          <DialogDescription asChild>
            <span>Rename, reorder, add or archive the deal-type options shown on every deal.</span>
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <ul className="space-y-1.5">
            {active.map((t, i) => (
              <li key={t.id} className="flex items-center gap-2 rounded-md border p-2">
                <div className="flex flex-col">
                  <button
                    type="button"
                    aria-label="Move up"
                    className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                    disabled={i === 0 || busy}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-30"
                    disabled={i === active.length - 1 || busy}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                </div>

                {editingId === t.id ? (
                  <>
                    <Input
                      autoFocus
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && void saveRename(t)}
                      className="h-8 flex-1"
                    />
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void saveRename(t)}>
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 truncate text-sm">{t.name}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Rename ${t.name}`}
                      onClick={() => {
                        setEditingId(t.id);
                        setEditName(t.name);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Archive ${t.name}`}
                      disabled={busy}
                      onClick={() => update.mutate({ dealTypeId: t.id, archived: true })}
                    >
                      <Archive className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </li>
            ))}
            {active.length === 0 && (
              <li className="rounded-md border border-dashed p-3 text-center text-sm text-muted-foreground">
                No deal types yet — add one below.
              </li>
            )}
          </ul>
        )}

        {/* ── Add a deal type ─────────────────────────────────────────────── */}
        <div className="space-y-2 border-t pt-3">
          <Label className="text-xs font-medium uppercase text-muted-foreground">Add a deal type</Label>
          <div className="flex gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleAdd()}
              placeholder="e.g. Sponsorship Inquiry"
              className="h-9"
            />
            <Button disabled={!newName.trim() || busy} onClick={() => void handleAdd()}>
              {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {/* ── Archived ─────────────────────────────────────────────────────── */}
        {archived.length > 0 && (
          <div className="border-t pt-3">
            <button
              type="button"
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? "Hide" : "Show"} archived ({archived.length})
            </button>
            {showArchived && (
              <ul className="mt-2 space-y-1.5">
                {archived.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 rounded-md border border-dashed p-2">
                    <span className="flex-1 truncate text-sm text-muted-foreground line-through">{t.name}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => update.mutate({ dealTypeId: t.id, archived: false }, { onSuccess: () => toast.success("Deal type restored") })}
                    >
                      <ArchiveRestore className="mr-1.5 h-3.5 w-3.5" />
                      Restore
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
