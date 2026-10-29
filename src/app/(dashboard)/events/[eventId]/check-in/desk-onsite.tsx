"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, MonitorSmartphone, RefreshCw, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TitleSelect } from "@/components/ui/title-select";
import { CountrySelect } from "@/components/ui/country-select";
import { fetchApi } from "@/hooks/use-api";

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
}

interface WaitingEntry extends OnsitePerson {
  /** When their link expires; the entry drops off after it. */
  until: number;
  completed: boolean;
}

interface OnsiteLink {
  url: string;
  qr: string;
  expiresAt: string;
}

const POLL_MS = 4000;

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
 * §5.1). Polls each waiting person's own registration, not the whole list,
 * and calls `onCompleted` once when someone finishes.
 */
export function useWaitingList(eventId: string, onCompleted: () => void) {
  const [entries, setEntries] = useState<WaitingEntry[]>([]);
  // A ref, so a new callback each render does not restart the poll's timer.
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
    const ids = pending.split(",");
    const timer = setInterval(async () => {
      const finished: string[] = [];
      for (const id of ids) {
        try {
          const reg = await fetchApi<{ completedAt?: string | null; userId?: string | null }>(
            `/api/events/${eventId}/registrations/${id}`,
            { cache: "no-store" },
          );
          if (reg.completedAt || reg.userId) finished.push(id);
        } catch (err) {
          console.error("[desk] waiting poll failed", err);
        }
      }
      update((prev) => prev.filter((e) => e.until > Date.now()));
      if (finished.length === 0) return;
      update((prev) => prev.map((e) => (finished.includes(e.id) ? { ...e, completed: true } : e)));
      onCompletedRef.current();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, eventId, update]);

  return { entries, add, remove };
}

function useCountdown(expiresAt: string | null): string {
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
  if (!expiresAt) return "";
  const left = Math.max(0, Date.parse(expiresAt) - now);
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  return left === 0 ? "expired" : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function CompleteOnsiteDialog({
  eventId,
  person,
  completed,
  onLinkCreated,
  onAdmit,
  onClose,
}: {
  eventId: string;
  person: OnsitePerson | null;
  /** Their form arrived (from the waiting list's poll). */
  completed: boolean;
  onLinkCreated: (person: OnsitePerson, expiresAt: string) => void;
  onAdmit: () => void;
  onClose: () => void;
}) {
  const [link, setLink] = useState<OnsiteLink | null>(null);
  const [loading, setLoading] = useState(false);
  const [where, setWhere] = useState<"phone" | "tablet">("phone");
  const countdown = useCountdown(link?.expiresAt ?? null);

  const createLink = useCallback(async () => {
    if (!person) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/events/${eventId}/registrations/${person.id}/onsite-link`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error || "Could not create the link");
        return;
      }
      setLink(data);
      onLinkCreated(person, data.expiresAt);
    } catch (err) {
      console.error("[desk] onsite link failed", err);
      toast.error("Network error: no link was created");
    } finally {
      setLoading(false);
    }
  }, [eventId, person, onLinkCreated]);

  useEffect(() => {
    setLink(null);
    setWhere("phone");
    if (person && !completed) createLink();
    // A new person opens a new link; re-renders of the same person must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person?.id]);

  const openOnTablet = () => {
    if (!link) return;
    window.open(`${link.url}&mode=tablet`, "_blank");
  };

  return (
    <Dialog open={!!person} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Complete onsite</DialogTitle>
          <DialogDescription>
            {person?.name} fills in the rest of their registration form. The link works once, for 30 minutes.
          </DialogDescription>
        </DialogHeader>

        {completed ? (
          <div className="flex items-center gap-3 rounded-lg border border-green-200 bg-green-50 p-4 text-green-800">
            <CheckCircle2 className="h-5 w-5 shrink-0" />
            <p className="text-sm font-medium">Their details are complete.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex rounded-lg border p-1 gap-1">
              <Button type="button" size="sm" variant={where === "phone" ? "default" : "ghost"} className="flex-1 gap-1.5" onClick={() => setWhere("phone")}>
                <Smartphone className="h-4 w-4" /> Their phone
              </Button>
              <Button type="button" size="sm" variant={where === "tablet" ? "default" : "ghost"} className="flex-1 gap-1.5" onClick={() => setWhere("tablet")}>
                <MonitorSmartphone className="h-4 w-4" /> This tablet
              </Button>
            </div>
            {loading && (
              <div className="flex h-56 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}
            {!loading && link && where === "phone" && (
              <div className="flex flex-col items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL from the route */}
                <img src={link.qr} alt="Scan to complete the registration form" className="h-56 w-56 rounded border bg-white p-2" />
                <p className="text-xs text-muted-foreground">Ask them to scan this with their phone camera.</p>
              </div>
            )}
            {!loading && link && where === "tablet" && (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <p className="text-sm text-muted-foreground">
                  The form opens in a new tab with no password and nothing remembered between people. Hand them the tablet; it closes itself when they finish.
                </p>
                <Button type="button" onClick={openOnTablet} className="gap-1.5">
                  <MonitorSmartphone className="h-4 w-4" /> Open the form on this tablet
                </Button>
              </div>
            )}
            {link && (
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="tabular-nums">Expires in {countdown}</span>
                <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={createLink} disabled={loading}>
                  <RefreshCw className="h-3 w-3" /> New link
                </Button>
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
