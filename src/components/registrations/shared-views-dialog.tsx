"use client";

/**
 * "Shared views" on the Registrations page (Sep 29, 2026;
 * docs/REGISTRATION_SHARE_PLAN.md): the organiser's list of named, read-only
 * registration links, and the editor for one. Checkboxes come from the
 * catalogue in src/lib/registration-share.ts, so the dialog, the routes and
 * the public page share one definition of every field.
 *
 * Not called "Share": the page already has "Share Link" for the public
 * registration form.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, Copy, ExternalLink, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { cn } from "@/lib/utils";
import { useCan } from "@/hooks/use-can";
import {
  LABEL_MAX,
  MAX_REGISTRATION_VIEWS,
  REGISTRATION_GROUP_TITLE,
  REGISTRATION_SHARE_FIELDS,
  REGISTRATION_SHARE_STATUSES,
  REGISTRATION_VIEW_PRESETS,
  defaultRegistrationView,
} from "@/lib/registration-share";
import {
  useRegistrationViewMutation,
  useRegistrationViews,
  type RegistrationViewBody,
  type RegistrationViewData,
  type RegistrationViewsResponse,
} from "@/hooks/use-api";

interface Props {
  eventId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Editing = { mode: "list" } | { mode: "new"; preset: string } | { mode: "edit"; id: string };

function absolute(path: string): string {
  return typeof window === "undefined" ? path : `${window.location.origin}${path}`;
}

function copyLink(path: string) {
  navigator.clipboard
    .writeText(absolute(path))
    .then(() => toast.success("Link copied"))
    .catch((err) => {
      console.error("[registration-views] copy failed", err);
      toast.error("Couldn't copy the link");
    });
}

export function SharedViewsDialog({ eventId, open, onOpenChange }: Props) {
  const { data, isLoading } = useRegistrationViews(eventId, open);
  const [editing, setEditing] = useState<Editing>({ mode: "list" });

  const close = (o: boolean) => {
    if (!o) setEditing({ mode: "list" });
    onOpenChange(o);
  };

  const current = editing.mode === "edit" ? data?.views.find((v) => v.id === editing.id) : undefined;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent border-b">
          <DialogTitle>Shared views</DialogTitle>
          <DialogDescription>
            Read-only, live lists of registrations for staff, each showing only what you choose. Amounts and payments are
            never shown.
          </DialogDescription>
        </DialogHeader>

        {isLoading || !data ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : editing.mode === "list" ? (
          <ViewList data={data} onNew={(preset) => setEditing({ mode: "new", preset })} onEdit={(id) => setEditing({ mode: "edit", id })} onClose={() => close(false)} />
        ) : (
          <ViewEditor
            // Keyed on the stored version: the draft starts from saved settings,
            // with no effect copying props into state.
            key={editing.mode === "edit" ? `${editing.id}:${current?.updatedAt ?? ""}` : `new:${editing.preset}`}
            eventId={eventId}
            options={data.options}
            view={current}
            preset={editing.mode === "new" ? editing.preset : undefined}
            onBack={() => setEditing({ mode: "list" })}
            onSaved={(id) => setEditing({ mode: "edit", id })}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ViewList({ data, onNew, onEdit, onClose }: { data: RegistrationViewsResponse; onNew: (preset: string) => void; onEdit: (id: string) => void; onClose: () => void }) {
  const atLimit = data.views.length >= MAX_REGISTRATION_VIEWS;
  return (
    <>
      <div className="px-6 py-5 space-y-5">
        {data.views.length === 0 ? (
          <p className="text-sm text-muted-foreground">No shared views yet. Start from one of these, then adjust it.</p>
        ) : (
          <ul className="divide-y rounded-lg border bg-muted/30">
            {data.views.map((v) => (
              <li key={v.id} className="flex flex-col sm:flex-row sm:items-center gap-2 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{v.label}</p>
                  <p className="text-xs text-muted-foreground">
                    <ViewStatus view={v} /> · {v.fields.length === 0 ? "names only" : `${v.fields.length} field${v.fields.length === 1 ? "" : "s"}`}
                    {v.expiresAt && !v.expired ? ` · expires ${new Date(v.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => copyLink(v.path)}>
                    <Copy className="h-4 w-4 mr-1" /> Copy
                  </Button>
                  <Button type="button" variant="outline" size="sm" asChild>
                    <a href={absolute(v.path)} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="h-4 w-4 mr-1" /> Open
                    </a>
                  </Button>
                  <Button type="button" size="sm" onClick={() => onEdit(v.id)}>
                    Edit
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">New view</h3>
          {atLimit ? (
            <p className="text-xs text-muted-foreground">An event can have {MAX_REGISTRATION_VIEWS} views. Remove one to add another.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-3">
              {REGISTRATION_VIEW_PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => onNew(p.key)}
                  className="text-left rounded-lg border bg-background p-3 hover:border-primary/50 hover:bg-primary/5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <Plus className="h-3.5 w-3.5 text-primary" /> {p.label}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">{p.description}</span>
                </button>
              ))}
            </div>
          )}
        </section>
        <p className="text-xs text-muted-foreground">
          A view is a convenience, not a restriction: staff who have their own sign-in can still open Registrations.
        </p>
      </div>
      <DialogFooter className="px-6 py-4 border-t bg-muted/30">
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

/** "Email", "Email and phone", "Email, additional email and phone". */
function listSentence(labels: string[]): string {
  const [first, ...rest] = labels.map((l, i) => (i === 0 ? l : l.toLowerCase()));
  if (rest.length === 0) return first ?? "";
  return `${[first, ...rest.slice(0, -1)].join(", ")} and ${rest[rest.length - 1]}`;
}

function ViewStatus({ view }: { view: RegistrationViewData }) {
  if (!view.enabled) return <span className="text-slate-500">Off</span>;
  if (view.expired) return <span className="text-amber-700">Expired</span>;
  return <span className="text-emerald-700">On</span>;
}

/** YYYY-MM-DD in the organiser's own timezone, for the date input. */
function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The chosen day's end, in the organiser's timezone, as an ISO instant. */
function fromDateInput(value: string): string | null {
  return value ? new Date(`${value}T23:59:59`).toISOString() : null;
}

function initialBody(view: RegistrationViewData | undefined, presetKey: string | undefined): RegistrationViewBody {
  if (view) {
    const { label, enabled, expiresAt, statuses, fields, ticketTypeIds, sponsorIds, promoCodeIds, includeFaculty } = view;
    return { label, enabled, expiresAt, statuses, fields, ticketTypeIds, sponsorIds, promoCodeIds, includeFaculty };
  }
  const preset = REGISTRATION_VIEW_PRESETS.find((p) => p.key === presetKey);
  const defaults = defaultRegistrationView();
  return {
    label: preset?.label ?? "",
    enabled: true,
    expiresAt: null,
    statuses: defaults.statuses,
    // A preset's contact fields were chosen by the organiser picking that
    // preset, which itself says "Asks you to confirm"; the confirm runs on save.
    fields: preset ? preset.fields : defaults.fields,
    ticketTypeIds: [],
    sponsorIds: [],
    promoCodeIds: [],
    includeFaculty: false,
  };
}

function ViewEditor({
  eventId,
  options,
  view,
  preset,
  onBack,
  onSaved,
}: {
  eventId: string;
  options: RegistrationViewsResponse["options"];
  view: RegistrationViewData | undefined;
  preset: string | undefined;
  onBack: () => void;
  onSaved: (id: string) => void;
}) {
  const mutate = useRegistrationViewMutation(eventId);
  // Sponsor attribution is finance data: the server refuses a view showing or
  // filtering by it to someone without finance.view, so it is not offered.
  const seesSponsors = useCan("finance.view") === "allowed";
  const [body, setBody] = useState<RegistrationViewBody>(() => {
    const b = initialBody(view, preset);
    return seesSponsors || view ? b : { ...b, fields: b.fields.filter((f) => f !== "sponsor") };
  });
  const [pendingContact, setPendingContact] = useState<string | null>(null);
  // Contact details must be confirmed once before they are saved: by the
  // tick-box prompt, or (for a preset that includes them) by a prompt on save.
  const [contactAcked, setContactAcked] = useState(false);
  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false);
  const [confirm, setConfirm] = useState<"regenerate" | "delete" | null>(null);

  const set = <K extends keyof RegistrationViewBody>(k: K, v: RegistrationViewBody[K]) => setBody((b) => ({ ...b, [k]: v }));
  const toggleIn = (k: "statuses" | "fields" | "ticketTypeIds" | "sponsorIds" | "promoCodeIds", value: string, on: boolean) =>
    setBody((b) => ({ ...b, [k]: on ? [...b[k], value] : b[k].filter((x) => x !== value) }));

  const contactKeys = REGISTRATION_SHARE_FIELDS.filter((f) => f.group === "contact").map((f) => f.key);
  const contactOn = body.fields.filter((f) => contactKeys.includes(f));
  const contactWasOn = (view?.fields ?? []).filter((f) => contactKeys.includes(f));
  const newlyShowingContact = contactOn.some((f) => !contactWasOn.includes(f));

  const shownLabels = useMemo(
    () => ["Number", "Name", ...REGISTRATION_SHARE_FIELDS.filter((f) => body.fields.includes(f.key)).map((f) => f.label)],
    [body.fields],
  );

  const toggleField = (key: string, isContact: boolean, checked: boolean) => {
    if (checked && isContact) {
      setPendingContact(key);
      return;
    }
    toggleIn("fields", key, checked);
  };

  const save = async (acked = contactAcked) => {
    if (!body.label.trim()) return toast.error("Give the view a name.");
    if (body.statuses.length === 0) return toast.error("Choose at least one status to show.");
    if (newlyShowingContact && !acked) return setSaveConfirmOpen(true);
    try {
      if (view) {
        await mutate.mutateAsync({ action: "update", id: view.id, body });
        toast.success("View saved");
        onSaved(view.id);
      } else {
        const r = await mutate.mutateAsync({ action: "create", body });
        toast.success("View created. Copy its link below.");
        if ("id" in r && typeof r.id === "string") onSaved(r.id);
        else onBack();
      }
    } catch (err) {
      console.error("[registration-views] save failed", err);
      toast.error(err instanceof Error ? err.message : "Could not save the view");
    }
  };

  const runConfirm = async () => {
    if (!view || !confirm) return;
    const action = confirm;
    setConfirm(null);
    try {
      await mutate.mutateAsync({ action, id: view.id });
      if (action === "delete") {
        toast.success("View removed. Its link no longer works.");
        onBack();
      } else {
        toast.success("New link created. The old link no longer works.");
      }
    } catch (err) {
      console.error(`[registration-views] ${action} failed`, err);
      toast.error(err instanceof Error ? err.message : "That did not work");
    }
  };

  const pendingField = REGISTRATION_SHARE_FIELDS.find((f) => f.key === pendingContact);
  const filterGroups = [
    { key: "ticketTypeIds" as const, title: "Registration types", items: options.ticketTypes.map((t) => ({ id: t.id, label: t.name })) },
    // Without finance.view, only the sponsors a view already filters on are
    // listed, so they can be unticked; the server refuses saving them.
    { key: "sponsorIds" as const, title: "Sponsors", items: options.sponsors.filter((s) => seesSponsors || body.sponsorIds.includes(s.id)).map((s) => ({ id: s.id, label: s.name })) },
    { key: "promoCodeIds" as const, title: "Promo codes", items: options.promoCodes.map((p) => ({ id: p.id, label: p.code })) },
  ].filter((g) => g.items.length > 0);

  return (
    <>
      <div className="px-6 py-5 space-y-5">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> All views
        </button>

        <section className="rounded-lg border bg-muted/40 p-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="space-y-1">
              <span className="text-sm font-medium">Name</span>
              <Input value={body.label} maxLength={LABEL_MAX} onChange={(e) => set("label", e.target.value)} placeholder="Front desk" />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium">Expires on (optional)</span>
              <Input type="date" value={toDateInput(body.expiresAt)} onChange={(e) => set("expiresAt", fromDateInput(e.target.value))} className="sm:w-44" />
            </label>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm">
              Link is <strong>{body.enabled ? "on" : "off"}</strong>
              <span className="text-xs text-muted-foreground"> · off shows &ldquo;no longer active&rdquo;</span>
            </p>
            <Switch checked={body.enabled} onCheckedChange={(v) => set("enabled", v)} aria-label="Link on or off" />
          </div>
          {view && (
            <div className="flex flex-col sm:flex-row gap-2">
              <input readOnly value={absolute(view.path)} onFocus={(e) => e.currentTarget.select()} aria-label="Shared link" className="flex-1 min-w-0 rounded-md border bg-background px-3 py-1.5 text-xs font-mono" />
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => copyLink(view.path)}>
                  <Copy className="h-4 w-4 mr-1" /> Copy
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setConfirm("regenerate")} disabled={mutate.isPending}>
                  <RefreshCw className="h-4 w-4 mr-1" /> New link
                </Button>
              </div>
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Which registrations appear</h3>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {REGISTRATION_SHARE_STATUSES.map((s) => (
              <label key={s.value} className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox checked={body.statuses.includes(s.value)} onCheckedChange={(v) => toggleIn("statuses", s.value, v === true)} />
                {s.label}
              </label>
            ))}
          </div>
          {filterGroups.map((g) => (
            <details key={g.key} className="rounded-lg border bg-muted/30 px-3 py-2" open={body[g.key].length > 0}>
              <summary className="cursor-pointer text-sm font-medium">
                {g.title}
                <span className="ml-2 text-xs font-normal text-muted-foreground">{body[g.key].length === 0 ? "all" : `${body[g.key].length} selected`}</span>
              </summary>
              <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                {g.items.map((it) => (
                  <label key={it.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox checked={body[g.key].includes(it.id)} onCheckedChange={(v) => toggleIn(g.key, it.id, v === true)} />
                    <span className="truncate">{it.label}</span>
                  </label>
                ))}
              </div>
            </details>
          ))}
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox checked={body.includeFaculty} onCheckedChange={(v) => set("includeFaculty", v === true)} />
            Include faculty (speakers&rsquo; own registrations)
          </label>
          <p className="text-xs text-muted-foreground">Filters combine: a registration must match every filter you set. Nothing ticked in a filter means all.</p>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold">What viewers see</h3>
          <p className="text-xs text-muted-foreground">Number and name are always shown, with totals at the top.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {(["people", "submission"] as const).map((group) => (
              <div key={group} className="rounded-lg border bg-muted/30 p-3 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{REGISTRATION_GROUP_TITLE[group]}</p>
                {REGISTRATION_SHARE_FIELDS.filter((f) => f.group === group && (seesSponsors || f.key !== "sponsor" || body.fields.includes("sponsor"))).map((f) => (
                  <label key={f.key} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox checked={body.fields.includes(f.key)} onCheckedChange={(v) => toggleField(f.key, false, v === true)} />
                    {f.label}
                  </label>
                ))}
              </div>
            ))}
          </div>
          <div className={cn("rounded-lg border p-3 space-y-2", contactOn.length ? "border-amber-300 bg-amber-50" : "border-amber-200/70 bg-amber-50/40")}>
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-800">
              <AlertTriangle className="h-3.5 w-3.5" /> {REGISTRATION_GROUP_TITLE.contact}
            </p>
            <p className="text-xs text-amber-900/80">Off by default. Everyone with the link would see these.</p>
            {REGISTRATION_SHARE_FIELDS.filter((f) => f.group === "contact").map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox checked={body.fields.includes(f.key)} onCheckedChange={(v) => toggleField(f.key, true, v === true)} />
                {f.label}
              </label>
            ))}
          </div>
          <p className="rounded-md bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Viewers will see: </span>
            {shownLabels.join(", ")}.
          </p>
        </section>
      </div>

      <DialogFooter className="px-6 py-4 border-t bg-muted/30 sm:justify-between">
        {view ? (
          <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirm("delete")} disabled={mutate.isPending}>
            <Trash2 className="h-4 w-4 mr-1" /> Remove view
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="outline" onClick={onBack}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={mutate.isPending}>
            {mutate.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            {view ? "Save changes" : "Create view"}
          </Button>
        </div>
      </DialogFooter>

      <AlertDialog open={!!pendingContact} onOpenChange={(o) => !o && setPendingContact(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Show {pendingField?.label.toLowerCase()}?</AlertDialogTitle>
            <AlertDialogDescription>
              Everyone with this link will see it, including anyone the link is forwarded to. Who switched it on is recorded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep hidden</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingContact) toggleIn("fields", pendingContact, true);
                setPendingContact(null);
                setContactAcked(true);
              }}
            >
              Show it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={saveConfirmOpen} onOpenChange={setSaveConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>This view shows contact details</AlertDialogTitle>
            <AlertDialogDescription>
              {listSentence(contactOn.map((k) => REGISTRATION_SHARE_FIELDS.find((f) => f.key === k)?.label ?? k))} will be visible to everyone
              with the link, including anyone it is forwarded to. Who switched them on is recorded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Go back</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setContactAcked(true);
                void save(true);
              }}
            >
              Save with contact details
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "delete" ? "Remove this view?" : "Create a new link?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "delete"
                ? "Its link stops working at once. This cannot be undone."
                : "Anyone using the old link loses access at once. You will need to send the new link again."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void runConfirm()}>{confirm === "delete" ? "Remove view" : "Create new link"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
