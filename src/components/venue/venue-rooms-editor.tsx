"use client";

/**
 * The Venue tab (docs/EVENT_BLUEPRINT_PLAN.md, D9 and D10): organisers pick a
 * template, then name the rooms, choose what each is for and how many people
 * it holds. The plan is automatic until someone draws one with the floor plan
 * editor (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md). The same rules the server
 * applies (lib/venue/rooms.ts) run here as the list is edited, so a list that
 * cannot be saved says why before Save.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertCircle, Building2, ExternalLink, Loader2, PencilRuler, Plus, Ruler, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PageHeader, SectionHeading } from "@/components/ui/typography";
import { useCan } from "@/hooks/use-can";
import { useSaveVenueRooms, useSetVenueOpen, useVenueRooms } from "@/hooks/use-api";
import { ApiError } from "@/lib/api-fetch";
import { VenueFloorPlan } from "@/components/venue/venue-floor-plan";
import { VenuePlanPdfButton } from "@/components/venue/venue-plan-pdf-button";
import { VenuePlanEditor } from "@/components/venue/venue-plan-editor";
import { VenueProgrammeCard } from "@/components/venue/venue-programme-card";
import { VenueExhibitorLinkCard } from "@/components/venue/venue-exhibitor-link-card";
import { BlueprintNotes, BlueprintReplaceRow, BlueprintStartCard } from "@/components/venue/venue-blueprint-start";
import { ROOM_KINDS, ROOM_KIND_INFO, ROOM_SETUPS, SEATED_KINDS, SETUP_INFO, SIZE_LIMITS, hasStage, TEMPLATES, TEMPLATE_KEYS, roomIdFor, roomsSchema, type RoomKind, type RoomSetup, type VenueRoom } from "@/lib/venue/rooms";

const SEATED: RoomKind[] = ["plenary", "hall", "workshop"];

export function VenueRoomsEditor({ eventId }: { eventId: string }) {
  const canEdit = useCan("events.update", eventId) === "allowed";
  const { data, isLoading, error } = useVenueRooms(eventId);
  const save = useSaveVenueRooms(eventId);
  const [draft, setDraft] = useState<VenueRoom[] | null>(null);
  // The draft came from the Blueprint (step 5): its fit notes show until it is saved or discarded.
  const [fromBlueprint, setFromBlueprint] = useState(false);
  const [editingPlan, setEditingPlan] = useState(false);
  const blueprint = data?.blueprint ?? null;
  const applyBlueprint = () => {
    if (!blueprint) return;
    setDraft(blueprint.rooms.map((r) => ({ ...r })));
    setFromBlueprint(true);
  };
  const edit = (next: VenueRoom[] | null) => {
    setDraft(next);
    if (next === null) setFromBlueprint(false);
  };

  const saved = data?.rooms ?? null;
  const rooms = draft ?? saved;
  const dirty = draft !== null;
  const issues = useMemo(() => {
    if (!rooms) return [];
    const r = roomsSchema.safeParse(rooms);
    return r.success ? [] : [...new Set(r.error.issues.map((i) => i.message))];
  }, [rooms]);

  const update = (i: number, patch: Partial<VenueRoom>) => setDraft((rooms ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => setDraft((rooms ?? []).filter((_, j) => j !== i));
  const add = (kind: RoomKind) => {
    const list = rooms ?? [];
    const n = list.filter((r) => r.kind === kind).length + 1;
    const name = ROOM_KIND_INFO[kind].max === 1 ? ROOM_KIND_INFO[kind].label : `${ROOM_KIND_INFO[kind].label} ${n}`;
    setDraft([...list, { id: roomIdFor(name, list.map((r) => r.id)), name, kind, capacity: ROOM_KIND_INFO[kind].capacity.start }]);
  };

  const onSave = async () => {
    if (!rooms) return;
    try {
      await save.mutateAsync({ rooms, version: data?.version ?? 0 });
      edit(null);
      toast.success("Rooms saved");
    } catch (e) {
      const stale = e instanceof ApiError && e.status === 409;
      toast.error(e instanceof Error ? e.message : "Couldn't save the rooms", stale ? { duration: 10000 } : undefined);
    }
  };

  const header = (
    <PageHeader
      icon={Building2}
      title="Online venue"
      description="The rooms of this event's walkable online venue: what each is for and how many people it holds. The venue is laid out from this list."
      actions={
        canEdit && rooms ? (
          <>
            {dirty && (
              <Button variant="outline" onClick={() => edit(null)} disabled={save.isPending}>
                Discard changes
              </Button>
            )}
            <Button onClick={onSave} disabled={!dirty || issues.length > 0 || save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Save rooms
            </Button>
          </>
        ) : null
      }
    />
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        {header}
        <p className="text-sm text-muted-foreground">Loading the rooms…</p>
      </div>
    );
  }
  if (editingPlan && data?.rooms) {
    return (
      <div className="space-y-6">
        <PageHeader icon={Building2} title="Online venue" description="Draw where each room goes. The 2D plan, the PDF and the walkable venue are all built from this plan." />
        <VenuePlanEditor eventId={eventId} slug={data.slug ?? null} rooms={data.rooms} stored={data.plan ?? null} sponsors={data.programme ? data.programme.standSponsors : null} onClose={() => setEditingPlan(false)} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="space-y-6">
        {header}
        <p className="text-sm text-destructive">Couldn&apos;t load the rooms. Reload the page to try again.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      {!rooms && canEdit && blueprint && <BlueprintStartCard blueprint={blueprint} onUse={applyBlueprint} />}
      {!rooms && <Templates canEdit={canEdit} onPick={(key) => setDraft(TEMPLATES[key].rooms.map((r) => ({ ...r })))} />}
      {rooms && (
        <>
          {fromBlueprint && blueprint && <BlueprintNotes notes={blueprint.notes} />}
          {!fromBlueprint && canEdit && blueprint && <BlueprintReplaceRow blueprint={blueprint} onUse={applyBlueprint} />}
          <RoomList rooms={rooms} canEdit={canEdit} onUpdate={update} onRemove={remove} onAdd={add} />
          {issues.length > 0 && (
            <div role="alert" className="flex gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div className="space-y-1">
                <p className="font-medium">Fix these before saving</p>
                <ul className="list-disc space-y-0.5 pl-4">
                  {issues.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <Summary rooms={rooms} />
          {dirty && <p className="text-sm text-muted-foreground">Not saved yet.</p>}
          {!dirty && saved && data?.slug && <OpenCard eventId={eventId} slug={data.slug} open={!!data.open} canEdit={canEdit} safetyInbox={data.safetyInbox ?? null} />}
          {/* Seeing the link is holding the secret, so it is for those who may change the venue. */}
          {!dirty && saved && canEdit && <VenueExhibitorLinkCard eventId={eventId} canEdit={canEdit} />}
          {issues.length === 0 && <VenueProgrammeCard rooms={rooms} programme={data?.programme} plan={data?.plan?.plan ?? null} />}
          {issues.length === 0 && (
            <VenueFloorPlan rooms={rooms} eventName="" plan={data?.plan?.plan ?? null} sponsors={data?.programme?.standSponsors ?? []} actions={<PlanActions eventId={eventId} rooms={(saved ?? []).filter((r) => SEATED_KINDS.includes(r.kind))} saved={!!saved && !dirty} canEdit={canEdit} onEdit={() => setEditingPlan(true)} />} />
          )}
        </>
      )}
      <Card>
        <CardContent className="space-y-1 p-5 text-sm">
          <p className="font-medium">How the venue is laid out</p>
          <p className="text-muted-foreground">
            Until you draw a plan, every venue follows the same one: the foyer at the entrance, a main corridor, the plenary hall at the end, session
            rooms, workshops and posters along one side, the exhibition and lounge along the other, each room sized from the people it holds. Use Edit
            the floor plan to move, resize and turn rooms, choose their doors and draw walkways; the walkable venue and the PDF then follow your plan.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function OpenCard({ eventId, slug, open, canEdit, safetyInbox }: { eventId: string; slug: string; open: boolean; canEdit: boolean; safetyInbox: string | null }) {
  const setOpen = useSetVenueOpen(eventId);
  const toggle = async (next: boolean) => {
    try {
      await setOpen.mutateAsync(next);
      toast.success(next ? "The venue is open to staff" : "The venue is closed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't change the venue");
    }
  };
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="space-y-1">
          <p className="text-base font-semibold">Walkable venue</p>
          <p className="text-sm text-muted-foreground">
            {open ? "Open: staff who can see this event can walk it, built from the saved rooms." : "Closed: nobody can walk it yet. Open it when the rooms are ready."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {open && (
            <Button variant="outline" asChild>
              <a href={`/e/${encodeURIComponent(slug)}/venue`} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4" aria-hidden />
                Walk the venue
              </a>
            </Button>
          )}
          {canEdit && (
            <label className="flex items-center gap-2 text-sm font-medium">
              <Switch id="venue-open" checked={open} disabled={setOpen.isPending} onCheckedChange={toggle} aria-label="Open the venue to staff" />
              Open to staff
            </label>
          )}
        </div>
      </CardContent>
      {/* Safety reports raised in the venue are emailed to the organisation's company email (tenancy review, Oct 27). */}
      <CardContent className="border-t px-5 py-3 text-sm">
        {safetyInbox ? (
          <p className="text-muted-foreground">
            Safety reports raised in the venue are emailed to <span className="font-medium text-foreground">{safetyInbox}</span>, the organisation&apos;s company email.
          </p>
        ) : (
          <p role="status" className="text-amber-800 dark:text-amber-300">
            Safety reports raised in the venue cannot be emailed: this organisation has no company email. They are still saved for the event team.
            An administrator can add one under Settings, Billing.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Templates({ canEdit, onPick }: { canEdit: boolean; onPick: (key: keyof typeof TEMPLATES) => void }) {
  if (!canEdit) {
    return <p className="text-sm text-muted-foreground">No rooms have been set up for this event yet.</p>;
  }
  return (
    <section className="space-y-3">
      <SectionHeading title="Start from a template" description="Pick the closest one; you can rename, add and remove rooms afterwards." />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {TEMPLATE_KEYS.map((key) => {
          const t = TEMPLATES[key];
          return (
            <Card key={key} className="flex flex-col">
              <CardContent className="flex flex-1 flex-col gap-3 p-5">
                <div className="space-y-1">
                  <p className="text-base font-semibold">{t.label}</p>
                  <p className="text-sm text-muted-foreground">{t.help}</p>
                </div>
                <p className="text-xs text-muted-foreground">{t.rooms.map((r) => r.name).join(", ")}</p>
                <Button variant="outline" className="mt-auto self-start" onClick={() => onPick(key)}>
                  Use {t.label.toLowerCase()}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function RoomList({
  rooms,
  canEdit,
  onUpdate,
  onRemove,
  onAdd,
}: {
  rooms: VenueRoom[];
  canEdit: boolean;
  onUpdate: (i: number, patch: Partial<VenueRoom>) => void;
  onRemove: (i: number) => void;
  onAdd: (kind: RoomKind) => void;
}) {
  const count = (kind: RoomKind) => rooms.filter((r) => r.kind === kind).length;
  const addable = ROOM_KINDS.filter((k) => count(k) < ROOM_KIND_INFO[k].max);
  return (
    <section className="space-y-3">
      <SectionHeading
        title="Rooms"
        description={`${rooms.length} room${rooms.length === 1 ? "" : "s"}`}
        actions={
          canEdit && addable.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <Plus className="h-4 w-4" aria-hidden />
                  Add a room
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                {addable.map((k) => (
                  <DropdownMenuItem key={k} onSelect={() => onAdd(k)} className="flex-col items-start gap-0.5">
                    <span className="font-medium">{ROOM_KIND_INFO[k].label}</span>
                    <span className="text-xs text-muted-foreground">{ROOM_KIND_INFO[k].help}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null
        }
      />
      <Card>
        <CardContent className="divide-y p-0">
          <div className="hidden grid-cols-[minmax(0,1fr)_13rem_11rem_8rem_5rem] gap-3 px-5 py-2.5 text-xs font-medium text-muted-foreground md:grid">
            <span>Name</span>
            <span>What it is for</span>
            <span>Setup</span>
            <span>People it holds</span>
            <span className="sr-only">Sizes and remove</span>
          </div>
          {rooms.map((room, i) => (
            <RoomRow key={room.id} room={room} canEdit={canEdit} onUpdate={(p) => onUpdate(i, p)} onRemove={() => onRemove(i)} kindFull={(k) => k !== room.kind && count(k) >= ROOM_KIND_INFO[k].max} />
          ))}
        </CardContent>
      </Card>
    </section>
  );
}

function RoomRow({
  room,
  canEdit,
  onUpdate,
  onRemove,
  kindFull,
}: {
  room: VenueRoom;
  canEdit: boolean;
  onUpdate: (patch: Partial<VenueRoom>) => void;
  onRemove: () => void;
  kindFull: (k: RoomKind) => boolean;
}) {
  const info = ROOM_KIND_INFO[room.kind];
  if (!canEdit) {
    return (
      <div className="grid gap-1 px-5 py-3 text-sm md:grid-cols-[minmax(0,1fr)_13rem_11rem_8rem_5rem] md:items-center md:gap-3">
        <span className="font-medium">{room.name}</span>
        <span className="text-muted-foreground">{info.label}</span>
        <span className="text-muted-foreground">{setupLabel(room)}</span>
        <span className="tabular-nums">{room.capacity.toLocaleString("en-GB")} people</span>
      </div>
    );
  }
  const isFoyer = room.kind === "foyer";
  return (
    <div className="grid gap-2 px-5 py-3 md:grid-cols-[minmax(0,1fr)_13rem_11rem_8rem_5rem] md:items-center md:gap-3">
      <Input id={`room-${room.id}-name`} name={`room-${room.id}-name`} aria-label="Room name" value={room.name} maxLength={60} onChange={(e) => onUpdate({ name: e.target.value })} />
      <Select value={room.kind} onValueChange={(v) => onUpdate({ kind: v as RoomKind, ...(!SEATED_KINDS.includes(v as RoomKind) && { setup: undefined, stage: undefined, screen: undefined }) })} disabled={isFoyer}>
        <SelectTrigger id={`room-${room.id}-kind`} aria-label="What the room is for" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROOM_KINDS.filter((k) => k !== "foyer").map((k) => (
            <SelectItem key={k} value={k} disabled={kindFull(k)}>
              {ROOM_KIND_INFO[k].label}
            </SelectItem>
          ))}
          {isFoyer && <SelectItem value="foyer">{ROOM_KIND_INFO.foyer.label}</SelectItem>}
        </SelectContent>
      </Select>
      <SetupSelect room={room} onUpdate={onUpdate} />
      <Input
        id={`room-${room.id}-capacity`}
        name={`room-${room.id}-capacity`}
        aria-label="People it holds"
        type="number"
        inputMode="numeric"
        min={info.capacity.min}
        max={info.capacity.max}
        value={Number.isFinite(room.capacity) ? room.capacity : ""}
        onChange={(e) => onUpdate({ capacity: e.target.value === "" ? Number.NaN : Math.round(Number(e.target.value)) })}
        className="tabular-nums"
      />
      <div className="flex items-center gap-1">
        <SizesButton room={room} onUpdate={onUpdate} />
        <Button variant="ghost" size="icon" aria-label={isFoyer ? "The foyer cannot be removed" : `Remove ${room.name}`} disabled={isFoyer} onClick={onRemove}>
          <Trash2 className="h-4 w-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

function Summary({ rooms }: { rooms: VenueRoom[] }) {
  const seats = rooms.filter((r) => SEATED.includes(r.kind)).reduce((n, r) => n + (Number.isFinite(r.capacity) ? r.capacity : 0), 0);
  const foyer = rooms.find((r) => r.kind === "foyer");
  return (
    <p className="text-sm text-muted-foreground">
      {seats.toLocaleString("en-GB")} seats across the plenary, session and workshop rooms
      {foyer && Number.isFinite(foyer.capacity) ? `; the foyer holds ${foyer.capacity.toLocaleString("en-GB")}` : ""}.
    </p>
  );
}

/**
 * The PDF and the plan editor both work from the SAVED rooms, so they are
 * offered only when what is on screen is saved. Editing is for a computer
 * (decision F5): on a phone the plan stays viewable.
 */
function PlanActions({ eventId, rooms, saved, canEdit, onEdit }: { eventId: string; rooms: VenueRoom[]; saved: boolean; canEdit: boolean; onEdit: () => void }) {
  if (!saved) return <p className="text-xs text-muted-foreground">Save the rooms to edit the plan or download it as a PDF.</p>;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canEdit && (
        <>
          <Button variant="outline" className="hidden lg:inline-flex" onClick={onEdit}>
            <PencilRuler className="h-4 w-4" aria-hidden />
            Edit the floor plan
          </Button>
          <p className="text-xs text-muted-foreground lg:hidden">Open this page on a computer to edit the plan.</p>
        </>
      )}
      <VenuePlanPdfButton eventId={eventId} rooms={rooms.map((r) => ({ id: r.id, name: r.name }))} />
    </div>
  );
}

/** What a workshop with no setup chosen has: round tables of six, as before setups existed. */
const WORKSHOP_ROUNDS = "rounds";

/** A seated room's setup in words; "Not seated" for a room people do not sit in. */
function setupLabel(room: VenueRoom): string {
  if (!SEATED_KINDS.includes(room.kind)) return "Not seated";
  if (room.setup) return SETUP_INFO[room.setup].label;
  return room.kind === "workshop" ? "Round tables of six" : SETUP_INFO.theatre.label;
}

/**
 * How a seated room is set up (rooms.ts ROOM_SETUPS). The kind's own setup is saved as no setup at all, so a
 * venue saved before setups existed, and one that never changes it, stay exactly as they were.
 */
function SetupSelect({ room, onUpdate }: { room: VenueRoom; onUpdate: (patch: Partial<VenueRoom>) => void }) {
  if (!SEATED_KINDS.includes(room.kind)) return <span className="hidden text-sm text-muted-foreground md:block">Not seated</span>;
  const workshop = room.kind === "workshop";
  const value = room.setup ?? (workshop ? WORKSHOP_ROUNDS : "theatre");
  const choose = (v: string) => {
    const own = v === WORKSHOP_ROUNDS || (v === "theatre" && !workshop);
    onUpdate({ setup: own ? undefined : (v as RoomSetup) });
  };
  return (
    <Select value={value} onValueChange={choose}>
      <SelectTrigger id={`room-${room.id}-setup`} aria-label="How the room is set up" className="w-full">
        {/* The name alone: the list's "(up to 40)" only matters while choosing. */}
        <SelectValue>{setupLabel(room)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {workshop && <SelectItem value={WORKSHOP_ROUNDS}>Round tables of six</SelectItem>}
        {ROOM_SETUPS.map((s) => {
          const most = SETUP_INFO[s].maxCapacity;
          const tooMany = !!most && Number.isFinite(room.capacity) && room.capacity > most;
          return (
            <SelectItem key={s} value={s} disabled={tooMany}>
              {SETUP_INFO[s].label}
              {most ? ` (up to ${most})` : ""}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

type Pair = { a: string; b: string };
const pairOf = (v: { w: number; d: number } | { w: number; h: number } | undefined, second: "d" | "h"): Pair =>
  v ? { a: String(v.w), b: String((v as Record<string, number>)[second]) } : { a: "", b: "" };

/** Whether the fields already read as this saved size (or both empty for none). */
function samePair(p: Pair, v: { w: number; d: number } | { w: number; h: number } | undefined, second: "d" | "h"): boolean {
  const r = readPair(p);
  if (!r.ok) return false;
  if (!v) return r.value === null;
  return r.value !== null && r.value[0] === v.w && r.value[1] === (v as Record<string, number>)[second];
}

/** Both numbers, both empty (no size: the venue sizes it), or neither yet (still typing). */
function readPair(p: Pair): { ok: true; value: [number, number] | null } | { ok: false } {
  if (p.a.trim() === "" && p.b.trim() === "") return { ok: true, value: null };
  const a = Number(p.a);
  const b = Number(p.b);
  return p.a.trim() !== "" && p.b.trim() !== "" && Number.isFinite(a) && Number.isFinite(b) ? { ok: true, value: [a, b] } : { ok: false };
}

/**
 * The room's real stage and screen, from the hotel's room plan (rooms.ts). Empty fields let the venue size them
 * from the room. The stage only shows for a setup that has one; a size typed for it is kept while another setup is
 * tried.
 */
function SizesButton({ room, onUpdate }: { room: VenueRoom; onUpdate: (patch: Partial<VenueRoom>) => void }) {
  const [stage, setStage] = useState<Pair>(() => pairOf(room.stage, "d"));
  const [screen, setScreen] = useState<Pair>(() => pairOf(room.screen, "h"));
  // When the saved sizes change from outside the fields (Discard, a Blueprint, a reload), show them, unless the
  // fields already say the same (review of 05371679: a stale field could save a size nobody entered).
  const [seen, setSeen] = useState({ stage: room.stage, screen: room.screen });
  if (seen.stage !== room.stage || seen.screen !== room.screen) {
    setSeen({ stage: room.stage, screen: room.screen });
    if (!samePair(stage, room.stage, "d")) setStage(pairOf(room.stage, "d"));
    if (!samePair(screen, room.screen, "h")) setScreen(pairOf(room.screen, "h"));
  }
  // Closing with a half-typed size goes back to what is saved, so what the fields show is what Save sends.
  const onOpenChange = (open: boolean) => {
    if (open) return;
    setStage(pairOf(room.stage, "d"));
    setScreen(pairOf(room.screen, "h"));
  };
  if (!SEATED_KINDS.includes(room.kind)) return <span className="h-9 w-9" aria-hidden />;
  const withStage = hasStage(room);
  const set = !!room.screen || (withStage && !!room.stage);
  const commitStage = (p: Pair) => {
    setStage(p);
    const r = readPair(p);
    if (r.ok) onUpdate({ stage: r.value ? { w: r.value[0], d: r.value[1] } : undefined });
  };
  const commitScreen = (p: Pair) => {
    setScreen(p);
    const r = readPair(p);
    if (r.ok) onUpdate({ screen: r.value ? { w: r.value[0], h: r.value[1] } : undefined });
  };
  const field = (id: string, label: string, [min, max]: readonly [number, number], value: string, onChange: (v: string) => void) => (
    <label htmlFor={id} className="grid gap-1 text-xs font-medium text-muted-foreground">
      {label}
      <Input id={id} name={id} type="number" inputMode="decimal" step="0.01" min={min} max={max} value={value} onChange={(e) => onChange(e.target.value)} className="tabular-nums" />
    </label>
  );
  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Stage and screen sizes for ${room.name}`} className={set ? "text-primary" : undefined}>
          <Ruler className="h-4 w-4" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-4">
        <div className="space-y-1">
          <p className="text-sm font-semibold">Stage and screen</p>
          <p className="text-xs text-muted-foreground">In metres, from the hotel&apos;s room plan. Leave both empty and the venue sizes them from the room.</p>
        </div>
        {withStage ? (
          <fieldset className="grid grid-cols-2 gap-3">
            <legend className="sr-only">Stage</legend>
            {field(`room-${room.id}-stage-w`, "Stage width", SIZE_LIMITS.stage.w, stage.a, (v) => commitStage({ ...stage, a: v }))}
            {field(`room-${room.id}-stage-d`, "Stage depth", SIZE_LIMITS.stage.d, stage.b, (v) => commitStage({ ...stage, b: v }))}
          </fieldset>
        ) : (
          <p className="text-xs text-muted-foreground">A {setupLabel(room).toLowerCase()} setup has no stage, only a screen.</p>
        )}
        <fieldset className="grid grid-cols-2 gap-3">
          <legend className="sr-only">Screen</legend>
          {field(`room-${room.id}-screen-w`, "Screen width", SIZE_LIMITS.screen.w, screen.a, (v) => commitScreen({ ...screen, a: v }))}
          {field(`room-${room.id}-screen-h`, "Screen height", SIZE_LIMITS.screen.h, screen.b, (v) => commitScreen({ ...screen, b: v }))}
        </fieldset>
        {(!readPair(stage).ok || !readPair(screen).ok) && <p className="text-xs text-amber-700 dark:text-amber-400">Enter both numbers of a size, or leave both empty. Closing keeps the size saved before.</p>}
      </PopoverContent>
    </Popover>
  );
}
