"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Clock, Loader2, MonitorSmartphone, RefreshCw, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TitleSelect } from "@/components/ui/title-select";
import { CountrySelect } from "@/components/ui/country-select";
import { fetchApi } from "@/hooks/use-api";
import { nextPollBatch } from "@/lib/desk-enter";

/**
 * Complete onsite and Edit, for the registration desk (docs/ONSITE_DESK_PLAN.md
 * §5). Someone the organiser added or imported finishes their own form on their
 * phone (a QR code) or on the desk tablet; the desk keeps a list of who is still
 * filling it in and admits them when they finish.
 */

export interface OnsitePerson {
  id: string;
  name: string;
  email: string;
  typeName?: string | null;
}

export interface OnsiteLink {
  url: string;
  qr: string;
  expiresAt: string;
}

interface WaitingEntry extends OnsitePerson {
  /** When their link expires; the entry drops off after it. */
  until: number;
  completed: boolean;
}

const POLL_MS = 4000;
const POLL_BATCH = 50;

function readWaiting(eventId: string): WaitingEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(`desk-waiting:${eventId}`) || "[]");
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e.id === "string" && e.until > Date.now()) : [];
  } catch {
    return [];
  }
}

function writeWaiting(eventId: string, entries: WaitingEntry[]) {
  try {
    localStorage.setItem(`desk-waiting:${eventId}`, JSON.stringify(entries));
  } catch {
    // Private window or blocked storage: the list lives for this page only.
  }
}

/**
 * Who is still completing their form at this desk, kept per desk (the plan's
 * §5.1). One small status request for everyone waiting, the next only after
 * the last answered, paused while the tab is hidden (review of cf9775fd,
 * MED 5). People no longer on the event, or cancelled, drop off.
 */
export function useWaitingList(eventId: string, onCompleted: () => void) {
  const [entries, setEntries] = useState<WaitingEntry[]>([]);
  // A ref, so a new callback each render does not restart the poll.
  const onCompletedRef = useRef(onCompleted);
  useEffect(() => {
    onCompletedRef.current = onCompleted;
  }, [onCompleted]);

  useEffect(() => {
    setEntries(readWaiting(eventId));
  }, [eventId]);

  const update = useCallback(
    (next: (prev: WaitingEntry[]) => WaitingEntry[]) => {
      setEntries((prev) => {
        const value = next(prev);
        writeWaiting(eventId, value);
        return value;
      });
    },
    [eventId],
  );

  const add = useCallback(
    (person: OnsitePerson, expiresAt: string) => {
      const until = Date.parse(expiresAt);
      update((prev) => [...prev.filter((e) => e.id !== person.id), { ...person, until, completed: false }]);
    },
    [update],
  );

  const remove = useCallback((id: string) => update((prev) => prev.filter((e) => e.id !== id)), [update]);

  const pending = entries.filter((e) => !e.completed).map((e) => e.id).join(",");
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    let offset = 0;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped) return;
      if (document.hidden) {
        timer = setTimeout(poll, POLL_MS);
        return;
      }
      // The route takes 50 at a time; a longer queue is polled in turn, the
      // next 50 each cycle (review of 44e6c9b1: it used to ask the same 50).
      const next = nextPollBatch(pending.split(","), offset, POLL_BATCH);
      offset = next.offset;
      const requested = new Set(next.batch);
      try {
        const { statuses } = await fetchApi<{ statuses: Array<{ id: string; status: string; completed: boolean }> }>(
          `/api/events/${eventId}/registrations/completion-status?ids=${encodeURIComponent([...requested].join(","))}`,
          { cache: "no-store" },
        );
        // The list changed while this was in flight: a newer poll owns it now
        // (review of 055680a9, HIGH 1).
        if (stopped) return;
        const byId = new Map(statuses.map((s) => [s.id, s]));
        const finished = statuses.filter((s) => s.completed).map((s) => s.id);
        update((prev) =>
          prev
            .filter((e) => e.until > Date.now())
            // Asked about and gone from the event, or cancelled: nothing left to
            // wait for. Someone this request did not ask about stays.
            .filter((e) => e.completed || !requested.has(e.id) || (byId.has(e.id) && byId.get(e.id)?.status !== "CANCELLED"))
            .map((e) => (finished.includes(e.id) ? { ...e, completed: true } : e)),
        );
        if (finished.length > 0) onCompletedRef.current();
      } catch (err) {
        console.error("[desk] waiting poll failed", err);
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    };
    timer = setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pending, eventId, update]);

  return { entries, add, remove };
}

function useCountdown(expiresAt: string | null): { label: string; expired: boolean } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    // Tick at once: the dialog stays mounted, so the first `now` is stale.
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [expiresAt]);
  if (!expiresAt) return { label: "", expired: false };
  const left = Math.max(0, Date.parse(expiresAt) - now);
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  return { label: `${minutes}:${String(seconds).padStart(2, "0")}`, expired: left === 0 };
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((part) => part && !/\.$/.test(part))
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="space-y-3">
      {items.map((text, i) => (
        <li key={text} className="flex gap-3 text-sm text-slate-600">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            {i + 1}
          </span>
          <span className="pt-0.5">{text}</span>
        </li>
      ))}
    </ol>
  );
}

export function CompleteOnsiteDialog({
  eventId,
  person,
  completed,
  cachedLink,
  onLinkCreated,
  onWatch,
  onAdmit,
  onClose,
}: {
  eventId: string;
  person: OnsitePerson | null;
  /** Their form arrived (from the waiting list's poll or the list itself). */
  completed: boolean;
  /**
   * The link this desk already made for them. Shown again rather than minting
   * a new one, which would revoke the link they may be typing into (review of
   * cf9775fd, HIGH 2).
   */
  cachedLink: OnsiteLink | null;
  onLinkCreated: (person: OnsitePerson, link: OnsiteLink) => void;
  /** Watch someone whose link was made elsewhere (no link to show here). */
  onWatch: (person: OnsitePerson, expiresAt: string) => void;
  onAdmit: () => void;
  onClose: () => void;
}) {
  const [link, setLink] = useState<OnsiteLink | null>(null);
  const [loading, setLoading] = useState(false);
  const [where, setWhere] = useState<"phone" | "tablet">("phone");
  const [confirmReplace, setConfirmReplace] = useState(false);
  // A link made elsewhere (another desk, or this one before a reload) is still
  // open: its expiry, until staff choose to replace it or keep it.
  const [openElsewhere, setOpenElsewhere] = useState<string | null>(null);
  const countdown = useCountdown(link?.expiresAt ?? null);
  const elsewhereCountdown = useCountdown(openElsewhere);

  const createLink = useCallback(async (replace = false) => {
    if (!person) return;
    setLoading(true);
    setConfirmReplace(false);
    try {
      const res = await fetch(`/api/events/${eventId}/registrations/${person.id}/onsite-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ replace }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.code === "LINK_ACTIVE") {
        setOpenElsewhere(data.expiresAt);
        return;
      }
      setOpenElsewhere(null);
      if (!res.ok) {
        toast.error(data.error || "Could not create the link");
        return;
      }
      setLink(data);
      onLinkCreated(person, data);
    } catch (err) {
      console.error("[desk] onsite link failed", err);
      toast.error("Network error: no link was created");
    } finally {
      setLoading(false);
    }
  }, [eventId, person, onLinkCreated]);

  useEffect(() => {
    setWhere("phone");
    setConfirmReplace(false);
    setOpenElsewhere(null);
    const live = cachedLink && Date.parse(cachedLink.expiresAt) > Date.now() ? cachedLink : null;
    setLink(live);
    if (person && !completed && !live) createLink();
    // A new person opens the window; re-renders of the same person must not mint again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person?.id]);

  /** Keep the open link and watch for their form, as for a link made here. */
  const keepWaiting = () => {
    if (person && openElsewhere) onWatch(person, openElsewhere);
    onClose();
  };

  // The other link ran out while this notice was up: nothing left to protect.
  useEffect(() => {
    if (openElsewhere && elsewhereCountdown.expired && !loading) createLink(false);
  }, [openElsewhere, elsewhereCountdown.expired, loading, createLink]);

  const openOnTablet = () => {
    if (!link) return;
    // noopener: the form tab gets no handle back to this signed-in staff page.
    window.open(`${link.url}&mode=tablet`, "_blank", "noopener");
  };

  return (
    <Dialog open={!!person} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Complete onsite</DialogTitle>
          <DialogDescription>They fill in the rest of their registration form themselves. The link works once, for 30 minutes.</DialogDescription>
        </DialogHeader>

        {person && (
          <div className="flex items-center gap-3 rounded-lg border bg-slate-50 p-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
              {initials(person.name)}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{person.name}</p>
              <p className="truncate text-xs text-muted-foreground">{person.email}</p>
            </div>
            {person.typeName && <Badge variant="outline">{person.typeName}</Badge>}
            {completed ? (
              <Badge className="bg-green-100 text-green-800 hover:bg-green-100">Form completed</Badge>
            ) : (
              <Badge variant="outline" className="border-amber-200 text-amber-700">Waiting</Badge>
            )}
          </div>
        )}

        {completed ? (
          <div className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 p-4 text-green-900">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
            <div className="space-y-1 text-sm">
              <p className="font-medium">Their details are complete.</p>
              <p className="text-green-800">Submitting the form sends their confirmation email with the entry barcode. Admit them to check in and print the badge.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {(link || loading) && (
            <div className="grid grid-cols-2 gap-1 rounded-lg border p-1">
              <Button type="button" size="sm" variant={where === "phone" ? "default" : "ghost"} className="gap-1.5" onClick={() => setWhere("phone")}>
                <Smartphone className="h-4 w-4" /> Their phone
              </Button>
              <Button type="button" size="sm" variant={where === "tablet" ? "default" : "ghost"} className="gap-1.5" onClick={() => setWhere("tablet")}>
                <MonitorSmartphone className="h-4 w-4" /> This tablet
              </Button>
            </div>
            )}

            {!loading && openElsewhere && !link && (
              <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <p className="font-medium">A link for them is already open, expiring in {elsewhereCountdown.label}.</p>
                <p>
                  It was made at another desk, or here before the page reloaded. They may be filling it in right now; a new
                  link would cancel it.
                </p>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="destructive" onClick={() => createLink(true)}>
                    Replace it with a new link
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={keepWaiting}>
                    Keep it and wait
                  </Button>
                </div>
              </div>
            )}

            {loading && (
              <div className="flex h-60 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}

            {!loading && link && where === "phone" && (
              <div className="grid items-center gap-6 sm:grid-cols-[auto_1fr]">
                {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL from the route */}
                <img src={link.qr} alt="Scan to complete the registration form" className="mx-auto h-60 w-60 rounded-lg border bg-white p-2" />
                <Steps
                  items={[
                    "Ask them to point their phone camera at the code.",
                    "They fill in the details we do not have yet and submit.",
                    "Their confirmation email arrives, and their name turns green under Waiting to complete.",
                  ]}
                />
              </div>
            )}

            {!loading && link && where === "tablet" && (
              <div className="grid items-center gap-6 sm:grid-cols-[1fr_auto]">
                <Steps
                  items={[
                    "Open the form in a new tab and hand them the tablet.",
                    "No password is asked, and nothing is remembered for the next person.",
                    "When they submit, the tab thanks them and closes itself.",
                  ]}
                />
                <Button type="button" size="lg" onClick={openOnTablet} className="gap-2">
                  <MonitorSmartphone className="h-5 w-5" /> Open the form
                </Button>
              </div>
            )}

            {link && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
                <span className={`inline-flex items-center gap-1.5 tabular-nums ${countdown.expired ? "text-red-600" : ""}`}>
                  <Clock className="h-3.5 w-3.5" />
                  {countdown.expired ? "This link has expired" : `Link expires in ${countdown.label}`}
                </span>
                {confirmReplace ? (
                  <span className="inline-flex items-center gap-2">
                    <span>This cancels the link they may be using.</span>
                    <Button type="button" size="sm" variant="destructive" className="h-7 text-xs" onClick={() => createLink(true)} disabled={loading}>
                      Replace
                    </Button>
                    <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirmReplace(false)}>
                      Keep
                    </Button>
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 text-xs"
                    // An expired link replaces nothing, so it needs no warning.
                    onClick={() => (countdown.expired ? createLink(true) : setConfirmReplace(true))}
                    disabled={loading}
                  >
                    <RefreshCw className="h-3 w-3" /> New link
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {completed ? "Close" : "Serve the next person"}
          </Button>
          {completed && (
            <Button type="button" onClick={onAdmit}>
              Admit now
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface EditablePerson {
  id: string;
  updatedAt?: string;
  attendee: {
    title?: string | null;
    firstName: string;
    lastName: string;
    organization?: string | null;
    jobTitle?: string | null;
    country?: string | null;
  };
}

/**
 * Fix what prints on the badge before it prints: name, title, organisation,
 * position, country. Email has its own route (Change Email) and stays out.
 */
export function EditDetailsDialog({
  eventId,
  person,
  onSaved,
  onClose,
}: {
  eventId: string;
  person: EditablePerson | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [fields, setFields] = useState({ title: "", firstName: "", lastName: "", organization: "", jobTitle: "", country: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!person) return;
    const a = person.attendee;
    setFields({
      title: a.title ?? "",
      firstName: a.firstName,
      lastName: a.lastName,
      organization: a.organization ?? "",
      jobTitle: a.jobTitle ?? "",
      country: a.country ?? "",
    });
  }, [person]);

  const set = (key: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!person) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/events/${eventId}/registrations/${person.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Refused with 409 when someone else saved first, rather than overwriting them.
          ...(person.updatedAt && { expectedUpdatedAt: person.updatedAt }),
          attendee: {
            title: fields.title || null,
            firstName: fields.firstName.trim(),
            lastName: fields.lastName.trim(),
            organization: fields.organization.trim(),
            jobTitle: fields.jobTitle.trim(),
            country: fields.country,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.code === "STALE_WRITE") {
        // Someone saved first: reload their row so a retry starts from it,
        // rather than failing the same way every time (review of cf9775fd).
        toast.error("Someone else changed these details. The latest are loaded; check them and edit again.");
        onSaved();
        onClose();
        return;
      }
      if (!res.ok) {
        toast.error(data.error || "The changes were not saved");
        return;
      }
      toast.success("Saved");
      onSaved();
      onClose();
    } catch (err) {
      console.error("[desk] edit failed", err);
      toast.error("Network error: the changes were NOT saved");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!person} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit details</DialogTitle>
          <DialogDescription>What prints on the badge. To change the email, use the registration page.</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-[110px_1fr_1fr] gap-3">
            <div className="space-y-1">
              <Label>Title</Label>
              <TitleSelect value={fields.title} onChange={(v) => setFields((f) => ({ ...f, title: v }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-first">First name</Label>
              <Input id="edit-first" value={fields.firstName} onChange={set("firstName")} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-last">Last name</Label>
              <Input id="edit-last" value={fields.lastName} onChange={set("lastName")} required />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="edit-position">Position</Label>
              <Input id="edit-position" value={fields.jobTitle} onChange={set("jobTitle")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-org">Organization</Label>
              <Input id="edit-org" value={fields.organization} onChange={set("organization")} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label>Country</Label>
              <CountrySelect value={fields.country} onChange={(v) => setFields((f) => ({ ...f, country: v }))} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
