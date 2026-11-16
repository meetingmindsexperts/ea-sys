"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFieldLabels, useSaveFieldLabels, type FieldLabels } from "@/hooks/use-person-fields";
import { ApiError } from "@/lib/api-fetch";
import { MAX_PERSON_FIELD_LABEL } from "@/lib/person-fields";

/**
 * What one field is called on every form and screen (step 1d of
 * docs/ORG_FIELDS_PLAN.md), for example "Profession" for Role. Shown at the
 * top of that field's own card, beside its answers. Title keeps its name.
 * File exports keep their usual column headings, so a file still reads back.
 */
export function FieldNameEditor({ field }: { field: keyof FieldLabels }) {
  const { data: saved } = useFieldLabels();
  const save = useSaveFieldLabels();
  // null = no unsaved edit. `base` is what the edit started from, sent with
  // the save so a stale one is refused.
  const [edited, setEdited] = useState<{ name: string; base: FieldLabels } | null>(null);
  if (!saved) return null;
  const name = edited?.name ?? saved[field];
  const base = edited?.base ?? saved;
  const dirty = edited !== null && name.trim() !== base[field];
  const id = `field-label-${field}`;

  const onSave = async () => {
    try {
      await save.mutateAsync({ labels: { ...base, [field]: name.trim() }, expected: base });
      setEdited(null);
      toast.success("Name saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
      if (e instanceof ApiError && e.code === "LABELS_CHANGED") setEdited(null);
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Name on forms</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={name}
          maxLength={MAX_PERSON_FIELD_LABEL}
          disabled={save.isPending}
          onChange={(e) => setEdited({ name: e.target.value, base })}
        />
        <Button variant="outline" onClick={onSave} disabled={!dirty || !name.trim() || save.isPending}>
          <Save className="mr-2 h-4 w-4" />
          {save.isPending ? "Saving..." : "Save name"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">File exports keep the usual column heading, so a file still reads back in.</p>
    </div>
  );
}
