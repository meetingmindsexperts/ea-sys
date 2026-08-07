"use client";

import { useState } from "react";
import { Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useAbstractThemes,
  useCreateAbstractTheme,
  useUpdateAbstractTheme,
  useDeleteAbstractTheme,
  useCreateAbstractSubTheme,
  useUpdateAbstractSubTheme,
  useDeleteAbstractSubTheme,
} from "@/hooks/use-api";

interface AbstractThemesSettingsProps {
  eventId: string;
}

interface SubTheme {
  id: string;
  name: string;
  sortOrder: number;
}

interface Theme {
  id: string;
  name: string;
  sortOrder: number;
  _count: { abstracts: number };
  /** Nested in the themes response — see the abstract-themes GET. */
  subThemes?: SubTheme[];
}

export function AbstractThemesSettings({ eventId }: AbstractThemesSettingsProps) {
  const { data: themes = [], isLoading } = useAbstractThemes(eventId);
  const createTheme = useCreateAbstractTheme(eventId);
  const updateTheme = useUpdateAbstractTheme(eventId);
  const deleteTheme = useDeleteAbstractTheme(eventId);

  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    try {
      await createTheme.mutateAsync({ name });
      setNewName("");
      toast.success(`Theme "${name}" created`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to create theme";
      toast.error(msg);
    }
  }

  async function handleUpdate(themeId: string) {
    const name = editingName.trim();
    if (!name) return;
    try {
      await updateTheme.mutateAsync({ themeId, name });
      setEditingId(null);
      toast.success("Theme updated");
    } catch {
      toast.error("Failed to update theme");
    }
  }

  async function handleDelete(theme: Theme) {
    if (theme._count.abstracts > 0) {
      toast.error(`Cannot delete: ${theme._count.abstracts} abstract(s) are using this theme`);
      return;
    }
    try {
      await deleteTheme.mutateAsync(theme.id);
      toast.success(`Theme "${theme.name}" deleted`);
    } catch {
      toast.error("Failed to delete theme");
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Themes let submitters categorise their abstracts. Each abstract belongs to one theme, and
        optionally to one sub-theme beneath it. Add sub-themes only where you want the extra
        breakdown — a theme with none is submitted exactly as before, and where a theme HAS
        sub-themes the submitter must choose one.
      </p>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (themes as Theme[]).length === 0 ? (
        <p className="text-sm text-muted-foreground italic">No themes configured yet.</p>
      ) : (
        <ul className="space-y-2">
          {(themes as Theme[]).map((theme) => (
            <li key={theme.id} className="rounded-lg border bg-card">
              <div className="flex items-center gap-2 p-2">
              {editingId === theme.id ? (
                <>
                  <Input
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleUpdate(theme.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="h-7 text-sm flex-1"
                    autoFocus
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    onClick={() => handleUpdate(theme.id)}
                    disabled={updateTheme.isPending}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    onClick={() => setEditingId(null)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-sm">{theme.name}</span>
                  {theme._count.abstracts > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {theme._count.abstracts} abstract{theme._count.abstracts !== 1 ? "s" : ""}
                    </span>
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0"
                    onClick={() => { setEditingId(theme.id); setEditingName(theme.name); }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
                    onClick={() => handleDelete(theme)}
                    disabled={deleteTheme.isPending}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
              </div>
              <SubThemeRows eventId={eventId} theme={theme} />
            </li>
          ))}
        </ul>
      )}

      {/* Add new theme */}
      <div className="flex gap-2">
        <Input
          placeholder="New theme name…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
          className="flex-1"
        />
        <Button
          onClick={handleCreate}
          disabled={!newName.trim() || createTheme.isPending}
          size="sm"
        >
          <Plus className="h-4 w-4 mr-1" />
          Add Theme
        </Button>
      </div>
    </div>
  );
}

/**
 * The sub-themes under one theme: an indented list with rename, delete and an
 * inline add.
 *
 * A child component so each theme keeps its own add/edit state — one shared
 * piece of state across the list would put the text you are typing under theme
 * A into the input under theme B.
 */
function SubThemeRows({ eventId, theme }: { eventId: string; theme: Theme }) {
  const createSub = useCreateAbstractSubTheme(eventId);
  const updateSub = useUpdateAbstractSubTheme(eventId);
  const deleteSub = useDeleteAbstractSubTheme(eventId);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const subThemes = theme.subThemes ?? [];

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    try {
      await createSub.mutateAsync({ themeId: theme.id, name });
      setNewName("");
      toast.success(`Sub-theme "${name}" added`);
    } catch (err) {
      // The server distinguishes a duplicate (409) from a real failure; surface
      // its message rather than a generic one so the operator knows which.
      toast.error(err instanceof Error ? err.message : "Failed to add sub-theme");
    }
  }

  async function handleRename(subThemeId: string) {
    const name = editingName.trim();
    if (!name) return;
    try {
      await updateSub.mutateAsync({ themeId: theme.id, subThemeId, name });
      setEditingId(null);
      toast.success("Sub-theme updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update sub-theme");
    }
  }

  async function handleDelete(sub: SubTheme) {
    if (!confirm(`Delete sub-theme "${sub.name}"?`)) return;
    try {
      await deleteSub.mutateAsync({ themeId: theme.id, subThemeId: sub.id });
      toast.success("Sub-theme deleted");
    } catch (err) {
      // In-use is refused server-side with a count, so the operator is told how
      // many abstracts to reassign rather than just "failed".
      toast.error(err instanceof Error ? err.message : "Failed to delete sub-theme");
    }
  }

  return (
    <div className="border-t bg-muted/20 px-2 py-2 pl-6 space-y-1.5">
      {subThemes.length === 0 && (
        <p className="text-xs text-muted-foreground italic">No sub-themes.</p>
      )}
      {subThemes.map((sub) => (
        <div key={sub.id} className="flex items-center gap-2">
          {editingId === sub.id ? (
            <>
              <Input
                value={editingName}
                onChange={(e) => setEditingName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRename(sub.id);
                  if (e.key === "Escape") setEditingId(null);
                }}
                className="h-7 text-sm flex-1"
                autoFocus
              />
              <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => handleRename(sub.id)} disabled={updateSub.isPending}>
                <Check className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => setEditingId(null)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </>
          ) : (
            <>
              <span className="flex-1 text-xs">{sub.name}</span>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={() => { setEditingId(sub.id); setEditingName(sub.name); }}
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
                onClick={() => handleDelete(sub)}
                disabled={deleteSub.isPending}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </>
          )}
        </div>
      ))}
      <div className="flex gap-2 pt-0.5">
        <Input
          placeholder="New sub-theme…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
          className="h-7 text-xs flex-1"
        />
        <Button onClick={handleAdd} disabled={!newName.trim() || createSub.isPending} size="sm" variant="outline" className="h-7 text-xs">
          <Plus className="h-3 w-3 mr-1" /> Add
        </Button>
      </div>
    </div>
  );
}
