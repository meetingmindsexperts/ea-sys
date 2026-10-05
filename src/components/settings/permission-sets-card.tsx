"use client";

/**
 * Settings → Roles (plan §6): the organisation's custom roles.
 *
 * A role is a NAME over a set of permission checkboxes, tagged onto people on
 * top of their base role. The four starter roles are seeded by the list
 * endpoint on first open, so this screen is never empty on a fresh
 * organisation.
 *
 * SUPER ADMIN ONLY, enforced by the API; the tab is simply not rendered for
 * anyone else. Roles are ARCHIVED, never deleted — archiving withdraws the
 * access from everyone holding the role at once, and a role that people held
 * has to stay resolvable from the audit trail.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Archive, Loader2, Pencil, Plus, ShieldCheck, Undo2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PERMISSION_CATALOGUE, PERMISSION_GROUPS, isGrantableKey } from "@/lib/permissions/catalogue";
import { roleWarnings, type DraftGrant } from "@/lib/permissions/role-warnings";
import { isProcurementKey, roleKind, type RoleKind } from "@/lib/permissions/role-kind";
import type { GrantScope } from "@/lib/permissions/system-roles";
import { useRuntimeFlags } from "@/components/runtime-flags";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { separationConflicts } from "@/lib/permissions/separation";
import { permissionSetKeys, usePermissionSets, type PermissionSetRow } from "@/hooks/use-permission-sets";

/** `"new"` opens the dialog empty; a row opens it on that role. */
type Editing = PermissionSetRow | "new" | null;

/** Copy per card (owner, Oct 5, 2026: two dialogs, two buttons). */
const CARD_COPY: Record<"procurement" | "custom", { title: string; description: string; cta: string; empty: string }> = {
  procurement: {
    title: "Budgets roles",
    description:
      "Budget & Procurement permissions you tag onto people, on top of their role. Assigned from a person's Procurement access, beside their approval limit.",
    cta: "New Budgets role",
    empty: "No Budgets roles yet.",
  },
  custom: {
    title: "Custom roles",
    description:
      "Permissions you add on top of a person's base role, anywhere in the app. Someone holding two roles can do everything both allow. Assigned from a person's Roles.",
    cta: "New role",
    empty: "No custom roles yet. Create one to give people more than their base role.",
  },
};

const keysOf = (set: PermissionSetRow) => set.permissions.map((p) => p.permission);

export function PermissionSetsCard({ kind }: { kind: "procurement" | "custom" }) {
  const qc = useQueryClient();
  const { data: allSets = [], isLoading } = usePermissionSets({ includeArchived: true });
  // This card's roles: Budgets ones here, everything else (mixed included) under Custom roles.
  const sets = allSets.filter((set) => {
    const k = roleKind(keysOf(set));
    return kind === "procurement" ? k === "procurement" : k !== "procurement";
  });
  const copy = CARD_COPY[kind];
  const [editing, setEditing] = useState<Editing>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: permissionSetKeys.all });

  async function toggleArchived(set: PermissionSetRow) {
    const archiving = set.archivedAt === null;
    if (
      archiving &&
      set.holderCount > 0 &&
      !confirm(
        `Archive "${set.name}"? ${set.holderCount} ${set.holderCount === 1 ? "person holds" : "people hold"} it, and they will lose everything it grants on their next click.`,
      )
    ) {
      return;
    }
    setBusyId(set.id);
    try {
      const res = await fetch(`/api/organization/permission-sets/${set.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: archiving }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error || "Couldn't change the role");
        return;
      }
      toast.success(archiving ? `"${set.name}" archived.` : `"${set.name}" restored.`);
      refresh();
    } catch (error) {
      console.error("Error archiving role:", error);
      toast.error("Couldn't change the role");
    } finally {
      setBusyId(null);
    }
  }

  const active = sets.filter((s) => s.archivedAt === null);
  const archived = sets.filter((s) => s.archivedAt !== null);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-amber-50 text-amber-600">
                <ShieldCheck className="h-4 w-4" />
              </div>
              {copy.title}
            </CardTitle>
            <CardDescription>{copy.description}</CardDescription>
          </div>
          <Button onClick={() => setEditing("new")}>
            <Plus className="mr-2 h-4 w-4" />
            {copy.cta}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading roles…
          </p>
        )}
        {!isLoading && sets.length === 0 && (
          <p className="text-sm text-muted-foreground">{copy.empty}</p>
        )}
        {[...active, ...archived].map((set) => (
          <div
            key={set.id}
            className={`rounded-lg border p-4 ${set.archivedAt ? "bg-muted/40 opacity-70" : "bg-card"}`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{set.name}</span>
                  {set.archivedAt && <Badge variant="secondary">Archived</Badge>}
                  <Badge variant="outline">{`${set.permissions.length} ${set.permissions.length === 1 ? "permission" : "permissions"}`}</Badge>
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Users className="h-3 w-3" />
                    {`${set.holderCount} ${set.holderCount === 1 ? "person" : "people"}`}
                  </span>
                </div>
                {set.description && <p className="text-sm text-muted-foreground mt-1">{set.description}</p>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!set.archivedAt && (
                  <Button variant="ghost" size="sm" title="Edit this role" onClick={() => setEditing(set)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyId === set.id}
                  title={set.archivedAt ? "Restore this role" : "Archive: everyone holding it loses what it grants"}
                  onClick={() => toggleArchived(set)}
                >
                  {busyId === set.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : set.archivedAt ? (
                    <Undo2 className="h-4 w-4" />
                  ) : (
                    <Archive className="h-4 w-4 text-amber-600" />
                  )}
                </Button>
              </div>
            </div>
          </div>
        ))}
      </CardContent>

      <PermissionSetDialog
        kind={editing && editing !== "new" ? roleKind(keysOf(editing)) : kind}
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          refresh();
          setEditing(null);
        }}
      />
    </Card>
  );
}

function PermissionSetDialog({
  kind,
  editing,
  onClose,
  onSaved,
}: {
  /** Which keys the dialog offers: Budgets keys, every other key, or all (a mixed role). */
  kind: RoleKind;
  editing: Editing;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({ name: "", description: "", permissions: [] as DraftGrant[] });
  const [search, setSearch] = useState("");
  // The keys a role may grant on this deployment: the Budgets keys, and every
  // key once custom roles are switched on (the server refuses anything else).
  const { customRolesEnabled } = useRuntimeFlags();
  const [saving, setSaving] = useState(false);
  // Seed on every closed -> open transition (React's previous-render pattern,
  // not an effect), so the boxes show the role being edited rather than
  // whichever one was opened last.
  const [prevKey, setPrevKey] = useState<string | null>(null);
  const key = editing === null ? null : editing === "new" ? "new" : editing.id;
  if (key !== prevKey) {
    setPrevKey(key);
    setSearch("");
    if (editing === "new") setForm({ name: "", description: "", permissions: [] });
    else if (editing)
      setForm({
        name: editing.name,
        description: editing.description ?? "",
        permissions: editing.permissions.map((p) => ({ permission: p.permission, scope: p.scope ?? null })),
      });
  }

  // Live, from the SAME pure function the server refuses with, so the screen
  // and the boundary can never disagree about what is allowed.
  const keys = form.permissions.map((g) => g.permission);
  const conflicts = separationConflicts({ permissions: keys });
  // Warnings, not refusals (plan §8.3): a deliberate role can still be saved.
  const warnings = roleWarnings(form.permissions);

  const grantable = PERMISSION_CATALOGUE.filter((p) => {
    if (!isGrantableKey(p.key, customRolesEnabled)) return false;
    if (kind === "procurement") return isProcurementKey(p.key);
    if (kind === "custom") return !isProcurementKey(p.key);
    return true;
  });
  const query = search.trim().toLowerCase();
  const shown = query
    ? grantable.filter((p) => `${p.label} ${p.description} ${p.group}`.toLowerCase().includes(query))
    : grantable;

  function toggle(permission: string, eventBound: boolean, on: boolean) {
    setForm((f) => ({
      ...f,
      // An event-bound key starts at every event; the scope picker narrows it.
      permissions: on
        ? [...f.permissions, { permission, scope: eventBound ? "ALL" : null }]
        : f.permissions.filter((p) => p.permission !== permission),
    }));
  }

  function setScope(permission: string, scope: GrantScope) {
    setForm((f) => ({ ...f, permissions: f.permissions.map((p) => (p.permission === permission ? { ...p, scope } : p)) }));
  }

  async function save() {
    if (editing === null) return;
    if (!form.name.trim()) {
      toast.error("Give the role a name.");
      return;
    }
    if (form.permissions.length === 0) {
      toast.error("Tick at least one permission, or the role grants nothing.");
      return;
    }
    if (conflicts.length > 0) {
      toast.error(conflicts[0].message);
      return;
    }
    setSaving(true);
    try {
      const isNew = editing === "new";
      const res = await fetch(
        isNew ? "/api/organization/permission-sets" : `/api/organization/permission-sets/${editing.id}`,
        {
          method: isNew ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: form.name.trim(),
            description: form.description.trim() || null,
            permissions: form.permissions.map((g) => (g.scope ? { permission: g.permission, scope: g.scope } : g.permission)),
            // The optimistic lock: a second admin's edit makes this stale and
            // the save is refused rather than silently overwriting theirs.
            ...(isNew ? {} : { expectedVersion: editing.version }),
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error || "Couldn't save the role");
        return;
      }
      toast.success(isNew ? `"${form.name.trim()}" created.` : `"${form.name.trim()}" saved.`);
      onSaved();
    } catch (error) {
      console.error("Error saving role:", error);
      toast.error("Couldn't save the role");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={editing !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing === "new" ? (kind === "procurement" ? "New Budgets role" : "New role") : kind === "procurement" ? "Edit Budgets role" : "Edit role"}
          </DialogTitle>
          <DialogDescription>
            Tick what this role lets someone do. People holding it pick the change up within five minutes; anything
            that moves money is re-checked at the moment they act.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="role-name">Name</Label>
              <Input
                id="role-name"
                value={form.name}
                maxLength={100}
                placeholder="PO Author"
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="role-description">Description (optional)</Label>
              <Textarea
                id="role-description"
                value={form.description}
                maxLength={1000}
                rows={2}
                placeholder="Who this is for, in one sentence."
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>
          </div>

          {conflicts.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {conflicts.map((c) => (
                <p key={c.code}>{c.message}</p>
              ))}
            </div>
          )}

          {warnings.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 space-y-1" role="status">
              {warnings.map((w) => (
                <p key={w.code}>{w.message}</p>
              ))}
            </div>
          )}

          {grantable.length > 12 && (
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${grantable.length} permissions`}
              aria-label="Search permissions"
            />
          )}

          <div className="space-y-4">
            {PERMISSION_GROUPS.map((group) => {
              const items = shown.filter((p) => p.group === group);
              if (items.length === 0) return null;
              return (
                <div key={group} className="rounded-lg border p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{group}</p>
                  <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                    {items.map((item) => {
                      const held = form.permissions.find((p) => p.permission === item.key);
                      return (
                        <div key={item.key} className="flex items-start gap-3">
                          <Checkbox
                            id={`perm-${item.key}`}
                            className="mt-0.5"
                            checked={!!held}
                            onCheckedChange={(v) => toggle(item.key, item.eventBound === true, v === true)}
                          />
                          <div className="min-w-0 flex-1 space-y-1.5">
                            <label htmlFor={`perm-${item.key}`} className="cursor-pointer">
                              <span className="text-sm font-medium block">{item.label}</span>
                              <span className="text-xs text-muted-foreground block">{item.description}</span>
                            </label>
                            {held && item.eventBound && (
                              <Select value={held.scope ?? "ALL"} onValueChange={(v) => setScope(item.key, v as GrantScope)}>
                                <SelectTrigger className="h-8 w-48 text-xs" aria-label={`Which events: ${item.label}`}>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="ALL">Every event</SelectItem>
                                  <SelectItem value="ASSIGNED">Events they are assigned to</SelectItem>
                                  <SelectItem value="WEBINAR">Webinars only</SelectItem>
                                </SelectContent>
                              </Select>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {kind !== "custom" && (
            <p className="text-xs text-muted-foreground">
              The amount somebody may approve is set on the person, not here: two people holding the same approving role
              can have different limits.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || conflicts.length > 0}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {editing === "new" ? "Create role" : "Save role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
