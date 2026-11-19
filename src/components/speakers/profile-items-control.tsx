"use client";

/**
 * What a speaker's form link asks for (Nov 19, 2026): photo, bio, passport
 * copy, cover letter, presentation. On the speaker page's "Photo & Documents
 * form" card: this speaker's list ("use the event's default", or their own),
 * and the event's default itself, which every speaker without their own list
 * follows. The pattern reimbursement's claim items use. Every rule is the
 * server's (src/lib/speaker-profile/constants.ts); this only shows them.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PROFILE_ITEMS, PROFILE_ITEM_KEYS, profileItemsSummary, type ProfileItemKey } from "@/lib/speaker-profile/constants";

/** The five ticks. At least one stays on: a form with nothing on it tells the speaker nothing. */
export function ProfileItemsPicker({
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  value: ProfileItemKey[];
  onChange: (next: ProfileItemKey[]) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const toggle = (key: ProfileItemKey, on: boolean) => {
    const next = on ? [...value, key] : value.filter((k) => k !== key);
    if (next.length === 0) return;
    onChange(PROFILE_ITEM_KEYS.filter((k) => next.includes(k)));
  };
  return (
    <div className="grid gap-2">
      {PROFILE_ITEMS.map((item) => {
        const checked = value.includes(item.key);
        const id = `${idPrefix}-${item.key}`;
        return (
          <label
            key={item.key}
            htmlFor={id}
            className={`flex items-start gap-2.5 rounded-md border px-3 py-2 text-sm ${disabled ? "opacity-60" : "cursor-pointer hover:bg-muted/40"} ${
              checked ? "border-primary/40 bg-primary/[0.04]" : "border-border"
            }`}
          >
            <Checkbox id={id} className="mt-0.5" checked={checked} disabled={disabled} onCheckedChange={(v) => toggle(item.key, v === true)} />
            <span className="min-w-0">
              <span className="block font-medium">{item.label}</span>
              <span className="block text-xs text-muted-foreground">{item.hint}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

export function SpeakerProfileItemsControl({ eventId, speakerId }: { eventId: string; speakerId: string }) {
  const speakerUrl = `/api/events/${eventId}/speakers/${speakerId}/profile-form-items`;
  const eventUrl = `/api/events/${eventId}/speakers/profile-form-settings`;

  /** The speaker's own list (null: the event's default) and the default itself, as saved. */
  const [saved, setSaved] = useState<{ items: ProfileItemKey[] | null; eventItems: ProfileItemKey[] } | null>(null);
  const [draft, setDraft] = useState<ProfileItemKey[]>([...PROFILE_ITEM_KEYS]);
  const [busy, setBusy] = useState(false);
  const [defaultOpen, setDefaultOpen] = useState(false);
  const [defaultDraft, setDefaultDraft] = useState<ProfileItemKey[]>([...PROFILE_ITEM_KEYS]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(speakerUrl);
      const json = await res.json().catch(() => null);
      if (!res.ok || !json) {
        console.error("profile-items:load-failed", res.status, json?.error);
        return;
      }
      setSaved({ items: json.items ?? null, eventItems: json.eventItems });
      setDraft(json.items ?? json.eventItems);
    } catch (err) {
      console.error("profile-items:load-error", err);
    }
  }, [speakerUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveSpeaker = async (items: ProfileItemKey[] | null) => {
    setBusy(true);
    try {
      const res = await fetch(speakerUrl, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json) {
        toast.error(json?.error || "Could not save what this speaker is asked for");
        return;
      }
      setSaved({ items: json.items ?? null, eventItems: json.eventItems });
      setDraft(json.items ?? json.eventItems);
      toast.success(items === null ? "This speaker follows the event's default" : `This speaker is asked for: ${profileItemsSummary(items)}`);
    } catch (err) {
      console.error("profile-items:save-error", err);
      toast.error("Could not save what this speaker is asked for");
    } finally {
      setBusy(false);
    }
  };

  const saveDefault = async () => {
    setBusy(true);
    try {
      const res = await fetch(eventUrl, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: defaultDraft }) });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json) {
        toast.error(json?.error || "Could not save the event's default");
        return;
      }
      toast.success(`The event now asks speakers for: ${profileItemsSummary(json.items)}`);
      setDefaultOpen(false);
      await load();
    } catch (err) {
      console.error("profile-items:save-default-error", err);
      toast.error("Could not save the event's default");
    } finally {
      setBusy(false);
    }
  };

  if (!saved) return null;
  const own = saved.items !== null;
  const dirty = own && !sameList(draft, saved.items ?? []);

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3">
      <p className="text-sm font-medium">What this speaker is asked for</p>
      <label htmlFor="profile-items-default" className="flex items-start gap-2 text-sm">
        <Checkbox
          id="profile-items-default"
          className="mt-0.5"
          checked={!own}
          disabled={busy}
          onCheckedChange={(v) => {
            // Ticked: back to the event's default, saved at once. Unticked:
            // their own list, starting from the default, saved with the button.
            if (v === true) void saveSpeaker(null);
            else {
              setSaved({ ...saved, items: saved.eventItems });
              setDraft(saved.eventItems);
            }
          }}
        />
        <span>
          Use the event&apos;s default
          <span className="block text-xs text-muted-foreground">{profileItemsSummary(saved.eventItems)}</span>
        </span>
      </label>
      {own && (
        <div className="space-y-2">
          <ProfileItemsPicker idPrefix="speaker-profile-item" value={draft} onChange={setDraft} disabled={busy} />
          <Button size="sm" disabled={busy || !dirty} onClick={() => void saveSpeaker(draft)}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Save for this speaker
          </Button>
        </div>
      )}
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-50"
        disabled={busy}
        onClick={() => {
          setDefaultDraft(saved.eventItems);
          setDefaultOpen(true);
        }}
      >
        <Settings2 className="h-3.5 w-3.5" /> Change the event&apos;s default
      </button>

      <Dialog open={defaultOpen} onOpenChange={setDefaultOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>What this event asks its speakers for</DialogTitle>
            <DialogDescription>
              Every speaker follows this unless they have their own list. A change shows on a speaker&apos;s form the next time they open their
              link.
            </DialogDescription>
          </DialogHeader>
          <ProfileItemsPicker idPrefix="event-profile-item" value={defaultDraft} onChange={setDefaultDraft} disabled={busy} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDefaultOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void saveDefault()} disabled={busy || sameList(defaultDraft, saved.eventItems)}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              Save the default
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
