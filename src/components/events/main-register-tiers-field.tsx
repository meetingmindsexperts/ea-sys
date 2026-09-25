"use client";

/**
 * Registration Types page: which rates the main public link
 * (`/e/<slug>/register`) may land on. The order is the tiers' own order, so
 * this only ticks names. Each tick saves at once, merging just this one key
 * into the event settings. The rules and the reasons live in
 * src/lib/main-register-tiers.ts; this is only the editor.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { queryKeys } from "@/hooks/use-api";
import { isPresenterTierName } from "@/lib/presenter-tiers";
import { orderedTierNames, readMainRegisterTiers } from "@/lib/main-register-tiers";

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

export function MainRegisterTiersField({ eventId, ticketTypes, settings }: Props) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  // Optimistic copy while a save is in flight; the event query is the truth.
  const [pending, setPending] = useState<string[] | null>(null);
  const ticked = pending ?? readMainRegisterTiers(settings);

  const publicTypes = ticketTypes.filter((tt) => !tt.isFaculty);
  const names = orderedTierNames(publicTypes);
  const hasPresenterTiers = publicTypes.some((tt) =>
    (tt.pricingTiers ?? []).some((t) => isPresenterTierName(t.name)),
  );

  const save = async (next: string[]) => {
    setPending(next);
    setSaving(true);
    try {
      const res = await fetch(`/api/events/${eventId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { mainRegisterTiers: next } }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Save failed (${res.status})`);
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.event(eventId) });
      toast.success("Main registration link updated");
    } catch (err) {
      console.error("main-register-tiers:save-failed", err);
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setPending(null);
      setSaving(false);
    }
  };

  const toggle = (slug: string, on: boolean) =>
    save(on ? [...ticked, slug] : ticked.filter((s) => s !== slug));

  if (names.length === 0) return null;

  const tickedNames = names.filter(({ slug }) => ticked.includes(slug)).map(({ name }) => name);
  const exampleSlug = names[0].slug;

  // Collapsed by default (owner request): set once per event, so it should not
  // sit between the organiser and the registration types. The summary line
  // says what is ticked, so the state is visible without opening it.
  return (
    <details className="group rounded-lg border border-slate-200 bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
        <span className="text-sm font-medium">
          Main registration link
          <span className="ml-2 font-normal text-muted-foreground">
            {tickedNames.length > 0 ? tickedNames.join(", ") : "nothing ticked (always closed)"}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-2 border-t px-3 py-3">
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            Your event has one general registration link, <code>/register</code>, the one you
            put on the website, in emails and on flyers. Each rate below also has its own
            link, for example <code>/register/{exampleSlug}</code>. This section decides which
            rates the general link is allowed to send people to.
          </p>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              <strong className="text-foreground">Ticked:</strong> the general link can send
              visitors here. It picks the first ticked rate that is open right now, in the order
              of the rates on the cards above. When that rate closes (for example Early Bird
              ends), visitors automatically go to the next ticked one.
            </li>
            <li>
              <strong className="text-foreground">Unticked:</strong> the general link never
              sends anyone here, but the rate stays open. People can still register on it through
              its own link, so you can send that link only to the people who should have it,
              such as society members, past attendees or sponsors.
            </li>
            <li>
              <strong className="text-foreground">Example:</strong> Early Bird and Standard are
              both open. Untick Early Bird and the general link sends everyone to Standard, while
              you email <code>/register/early-bird</code> to your members so only they get the
              lower price.
            </li>
            <li>
              <strong className="text-foreground">Good to know:</strong> an unticked rate is
              unlisted, not locked. Anyone who has its link, or guesses it, can use it. If a
              discount must be protected, use a promo code instead (Promo Codes tab at the top of
              this page): people then need the code, and you can limit how often it is used.
            </li>
            <li>
              A rate only takes registrations while it is switched on in its registration type
              card and inside its sales dates. Ticking it here does not open a closed rate.
            </li>
          </ul>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {names.map(({ slug, name }) => (
            <label key={slug} htmlFor={`main-tier-${slug}`} className="flex items-center gap-2 text-sm">
              <Checkbox
                id={`main-tier-${slug}`}
                checked={ticked.includes(slug)}
                disabled={saving}
                onCheckedChange={(checked) => toggle(slug, checked === true)}
              />
              {name}
            </label>
          ))}
        </div>
        {!names.some(({ slug }) => ticked.includes(slug)) && (
          <p className="text-xs text-amber-600">
            Nothing is ticked, so the general link always shows &quot;Registration
            Closed&quot;. People can only register through a rate&apos;s own link.
          </p>
        )}
        {hasPresenterTiers && (
          <p className="text-xs text-muted-foreground">
            Presenter rates never appear here: presenters register through the abstract
            submission signup, not the general link.
          </p>
        )}
      </div>
    </details>
  );
}
