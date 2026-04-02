"use client";

import { useAbstractThemes } from "@/hooks/use-api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface AbstractThemeSelectProps {
  eventId: string;
  value?: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function AbstractThemeSelect({
  eventId,
  value,
  onChange,
  placeholder = "Select theme (optional)",
  disabled,
}: AbstractThemeSelectProps) {
  const { data: themes = [], isLoading } = useAbstractThemes(eventId);

  if (!isLoading && themes.length === 0) return null;

  return (
    <Select
      value={value ?? ""}
      onValueChange={(v) => onChange(v === "" ? null : v)}
      disabled={disabled || isLoading}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="">No theme</SelectItem>
        {themes.map((t: { id: string; name: string }) => (
          <SelectItem key={t.id} value={t.id}>
            {t.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
