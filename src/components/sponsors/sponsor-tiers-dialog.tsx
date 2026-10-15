"use client";

import { useState } from "react";
import { Loader2, Lock, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUpdateSponsorTiers, type SponsorTierDef } from "@/hooks/use-api";
import { MAX_CUSTOM_SPONSOR_TIERS, MAX_SPONSOR_TIER_LABEL } from "@/lib/sponsor-tiers";

interface DraftTier {
  /** Absent for a tier added in this dialog; the server gives it one. */
  key?: string;
  label: string;
  /** Stable React key, so typing in one row never jumps to another. */
  rowId: string;
}

let rowCounter = 0;
const nextRowId = () => `tier-row-${++rowCounter}`;

/**
 * The organisation's sponsor tiers. Built-ins are listed and locked; the
 * organisation's own can be added, renamed and removed, and apply to every
 * event. Renaming keeps every sponsor on the tier; removing one still in use
 * is refused by the server with the count, which is shown as the error.
 * Mount it only while open (`{open && <SponsorTiersDialog ... />}`).
 */
export function SponsorTiersDialog({
  open,
  onOpenChange,
  tiers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tiers: SponsorTierDef[];
}) {
  const save = useUpdateSponsorTiers();
  // The page mounts this only while it is open, so the draft starts from the
  // current list every time.
  const [draft, setDraft] = useState<DraftTier[]>(() =>
    tiers.filter((t) => !t.builtIn).map((t) => ({ key: t.key, label: t.label, rowId: nextRowId() })),
  );

  const builtIns = tiers.filter((t) => t.builtIn);
  const handleOpenChange = onOpenChange;

  const setLabel = (rowId: string, label: string) =>
    setDraft((prev) => prev.map((t) => (t.rowId === rowId ? { ...t, label } : t)));

  const remove = (rowId: string) => setDraft((prev) => prev.filter((t) => t.rowId !== rowId));

  const add = () => setDraft((prev) => [...prev, { label: "", rowId: nextRowId() }]);

  const handleSave = async () => {
    const tiersToSave = draft.map((t) => ({ ...(t.key ? { key: t.key } : {}), label: t.label.trim() }));
    if (tiersToSave.some((t) => !t.label)) {
      toast.error("Every tier needs a name");
      return;
    }
    try {
      await save.mutateAsync(tiersToSave);
      toast.success("Sponsor tiers saved");
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save sponsor tiers");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Sponsor tiers</DialogTitle>
          <DialogDescription>
            Your own tiers apply to every event. The standard tiers cannot be changed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Standard</h3>
            <div className="flex flex-wrap gap-1.5">
              {builtIns.map((t) => (
                <span
                  key={t.key}
                  className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
                >
                  <Lock className="h-3 w-3" aria-hidden />
                  {t.label}
                </span>
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Your tiers</h3>
            {draft.length === 0 && (
              <p className="text-sm text-muted-foreground">None yet. Add one, for example Associate.</p>
            )}
            {draft.map((t) => (
              <div key={t.rowId} className="flex items-center gap-2">
                <Input
                  value={t.label}
                  onChange={(e) => setLabel(t.rowId, e.target.value)}
                  placeholder="Tier name"
                  maxLength={MAX_SPONSOR_TIER_LABEL}
                  aria-label="Tier name"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => remove(t.rowId)}
                  className="shrink-0 text-red-600 hover:bg-red-50 hover:text-red-700"
                  title="Remove tier"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={add} disabled={draft.length >= MAX_CUSTOM_SPONSOR_TIERS}>
              <Plus className="mr-2 h-4 w-4" />
              Add tier
            </Button>
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={save.isPending}>
            {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save tiers
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
