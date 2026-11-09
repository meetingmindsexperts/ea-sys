"use client";

import Link from "next/link";
import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { CatalogueHeroPhotoField } from "@/components/settings/catalogue-hero-photo-field";
import { useCan } from "@/hooks/use-can";
import { useCatalogueSettings, useSaveCatalogueSettings, useSetCatalogueListing, type CatalogueSettingsResponse } from "@/hooks/use-api";
import { CATALOGUE_TEXT_LIMITS as L, isHttpsLinkUrl, type CatalogueSettings } from "@/lib/catalogue";

/**
 * Settings, Catalogue (Nov 5, 2026; owner: "a new tab called catalogue with
 * however many controls the catalogue page needs"): the public catalogue's
 * hero (photo and words), which sections show, the footer, and which events
 * are listed. Every text field left empty falls back to the page's own
 * wording, shown as the field's placeholder.
 */

/** The route returns at most this many events, newest first. */
const EVENT_LIST_CAP = 200;

type TextKey = "eyebrow" | "headline" | "intro" | "footerAbout" | "contactEmail" | "contactPhone" | "termsUrl" | "privacyUrl";
type SectionKey = "showStats" | "showBannerFan" | "showNextUp" | "showHowItWorks" | "showTopics";
type Form = Record<TextKey, string> & Record<SectionKey, boolean> & { heroImage: string | null };

const SECTIONS: { key: SectionKey; label: string; hint: string }[] = [
  { key: "showStats", label: "Track record", hint: "Events hosted, delegates, faculty and countries, counted from your events. Shown once you have three events." },
  { key: "showBannerFan", label: "Event banners in the hero", hint: "The next three listed events' banners, fanned beside the headline and changing every few seconds." },
  { key: "showNextUp", label: "Next up", hint: "The soonest event, large, with a countdown and each registration type's current price." },
  { key: "showHowItWorks", label: "How registering works", hint: "Three steps: choose an event, register and pay online, download your certificate." },
  { key: "showTopics", label: "Browse by specialty and country", hint: "Links to a page per specialty and country, which also helps search engines find them." },
];

function toForm(s: CatalogueSettings): Form {
  return {
    heroImage: s.heroImage,
    eyebrow: s.eyebrow ?? "",
    headline: s.headline ?? "",
    intro: s.intro ?? "",
    footerAbout: s.footerAbout ?? "",
    contactEmail: s.contactEmail ?? "",
    contactPhone: s.contactPhone ?? "",
    termsUrl: s.termsUrl ?? "",
    privacyUrl: s.privacyUrl ?? "",
    showStats: s.showStats,
    showBannerFan: s.showBannerFan,
    showNextUp: s.showNextUp,
    showHowItWorks: s.showHowItWorks,
    showTopics: s.showTopics,
  };
}

export function CatalogueSettingsCard({ readOnly }: { readOnly: boolean }) {
  const { data, isLoading, error } = useCatalogueSettings();
  if (error) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-destructive">Couldn&apos;t load the catalogue settings. Refresh to try again.</CardContent>
      </Card>
    );
  }
  if (isLoading || !data) {
    return (
      <Card>
        <CardContent className="flex justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return <CatalogueForm data={data} readOnly={readOnly} />;
}

/** The form, starting from what was loaded; after a save it already holds what was saved. */
function CatalogueForm({ data, readOnly }: { data: CatalogueSettingsResponse; readOnly: boolean }) {
  const save = useSaveCatalogueSettings();
  const [form, setForm] = useState<Form>(() => toForm(data.settings));
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const onSave = async () => {
    // Said here rather than as the API's bare "Invalid input".
    const badLink = [form.termsUrl, form.privacyUrl].find((v) => v.trim() && !isHttpsLinkUrl(v.trim()));
    if (badLink) {
      toast.error("The terms and privacy links must be https addresses, like https://example.com/terms");
      return;
    }
    try {
      await save.mutateAsync(form);
      toast.success("Catalogue settings saved");
    } catch (err) {
      console.error("settings:catalogue-save-failed", err);
      toast.error(err instanceof Error ? err.message : "Couldn't save the catalogue settings");
    }
  };
  const { defaults } = data;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Event catalogue</CardTitle>
            <CardDescription>
              The public page listing your events, at /catalogue, with a page per specialty and country. Leave a field empty to
              use the wording shown in it.
            </CardDescription>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/catalogue" target="_blank" rel="noopener">
              View catalogue <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="space-y-8">
          <section className="space-y-4">
            <h3 className="text-sm font-semibold">Hero</h3>
            <CatalogueHeroPhotoField value={form.heroImage} onChange={(url) => set({ heroImage: url })} disabled={readOnly} />
            <TextField id="catalogue-eyebrow" label="Line above the headline" value={form.eyebrow} max={L.eyebrow} placeholder={defaults.organizationName} disabled={readOnly} onChange={(v) => set({ eyebrow: v })} />
            <TextField
              id="catalogue-headline"
              label="Headline"
              hint="The page's main heading, and what search engines read first. Empty shows where your next events are, which updates by itself."
              value={form.headline}
              max={L.headline}
              placeholder="Medical conferences and CME, from Dubai to Muscat."
              disabled={readOnly}
              onChange={(v) => set({ headline: v })}
            />
            <TextField
              id="catalogue-intro"
              label="Description"
              hint="Under the headline, and the text search results show under the page title."
              value={form.intro}
              max={L.intro}
              multiline
              placeholder="Browse upcoming conferences, workshops and webinars, register in a few minutes, and download your certificates from My events afterwards."
              disabled={readOnly}
              onChange={(v) => set({ intro: v })}
            />
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Sections</h3>
            <ul className="divide-y rounded-md border">
              {SECTIONS.map((s) => (
                <li key={s.key} className="flex items-start justify-between gap-4 p-3.5">
                  <div className="space-y-0.5">
                    <Label htmlFor={`catalogue-${s.key}`}>{s.label}</Label>
                    <p className="text-xs text-muted-foreground">{s.hint}</p>
                  </div>
                  <Switch id={`catalogue-${s.key}`} checked={form[s.key]} disabled={readOnly} onCheckedChange={(v) => set({ [s.key]: v })} />
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-4">
            <h3 className="text-sm font-semibold">Footer</h3>
            <TextField
              id="catalogue-footer-about"
              label="About line"
              value={form.footerAbout}
              max={L.footerAbout}
              multiline
              placeholder={`Medical conferences, workshops and webinars, organised by ${defaults.organizationName}.`}
              disabled={readOnly}
              onChange={(v) => set({ footerAbout: v })}
            />
            <div className="grid gap-4 md:grid-cols-2">
              <TextField
                id="catalogue-contact-email"
                label="Contact email"
                hint="Empty uses the company email from Billing."
                value={form.contactEmail}
                max={L.contactEmail}
                placeholder={defaults.companyEmail ?? "events@example.com"}
                disabled={readOnly}
                onChange={(v) => set({ contactEmail: v })}
              />
              <TextField
                id="catalogue-contact-phone"
                label="Contact phone"
                hint="Empty uses the company phone from Billing."
                value={form.contactPhone}
                max={L.contactPhone}
                placeholder={defaults.companyPhone ?? "+971 4 000 0000"}
                disabled={readOnly}
                onChange={(v) => set({ contactPhone: v })}
              />
            </div>
          </section>

          <section className="space-y-4">
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">Accounts</h3>
              <p className="text-xs text-muted-foreground">
                Linked from the Create an account form at /signup. Each event keeps its own registration terms.
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <TextField
                id="catalogue-terms-url"
                label="Terms of use link"
                hint="An https address. Empty shows the agreement without a link."
                value={form.termsUrl}
                max={L.linkUrl}
                placeholder="https://example.com/terms"
                disabled={readOnly}
                onChange={(v) => set({ termsUrl: v })}
              />
              <TextField
                id="catalogue-privacy-url"
                label="Privacy policy link"
                hint="An https address."
                value={form.privacyUrl}
                max={L.linkUrl}
                placeholder="https://example.com/privacy"
                disabled={readOnly}
                onChange={(v) => set({ privacyUrl: v })}
              />
            </div>
          </section>

          {!readOnly && (
            <div className="flex justify-end border-t pt-4">
              <Button onClick={onSave} disabled={save.isPending}>
                {save.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save catalogue settings
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <ListedEvents events={data.events} />
    </div>
  );
}

function TextField({
  id,
  label,
  hint,
  value,
  max,
  placeholder,
  multiline,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  max: number;
  placeholder: string;
  multiline?: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const props = { id, value, maxLength: max, placeholder, disabled, onChange: (e: { target: { value: string } }) => onChange(e.target.value) };
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {multiline ? <Textarea rows={3} {...props} /> : <Input {...props} />}
      <p className="flex justify-between gap-3 text-xs text-muted-foreground">
        <span>{hint}</span>
        <span className="shrink-0 tabular-nums">
          {value.length}/{max}
        </span>
      </p>
    </div>
  );
}

/**
 * Which events the catalogue lists: the same switch as each event's Settings,
 * Registration tab, saved as it is flipped. Published, live and completed
 * events only; a draft never lists.
 */
function ListedEvents({ events }: { events: CatalogueSettingsResponse["events"] }) {
  const setListing = useSetCatalogueListing();
  const [pending, setPending] = useState<string | null>(null);
  // Listing changes an event's own settings, a key of its own.
  const canList = useCan("events.settings") === "allowed";
  const now = Date.now();
  const listedCount = events.filter((e) => e.listed).length;

  const toggle = async (eventId: string, listed: boolean) => {
    setPending(eventId);
    try {
      await setListing.mutateAsync({ eventId, listed });
      toast.success(listed ? "Listed in the catalogue" : "Removed from the catalogue");
    } catch (err) {
      console.error("settings:catalogue-listing-failed", err);
      toast.error(err instanceof Error ? err.message : "Couldn't change the listing");
    } finally {
      setPending(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Listed events</CardTitle>
        <CardDescription>
          {listedCount} of {events.length} published {events.length === 1 ? "event is" : "events are"} in the catalogue. Past events move to its
          Past tab. Each event&apos;s own Settings, Registration tab has the same switch.
          {!canList && " Changing a listing needs permission to edit event settings."}
          {events.length >= EVENT_LIST_CAP && ` Showing the ${EVENT_LIST_CAP} most recent; older events are listed from their own settings.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No published events yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {events.map((e) => {
              const past = new Date(e.endDate).getTime() < now;
              return (
                <li key={e.id} className="flex items-center justify-between gap-4 p-3.5">
                  <div className="min-w-0 space-y-0.5">
                    <Link href={`/events/${e.id}/settings`} className="block truncate text-sm font-medium hover:underline">
                      {e.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {new Date(e.startDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                      {[e.city, e.country].filter(Boolean).length > 0 && ` · ${[e.city, e.country].filter(Boolean).join(", ")}`}
                      {past && " · Past"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {e.listed && (
                      <Link href={`/e/${e.slug}`} target="_blank" rel="noopener" className="hidden text-xs text-primary hover:underline sm:inline">
                        Public page
                      </Link>
                    )}
                    {pending === e.id && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    <Switch
                      checked={e.listed}
                      disabled={!canList || pending !== null}
                      onCheckedChange={(v) => toggle(e.id, v)}
                      aria-label={`${e.listed ? "Remove" : "List"} ${e.name} ${e.listed ? "from" : "in"} the catalogue`}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
