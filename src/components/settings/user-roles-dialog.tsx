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
import { roleKind } from "@/lib/permissions/role-kind";
import { describePermission } from "@/lib/permissions/catalogue";
import { grantsOutsideAreas, keyArea } from "@/lib/permissions/key-areas";
import { systemRoleFor } from "@/lib/permissions/system-roles";

interface Person {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  /** The base role: a custom role can only add within its areas. */
  role: string;
}

const AREA_LABEL: Record<string, string> = {
  events: "event management",
  desk: "the registration desk",
  crm: "the CRM",
  hr: "HR",
  procurement: "Budgets",
  org: "organisation-wide access",
};

/**
 * Why a role cannot go to this person, or null when it fits. The same area
 * rule the server applies on save (409 OUTSIDE_AREAS); shown up front so the
 * admin is not told only after pressing Save (Oct 7, 2026: a Corporate role
 * failed silently on a Webinars user).
 */
export function roleMisfit(baseRole: string, permissions: { permission: string; scope?: "ALL" | "ASSIGNED" | "WEBINAR" | null }[]): string | null {
  const outside = grantsOutsideAreas(baseRole, permissions.map((p) => ({ permission: p.permission, scope: p.scope ?? null })));
  if (outside.length === 0) return null;
  const role = systemRoleFor(baseRole);
  // An area the base role already works in, at a narrower scope (an Onsite
  // desk on assigned events), is a wider SCOPE, not a new area: say so.
  const describe = (permission: string) => {
    const area = keyArea(permission);
    const label = AREA_LABEL[area] ?? area;
    const held = role?.areas.find((a) => a.area === area);
    if (!held) return label;
    const narrower = held.scope === "WEBINAR" ? "webinars" : "assigned ones";
    return `${label} on every event, not only ${narrower}`;
  };
  const areas = [...new Set(outside.map((g) => describe(g.permission)))];
  const base = role?.name ?? baseRole;
  const example = describePermission(outside[0].permission)?.label ?? outside[0].permission;
  const article = /^[aeiou]/i.test(base) ? "an" : "a";
  return `Doesn't fit ${article} ${base} base role: it adds ${areas.join(", ")} (for example "${example}"). Change their base role first, or use a narrower role.`;
}

export function UserRolesDialog({ user, onClose, onSaved }: { user: Person | null; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient();
  const open = user !== null;
  // Custom roles only: Budgets roles are assigned from Procurement access.
  // Saving sends every role held, so the Budgets ones are kept as they are.
  const { data: allRoles = [], isLoading } = usePermissionSets({ enabled: open });
  const roles = allRoles.filter((r) => roleKind(r.permissions.map((p) => p.permission)) !== "procurement");
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
        {isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label="Loading" />
          </div>
        )}
        {!isLoading && (roles.length === 0 ? (
          <p className="text-sm text-muted-foreground">No roles yet. Create one under Settings, Roles, Custom roles.</p>
        ) : (
          <div className="space-y-3 max-h-80 overflow-y-auto">
            {roles.map((role) => {
              const misfit = user ? roleMisfit(user.role, role.permissions) : null;
              const isHeld = selected.includes(role.id);
              // A held role that no longer fits can still be taken off.
              const blocked = misfit !== null && !isHeld;
              return (
                <div key={role.id} className="flex items-start gap-3">
                  <Checkbox
                    id={`user-role-${role.id}`}
                    className="mt-0.5"
                    checked={isHeld}
                    disabled={blocked}
                    aria-describedby={misfit ? `user-role-${role.id}-misfit` : undefined}
                    onCheckedChange={(v) =>
                      setPicked(v === true ? [...selected, role.id] : selected.filter((id) => id !== role.id))
                    }
                  />
                  <label htmlFor={`user-role-${role.id}`} className={`min-w-0 ${blocked ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}>
                    <span className="text-sm font-medium block">{role.name}</span>
                    {role.description && <span className="text-xs text-muted-foreground block">{role.description}</span>}
                    {misfit && (
                      <span id={`user-role-${role.id}-misfit`} className="text-xs text-amber-700 dark:text-amber-400 block mt-0.5">
                        {misfit}
                      </span>
                    )}
                  </label>
                </div>
              );
            })}
          </div>
        ))}
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
