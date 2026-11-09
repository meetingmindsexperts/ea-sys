import { Award } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

/**
 * A person's CME hours, this year and in total (cmeTotals). Shared by My events
 * and My certificates so the two always show the same figures.
 */
export function CmeTotalsCard({ thisYear, allTime, year }: { thisYear: number; allTime: number; year: string }) {
  return (
    <Card className="gap-0 py-0">
      <CardContent className="flex items-center gap-4 p-4 sm:p-5">
        <Award className="h-8 w-8 shrink-0 text-primary" aria-hidden />
        <div className="grid flex-1 grid-cols-2 gap-4">
          <div>
            <p className="text-2xl font-semibold tabular-nums">{thisYear}</p>
            <p className="text-xs text-muted-foreground">CME hours in {year}</p>
          </div>
          <div>
            <p className="text-2xl font-semibold tabular-nums">{allTime}</p>
            <p className="text-xs text-muted-foreground">CME hours in total</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
