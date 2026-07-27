"use client";

/**
 * A sortable table header cell for the CRM list tables.
 *
 * Shared by Companies + Contacts so the two don't grow divergent copies. Carries
 * `aria-sort` (WCAG sortable-table) so a screen reader announces the current sort,
 * and a chevron affordance so a sighted user knows the column is clickable and which
 * way it's ordered.
 *
 * Sort is only offered on UNAMBIGUOUS columns (names, counts, scores) — never on a
 * cross-currency "deal value", where a single numeric order would be as fabricated
 * as summing AED into USD (the same rule that keeps sums honest elsewhere).
 */
import { ChevronDown, ChevronsUpDown, ChevronUp } from "lucide-react";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type SortDir = "asc" | "desc";

export function SortableTh({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: string;
  activeKey: string;
  dir: SortDir;
  onSort: (key: string) => void;
  align?: "left" | "right";
}) {
  const active = activeKey === sortKey;
  return (
    <TableHead
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={align === "right" ? "text-right" : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 transition-colors hover:text-foreground",
          align === "right" && "flex-row-reverse",
          active ? "font-semibold text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        {active ? (
          dir === "asc" ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}

/**
 * Toggle helper for the page's `set`: click the active column to flip direction,
 * click a new column to sort it ascending. Returns the `{ sort, dir }` patch.
 */
export function nextSort(current: string, currentDir: SortDir, clicked: string): { sort: string; dir: SortDir } {
  if (current === clicked) return { sort: clicked, dir: currentDir === "asc" ? "desc" : "asc" };
  return { sort: clicked, dir: "asc" };
}
