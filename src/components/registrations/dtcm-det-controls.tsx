"use client";

/**
 * The registration detail sheet's DET controls (docs/DTCM_ETICKET_PLAN.md
 * step 3): "Get code from DET" for a registration with no code, and the state
 * of its DET orders, including the two that need a person: an UNCERTAIN (or
 * crashed) purchase, and a sale whose barcode was not read yet.
 *
 * Shown only where DET can work for this registration (`detReady`), so an
 * organisation that only imports CSV codes never sees a button that cannot.
 */
import { useState } from "react";
import { AlertTriangle, Barcode, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useIssueDtcmFromDet, useRegistrationDtcmOrders, useResolveDtcmOrder, type DtcmOrderSummary } from "@/hooks/use-api";

interface Props {
  eventId: string;
  registrationId: string;
  /** The registration's DTCM code now, or null. */
  currentCode: string | null;
  /** `dtcm.import`: may decide what happened to an uncertain sale. */
  canResolve: boolean;
  /** Re-read the registration after its code changed. */
  onCodeChanged: () => Promise<void> | void;
  /** Disable while the sheet's other code buttons are working. */
  busy?: boolean;
  /** Put a DET sale's barcode on the registration (the sheet's manual save). */
  onUseCode: (code: string) => Promise<void>;
}

export function DtcmDetControls({ eventId, registrationId, currentCode, canResolve, onCodeChanged, busy, onUseCode }: Props) {
  // The code a press here just put on the registration. The caller's own copy
  // arrives only when its re-read lands, and the order list usually lands
  // first: for that moment the new sale looked like "a ticket DET sold that is
  // not on this registration", with a button to put it there (review of
  // 243b7136). Knowing the code at once closes that.
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const knownCode = currentCode ?? issuedCode;
  const hasCode = Boolean(knownCode);
  const { data } = useRegistrationDtcmOrders(eventId, registrationId);
  const issue = useIssueDtcmFromDet(eventId, registrationId);

  if (!data) return null;
  const open = data.orders.find((o) => o.unresolved) ?? data.orders.find((o) => o.status === "PURCHASED" && !o.barcode);
  // A ticket DET sold for this person whose barcode is not the one on the
  // registration (cleared by hand, or a code arrived another way during the
  // sale). Buying again would be refused, so say what exists instead.
  const orphan = open ? undefined : data.orders.find((o) => o.status === "PURCHASED" && o.barcode && o.barcode !== knownCode);
  // Only a sale from the environment in use now may go on the registration: a
  // sandbox order outlives the switch to production, and its barcode would
  // print on a badge DTCM's gate rejects.
  const orphanUsable = Boolean(orphan && !hasCode && orphan.environment === data.environment);

  const handleIssue = async () => {
    try {
      const out = await issue.mutateAsync();
      if (out.barcode) setIssuedCode(out.barcode);
      // Refresh FIRST: a success toast over a sheet still showing the button
      // invites a second click (which the server refuses, but should not be offered).
      await onCodeChanged();
      if (out.source === "pool") {
        toast.warning(`DET did not issue a code, so a spare one from the pool was used. ${out.detError ?? ""}`, { duration: 12000 });
      } else {
        toast.success("DTCM code issued by DET.");
      }
    } catch (err) {
      console.error("[dtcm] get code from DET failed", err);
      toast.error(err instanceof Error ? err.message : "Could not get a code from DET", { duration: 12000 });
      // A refusal is often news about the registration itself ("already has a
      // code": another desk or the bulk run got there first), so re-read it:
      // otherwise the caller goes on showing a row with no code and the same
      // press fails the same way (review of 243b7136).
      try {
        await onCodeChanged();
      } catch (refreshErr) {
        console.error("[dtcm] re-read after a refused DET purchase failed", refreshErr);
      }
    }
  };

  return (
    <div className="space-y-2">
      {!hasCode && data.detReady && !open && !orphan && (
        <Button size="sm" onClick={handleIssue} disabled={issue.isPending || busy}>
          {issue.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Barcode className="mr-2 h-4 w-4" />}
          Get code from DET
        </Button>
      )}
      {orphan && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-left text-xs text-amber-800">
          DET sold a ticket for this person (order {orphan.orderId}, {envLabel(orphan.environment)}) with barcode{" "}
          <span className="font-mono">{orphan.barcode}</span>, which is not the code on this registration.{" "}
          {orphanAdvice(orphanUsable, orphan.environment === data.environment)}
          {/* Only onto an EMPTY registration (replacing a code someone put
              there on purpose is a decision, not a one-click fix), and only
              from the environment in use now. */}
          {orphanUsable && (
            <Button
              size="sm"
              variant="outline"
              className="mt-2 block bg-white"
              disabled={busy}
              onClick={() => void onUseCode(orphan.barcode as string)}
            >
              Use this code
            </Button>
          )}
        </p>
      )}
      {open && (
        <OpenOrder
          eventId={eventId}
          registrationId={registrationId}
          order={open}
          canResolve={canResolve}
          onCodeChanged={onCodeChanged}
        />
      )}
    </div>
  );
}

function OpenOrder({
  eventId,
  registrationId,
  order,
  canResolve,
  onCodeChanged,
}: {
  eventId: string;
  registrationId: string;
  order: DtcmOrderSummary;
  canResolve: boolean;
  onCodeChanged: () => Promise<void> | void;
}) {
  const resolve = useResolveDtcmOrder(eventId, registrationId);
  const [detOrderId, setDetOrderId] = useState("");
  const env = envLabel(order.environment);

  const run = async (body: { action: "found"; detOrderId: string } | { action: "not-bought" } | { action: "read-barcode" }, done: string) => {
    try {
      await resolve.mutateAsync({ dtcmOrderId: order.id, body });
      await onCodeChanged();
      toast.success(done);
    } catch (err) {
      console.error("[dtcm] resolve DET order failed", err);
      toast.error(err instanceof Error ? err.message : "Could not update the DET order", { duration: 12000 });
    }
  };

  if (!order.unresolved) {
    // PURCHASED, barcode not read yet.
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-left text-xs text-amber-800">
        <p>
          DET sold this ticket (order {order.orderId}, {env}) but its barcode has not been read yet.
          {/* The read goes through the organiser's key (`dtcm.import`), so desk
              staff were shown a button that could only answer Forbidden. */}
          {!canResolve && " Do not buy another: an organiser can read it from the registration."}
        </p>
        {canResolve && (
          <Button size="sm" variant="outline" className="mt-2" disabled={resolve.isPending} onClick={() => run({ action: "read-barcode" }, "Barcode read from DET.")}>
            Read barcode again
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-left text-xs text-amber-800">
      <p className="flex items-start gap-1.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          A DET purchase for this person ({order.area}/{order.priceTypeCode}, {env}) may have gone through, but its answer was
          lost. Do not try again: that could buy a second ticket.
          {!canResolve && " An organiser can check DET and resolve it."}
        </span>
      </p>
      {canResolve && (
        <div className="space-y-2">
          <p>Look the sale up in DET. If you find it, enter its order number; if DET has no sale, mark it as not bought.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={detOrderId}
              onChange={(e) => setDetOrderId(e.target.value.trim())}
              placeholder="DET order number"
              className="h-8 w-40 bg-white font-mono"
              aria-label="DET order number"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!detOrderId || resolve.isPending}
              onClick={() => run({ action: "found", detOrderId }, "DET order linked and its barcode recorded.")}
            >
              Use this order
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={resolve.isPending}
              onClick={() => {
                if (window.confirm("Mark this purchase as not bought? Only do this if DET has no sale for this person.")) {
                  void run({ action: "not-bought" }, "Marked as not bought. You can get a code again.");
                }
              }}
            >
              Not bought
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function envLabel(environment: string): string {
  return environment === "production" ? "production" : "sandbox";
}

function orphanAdvice(usable: boolean, sameEnvironment: boolean): string {
  if (usable) return "Put it on the registration rather than buying another.";
  if (!sameEnvironment) return "It was bought in another DET environment, so it cannot be used here.";
  return "If it is not needed, have an organiser reverse the unused DET order.";
}
