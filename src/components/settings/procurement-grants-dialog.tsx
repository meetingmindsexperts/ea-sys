"use client";

/**
 * Settings → Users: the four Budget & Procurement grants on one team member
 * (spec §4). SUPER_ADMIN only, and only while the module is on; both are
 * re-checked by the users PUT, which also refuses the two impossible pairs
 * (the final approver holding the request grant, and settle beside a
 * ceiling) with a named code the dialog shows verbatim.
 *
 * In core rather than in the module because the Settings page would
 * otherwise need an exemption on the one-way import boundary; it talks to
 * the users API only.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2 } from "lucide-react";

export interface ProcurementGrantTarget {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  procurementRequest?: boolean;
  procurementApproveCeilingAed?: number | null;
  procurementApproveUnlimited?: boolean;
  procurementSettle?: boolean;
}

export function hasAnyGrant(u: ProcurementGrantTarget): boolean {
  return !!u.procurementRequest || !!u.procurementApproveUnlimited || !!u.procurementSettle || (u.procurementApproveCeilingAed ?? 0) > 0;
}

export function ProcurementGrantsDialog({ user, onClose, onSaved }: { user: ProcurementGrantTarget | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ request: false, ceiling: "", unlimited: false, settle: false });
  const [saving, setSaving] = useState(false);
  // Seed on every closed -> open transition (React's previous-render pattern,
  // not an effect), so the switches show the person being edited.
  const [prevUserId, setPrevUserId] = useState<string | null>(null);
  if ((user?.id ?? null) !== prevUserId) {
    setPrevUserId(user?.id ?? null);
    if (user) {
      setForm({
        request: !!user.procurementRequest,
        ceiling: user.procurementApproveCeilingAed ? String(user.procurementApproveCeilingAed) : "",
        unlimited: !!user.procurementApproveUnlimited,
        settle: !!user.procurementSettle,
      });
    }
  }

  async function save() {
    if (!user) return;
    const ceiling = form.ceiling.trim() === "" ? null : Number(form.ceiling);
    if (ceiling !== null && (!Number.isFinite(ceiling) || ceiling <= 0)) {
      toast.error("The approval ceiling must be a positive AED amount, or empty for none.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/organization/users/${user.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          procurementRequest: form.request,
          procurementApproveCeilingAed: form.unlimited ? null : ceiling,
          procurementApproveUnlimited: form.unlimited,
          procurementSettle: form.settle,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error || "Couldn't save the procurement grants");
        return;
      }
      toast.success(`Procurement grants saved for ${`${user.firstName} ${user.lastName}`.trim() || user.email}.`);
      onSaved();
      onClose();
    } catch (error) {
      console.error("Error saving procurement grants:", error);
      toast.error("Couldn't save the procurement grants");
    } finally {
      setSaving(false);
    }
  }

  const name = user ? `${user.firstName} ${user.lastName}`.trim() || user.email : "";
  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Procurement grants</DialogTitle>
          <DialogDescription>
            {/* One expression, not text after an interpolation: JSX trims the
                leading space of a text node that runs to the end of the line. */}
            {`What ${name} may do in Budget & Procurement, on top of their role. Reading needs no grant. Takes effect on their next click.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <label className="flex items-start justify-between gap-4">
            <span>
              <span className="font-medium">Request</span>
              <span className="block text-xs text-muted-foreground">Raise purchase requests against a budget line (Phase 2).</span>
            </span>
            <Switch checked={form.request} onCheckedChange={(v) => setForm((f) => ({ ...f, request: v }))} disabled={form.unlimited} />
          </label>
          <div className="space-y-2">
            <Label htmlFor="ceiling">Approve up to (AED)</Label>
            <Input id="ceiling" type="number" min={1} step="1" value={form.ceiling} disabled={form.unlimited || form.settle} placeholder="No approval authority" onChange={(e) => setForm((f) => ({ ...f, ceiling: e.target.value }))} />
            <p className="text-xs text-muted-foreground">Decides budgets and reallocations up to this AED amount; anything above routes to the tier above.</p>
          </div>
          <label className="flex items-start justify-between gap-4">
            <span>
              <span className="font-medium">Unlimited approver</span>
              <span className="block text-xs text-muted-foreground">The final tier. Cannot also hold the request grant.</span>
            </span>
            <Switch checked={form.unlimited} disabled={form.settle} onCheckedChange={(v) => setForm((f) => ({ ...f, unlimited: v, ...(v ? { request: false, ceiling: "" } : {}) }))} />
          </label>
          <label className="flex items-start justify-between gap-4">
            <span>
              <span className="font-medium">Settle</span>
              <span className="block text-xs text-muted-foreground">Checks and signs off a closed budget; never decides an approval, so it cannot sit beside a ceiling.</span>
            </span>
            <Switch checked={form.settle} onCheckedChange={(v) => setForm((f) => ({ ...f, settle: v, ...(v ? { unlimited: false, ceiling: "" } : {}) }))} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save grants
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
