"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { CountrySelect } from "@/components/ui/country-select";
import { Plus, Trash2, Users } from "lucide-react";
import { type CoAuthor, EMPTY_CO_AUTHOR, MAX_CO_AUTHORS } from "@/lib/abstract-coauthors";

interface CoAuthorFieldsProps {
  value: CoAuthor[];
  onChange: (rows: CoAuthor[]) => void;
  disabled?: boolean;
}

/**
 * Repeatable co-author editor (name*, email, phone, job title, organization,
 * country). Shared by the abstract submit + edit forms.
 */
export function CoAuthorFields({ value, onChange, disabled = false }: CoAuthorFieldsProps) {
  const rows = value ?? [];

  const update = (i: number, field: keyof CoAuthor, v: string) => {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, [field]: v } : r)));
  };
  const add = () => {
    if (rows.length >= MAX_CO_AUTHORS) return;
    onChange([...rows, { ...EMPTY_CO_AUTHOR }]);
  };
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Users className="h-4 w-4 text-muted-foreground" />
          Co-authors {rows.length > 0 && <span className="text-muted-foreground">({rows.length})</span>}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={add}
          disabled={disabled || rows.length >= MAX_CO_AUTHORS}
        >
          <Plus className="h-4 w-4 mr-1.5" /> Add co-author
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No co-authors added. The submitting author is captured automatically — add any
          additional authors here.
        </p>
      ) : (
        <div className="space-y-4">
          {rows.map((row, i) => (
            <div key={i} className="rounded-lg border p-4 space-y-3 relative">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Co-author {i + 1}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-red-500 hover:text-red-600 hover:bg-red-50"
                  onClick={() => remove(i)}
                  disabled={disabled}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Full name *</Label>
                  <Input
                    value={row.name}
                    onChange={(e) => update(i, "name", e.target.value)}
                    placeholder="Dr. Jane Doe"
                    required
                    disabled={disabled}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Email</Label>
                  <Input
                    type="email"
                    value={row.email ?? ""}
                    onChange={(e) => update(i, "email", e.target.value)}
                    placeholder="jane@example.com"
                    disabled={disabled}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Phone</Label>
                  <Input
                    value={row.phone ?? ""}
                    onChange={(e) => update(i, "phone", e.target.value)}
                    disabled={disabled}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Job title</Label>
                  <Input
                    value={row.jobTitle ?? ""}
                    onChange={(e) => update(i, "jobTitle", e.target.value)}
                    disabled={disabled}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Organization</Label>
                  <Input
                    value={row.organization ?? ""}
                    onChange={(e) => update(i, "organization", e.target.value)}
                    disabled={disabled}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Country</Label>
                  <CountrySelect
                    value={row.country ?? ""}
                    onChange={(v) => update(i, "country", v)}
                    disabled={disabled}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
