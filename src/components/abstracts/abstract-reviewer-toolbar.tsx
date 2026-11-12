"use client";

/**
 * The bar above the abstracts list for whoever assigns reviewers
 * (Nov 12, 2026): two filters that make selecting quick (by theme, and "no
 * reviewer yet"), the three ways to choose abstracts (tick, Select by IDs,
 * paste the chair's sheet) and, once something is ticked, Assign and Remove.
 *
 * Presentational: the page owns the selection and the filters.
 */
import { ClipboardPaste, ListChecks, UserMinus, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Theme filter values that are not a theme id. */
export const ALL_THEMES = "all";
export const NO_THEME = "none";

export interface AbstractReviewerToolbarProps {
  themes: { id: string; name: string }[];
  themeFilter: string;
  onThemeFilter: (value: string) => void;
  unassignedOnly: boolean;
  onUnassignedOnly: (value: boolean) => void;
  shownCount: number;
  totalCount: number;
  /** Tick state of "select all shown": every shown row, some, or none. */
  shownSelection: "all" | "some" | "none";
  onToggleAllShown: () => void;
  selectedCount: number;
  /** Ticked abstracts the current filters hide. */
  selectedHiddenCount: number;
  onSelectByIds: () => void;
  onPasteSheet: () => void;
  onAssign: () => void;
  onRemove: () => void;
  onClear: () => void;
}

function checkedState(shownSelection: "all" | "some" | "none"): boolean | "indeterminate" {
  if (shownSelection === "all") return true;
  return shownSelection === "some" ? "indeterminate" : false;
}

export function AbstractReviewerToolbar(props: AbstractReviewerToolbarProps) {
  const filtered = props.shownCount !== props.totalCount;
  return (
    <div className="mb-4 space-y-3 rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="select-all-abstracts" className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            id="select-all-abstracts"
            checked={checkedState(props.shownSelection)}
            onCheckedChange={props.onToggleAllShown}
            disabled={props.shownCount === 0}
          />
          Select all {filtered ? `${props.shownCount} shown` : props.shownCount}
        </label>

        {props.themes.length > 0 && (
          <Select value={props.themeFilter} onValueChange={props.onThemeFilter}>
            <SelectTrigger className="h-8 w-[220px] text-xs" aria-label="Filter by theme">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_THEMES}>All themes</SelectItem>
              {props.themes.map((theme) => (
                <SelectItem key={theme.id} value={theme.id}>
                  {theme.name}
                </SelectItem>
              ))}
              <SelectItem value={NO_THEME}>No theme</SelectItem>
            </SelectContent>
          </Select>
        )}

        <label htmlFor="filter-no-reviewer" className="flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            id="filter-no-reviewer"
            checked={props.unassignedOnly}
            onCheckedChange={(checked) => props.onUnassignedOnly(checked === true)}
          />
          No reviewer yet
        </label>

        {filtered && (
          <span className="text-xs text-muted-foreground">
            Showing {props.shownCount} of {props.totalCount}
          </span>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={props.onSelectByIds}>
            <ListChecks className="mr-2 h-4 w-4" />
            Select by IDs
          </Button>
          <Button variant="outline" size="sm" onClick={props.onPasteSheet}>
            <ClipboardPaste className="mr-2 h-4 w-4" />
            Paste reviewer sheet
          </Button>
        </div>
      </div>

      {props.selectedCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <span className="text-sm font-medium">
            {props.selectedCount} selected
            {props.selectedHiddenCount > 0 && (
              <span className="font-normal text-muted-foreground"> ({props.selectedHiddenCount} not shown by the filters)</span>
            )}
          </span>
          <Button size="sm" onClick={props.onAssign}>
            <UserPlus className="mr-2 h-4 w-4" />
            Assign reviewers
          </Button>
          <Button size="sm" variant="outline" onClick={props.onRemove}>
            <UserMinus className="mr-2 h-4 w-4" />
            Remove reviewer
          </Button>
          <Button size="sm" variant="ghost" onClick={props.onClear}>
            <X className="mr-1 h-4 w-4" />
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}
