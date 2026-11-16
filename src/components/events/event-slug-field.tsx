"use client";

/**
 * The event's URL slug in Settings (Nov 16, 2026). It cleans as you type
 * (letters, digits and hyphens only; Greek letters spelled out, accents
 * removed), finishes the slug when you leave the box, and makes one from the
 * event's name on request. The save route applies the same rule (event-slug.ts).
 */
import { AlertTriangle, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cleanEventSlugInput, eventSlugFromName, isValidEventSlug, normalizeEventSlug } from "@/lib/event-slug";

export function EventSlugField({
  value,
  name,
  savedSlug,
  onChange,
}: {
  value: string;
  /** The event's name as it stands in the form. */
  name: string;
  /** The slug as saved, to tell a broken one and a change to a live link. */
  savedSlug: string | null | undefined;
  onChange: (slug: string) => void;
}) {
  const fromName = eventSlugFromName(name);
  const savedIsBroken = Boolean(savedSlug) && !isValidEventSlug(savedSlug ?? "");
  const changingLiveLink = Boolean(savedSlug) && !savedIsBroken && value !== savedSlug;

  return (
    <div className="space-y-2">
      <Label htmlFor="slug">URL Slug</Label>
      <div className="flex gap-2">
        <Input
          id="slug"
          value={value}
          onChange={(e) => onChange(cleanEventSlugInput(e.target.value))}
          onBlur={() => onChange(normalizeEventSlug(value))}
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => onChange(fromName)}
          disabled={fromName.length < 2 || fromName === value}
          title={fromName.length < 2 ? "The name has no letters to make an address from" : `Use "${fromName}"`}
        >
          <Wand2 className="mr-2 h-4 w-4" />
          Generate from name
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Your public registration page: /e/{value || "your-event-slug"}. Letters, digits and hyphens only; Greek
        letters are written out (β becomes beta).
      </p>
      {savedIsBroken && (
        <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          The saved address has spaces or symbols that break links and Zoom&apos;s stream setup. Press Generate from
          name, then save.
        </p>
      )}
      {changingLiveLink && (
        <p className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Links already sent with /e/{savedSlug} stop working once you save a new address.
        </p>
      )}
    </div>
  );
}
