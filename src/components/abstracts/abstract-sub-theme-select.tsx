"use client";

import { useAbstractThemes } from "@/hooks/use-api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The second dropdown: narrows the chosen theme.
 *
 * Renders NOTHING until a theme is chosen, and nothing when that theme has no
 * sub-themes — which is what keeps the feature invisible on events that do not
 * use it. Reads the same `useAbstractThemes` query as the theme picker (the
 * children ride nested in that response), so there is no second request and the
 * two dropdowns cannot disagree about what exists.
 */

interface ThemeWithSubs {
  id: string;
  subThemes?: Array<{ id: string; name: string }>;
}

/** The chosen theme's sub-themes, or an empty list. Exported so a form can ask
 *  "is a sub-theme required here?" without re-deriving the lookup. */
export function subThemesOf(
  themes: unknown,
  themeId: string | null | undefined,
): Array<{ id: string; name: string }> {
  if (!themeId || !Array.isArray(themes)) return [];
  const theme = (themes as ThemeWithSubs[]).find((t) => t.id === themeId);
  return theme?.subThemes ?? [];
}

interface AbstractSubThemeSelectProps {
  eventId: string;
  /** The currently chosen THEME — the sub-theme list depends on it. */
  themeId?: string | null;
  value?: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}

export function AbstractSubThemeSelect({
  eventId,
  themeId,
  value,
  onChange,
  disabled,
}: AbstractSubThemeSelectProps) {
  const { data: themes = [], isLoading } = useAbstractThemes(eventId);
  const subThemes = subThemesOf(themes, themeId);

  if (isLoading || subThemes.length === 0) return null;

  return (
    <Select value={value ?? undefined} onValueChange={(v) => onChange(v)} disabled={disabled}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select a sub-theme" />
      </SelectTrigger>
      <SelectContent>
        {subThemes.map((st) => (
          <SelectItem key={st.id} value={st.id}>
            {st.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
