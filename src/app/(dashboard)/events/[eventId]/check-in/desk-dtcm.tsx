"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Barcode, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DtcmDetControls } from "@/components/registrations/dtcm-det-controls";
import { queryKeys, useClaimSpareDtcmCode, useDtcmPool, useRegistrationDtcmOrders } from "@/hooks/use-api";
import { useCan } from "@/hooks/use-can";
import { ApiError, apiPutJson } from "@/lib/api-fetch";
import { deskDtcmNoSourceMessage } from "@/lib/desk-dtcm";

/**
 * A desk row's DTCM panel (docs/DTCM_ETICKET_PLAN.md §5.4, built Nov 11 2026):
 * get this person a compliance code before their badge prints. Two sources,
 * the ones the registration sheet has had since Nov 3, and at the desk DET is
 * the main one (owner, Nov 11 2026): its button leads, the pool is the
 * alternative beside it.
 *
 * - DET, where the event's sections are mapped: the sheet's own controls
 *   (`DtcmDetControls`), so an uncertain sale, a sale whose barcode is unread
 *   and a pool fallback read the same here as there.
 * - The spare pool: the next code nobody holds. Offered only while it has one.
 *
 * Every press on "Get code from DET" buys a real ticket out of the permit's
 * seats, so nothing here presses it for the desk: opening the panel only reads.
 *
 * Mount it only for someone who holds `dtcm.assign` and `barcode.view`: both
 * routes refuse anyone else.
 */
export function DeskDtcmPanel({
  eventId,
  registrationId,
  updatedAt,
  onChanged,
  onClose,
}: {
  eventId: string;
  registrationId: string;
  /** The row's version, for putting a DET sale's barcode on it (the registration's own save). */
  updatedAt?: string;
  /** Re-read the list: the row then carries its code and this panel goes away. */
  onChanged: () => Promise<void> | void;
  onClose: () => void;
}) {
  // Settling an uncertain sale is the organiser's (`dtcm.import`), never the desk's.
  const canResolve = useCan("dtcm.import", eventId) === "allowed";
  // Both answers are cached for minutes elsewhere in the app. At the desk
  // they are read fresh each time the panel opens: an organiser may have
  // imported spare codes, or settled this person's DET sale, a moment ago.
  const queryClient = useQueryClient();
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.dtcmPool(eventId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.dtcmRegistrationOrders(eventId, registrationId) });
  }, [queryClient, eventId, registrationId]);
  const detQuery = useRegistrationDtcmOrders(eventId, registrationId);
  const poolQuery = useDtcmPool(eventId);
  const det = detQuery.data;
  const pool = poolQuery.data;
  // One source failing to load must not hide the other: the desk still needs a code.
  const loading = detQuery.isLoading || poolQuery.isLoading;
  const loadFailed = detQuery.isError || poolQuery.isError;
  const claim = useClaimSpareDtcmCode(eventId);
  const [savingCode, setSavingCode] = useState(false);

  const spare = pool?.counts?.spare ?? 0;
  const noSource =
    det && pool
      ? deskDtcmNoSourceMessage({
          detReady: det.detReady,
          // The same rows the DET controls show: a sale waiting on a person, or sold with no barcode on the row.
          hasDetOrderToShow: det.orders.some((o) => o.unresolved || o.status === "PURCHASED"),
          spare,
        })
      : null;

  const assignSpare = async () => {
    try {
      const out = await claim.mutateAsync(registrationId);
      // Refresh FIRST, so the panel is gone before the toast invites a second press.
      await onChanged();
      toast.success(out.status === "already-has-code" ? "They already had a DTCM code." : "Spare DTCM code assigned.");
    } catch (err) {
      console.error("[desk] spare DTCM code failed", err);
      // "Import more" is an instruction: give it time to be read.
      toast.error(err instanceof Error ? err.message : "Could not assign a spare code", { duration: 10000 });
    }
  };

  /** A ticket DET sold for this person that never reached their row: put its barcode on it. */
  const putDetSaleOnRow = async (code: string) => {
    setSavingCode(true);
    try {
      await apiPutJson(`/api/events/${eventId}/registrations/${registrationId}`, { dtcmBarcode: code, expectedUpdatedAt: updatedAt });
      await onChanged();
      toast.success("DTCM code saved.");
    } catch (err) {
      console.error("[desk] saving the DET code failed", err);
      toast.error(err instanceof ApiError ? err.message : "Could not save the code", { duration: 10000 });
      // Someone else changed the row meanwhile: reload it, or a retry carries the same stale version.
      if (err instanceof ApiError && err.code === "STALE_WRITE") await onChanged();
    } finally {
      setSavingCode(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50/60 p-2">
      <p className="text-xs text-amber-900">No DTCM code yet. A badge printed now would have no compliance QR.</p>
      {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading the DTCM options" />}
      {loadFailed && (
        <p className="text-xs text-amber-900">Some of the DTCM options could not be loaded. Close this and open it again; if it stays, ask an organiser.</p>
      )}
      <DtcmDetControls
        eventId={eventId}
        registrationId={registrationId}
        currentCode={null}
        canResolve={canResolve}
        busy={claim.isPending || savingCode}
        onCodeChanged={onChanged}
        onUseCode={putDetSaleOnRow}
      />
      {noSource && <p className="text-xs text-amber-900">{noSource}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {pool && spare > 0 && (
          <Button size="sm" variant="outline" className="h-8 gap-1.5 bg-white" disabled={claim.isPending || savingCode} onClick={assignSpare}>
            {claim.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Barcode className="h-4 w-4" />}
            {det?.detReady ? "Use a spare code instead" : "Use a spare code"} ({spare} left)
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-8" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
