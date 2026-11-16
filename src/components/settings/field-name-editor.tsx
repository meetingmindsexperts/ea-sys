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

/** The field itself, whatever it is called now: what the two editors are told apart by. */
const FIELD_WORD: Record<keyof FieldLabels, string> = { role: "Role", specialty: "Specialty" };

/**
 * What one field is called on every form and screen (step 1d of
 * docs/ORG_FIELDS_PLAN.md), for example "Profession" for Role. Shown at the
 * top of that field's own card, beside its answers. Title keeps its name.
 * File exports keep their usual column headings, so a file still reads back.
 */
export function FieldNameEditor({ field }: { field: keyof FieldLabels }) {
  const { data: saved, refetch } = useFieldLabels();
  const save = useSaveFieldLabels();
  // null = no unsaved edit. `from` is this field's name when the edit began,
  // sent with the save so a stale one is refused. Only this field is sent: the
  // other field's card saves its own name (review of 24f390fb: a save that
  // carried both was refused as stale right after the other card had saved).
  const [edited, setEdited] = useState<{ name: string; from: string } | null>(null);
  // Before the names arrive the input is shown empty and locked, so the card
  // does not jump when they do (review of 24f390fb).
  const current = saved?.[field] ?? "";
  const name = edited?.name ?? current;
  const from = edited?.from ?? current;
  const dirty = saved !== undefined && edited !== null && name.trim() !== from;
  const id = `field-label-${field}`;

  const onSave = async () => {
    try {
      await save.mutateAsync({ labels: { [field]: name.trim() }, expected: { [field]: from } });
      setEdited(null);
      toast.success("Name saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
      if (e instanceof ApiError && e.code === "LABELS_CHANGED") {
        setEdited(null);
        refetch();
      }
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Name on forms</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          // Two of these sit side by side: each says whose name it is (review of 24f390fb).
          aria-label={`${FIELD_WORD[field]}: name on forms`}
          value={name}
          maxLength={MAX_PERSON_FIELD_LABEL}
          disabled={saved === undefined || save.isPending}
          onChange={(e) => setEdited({ name: e.target.value, from })}
        />
        <Button variant="outline" aria-label={`Save the name of ${FIELD_WORD[field]}`} onClick={onSave} disabled={!dirty || !name.trim() || save.isPending}>
          <Save className="mr-2 h-4 w-4" />
          {save.isPending ? "Saving..." : "Save name"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">File exports keep the usual column heading, so a file still reads back in.</p>
    </div>
  );
}
