"use client";

/**
 * Give one person custom roles (custom roles Phase 5). Roles add to the
 * person's base role and never replace it; the server refuses a role wider
 * than the assigner's own access, and changing your own roles.
 *
 * Shown when custom roles are switched on for everything. Where only Budgets
 * is on, the Procurement access dialog does this beside the approval limits.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { permissionSetKeys, usePermissionSets, useUserPermissionSets } from "@/hooks/use-permission-sets";

interface Person {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export function UserRolesDialog({ user, onClose, onSaved }: { user: Person | null; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient();
  const open = user !== null;
  const { data: roles = [], isLoading } = usePermissionSets({ enabled: open });
  const { data: held } = useUserPermissionSets(user?.id ?? null);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [prevUser, setPrevUser] = useState<string | null>(null);
  if ((user?.id ?? null) !== prevUser) {
    setPrevUser(user?.id ?? null);
    setPicked(null);
  }
  const selected = picked ?? held?.permissionSetIds ?? [];
  const name = user ? `${user.firstName} ${user.lastName}`.trim() || user.email : "";

  async function save() {
    if (!user) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/organization/users/${user.id}/permission-sets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissionSetIds: selected }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error || "Couldn't save the roles");
        return;
      }
      toast.success(`Roles saved for ${name}. They apply within five minutes.`);
      qc.invalidateQueries({ queryKey: permissionSetKeys.all });
      onSaved();
      onClose();
    } catch (error) {
      console.error("user-roles-dialog:save-failed", error);
      toast.error("Couldn't save the roles");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Roles for {name}</DialogTitle>
          <DialogDescription>
            Each role adds what it grants to this person&apos;s base role. Nothing here takes access away.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />
          </div>
        ) : roles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No roles yet. Create one under Settings, Roles.</p>
        ) : (
          <div className="space-y-3 max-h-80 overflow-y-auto">
            {roles.map((role) => (
              <div key={role.id} className="flex items-start gap-3">
                <Checkbox
                  id={`user-role-${role.id}`}
                  className="mt-0.5"
                  checked={selected.includes(role.id)}
                  onCheckedChange={(v) =>
                    setPicked(v === true ? [...selected, role.id] : selected.filter((id) => id !== role.id))
                  }
                />
                <label htmlFor={`user-role-${role.id}`} className="cursor-pointer min-w-0">
                  <span className="text-sm font-medium block">{role.name}</span>
                  {role.description && <span className="text-xs text-muted-foreground block">{role.description}</span>}
                </label>
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || isLoading}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save roles
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
