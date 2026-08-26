"use client";

import { ScanBarcode, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDtcmPool } from "@/hooks/use-api";

/**
 * How many spare DTCM codes count as "running low".
 *
 * A flat number, not a percentage of the block: a 50-code block issued for a
 * 40-person event is perfectly healthy at 10 spare, so a percentage would cry
 * wolf on small events and stay quiet on large ones. Ten is roughly a busy
 * hour of walk-ups at the counter — enough warning to import more before the
 * pool actually runs dry.
 */
const LOW_SPARE_THRESHOLD = 10;

interface DtcmPoolCardProps {
  eventId: string;
  /**
   * The caller MUST have already checked `canViewEntryBarcode`. A DTCM code is
   * a compliance credential and the route behind this refuses roles outside
   * `BARCODE_ROLES` — mounting it for MEMBER would fire a request that can only
   * 403.
   */
  enabled: boolean;
}

/**
 * The spare-code pool, on the page where the desk actually adds walk-ups.
 *
 * This exists because the failure it reports is otherwise INVISIBLE until the
 * wrong moment: a walk-up registers fine, and the badge simply prints without a
 * compliance QR. Nothing on screen says the pool ran out. So the number lives
 * next to the button that consumes it.
 */
export function DtcmPoolCard({ eventId, enabled }: DtcmPoolCardProps) {
  const { data, isLoading, isError } = useDtcmPool(eventId, enabled);

  // Silent while loading, and silent on failure. A broken strip above the
  // registrations table would be worse than no strip: it reads as "the pool is
  // broken" when the truth is "we could not read it". The failure is logged
  // server-side either way.
  if (!enabled || isLoading || isError) return null;
  if (!data?.enabled || !data.counts) return null;

  const { total, assigned, spare, assignedOutsidePool } = data.counts;
  const isEmpty = spare === 0;
  const isLow = !isEmpty && spare <= LOW_SPARE_THRESHOLD;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-2.5 text-sm",
        isEmpty
          ? "border-red-200 bg-red-50 text-red-800"
          : isLow
            ? "border-amber-200 bg-amber-50 text-amber-900"
            : "bg-muted/40",
      )}
    >
      {isEmpty || isLow ? (
        <AlertTriangle className="h-4 w-4 shrink-0" />
      ) : (
        <ScanBarcode className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}

      <span className="font-medium">DTCM codes</span>

      <span className={cn(!isEmpty && !isLow && "text-muted-foreground")}>
        <span className="font-semibold tabular-nums">{spare}</span> spare
        {total > 0 && (
          <>
            {" · "}
            <span className="tabular-nums">{assigned}</span> assigned of{" "}
            <span className="tabular-nums">{total}</span> imported
          </>
        )}
      </span>

      {assignedOutsidePool > 0 && (
        <span
          className="text-xs text-muted-foreground"
          title="Codes assigned by the pre-event CSV that were never imported as spares. Normal — shown so the numbers add up."
        >
          +{assignedOutsidePool} held outside the pool
        </span>
      )}

      {/* The consequence, spelled out. "0 spare" means nothing to someone who
          has not been told what a spare code is for. */}
      {isEmpty && (
        <span className="text-xs">
          {total === 0
            ? "None imported yet — walk-ups will register without a compliance code. Use Import Barcodes → “Spare codes for the desk”."
            : "Walk-ups will register without a compliance code until more are imported."}
        </span>
      )}
      {isLow && <span className="text-xs">Running low — import more before the doors open.</span>}
    </div>
  );
}
