"use client";

/**
 * Event Settings → Group Registration: one group link per rate (Oct 16, 2026,
 * owner: "we send the link, either Early Bird or Standard"). The link fixes
 * the rate; the coordinator picks each member's type among the types that
 * carry it. Sponsor-link and presenter rates never get a group link.
 */
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEvent, useTickets } from "@/hooks/use-api";
import { orderedTierNames } from "@/lib/main-register-tiers";
import { readCodeRequiredTiers } from "@/lib/code-required-tiers";

interface TicketTypeRow {
  isFaculty?: boolean;
  pricingTiers?: { name: string; sortOrder?: number | null }[] | null;
}

export function GroupRateLinks({ eventId, slug }: { eventId: string; slug: string }) {
  const { data: ticketTypes = [] } = useTickets(eventId);
  const { data: event } = useEvent(eventId);
  const sponsorLinks = readCodeRequiredTiers(event?.settings);
  const rates = orderedTierNames((ticketTypes as TicketTypeRow[]).filter((tt) => !tt.isFaculty)).filter(
    ({ slug: rate }) => !sponsorLinks.includes(rate),
  );

  const copy = (rate: string) => {
    const url = `${window.location.origin}/e/${slug}/group/register/${rate}`;
    navigator.clipboard
      .writeText(url)
      .then(() => toast.success("Group registration link copied"))
      .catch(() => toast.error("Couldn't copy, copy it manually: " + url));
  };

  if (rates.length === 0) {
    return <p className="text-xs text-muted-foreground">Add a rate on the Registration Types page to get a group link.</p>;
  }

  return (
    <div className="space-y-2">
      {rates.map(({ slug: rate, name }) => (
        <div key={rate} className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => copy(rate)}>
            <Copy className="mr-1.5 h-3.5 w-3.5" />
            {name}
          </Button>
          <span className="truncate text-xs text-muted-foreground">/e/{slug}/group/register/{rate}</span>
        </div>
      ))}
    </div>
  );
}
