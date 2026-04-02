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
} from "@/hooks/use-api";

interface AbstractThemesSettingsProps {
  eventId: string;
}

interface Theme {
  id: string;
  name: string;
  sortOrder: number;
  _count: { abstracts: number };
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
        Themes let submitters categorise their abstracts. Each abstract can belong to one theme.
      </p>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (themes as Theme[]).length === 0 ? (
        <p className="text-sm text-muted-foreground italic">No themes configured yet.</p>
      ) : (
        <ul className="space-y-2">
          {(themes as Theme[]).map((theme) => (
            <li key={theme.id} className="flex items-center gap-2 p-2 rounded-lg border bg-card">
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
