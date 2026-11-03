"use client";

/**
 * "Unused DET tickets" (docs/DTCM_ETICKET_PLAN.md §6, step 5): bought tickets
 * nobody is using, each with a Reverse button that gives its seat back to the
 * permit. Organisers only (`dtcm.import`); renders nothing when there are none.
 *
 * Never automatic (owner decision D3): a cancelled attendee may still carry a
 * printed badge, so the organiser decides, one ticket at a time.
 */
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api-fetch";
import { useDtcmUnusedOrders, useReverseDtcmOrder, type DtcmUnusedOrder } from "@/hooks/use-api";

const WHY: Record<DtcmUnusedOrder["reason"], string> = {
  REGISTRATION_CANCELLED: "registration cancelled",
  REGISTRATION_DELETED: "registration deleted",
  BARCODE_NOT_ON_REGISTRATION: "the registration has a different code",
};

export function DtcmUnusedCard({ eventId }: { eventId: string }) {
  const { data } = useDtcmUnusedOrders(eventId, true);
  const reverse = useReverseDtcmOrder(eventId);
  const unused = data?.unused ?? [];
  if (unused.length === 0) return null;

  const handleReverse = async (o: DtcmUnusedOrder) => {
    const who = o.name ?? "a deleted registration";
    if (!window.confirm(`Reverse DET order ${o.orderId} (${who})? Its DTCM barcode stops working and the seat goes back to the permit.`)) return;
    try {
      const out = await reverse.mutateAsync({ dtcmOrderId: o.id, action: "reverse" });
      toast.success(out.clearedRegistrationCode ? "Reversed, and the code was removed from the registration." : "Reversed.");
    } catch (err) {
      // DET has no such order: reversed already (a lost answer, or in DET's
      // portal). Offer to record that, which is checked with DET again.
      if (err instanceof ApiError && err.code === "DET_NOT_FOUND") {
        if (window.confirm(`${err.message}\n\nIf DET's portal shows order ${o.orderId} reversed, mark it reversed here?`)) {
          await markReversed(o);
        }
        return;
      }
      toast.error(err instanceof Error ? err.message : "Could not reverse the DET order", { duration: 12000 });
    }
  };

  const markReversed = async (o: DtcmUnusedOrder) => {
    try {
      await reverse.mutateAsync({ dtcmOrderId: o.id, action: "mark-reversed" });
      toast.success("Marked as reversed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not mark the order reversed", { duration: 12000 });
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/50 p-4">
      <p className="text-sm font-medium">
        Unused DET tickets: {unused.length}
      </p>
      <p className="text-xs text-muted-foreground">
        Bought from DET but not on an active registration. Reversing one gives its seat back to the permit and stops its
        barcode working, so only reverse a ticket nobody will use.
      </p>
      <ul className="divide-y text-xs">
        {unused.map((o) => (
          <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span>
              <span className="font-medium">{o.name ?? "Deleted registration"}</span>: order {o.orderId} ({o.area},{" "}
              {o.environment === "production" ? "production" : "sandbox"}), {WHY[o.reason]}
            </span>
            <Button size="sm" variant="outline" disabled={reverse.isPending} onClick={() => handleReverse(o)}>
              {reverse.isPending && reverse.variables?.dtcmOrderId === o.id && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Reverse
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
