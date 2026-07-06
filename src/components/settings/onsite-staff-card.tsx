"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { UserPlus, Trash2, Loader2, CalendarDays, X, Check } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface OnsiteStaff {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  active: boolean;
  eventIds: string[];
}
interface EventLite {
  id: string;
  name: string;
  startDate: string;
}

async function fetchOnsiteStaff(): Promise<{ onsiteStaff: OnsiteStaff[]; events: EventLite[] }> {
  const res = await fetch("/api/organization/onsite-staff");
  if (!res.ok) throw new Error("Failed to load onsite staff");
  return res.json();
}

async function assignToEvent(eventId: string, userId: string) {
  const res = await fetch(`/api/events/${eventId}/onsite-staff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Failed to assign");
}
async function unassignFromEvent(eventId: string, userId: string) {
  const res = await fetch(`/api/events/${eventId}/onsite-staff?userId=${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Failed to unassign");
}

export function OnsiteStaffCard() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["onsite-staff"],
    queryFn: fetchOnsiteStaff,
  });
  const staff = data?.onsiteStaff ?? [];
  const events = data?.events ?? [];
  const eventName = (id: string) => events.find((e) => e.id === id)?.name ?? "Unknown event";
  const invalidate = () => qc.invalidateQueries({ queryKey: ["onsite-staff"] });

  const [addOpen, setAddOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<OnsiteStaff | null>(null);

  // Create a temp account + assign to the picked events, in one submit.
  const createMutation = useMutation({
    mutationFn: async (input: {
      firstName: string;
      lastName: string;
      email: string;
      password: string;
      eventIds: string[];
    }) => {
      const res = await fetch("/api/organization/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          role: "ONSITE",
          password: input.password,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Failed to create the account");
      const userId = body.id as string;
      // Assign to each selected event. Collect failures so a partial assign
      // still surfaces (the account exists; the admin can retry the event).
      const failed: string[] = [];
      for (const eventId of input.eventIds) {
        try {
          await assignToEvent(eventId, userId);
        } catch {
          failed.push(eventName(eventId));
        }
      }
      return { failed };
    },
    onSuccess: ({ failed }) => {
      invalidate();
      setAddOpen(false);
      if (failed.length) {
        toast.warning(`Account created, but couldn't assign: ${failed.join(", ")}. Retry from the row.`);
      } else {
        toast.success("Temp staff added");
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to add temp staff"),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ eventId, userId, assign }: { eventId: string; userId: string; assign: boolean }) =>
      assign ? assignToEvent(eventId, userId) : unassignFromEvent(eventId, userId),
    onSuccess: () => invalidate(),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to update assignment"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (s: OnsiteStaff) => {
      // Strip the id from every event's onsiteUserIds first so no stale id
      // lingers in settings (best-effort), then delete the account.
      for (const eid of s.eventIds) {
        try {
          await unassignFromEvent(eid, s.id);
        } catch {
          /* best-effort cleanup — the account delete below is what matters */
        }
      }
      const res = await fetch(`/api/organization/users/${s.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || "Failed to delete");
    },
    onSuccess: () => {
      invalidate();
      setConfirmDelete(null);
      toast.success("Temp staff account deleted");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to delete account"),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-[#00aade]" />
            Onsite / Temp Staff
          </CardTitle>
          <CardDescription>
            Registration-desk staff scoped to specific events — they can add registrations, check
            attendees in, and print badges, but <strong>only for the events you assign them to</strong>.
            Money is always hidden. Remove them from an event (or delete the account) to revoke access.
          </CardDescription>
        </div>
        <Button onClick={() => setAddOpen(true)} className="shrink-0">
          <UserPlus className="mr-2 h-4 w-4" />
          Add temp staff
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : isError ? (
          <div className="flex h-24 items-center justify-center text-sm text-destructive">
            Couldn&apos;t load temp staff. Refresh and try again.
          </div>
        ) : staff.length === 0 ? (
          <div className="flex h-24 flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
            <span>No temp staff yet.</span>
            <span>Add one and assign them to an event — they&apos;ll see only that event.</span>
          </div>
        ) : (
          <div className="space-y-3">
            {staff.map((s) => (
              <div key={s.id} className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {s.firstName} {s.lastName}
                    </span>
                    <Badge
                      className={
                        s.active
                          ? "bg-green-100 text-green-800 hover:bg-green-100"
                          : "bg-amber-100 text-amber-800 hover:bg-amber-100"
                      }
                    >
                      {s.active ? "Active" : "Pending"}
                    </Badge>
                  </div>
                  <div className="truncate text-sm text-muted-foreground">{s.email}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {s.eventIds.length === 0 ? (
                      <span className="text-xs italic text-muted-foreground">No events assigned — no access yet</span>
                    ) : (
                      s.eventIds.map((eid) => (
                        <Badge key={eid} variant="secondary" className="gap-1">
                          {eventName(eid)}
                          <button
                            type="button"
                            aria-label={`Remove from ${eventName(eid)}`}
                            className="ml-0.5 rounded-full hover:text-destructive"
                            onClick={() => toggleMutation.mutate({ eventId: eid, userId: s.id, assign: false })}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm">
                        <CalendarDays className="mr-2 h-4 w-4" />
                        Manage events
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-72 p-0">
                      <div className="border-b p-2 text-xs font-medium text-muted-foreground">
                        Assign to events
                      </div>
                      <div className="max-h-64 overflow-y-auto p-1">
                        {events.length === 0 ? (
                          <div className="p-3 text-center text-xs text-muted-foreground">No events yet.</div>
                        ) : (
                          events.map((e) => {
                            const assigned = s.eventIds.includes(e.id);
                            return (
                              <button
                                key={e.id}
                                type="button"
                                onClick={() => toggleMutation.mutate({ eventId: e.id, userId: s.id, assign: !assigned })}
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                              >
                                <span className={`flex h-4 w-4 items-center justify-center rounded border ${assigned ? "border-[#00aade] bg-[#00aade] text-white" : "border-input"}`}>
                                  {assigned && <Check className="h-3 w-3" />}
                                </span>
                                <span className="truncate">{e.name}</span>
                              </button>
                            );
                          })
                        )}
                      </div>
                    </PopoverContent>
                  </Popover>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setConfirmDelete(s)}
                    aria-label="Delete temp staff account"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <AddTempStaffDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        events={events}
        pending={createMutation.isPending}
        onSubmit={(v) => createMutation.mutate(v)}
      />

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this temp staff account?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete && (
                <>
                  {confirmDelete.firstName} {confirmDelete.lastName} ({confirmDelete.email}) will lose
                  access to every event and won&apos;t be able to sign in. This can&apos;t be undone.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDelete && deleteMutation.mutate(confirmDelete)}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function AddTempStaffDialog({
  open,
  onOpenChange,
  events,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  events: EventLite[];
  pending: boolean;
  onSubmit: (v: { firstName: string; lastName: string; email: string; password: string; eventIds: string[] }) => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [eventIds, setEventIds] = useState<string[]>([]);

  // Reset when closing so a reopened dialog is clean.
  const handleOpenChange = (o: boolean) => {
    if (!o) {
      setFirstName("");
      setLastName("");
      setEmail("");
      setPassword("");
      setEventIds([]);
    }
    onOpenChange(o);
  };

  const valid =
    firstName.trim() && lastName.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && password.length >= 8;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add temp staff</DialogTitle>
          <DialogDescription>
            Creates a registration-desk account and assigns it to the events you pick. Share the email
            + password with them — they can sign in right away. No verification email is sent.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="ts-first">First name</Label>
              <Input id="ts-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ts-last">Last name</Label>
              <Input id="ts-last" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ts-email">Email</Label>
            <Input id="ts-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="desk@example.com" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ts-password">Temporary password</Label>
            <Input id="ts-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
            <p className="text-xs text-muted-foreground">You&apos;ll hand this to the staffer to sign in.</p>
          </div>
          <div className="space-y-2">
            <Label>Assign to events</Label>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No events yet — create one first.</p>
            ) : (
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                {events.map((e) => (
                  <label key={e.id} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                    <Checkbox
                      checked={eventIds.includes(e.id)}
                      onCheckedChange={(c) =>
                        setEventIds((prev) => (c ? [...prev, e.id] : prev.filter((id) => id !== e.id)))
                      }
                    />
                    <span className="truncate">{e.name}</span>
                  </label>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Pick one event for a single-event desk worker, or several for a multi-day/hall staffer.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => onSubmit({ firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim(), password, eventIds })}
            disabled={!valid || pending}
          >
            {pending ? "Creating…" : "Create + assign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
