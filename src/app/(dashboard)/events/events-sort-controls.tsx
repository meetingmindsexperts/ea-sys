"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import type { EventSortField, EventSortOrder } from "@/lib/event-sort";

interface EventsSortControlsProps {
  sort: EventSortField;
  order: EventSortOrder;
}

const SORT_LABELS: Record<EventSortField, string> = {
  startDate: "Start date",
  createdAt: "Created",
  name: "Name",
};

export function EventsSortControls({ sort, order }: EventsSortControlsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const updateParams = (next: Partial<{ sort: EventSortField; order: EventSortOrder }>) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next.sort) params.set("sort", next.sort);
    if (next.order) params.set("order", next.order);
    router.replace(`/events?${params.toString()}`);
  };

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Sort by</span>
      <Select value={sort} onValueChange={(v) => updateParams({ sort: v as EventSortField })}>
        <SelectTrigger className="h-8 w-[140px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(SORT_LABELS) as EventSortField[]).map((f) => (
            <SelectItem key={f} value={f}>
              {SORT_LABELS[f]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8"
        aria-label={order === "asc" ? "Ascending — click for descending" : "Descending — click for ascending"}
        onClick={() => updateParams({ order: order === "asc" ? "desc" : "asc" })}
      >
        {order === "asc" ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
      </Button>
    </div>
  );
}
