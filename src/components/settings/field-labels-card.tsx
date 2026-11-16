"use client";

import { useState } from "react";
import { Save, Type } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFieldLabels, useSaveFieldLabels, type FieldLabels } from "@/hooks/use-person-fields";
import { ApiError } from "@/lib/api-fetch";
import { MAX_PERSON_FIELD_LABEL } from "@/lib/person-fields";

const ROWS: { key: keyof FieldLabels; usual: string }[] = [
  { key: "role", usual: "Role" },
  { key: "specialty", usual: "Specialty" },
];

/**
 * What the Role and Specialty fields are called on every form and screen
 * (step 1d of docs/ORG_FIELDS_PLAN.md), for example "Profession". Title keeps
 * its name. File exports keep their fixed column headings.
 */
export function FieldLabelsCard() {
  const { data: saved, isError, refetch } = useFieldLabels();
  const save = useSaveFieldLabels();
  const [edited, setEdited] = useState<{ labels: FieldLabels; base: FieldLabels } | null>(null);
  const labels = edited?.labels ?? saved;
  const base = edited?.base ?? saved;
  const dirty = !!labels && !!base && (labels.role.trim() !== base.role || labels.specialty.trim() !== base.specialty);
  const blank = !!labels && (!labels.role.trim() || !labels.specialty.trim());

  const onSave = async () => {
    if (!labels || !base) return;
    try {
      await save.mutateAsync({ labels: { role: labels.role.trim(), specialty: labels.specialty.trim() }, expected: base });
      setEdited(null);
      toast.success("Field names saved");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
      if (e instanceof ApiError && e.code === "LABELS_CHANGED") {
        setEdited(null);
        refetch();
      }
    }
  };

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
            <Type className="h-4 w-4" />
          </div>
          Field names
        </CardTitle>
        <CardDescription>
          What Role and Specialty are called on every form and screen, for example &quot;Profession&quot;. Title keeps its name.
          File exports keep their usual column headings, so a file still reads back in.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isError && !saved && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
            <p className="text-sm text-destructive">The names could not be loaded, so they cannot be edited yet.</p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              Try again
            </Button>
          </div>
        )}
        {labels &&
          ROWS.map((row) => (
            <div key={row.key} className="grid grid-cols-[8rem_1fr] items-center gap-3">
              <Label htmlFor={`field-label-${row.key}`} className="text-muted-foreground">
                {row.usual}
              </Label>
              <Input
                id={`field-label-${row.key}`}
                value={labels[row.key]}
                maxLength={MAX_PERSON_FIELD_LABEL}
                disabled={save.isPending}
                onChange={(e) => base && setEdited({ labels: { ...labels, [row.key]: e.target.value }, base })}
              />
            </div>
          ))}
        {labels && (
          <div className="flex justify-end gap-2">
            {dirty && (
              <Button variant="ghost" onClick={() => setEdited(null)} disabled={save.isPending}>
                Discard changes
              </Button>
            )}
            <Button onClick={onSave} disabled={!dirty || blank || save.isPending}>
              <Save className="mr-2 h-4 w-4" />
              {save.isPending ? "Saving..." : "Save names"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
