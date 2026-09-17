"use client";

/**
 * Settings → Users: what one team member may do in Budget & Procurement.
 *
 * ROLES ARE THE MECHANISM NOW (plan §6). The dialog picks the custom roles
 * tagged on the person and sets the AED authority that goes with approving.
 * The amount stays on the PERSON rather than on the role (D3), because two
 * people holding the same "PO Approver" approve to different limits.
 *
 * THE TWO OLD SWITCHES ARE STILL HERE, under "Earlier grants", and that is
 * deliberate rather than leftover. Until the predicates drop their legacy arm
 * (§10a) `procurementRequest` and `procurementSettle` still grant access on
 * their own, so hiding them would leave the people who hold them today with
 * access nobody can see or take away. They go when the columns do.
 *
 * SUPER_ADMIN only, and the API re-checks everything here: an admin kept out of
 * approving must not be able to grant it to themselves.
 *
 * In core rather than in the module because the Settings page would otherwise
 * need an exemption on the one-way import boundary.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { separationConflicts } from "@/lib/permissions/separation";
import {
  permissionSetKeys,
  usePermissionSets,
  useUserPermissionSets,
} from "@/hooks/use-permission-sets";

export interface ProcurementGrantTarget {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  procurementRequest?: boolean;
  procurementApproveCeilingAed?: number | null;
  procurementApproveUnlimited?: boolean;
  procurementSettle?: boolean;
  /** Who stands in after 48 hours without a decision; null = the next tier. */
  procurementDelegateUserId?: string | null;
}

/** The Select cannot hold an empty value, so "the next tier" travels as this sentinel. */
const NEXT_TIER = "__next_tier__";

function personName(u: ProcurementGrantTarget): string {
  return `${u.firstName} ${u.lastName}`.trim() || u.email;
}

export function hasAnyGrant(u: ProcurementGrantTarget): boolean {
  return !!u.procurementRequest || !!u.procurementApproveUnlimited || !!u.procurementSettle || (u.procurementApproveCeilingAed ?? 0) > 0;
}

/**
 * Does this person have procurement access by ANY route: a legacy grant, or a
 * custom role tagged on them?
 *
 * Deliberately NOT folded into `hasAnyGrant`. That predicate answers "does this
 * person hold one of the four GRANTS", which other callers rely on meaning
 * exactly that; widening it in place would change their answer silently. Roles
 * became the mechanism in plan §6, so the Team list needs the broader question,
 * and asking it separately keeps both available.
 *
 * `permissionSetCount` is absent for somebody holding none, so the `?? 0` is
 * where that default lives.
 */
export function hasProcurementAccess(
  u: ProcurementGrantTarget & { permissionSetCount?: number },
): boolean {
  return hasAnyGrant(u) || (u.permissionSetCount ?? 0) > 0;
}

export function ProcurementGrantsDialog({
  user,
  approvers = [],
  onClose,
  onSaved,
}: {
  user: ProcurementGrantTarget | null;
  /** Team members who can approve, the delegate candidates. */
  approvers?: ProcurementGrantTarget[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const open = !!user;
  const { data: allSets = [] } = usePermissionSets({ enabled: open });
  const { data: held } = useUserPermissionSets(user?.id ?? null);

  const [form, setForm] = useState({ request: false, ceiling: "", unlimited: false, settle: false, delegate: NEXT_TIER });
  const [roleIds, setRoleIds] = useState<string[]>([]);
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
        delegate: user.procurementDelegateUserId ?? NEXT_TIER,
      });
    }
  }
  // The person's stored roles arrive after the dialog opens, so they seed on
  // arrival rather than on the open transition above.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (held && user && seededFor !== user.id) {
    setSeededFor(user.id);
    setRoleIds(held.permissionSetIds);
  }

  const bandedApprover = !form.unlimited && !form.settle && form.ceiling.trim() !== "";
  const pickedSets = allSets.filter((s) => roleIds.includes(s.id));
  const unionPermissions = [...new Set(pickedSets.flatMap((s) => s.permissions.map((p) => p.permission)))];

  // Checked on the RESULTING picture before either request goes out: the save
  // is two calls (grants, then roles) and neither order is safe for every
  // change, so the combination is settled here and the server is the backstop.
  const conflicts = separationConflicts({
    permissions: unionPermissions,
    approvalUnlimited: form.unlimited,
    legacyRequest: form.request,
    legacySettle: form.settle,
  });

  function toggleRole(id: string, on: boolean) {
    setRoleIds((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)));
  }

  async function save() {
    if (!user) return;
    const ceiling = form.ceiling.trim() === "" ? null : Number(form.ceiling);
    if (ceiling !== null && (!Number.isFinite(ceiling) || ceiling <= 0)) {
      toast.error("The approval ceiling must be a positive AED amount, or empty for none.");
      return;
    }
    if (conflicts.length > 0) {
      toast.error(conflicts[0].message);
      return;
    }
    setSaving(true);
    try {
      // GRANTS FIRST, then roles. A change that lowers someone's authority and
      // gives them a raising role only passes in this order; the client-side
      // check above is what keeps the other direction from getting here.
      const grantRes = await fetch(`/api/organization/users/${user.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          procurementRequest: form.request,
          procurementApproveCeilingAed: form.unlimited ? null : ceiling,
          procurementApproveUnlimited: form.unlimited,
          procurementSettle: form.settle,
          // Only a banded approver has a delegate (the final approver has no
          // standby, and a delegate for someone who cannot approve means nothing),
          // so anything else clears it rather than leaving a stale one stored.
          procurementDelegateUserId: bandedApprover && form.delegate !== NEXT_TIER ? form.delegate : null,
        }),
      });
      if (!grantRes.ok) {
        const body = await grantRes.json().catch(() => null);
        toast.error(body?.error || "Couldn't save the procurement grants");
        return;
      }

      const roleRes = await fetch(`/api/organization/users/${user.id}/permission-sets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissionSetIds: roleIds }),
      });
      if (!roleRes.ok) {
        const body = await roleRes.json().catch(() => null);
        // The limits saved and the roles did not, so say so rather than let the
        // admin believe nothing changed.
        toast.error(`${body?.error || "Couldn't save the roles"} The approval limit was saved; the roles were not.`);
        qc.invalidateQueries({ queryKey: permissionSetKeys.all });
        onSaved();
        return;
      }

      toast.success(`Procurement access saved for ${personName(user)}.`);
      qc.invalidateQueries({ queryKey: permissionSetKeys.all });
      onSaved();
      onClose();
    } catch (error) {
      console.error("Error saving procurement access:", error);
      toast.error("Couldn't save the procurement access");
    } finally {
      setSaving(false);
    }
  }

  const name = user ? personName(user) : "";
  const candidates = approvers.filter((a) => a.id !== user?.id);
  const storedNotListed = form.delegate !== NEXT_TIER && !candidates.some((a) => a.id === form.delegate);
  const legacyHeld = form.request || form.settle;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Procurement access</DialogTitle>
          <DialogDescription>
            {/* One expression, not text after an interpolation: JSX trims the
                leading space of a text node that runs to the end of the line. */}
            {`What ${name} may do in Budget & Procurement, on top of their role. Reading needs no grant. Takes effect within five minutes; anything that moves money is re-checked as they act.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label>Roles</Label>
            {allSets.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No roles yet. Create one under Settings → Roles, then tag it here.
              </p>
            ) : (
              <div className="grid gap-x-6 gap-y-3 rounded-lg border p-3 sm:grid-cols-2">
                {allSets.map((set) => (
                  <label key={set.id} className="flex items-start gap-3 cursor-pointer">
                    <Checkbox
                      className="mt-0.5"
                      checked={roleIds.includes(set.id)}
                      onCheckedChange={(v) => toggleRole(set.id, v === true)}
                    />
                    <span className="min-w-0">
                      <span className="text-sm font-medium block">{set.name}</span>
                      {set.description && (
                        <span className="text-xs text-muted-foreground block">{set.description}</span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {conflicts.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {conflicts.map((c) => (
                <p key={c.code}>{c.message}</p>
              ))}
            </div>
          )}

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ceiling">Approve up to (AED)</Label>
              <Input id="ceiling" type="number" min={1} step="1" value={form.ceiling} disabled={form.unlimited || form.settle} placeholder="No approval authority" onChange={(e) => setForm((f) => ({ ...f, ceiling: e.target.value }))} />
              <p className="text-xs text-muted-foreground">
                How much this person may decide. A role that grants approving does nothing until an amount is set here.
              </p>
            </div>

            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="font-medium">Unlimited approver</span>
                <span className="block text-xs text-muted-foreground">The final tier. Cannot also raise requests.</span>
              </span>
              <Switch checked={form.unlimited} disabled={form.settle} onCheckedChange={(v) => setForm((f) => ({ ...f, unlimited: v, ...(v ? { request: false, ceiling: "" } : {}) }))} />
            </label>

            {bandedApprover && (
              <div className="space-y-2">
                <Label htmlFor="delegate">Stands in after 48 hours</Label>
                <Select value={form.delegate} onValueChange={(v) => setForm((f) => ({ ...f, delegate: v }))}>
                  <SelectTrigger id="delegate" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NEXT_TIER}>The next tier (default)</SelectItem>
                    {storedNotListed && <SelectItem value={form.delegate}>Someone who can no longer approve</SelectItem>}
                    {candidates.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {`${personName(a)} · ${a.procurementApproveUnlimited ? "final approver" : `up to AED ${Number(a.procurementApproveCeilingAed ?? 0).toLocaleString("en-US")}`}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  When this person has not decided a request for 48 hours, the delegate can decide it too; at 96 hours it moves to the next tier. A request above the delegate&apos;s ceiling goes to the next tier instead.
                </p>
              </div>
            )}
          </div>

          <details open={legacyHeld} className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              {legacyHeld ? "Earlier grants (in use)" : "Earlier grants"}
            </summary>
            <p className="text-xs text-muted-foreground mt-2 mb-3">
              The switches used before roles existed. They still work, so anyone holding one keeps their access; give a
              role instead and switch these off.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex items-start justify-between gap-4">
                <span>
                  <span className="font-medium text-sm">Request</span>
                  <span className="block text-xs text-muted-foreground">Raise purchase requests against a budget line.</span>
                </span>
                <Switch checked={form.request} onCheckedChange={(v) => setForm((f) => ({ ...f, request: v }))} disabled={form.unlimited} />
              </label>
              <label className="flex items-start justify-between gap-4">
                <span>
                  <span className="font-medium text-sm">Settle</span>
                  <span className="block text-xs text-muted-foreground">Checks and signs off a closed budget; never decides an approval.</span>
                </span>
                <Switch checked={form.settle} onCheckedChange={(v) => setForm((f) => ({ ...f, settle: v, ...(v ? { unlimited: false, ceiling: "" } : {}) }))} />
              </label>
            </div>
          </details>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || conflicts.length > 0}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
