"use client";

/**
 * Dedicated deal page — /crm/deals/[dealId].
 *
 * A deal is its own record with its own URL (deep-linkable, back-button-friendly),
 * rather than a slide-out over the board. The detail lives in DealDetailBody; this
 * page fetches by id, guards loading / not-found, and sends you back to the board
 * after an archive or close.
 */
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCrmDeal } from "@/crm/hooks/use-crm-api";
import { canOwnDeals } from "@/crm/lib/crm-roles";
import { DealDetailBody } from "@/crm/components/deal-detail-body";

export default function CrmDealPage() {
  const params = useParams();
  const dealId = Array.isArray(params.dealId) ? params.dealId[0] : (params.dealId ?? "");
  const router = useRouter();
  const { data: session } = useSession();
  const canWrite = canOwnDeals(session?.user?.role);

  const { data: deal, isLoading, isError } = useCrmDeal(dealId);

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/crm/deals">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to deals
        </Link>
      </Button>

      {isLoading ? (
        <div className="flex items-center gap-2 py-16 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading deal…
        </div>
      ) : isError || !deal ? (
        <div className="rounded-lg border bg-muted/20 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            This deal could not be found — it may have been removed.
          </p>
        </div>
      ) : (
        <DealDetailBody deal={deal} canWrite={canWrite} onClosed={() => router.push("/crm/deals")} />
      )}
    </div>
  );
}
