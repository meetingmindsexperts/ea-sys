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
import { PERMISSION_CATALOGUE, PERMISSION_GROUPS } from "@/lib/permissions/catalogue";
import { separationConflicts } from "@/lib/permissions/separation";
import { permissionSetKeys, usePermissionSets, type PermissionSetRow } from "@/hooks/use-permission-sets";

/** `"new"` opens the dialog empty; a row opens it on that role. */
type Editing = PermissionSetRow | "new" | null;

export function PermissionSetsCard() {
  const qc = useQueryClient();
  const { data: sets = [], isLoading } = usePermissionSets({ includeArchived: true });
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
              Roles
            </CardTitle>
            <CardDescription>
              Named sets of permissions you tag onto people, on top of their role. Someone holding two roles can do
              everything both allow.
            </CardDescription>
          </div>
          <Button onClick={() => setEditing("new")}>
            <Plus className="mr-2 h-4 w-4" />
            New role
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
          <p className="text-sm text-muted-foreground">No roles yet. Create one to get started.</p>
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
  editing,
  onClose,
  onSaved,
}: {
  editing: Editing;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({ name: "", description: "", permissions: [] as string[] });
  const [saving, setSaving] = useState(false);
  // Seed on every closed -> open transition (React's previous-render pattern,
  // not an effect), so the boxes show the role being edited rather than
  // whichever one was opened last.
  const [prevKey, setPrevKey] = useState<string | null>(null);
  const key = editing === null ? null : editing === "new" ? "new" : editing.id;
  if (key !== prevKey) {
    setPrevKey(key);
    if (editing === "new") setForm({ name: "", description: "", permissions: [] });
    else if (editing)
      setForm({
        name: editing.name,
        description: editing.description ?? "",
        permissions: editing.permissions.map((p) => p.permission),
      });
  }

  // Live, from the SAME pure function the server refuses with, so the screen
  // and the boundary can never disagree about what is allowed.
  const conflicts = separationConflicts({ permissions: form.permissions });

  function toggle(permission: string, on: boolean) {
    setForm((f) => ({
      ...f,
      permissions: on ? [...f.permissions, permission] : f.permissions.filter((p) => p !== permission),
    }));
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
            permissions: form.permissions,
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
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing === "new" ? "New role" : "Edit role"}</DialogTitle>
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

          <div className="space-y-4">
            {PERMISSION_GROUPS.map((group) => {
              const items = PERMISSION_CATALOGUE.filter((p) => p.group === group);
              if (items.length === 0) return null;
              return (
                <div key={group} className="rounded-lg border p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">{group}</p>
                  <div className="space-y-2">
                    {items.map((item) => (
                      <label key={item.key} className="flex items-start gap-3 cursor-pointer">
                        <Checkbox
                          className="mt-0.5"
                          checked={form.permissions.includes(item.key)}
                          onCheckedChange={(v) => toggle(item.key, v === true)}
                        />
                        <span className="min-w-0">
                          <span className="text-sm font-medium block">{item.label}</span>
                          <span className="text-xs text-muted-foreground block">{item.description}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="text-xs text-muted-foreground">
            The amount somebody may approve is set on the person, not here: two people holding the same approving role
            can have different limits.
          </p>
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
