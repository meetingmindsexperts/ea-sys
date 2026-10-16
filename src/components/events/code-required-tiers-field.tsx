"use client";

/**
 * Registration Types page: which rates' links are sponsor links, so that only
 * a sponsor's code (one that covers the fee) can register on them. By rate
 * NAME, like the main link: ticking "Inclusive" covers that rate on every
 * registration type, including ones added later. Each tick saves at once. The
 * rules live in src/lib/code-required-tiers.ts; this is only the editor.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { queryKeys } from "@/hooks/use-api";
import { orderedTierNames } from "@/lib/main-register-tiers";
import { readCodeRequiredTiers } from "@/lib/code-required-tiers";

interface TicketTypeRow {
  isFaculty?: boolean;
  pricingTiers?: { name: string; sortOrder?: number | null }[] | null;
}

interface Props {
  eventId: string;
  ticketTypes: TicketTypeRow[];
  /** The event's settings JSON, as the event query returns it. */
  settings: unknown;
}

export function CodeRequiredTiersField({ eventId, ticketTypes, settings }: Props) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<string[] | null>(null);
  const ticked = pending ?? readCodeRequiredTiers(settings);

  const names = orderedTierNames(ticketTypes.filter((tt) => !tt.isFaculty));

  const save = async (next: string[]) => {
    setPending(next);
    setSaving(true);
    try {
      const res = await fetch(`/api/events/${eventId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { codeRequiredTiers: next } }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Save failed (${res.status})`);
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.event(eventId) });
      toast.success("Sponsor links updated");
    } catch (err) {
      console.error("code-required-tiers:save-failed", err);
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setPending(null);
      setSaving(false);
    }
  };

  const toggle = (slug: string, on: boolean) => save(on ? [...ticked, slug] : ticked.filter((s) => s !== slug));

  if (names.length === 0) return null;

  const tickedNames = names.filter(({ slug }) => ticked.includes(slug)).map(({ name }) => name);
  // Marked names no rate carries any more (a rate renamed or deleted). Shown
  // so they can be unticked; they protect nothing until a rate has the name.
  const orphans = ticked.filter((slug) => !names.some((n) => n.slug === slug));

  return (
    <details className="group rounded-lg border border-slate-200 bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
        <span className="text-sm font-medium">
          Sponsor links
          <span className="ml-2 font-normal text-muted-foreground">
            {tickedNames.length > 0 ? `${tickedNames.join(", ")} need a sponsor's code` : "none"}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-2 border-t px-3 py-3">
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            Tick a rate to make its link a sponsor link, for example <code>/register/inclusive</code>.
            On a ticked rate, nobody can register without a sponsor&apos;s promo code, one with
            &ldquo;Sponsor covers the fee&rdquo; switched on. A discount code does not count. The
            rule covers that rate on every registration type, including types you add later.
          </p>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              <strong className="text-foreground">For the sponsor&apos;s people:</strong>{" "}
              send the
              sponsor their code&apos;s link (the link button in Promo Codes), or the rate&apos;s link
              with the code. The code is filled in and applied for them.
            </li>
            <li>
              <strong className="text-foreground">For everyone else:</strong>{" "}
              the promo code field is
              required and the registration is refused without a sponsor&apos;s code, even if someone
              finds the link.
            </li>
            <li>
              Make sure each sponsor&apos;s code applies to the registration types its people may use
              (Applicable Registration Types on the code). Your team can still add registrations on
              these rates from the dashboard.
            </li>
          </ul>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {names.map(({ slug, name }) => (
            <label key={slug} htmlFor={`sponsor-link-${slug}`} className="flex items-center gap-2 text-sm">
              <Checkbox
                id={`sponsor-link-${slug}`}
                checked={ticked.includes(slug)}
                disabled={saving}
                onCheckedChange={(checked) => toggle(slug, checked === true)}
              />
              {name}
            </label>
          ))}
          {orphans.map((slug) => (
            <label key={slug} htmlFor={`sponsor-link-${slug}`} className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                id={`sponsor-link-${slug}`}
                checked
                disabled={saving}
                onCheckedChange={() => toggle(slug, false)}
              />
              {slug} <span className="text-xs">(no rate has this name now)</span>
            </label>
          ))}
        </div>
      </div>
    </details>
  );
}
