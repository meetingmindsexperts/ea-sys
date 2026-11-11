"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Barcode, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DtcmDetControls } from "@/components/registrations/dtcm-det-controls";
import { queryKeys, useClaimSpareDtcmCode, useDtcmPool, useIsIssuingDtcmFromDet, useRegistrationDtcmOrders } from "@/hooks/use-api";
import { useCan } from "@/hooks/use-can";
import { ApiError, apiPutJson } from "@/lib/api-fetch";
import { UNANSWERED_PRESS_HOLD_MS, deskDetState, deskDtcmNoSourceMessage, deskMayOfferSpare } from "@/lib/desk-dtcm";

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
 * - The spare pool: the next code nobody holds. Offered only while it has one
 *   AND DET has nothing live for this person (`deskMayOfferSpare`): a spare
 *   taken beside a purchase in flight leaves a bought ticket nobody holds.
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
  const loading = detQuery.isLoading || poolQuery.isLoading;
  const loadFailed = detQuery.isError || poolQuery.isError;
  const claim = useClaimSpareDtcmCode(eventId);
  const [savingCode, setSavingCode] = useState(false);
  // A press on "Get code from DET" for this person that has not answered yet.
  const buyingHere = useIsIssuingDtcmFromDet(eventId, registrationId);
  // The list re-read after a code arrives: until it lands the row still looks code-less.
  const [settling, setSettling] = useState(false);
  const reread = async () => {
    setSettling(true);
    try {
      await onChanged();
    } finally {
      setSettling(false);
    }
  };

  // A press that got no answer at all: a purchase may be running that DET's
  // side does not show yet, so the spare is held a while (UNANSWERED_PRESS_HOLD_MS).
  const [unanswered, setUnanswered] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
  }, []);
  const holdAfterUnansweredPress = () => {
    setUnanswered(true);
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => setUnanswered(false), UNANSWERED_PRESS_HOLD_MS);
  };

  const spare = pool?.counts?.spare ?? 0;
  const detState = deskDetState(det?.orders ?? []);
  // Held while either answer is being re-read too: a cached "nothing live" may be minutes old.
  const working = claim.isPending || savingCode || settling || detQuery.isFetching || poolQuery.isFetching;
  const offerSpare =
    !poolQuery.isError && deskMayOfferSpare({ detKnown: !!det && !detQuery.isError, detState, buyingHere: buyingHere || unanswered, spare });
  const noSource = det && pool ? deskDtcmNoSourceMessage({ detReady: det.detReady, detState, spare }) : null;

  /** Ask DET and the list again: for a purchase someone else has in flight. */
  const checkAgain = async () => {
    await Promise.all([detQuery.refetch(), reread()]);
  };

  const assignSpare = async () => {
    // What this panel knows of DET can be minutes old: it was read when the
    // panel opened and does not poll, and another desk or the bulk run may
    // have started a purchase for this person since. Ask again now, and take a
    // spare only if DET's side still shows nothing (second review of 243b7136).
    const fresh = await detQuery.refetch();
    const stillClear = deskMayOfferSpare({
      detKnown: !fresh.isError && !!fresh.data,
      detState: deskDetState(fresh.data?.orders ?? []),
      buyingHere,
      spare: 1,
    });
    if (!stillClear) {
      toast.warning("DET has something in progress for this person, so no spare code was used. Look at the panel again.", { duration: 10000 });
      return;
    }
    try {
      const out = await claim.mutateAsync(registrationId);
      // Refresh FIRST, so the panel is gone before the toast invites a second press.
      await reread();
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
      await reread();
      toast.success("DTCM code saved.");
    } catch (err) {
      console.error("[desk] saving the DET code failed", err);
      toast.error(err instanceof ApiError ? err.message : "Could not save the code", { duration: 10000 });
      // Someone else changed the row meanwhile: reload it, or a retry carries the same stale version.
      if (err instanceof ApiError && err.code === "STALE_WRITE") await reread();
    } finally {
      setSavingCode(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50/60 p-2">
      <p className="text-xs text-amber-900">No DTCM code yet. A badge printed now would have no compliance QR.</p>
      {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading the DTCM options" />}
      {loadFailed && (
        <p className="text-xs text-amber-900">The DTCM options could not be loaded, so no spare code is offered. Close this and open it again; if it stays, ask an organiser.</p>
      )}
      {detState === "buying" ? (
        // Not the DET button: the server would refuse it, and not the spare: the ticket being bought would be left unused.
        <div className="space-y-2 text-xs text-amber-900">
          <p>DET is issuing a ticket for this person right now (another desk, the bulk run, or a press here whose answer was cut off). Wait a few seconds, then check again. Do not use a spare code meanwhile. If this is still here after a few minutes, ask an organiser.</p>
          <Button size="sm" variant="outline" className="h-8 gap-1.5 bg-white" disabled={working} onClick={checkAgain}>
            {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Check again
          </Button>
        </div>
      ) : (
        <DtcmDetControls
          eventId={eventId}
          registrationId={registrationId}
          currentCode={null}
          canResolve={canResolve}
          busy={working}
          onCodeChanged={reread}
          onUseCode={putDetSaleOnRow}
          onIssueUnanswered={holdAfterUnansweredPress}
        />
      )}
      {unanswered && detState !== "buying" && (
        <div className="space-y-2 text-xs text-amber-900">
          <p>That request to DET got no answer, so a ticket may still be on its way. Wait a moment and check again before trying anything else. A spare code is not offered meanwhile.</p>
          <Button size="sm" variant="outline" className="h-8 gap-1.5 bg-white" disabled={working} onClick={checkAgain}>
            {working ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Check again
          </Button>
        </div>
      )}
      {noSource && <p className="text-xs text-amber-900">{noSource}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {offerSpare && (
          <Button size="sm" variant="outline" className="h-8 gap-1.5 bg-white" disabled={working} onClick={assignSpare}>
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
