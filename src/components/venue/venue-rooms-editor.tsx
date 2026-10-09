"use client";

/**
 * The Venue tab (docs/EVENT_BLUEPRINT_PLAN.md, D9 and D10): organisers pick a
 * template, then name the rooms, choose what each is for and how many people
 * it holds. The floor plan's shape is fixed (D10), so there is nothing to
 * place. The same rules the server applies (lib/venue/rooms.ts) run here as
 * the list is edited, so a list that cannot be saved says why before Save.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertCircle, Building2, ExternalLink, Loader2, Plus, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { PageHeader, SectionHeading } from "@/components/ui/typography";
import { useCan } from "@/hooks/use-can";
import { useSaveVenueRooms, useSetVenueOpen, useVenueRooms } from "@/hooks/use-api";
import { ApiError } from "@/lib/api-fetch";
import { VenueFloorPlan } from "@/components/venue/venue-floor-plan";
import { VenueProgrammeCard } from "@/components/venue/venue-programme-card";
import { BlueprintNotes, BlueprintReplaceRow, BlueprintStartCard } from "@/components/venue/venue-blueprint-start";
import { ROOM_KINDS, ROOM_KIND_INFO, TEMPLATES, TEMPLATE_KEYS, roomIdFor, roomsSchema, type RoomKind, type VenueRoom } from "@/lib/venue/rooms";

const SEATED: RoomKind[] = ["plenary", "hall", "workshop"];

export function VenueRoomsEditor({ eventId }: { eventId: string }) {
  const canEdit = useCan("events.update", eventId) === "allowed";
  const { data, isLoading, error } = useVenueRooms(eventId);
  const save = useSaveVenueRooms(eventId);
  const [draft, setDraft] = useState<VenueRoom[] | null>(null);
  // The draft came from the Blueprint (step 5): its fit notes show until it is saved or discarded.
  const [fromBlueprint, setFromBlueprint] = useState(false);
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
          {!dirty && saved && data?.slug && <OpenCard eventId={eventId} slug={data.slug} open={!!data.open} canEdit={canEdit} />}
          {issues.length === 0 && <VenueProgrammeCard rooms={rooms} programme={data?.programme} />}
          {issues.length === 0 && <VenueFloorPlan rooms={rooms} eventName="" />}
        </>
      )}
      <Card>
        <CardContent className="space-y-1 p-5 text-sm">
          <p className="font-medium">How the venue is laid out</p>
          <p className="text-muted-foreground">
            Every venue follows the same plan: the foyer at the entrance, a main corridor, the plenary hall at the end, session rooms, workshops and
            posters along one side, the exhibition and lounge along the other. Each room is sized from the people it holds, and the plan above is redrawn
            as you edit. The walkable venue is built from the saved rooms each time someone opens it.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function OpenCard({ eventId, slug, open, canEdit }: { eventId: string; slug: string; open: boolean; canEdit: boolean }) {
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
          <div className="hidden grid-cols-[minmax(0,1fr)_14rem_9rem_2.5rem] gap-3 px-5 py-2.5 text-xs font-medium text-muted-foreground md:grid">
            <span>Name</span>
            <span>What it is for</span>
            <span>People it holds</span>
            <span className="sr-only">Remove</span>
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
      <div className="grid gap-1 px-5 py-3 text-sm md:grid-cols-[minmax(0,1fr)_14rem_9rem_2.5rem] md:items-center md:gap-3">
        <span className="font-medium">{room.name}</span>
        <span className="text-muted-foreground">{info.label}</span>
        <span className="tabular-nums">{room.capacity.toLocaleString("en-GB")} people</span>
      </div>
    );
  }
  const isFoyer = room.kind === "foyer";
  return (
    <div className="grid gap-2 px-5 py-3 md:grid-cols-[minmax(0,1fr)_14rem_9rem_2.5rem] md:items-center md:gap-3">
      <Input id={`room-${room.id}-name`} name={`room-${room.id}-name`} aria-label="Room name" value={room.name} maxLength={60} onChange={(e) => onUpdate({ name: e.target.value })} />
      <Select value={room.kind} onValueChange={(v) => onUpdate({ kind: v as RoomKind })} disabled={isFoyer}>
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
      <Button variant="ghost" size="icon" aria-label={isFoyer ? "The foyer cannot be removed" : `Remove ${room.name}`} disabled={isFoyer} onClick={onRemove}>
        <Trash2 className="h-4 w-4" aria-hidden />
      </Button>
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
