"use client";

/**
 * The floor plan editor (docs/VENUE_FLOOR_PLAN_EDITOR_PLAN.md, 3.5, phase 1).
 * Starts from the saved drawn plan, or from the automatic plan the organiser
 * already sees, and changes it: move, resize and turn rooms, choose each door's
 * wall, draw and remove walkways, place the entrance. What is drawn here is
 * exactly what the 2D plan, the PDF and the walkable venue use.
 *
 * The same checks the server runs on save (plan shape, the building it makes,
 * walkability) run here as the plan changes, so a plan that cannot be saved
 * says why before Save. A room drawn too small for its people is a warning,
 * not a refusal (decision F2).
 *
 * Stands (section 10): "Place stands yourself" turns the exhibition rooms'
 * automatic stands into stands on the plan, as they were; from then on each
 * stand is moved, sized, numbered and given a sponsor here.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { toast } from "sonner";
import { useSession } from "next-auth/react";
import { AlertCircle, Box, CheckCircle2, LayoutGrid, Loader2, MousePointer2, Plus, Redo2, RotateCw, Route, Trash2, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
import { SectionHeading } from "@/components/ui/typography";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useSaveVenuePlan, type VenueRoomsData } from "@/hooks/use-api";
import { ApiError } from "@/lib/api-fetch";
import { generateLayout, type Rect } from "@/lib/venue/layout";
import { checkLayout } from "@/lib/venue/layout-check";
import {
  FIXTURE_INFO,
  FIXTURE_KINDS,
  FIXTURE_MIN_SIDE,
  FLOOR_NAME,
  PLAN_FLOORS,
  PLAN_MAX_FIXTURES,
  PLAN_MAX_WALKWAYS,
  PLAN_WALLS,
  STAND_PRESETS,
  fixtureLabel,
  floorLinks,
  floorView,
  isInternal,
  isStand,
  planFromLayout,
  planIssues,
  planSchema,
  wallSpan,
  withFloor,
  type FixtureKind,
  type PlanFixture, type PlanDoor, type PlanFloor, type PlanWall, type VenuePlan } from "@/lib/venue/plan";
import { doorsLeftShut, floorLayout, layoutFromPlan } from "@/lib/venue/plan-layout";
import {
  addFixture,
  addPartner,
  addStand,
  automaticStands,
  placeStandsYourself,
  renumberStands,
  canAddFixture,
  missingPartner,
  removeJoined,
  setFixture,
  addWalkway,
  canAddWalkway,
  spotBeside,
  keepListedRooms,
  keepPairs,
  nudge,
  overlapping,
  placeRoom,
  rectOf,
  removeWalkway,
  renameWalkway,
  setDoor,
  setSize,
  moveTo,
  targetFloor,
  toFloor,
  tooSmall,
  turn,
  unplacedRooms,
  type PlanTarget,
} from "@/lib/venue/plan-edit";
import { ROOM_KIND_INFO, type VenueRoom } from "@/lib/venue/rooms";
import type { StandSponsorRef } from "@/lib/venue/stands";
import { PLAN_ZOOMS, VenuePlanCanvas, stepZoom, type PlanGhost, type PlanTool } from "@/components/venue/venue-plan-canvas";

const WALL_LABEL: Record<PlanWall, string> = { n: "North", e: "East", s: "South", w: "West" };
const isNS = (w: PlanWall) => w === "n" || w === "s";

type StoredPlan = NonNullable<VenueRoomsData["plan"]>;

/** What the server would say about this plan, worked out here first. */
function judge(rooms: VenueRoom[], plan: VenuePlan, sponsors: StandSponsorRef[]): { problems: string[]; warnings: string[] } {
  const known = new Set(sponsors.map((sp) => sp.id));
  // A sponsor removed from the event since it was given a stand: the stand shows as Available (never an error).
  const gone = plan.fixtures.filter((f) => isStand(f) && f.sponsorId && !known.has(f.sponsorId)).map((f) => `${fixtureLabel(f)}: its sponsor is no longer on the event's list, so it shows as Available`);
  const warnings = [...tooSmall(plan, rooms), ...gone];
  // The schema first, as the server does: a limit (12 walkways, a 30 m door) must not show as walkable and then fail on save.
  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) return { problems: [...new Set(parsed.error.issues.map((i) => i.message))], warnings };
  const shape = planIssues(rooms, plan);
  if (shape.length) return { problems: shape, warnings };
  const built = layoutFromPlan(rooms, plan, { eventName: "" });
  if (built.issues.length) return { problems: built.issues, warnings };
  return { problems: checkLayout(built.layout).issues, warnings };
}

/** One undo step per gesture or panel change; `live` is a drag in progress, drawn but not yet a step. */
function useHistory(initial: VenuePlan) {
  const [h, setH] = useState({ stack: [initial], i: 0 });
  // The plan as opened, kept apart from the stack: the stack drops its oldest steps after 200, and changes are measured against this.
  const [original] = useState(initial);
  const [live, setLive] = useState<VenuePlan | null>(null);
  const push = useCallback((next: VenuePlan) => setH((cur) => ({ stack: [...cur.stack.slice(0, cur.i + 1), next].slice(-200), i: Math.min(cur.i + 1, 199) })), []);
  const undo = useCallback(() => setH((cur) => ({ ...cur, i: Math.max(0, cur.i - 1) })), []);
  const redo = useCallback(() => setH((cur) => ({ ...cur, i: Math.min(cur.stack.length - 1, cur.i + 1) })), []);
  const committed = h.stack[h.i];
  /** The plan an undo (-1) or redo (+1) would show, or null when there is none. */
  const peek = (dir: -1 | 1): VenuePlan | null => h.stack[h.i + dir] ?? null;
  return {
    plan: live ?? committed,
    committed,
    dragging: live !== null,
    dirty: committed !== original,
    canUndo: h.i > 0,
    canRedo: h.i < h.stack.length - 1,
    push,
    undo,
    redo,
    peek,
    setLive,
  };
}

/** Inside an open dropdown, list or dialog: its own keys (arrows choose an option) must not also edit the plan. */
const inPopup = (el: EventTarget | null) => el instanceof Element && !!el.closest('[role="listbox"],[role="option"],[role="menu"],[role="dialog"],[role="alertdialog"]');

const typingIn = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.getAttribute("role") === "combobox");

/** Where unsaved changes wait in this browser, per event (phase 2): a tab closed by accident loses nothing. */
/** Per event and per person: colleagues sharing a computer do not see each other's drafts. */
const draftKey = (eventId: string, userId: string) => `ea-sys:venue-plan-draft:${eventId}:${userId}`;
/** A draft older than this is not offered (a week-old change is more likely forgotten than wanted). */
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface PlanDraft {
  /** The saved plan's version the changes were made on: a draft over an older version is not offered. */
  version: number;
  savedAt: number;
  plan: VenuePlan;
}

function readDraft(eventId: string, userId: string, version: number): PlanDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(eventId, userId));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<PlanDraft>;
    const plan = planSchema.safeParse(d.plan);
    if (d.version !== version || typeof d.savedAt !== "number" || Date.now() - d.savedAt > DRAFT_MAX_AGE_MS || !plan.success) {
      window.localStorage.removeItem(draftKey(eventId, userId));
      return null;
    }
    return { version, savedAt: d.savedAt, plan: plan.data };
  } catch {
    return null;
  }
}

function writeDraft(eventId: string, userId: string, draft: PlanDraft | null) {
  try {
    if (draft) window.localStorage.setItem(draftKey(eventId, userId), JSON.stringify(draft));
    else window.localStorage.removeItem(draftKey(eventId, userId));
  } catch {
    // Storage can be full or blocked (a private window); the draft is a convenience, so editing goes on without it.
  }
}

/**
 * Open the walkable venue in a new tab with this plan, unsaved (phase 2). A
 * form POST, because the plan is too large for a link and the new tab needs a
 * page of its own; the server checks the plan exactly as a save would.
 */
function previewIn3d(slug: string, plan: VenuePlan) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = `/e/${encodeURIComponent(slug)}/venue/preview`;
  form.target = "_blank";
  const field = document.createElement("input");
  field.type = "hidden";
  field.name = "plan";
  // The team's notes are not built in 3D; left out, a plan full of notes stays under the preview's size limit (review LOW).
  field.value = JSON.stringify({ ...plan, fixtures: plan.fixtures.map((f) => ({ ...f, note: undefined })) });
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

const NUDGE: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

export function VenuePlanEditor({
  eventId,
  slug,
  rooms,
  stored,
  sponsors: sponsorList,
  onClose,
}: {
  eventId: string;
  slug: string | null;
  rooms: VenueRoom[];
  stored: StoredPlan | null;
  /**
   * The event's sponsors in stand order: who the automatic stands go to, and the choice for each placed stand.
   * Null when they could not be read: placing the stands then waits, or every stand would lose its sponsor.
   */
  sponsors: StandSponsorRef[] | null;
  onClose: () => void;
}) {
  const save = useSaveVenuePlan(eventId);
  const sponsors = useMemo(() => sponsorList ?? [], [sponsorList]);
  const initial = useMemo(() => (stored ? keepListedRooms(stored.plan, rooms) : planFromLayout(generateLayout(rooms, { eventName: "" }))), [stored, rooms]);
  const hist = useHistory(initial);
  // The version as opened. The page re-reads the plan when the window regains focus, and saving with that
  // newer version would quietly overwrite a colleague's save; with this one, theirs makes ours a 409.
  const [version] = useState(stored?.version ?? 0);
  const { push } = hist;
  // The floor being edited (owner, Oct 26: Ground and Level 1). Every tool works on that floor's own view of
  // the plan, and each change is written back into the whole plan, so the edit rules need not know about floors.
  const [floor, setFloor] = useState<PlanFloor>("ground");
  const plan = useMemo(() => floorView(hist.plan, floor), [hist.plan, floor]);
  const [selected, setSelected] = useState<PlanTarget | null>(null);
  const [tool, setTool] = useState<PlanTool>("select");
  const [serverIssues, setServerIssues] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<"discard" | "reset" | null>(null);
  const [zoom, setZoom] = useState(1);
  // Changes left unsaved in this browser last time, offered once when the editor opens.
  const userId = useSession().data?.user?.id ?? "";
  const [draft, setDraft] = useState<PlanDraft | null>(() => {
    const d = typeof window === "undefined" || !userId ? null : readDraft(eventId, userId, version);
    return d && JSON.stringify(d.plan) !== JSON.stringify(initial) ? d : null;
  });

  const names = useMemo(() => new Map(rooms.map((r) => [r.id, r.name])), [rooms]);
  const foyerId = rooms.find((r) => r.kind === "foyer")?.id ?? null;
  const layout = useMemo(() => floorLayout(rooms, plan, { eventName: "" }).layout, [rooms, plan]);
  const flagged = useMemo(() => overlapping(plan), [plan]);
  const shut = useMemo(() => doorsLeftShut(plan, layout), [plan, layout]);
  const ghost = useMemo(() => ghostOf(hist.plan, floor), [hist.plan, floor]);
  // The walkability walk takes a few milliseconds on a large building; deferred so dragging stays smooth.
  const settled = useDeferredValue(hist.committed);
  const verdict = useMemo(() => judge(rooms, settled, sponsors), [rooms, settled, sponsors]);
  const checking = settled !== hist.committed;
  const unplaced = unplacedRooms(hist.plan, rooms);

  /** Save a changed view of the floor being edited into the whole plan, as one undo step; joined stairs and lifts follow on the other floor. */
  const change = useCallback(
    (next: VenuePlan) => {
      push(keepPairs(hist.committed, withFloor(hist.committed, floor, next)));
      setServerIssues([]);
    },
    [push, hist.committed, floor],
  );
  const live = useCallback((next: VenuePlan | null) => hist.setLive(next && keepPairs(hist.committed, withFloor(hist.committed, floor, next))), [hist, floor]);
  const showFloor = (f: PlanFloor) => {
    setFloor(f);
    setSelected(null);
    setTool("select");
  };
  /**
   * Undo (-1) or redo (+1), showing the floor the step changes: the selected item's floor when it is
   * still there, else whichever floor changed, so a step taken on the other floor is never invisible.
   */
  const travelHistory = useCallback(
    (dir: -1 | 1) => {
      const next = hist.peek(dir);
      if (!next) return;
      const mine = selected && targetFloor(next, selected);
      if (selected && !mine) setSelected(null);
      const changed = PLAN_FLOORS.filter((f) => JSON.stringify(floorView(hist.committed, f)) !== JSON.stringify(floorView(next, f)));
      const show = mine || (changed.includes(floor) ? floor : changed[0]);
      if (show) setFloor(show);
      if (dir < 0) hist.undo();
      else hist.redo();
    },
    [hist, selected, floor],
  );
  /** Put a room on the list onto the plan: on the floor being edited, except the foyer, which goes on the ground floor. */
  const placeOnPlan = (id: string) => {
    const to = id === foyerId ? "ground" : floor;
    push(withFloor(hist.committed, to, placeRoom(floorView(hist.committed, to), rooms, id)));
    setServerIssues([]);
    setFloor(to);
    setSelected({ kind: "room", id });
  };
  // The selected stair or lift's missing partner on the other floor, and whether that floor has room for it there.
  const partnerFloor = selected?.kind === "fixture" ? missingPartner(hist.plan, selected.id) : null;
  const partnerFits = !!(partnerFloor && selected && addPartner(hist.committed, selected.id));
  const addMatching = () => {
    const added = selected && addPartner(hist.committed, selected.id);
    if (!added || !partnerFloor) return;
    push(added.plan);
    setServerIssues([]);
    setFloor(partnerFloor);
    setSelected({ kind: "fixture", id: added.id });
  };
  /** Move the selected room or walkway to the other floor, and follow it there. */
  const moveToFloor = (t: PlanTarget, to: PlanFloor) => {
    push(toFloor(hist.committed, t, to, foyerId));
    setServerIssues([]);
    setFloor(to);
    setSelected(t);
  };

  const addAndSelect = (rect: Rect) => {
    setTool("select");
    const added = addWalkway(plan, rect);
    if (!added) return;
    change(added.plan);
    setSelected({ kind: "corridor", id: added.id });
  };
  const walkwaysFull = !canAddWalkway(plan);

  /** Remove the selected walkway or fixture (rooms come and go on the room list, not here). */
  const removeSelected = useCallback(() => {
    if (selected?.kind === "corridor") change(removeWalkway(plan, selected.id));
    else if (selected?.kind === "fixture") {
      // A joined stair or lift goes from both floors at once (review LOW, Oct 27).
      push(removeJoined(hist.committed, selected.id));
      setServerIssues([]);
    } else return;
    setSelected(null);
  }, [selected, plan, change, push, hist.committed]);

  const addFixtureOf = (kind: FixtureKind) => {
    // A stair or lift goes over one on the other floor that has no partner yet, so the two join at once.
    // The whole plan's count, both floors: the limit is on the plan, not on one floor (review MED).
    if (!canAddFixture(hist.committed)) return;
    const matched = hist.committed.fixtures
      .filter((g) => g.kind === kind && missingPartner(hist.committed, g.id) === floor)
      .map((g) => addPartner(hist.committed, g.id))
      .find((m) => m !== null);
    if (matched) {
      push(matched.plan);
      setServerIssues([]);
      setTool("select");
      setSelected({ kind: "fixture", id: matched.id });
      return;
    }
    // In the selected room or walkway, else the foyer: somewhere the organiser is looking.
    const host = selected && selected.kind !== "fixture" ? rectOf(plan, selected) : (plan.rooms.find((p) => p.id === foyerId)?.rect ?? null);
    const added = addFixture(plan, kind, host);
    if (!added) return;
    change(added.plan);
    setTool("select");
    setSelected({ kind: "fixture", id: added.id });
  };

  /** Switch the whole plan to placed stands, starting from what the venue shows now (both floors, one undo step). */
  const placeStands = () => {
    if (!sponsorList) return;
    const { plan: placed, skipped } = placeStandsYourself(hist.committed, rooms, sponsorList);
    push(placed);
    setServerIssues([]);
    setSelected(null);
    if (skipped) toast.warning(`${skipped} of the automatic stands did not fit under the plan's limit of ${PLAN_MAX_FIXTURES} stands and fixtures, so they were left out. Remove some fixtures, then add stands.`);
  };
  const wholePlan = (edit: (p: VenuePlan) => VenuePlan) => {
    push(edit(hist.committed));
    setServerIssues([]);
    setSelected(null);
  };
  /** A stand or table, in the selected room or walkway, else the first exhibition room, else the foyer. */
  const addStandOf = (kind: "stand" | "table", size: [number, number]) => {
    if (!canAddFixture(hist.committed)) return;
    const expo = plan.rooms.find((p) => rooms.find((r) => r.id === p.id)?.kind === "exhibition");
    const host = selected && selected.kind !== "fixture" ? rectOf(plan, selected) : ((expo ?? plan.rooms.find((p) => p.id === foyerId))?.rect ?? null);
    const added = addStand(plan, kind, size, host);
    if (!added) return;
    change(added.plan);
    setTool("select");
    setSelected({ kind: "fixture", id: added.id });
  };

  // Undo, redo, delete a walkway, and Escape, from anywhere on the page except while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A key a dropdown or dialog already handled, or one pressed inside it, is not for the plan.
      if (e.defaultPrevented || typingIn(e.target) || inPopup(e.target) || document.querySelector('[role="alertdialog"]')) return;
      const mod = e.metaKey || e.ctrlKey;
      // Mid-drag, undo would be overwritten when the drag lands; the drag finishes first.
      if (mod && hist.dragging) return;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        travelHistory(e.shiftKey ? 1 : -1);
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        travelHistory(1);
        return;
      }
      if (e.key === "Escape") {
        setTool("select");
        setSelected(null);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && (selected?.kind === "corridor" || selected?.kind === "fixture")) {
        e.preventDefault();
        removeSelected();
        return;
      }
      // Arrow keys nudge the selected area half a metre, Shift five.
      const dir = NUDGE[e.key];
      if (!dir || !selected || mod || hist.dragging) return;
      e.preventDefault();
      const step = e.shiftKey ? 5 : 0.5;
      change(nudge(floorView(hist.committed, floor), selected, dir[0] * step, dir[1] * step, foyerId));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hist, selected, removeSelected, change, foyerId, floor, travelHistory]);

  // Unsaved changes wait in this browser until saved or thrown away (not while last time's are still on offer).
  // Editing without answering the offer means starting afresh: the offer goes and the new changes become the draft (the banner says so).
  const offer = hist.canUndo ? null : draft;
  useEffect(() => {
    if (offer || !userId) return;
    writeDraft(eventId, userId, hist.dirty ? { version, savedAt: Date.now(), plan: hist.committed } : null);
  }, [eventId, userId, version, offer, hist.dirty, hist.committed]);

  const leave = () => {
    writeDraft(eventId, userId, null);
    onClose();
  };

  // Leaving the page with unsaved changes asks first.
  useEffect(() => {
    if (!hist.dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hist.dirty]);

  const onSave = async () => {
    try {
      await save.mutateAsync({ plan: hist.committed, planVersion: version });
      toast.success("Floor plan saved. The venue, its plan and the PDF now use it.");
      leave();
    } catch (e) {
      const issues = e instanceof ApiError && Array.isArray(e.data?.issues) ? (e.data.issues as string[]) : [];
      setServerIssues(issues);
      const stale = e instanceof ApiError && e.status === 409;
      toast.error(e instanceof Error ? e.message : "Couldn't save the floor plan", stale ? { duration: 10000 } : undefined);
    }
  };

  const onReset = async () => {
    setConfirm(null);
    try {
      await save.mutateAsync({ plan: null, planVersion: version });
      toast.success("The venue is back on the automatic plan");
      leave();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't reset the floor plan");
    }
  };

  const problems = serverIssues.length ? serverIssues : verdict.problems;
  const ok = problems.length === 0;

  return (
    <section className="space-y-3">
      <SectionHeading
        title="Edit the floor plan"
        description="Drag rooms and walkways to move them, drag the handles to resize, and choose where each door is. North is up; the grid squares are 5 m."
        actions={
          <>
            {stored && (
              <Button variant="outline" onClick={() => setConfirm("reset")} disabled={save.isPending}>
                Reset to automatic
              </Button>
            )}
            {slug && (
              <Button variant="outline" onClick={() => previewIn3d(slug, hist.committed)} disabled={!ok || checking}>
                <Box className="h-4 w-4" aria-hidden />
                Preview in 3D
              </Button>
            )}
            <Button variant="outline" onClick={() => (hist.dirty ? setConfirm("discard") : leave())} disabled={save.isPending}>
              {hist.dirty ? "Discard changes" : "Close"}
            </Button>
            <Button onClick={onSave} disabled={!hist.dirty || !ok || checking || save.isPending}>
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Save plan
            </Button>
          </>
        }
      />
      <Card>
        <CardContent className="space-y-3 p-4">
          {offer && (
            <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200">
              <p className="flex-1">
                You have unsaved changes to this plan from {new Date(offer.savedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}, kept in this browser.
                Editing the plan before choosing starts afresh instead.
              </p>
              <Button
                size="sm"
                onClick={() => {
                  // The draft is the whole plan, every floor, so it replaces the plan rather than one floor's view.
                  push(keepListedRooms(offer.plan, rooms));
                  setServerIssues([]);
                  setDraft(null);
                }}
              >
                Restore them
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="bg-background"
                onClick={() => {
                  writeDraft(eventId, userId, null);
                  setDraft(null);
                }}
              >
                Throw them away
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Floor plan tools">
            <div className="flex rounded-md border p-0.5" role="group" aria-label="Floor">
              {PLAN_FLOORS.map((f) => (
                <Button key={f} size="sm" variant={floor === f ? "default" : "ghost"} aria-pressed={floor === f} className="h-7" onClick={() => showFloor(f)}>
                  {FLOOR_NAME[f]}
                </Button>
              ))}
            </div>
            <span className="mx-1 h-6 w-px bg-border" aria-hidden />
            <Button size="sm" variant={tool === "select" ? "default" : "outline"} aria-pressed={tool === "select"} onClick={() => setTool("select")}>
              <MousePointer2 className="h-4 w-4" aria-hidden />
              Select and move
            </Button>
            <Button size="sm" variant={tool === "walkway" ? "default" : "outline"} aria-pressed={tool === "walkway"} onClick={() => setTool("walkway")} disabled={walkwaysFull}>
              <Route className="h-4 w-4" aria-hidden />
              Draw a walkway
            </Button>
            <Button size="sm" variant="outline" onClick={() => addAndSelect(spotBeside(plan.rooms.length || plan.corridors.length ? plan : floorView(hist.plan, "ground"), 6, 20))} disabled={walkwaysFull}>
              <Plus className="h-4 w-4" aria-hidden />
              Add a walkway
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={!canAddFixture(hist.plan)}>
                  <Plus className="h-4 w-4" aria-hidden />
                  Add stairs, lift, toilets…
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-80">
                {FIXTURE_KINDS.filter((k) => k !== "stand" && k !== "table").map((k) => (
                  <DropdownMenuItem key={k} onSelect={() => addFixtureOf(k)} className="flex-col items-start gap-0.5">
                    <span className="font-medium">{FIXTURE_INFO[k].label}</span>
                    <span className="text-xs text-muted-foreground">{FIXTURE_INFO[k].help}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {hist.plan.standsPlaced ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline">
                    <LayoutGrid className="h-4 w-4" aria-hidden />
                    Stands
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72">
                  {STAND_PRESETS.map((p) => (
                    <DropdownMenuItem key={`${p.kind}-${p.size.join("x")}`} disabled={!canAddFixture(hist.plan)} onSelect={() => addStandOf(p.kind, p.size)}>
                      Add a {p.kind === "table" ? "sponsor table" : "stand"}, {p.size[0]} x {p.size[1]} m
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => wholePlan(renumberStands)} className="flex-col items-start gap-0.5">
                    <span className="font-medium">Renumber stands</span>
                    <span className="text-xs text-muted-foreground">Row by row from the north, west to east. Sponsors stay on their stands.</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => wholePlan(automaticStands)} className="flex-col items-start gap-0.5">
                    <span className="font-medium">Back to automatic stands</span>
                    <span className="text-xs text-muted-foreground">Removes the placed stands; the exhibition rooms lay out their own again, sponsors in tier order.</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={placeStands}
                disabled={!sponsorList}
                title={sponsorList ? "Turn the exhibition's stands into stands you move, size, number and give to sponsors" : "The event's sponsors could not be read, so the stands would lose them. Reload the page and try again."}
              >
                <LayoutGrid className="h-4 w-4" aria-hidden />
                Place stands yourself
              </Button>
            )}
            <span className="mx-1 h-6 w-px bg-border" aria-hidden />
            <Button size="sm" variant="ghost" onClick={() => travelHistory(-1)} disabled={!hist.canUndo} aria-label="Undo">
              <Undo2 className="h-4 w-4" aria-hidden />
              Undo
            </Button>
            <Button size="sm" variant="ghost" onClick={() => travelHistory(1)} disabled={!hist.canRedo} aria-label="Redo">
              <Redo2 className="h-4 w-4" aria-hidden />
              Redo
            </Button>
            <span className="mx-1 h-6 w-px bg-border" aria-hidden />
            <Button size="sm" variant="ghost" onClick={() => setZoom(stepZoom(zoom, -1))} disabled={zoom <= PLAN_ZOOMS[0]} aria-label="Zoom out">
              <ZoomOut className="h-4 w-4" aria-hidden />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setZoom(1)} aria-label="Zoom to fit the width" className="w-14 tabular-nums">
              {Math.round(zoom * 100)}%
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setZoom(stepZoom(zoom, 1))} disabled={zoom >= PLAN_ZOOMS[PLAN_ZOOMS.length - 1]} aria-label="Zoom in">
              <ZoomIn className="h-4 w-4" aria-hidden />
            </Button>
            <p className="ml-auto text-xs text-muted-foreground">
              <ToolHint tool={tool} walkwaysFull={walkwaysFull} />
            </p>
          </div>
          {/* The panel sits beside the plan only where both fit with the plan at least 760 px wide; below that it drops under it. */}
          <div className="grid items-start gap-4 min-[1400px]:grid-cols-[minmax(0,1fr)_17rem]">
            <VenuePlanCanvas
              plan={plan}
              layout={layout}
              names={names}
              selected={selected}
              tool={tool}
              flagged={flagged}
              foyerId={foyerId}
              onSelect={setSelected}
              onLive={live}
              onCommit={change}
              onDrawn={addAndSelect}
              zoom={zoom}
              onZoom={setZoom}
              ghost={ghost}
              sponsors={sponsors}
            />
            <PlanPanel
              plan={plan}
              rooms={rooms}
              names={names}
              foyerId={foyerId}
              selected={selected}
              unplaced={unplaced}
              onSelect={setSelected}
              onChange={change}
              onRemove={removeSelected}
              floor={floor}
              onMoveToFloor={moveToFloor}
              onPlace={placeOnPlan}
              partner={partnerFloor && { floor: partnerFloor, fits: partnerFits, add: addMatching }}
              joined={selected?.kind === "fixture" && floorLinks(hist.plan).some((l) => l.lower.id === selected.id || l.upper.id === selected.id)}
              doorShut={selected?.kind === "room" && shut.has(selected.id)}
              sponsors={sponsors}
              allFixtures={hist.plan.fixtures}
            />
          </div>
          <Status ok={ok} checking={checking} problems={problems} warnings={verdict.warnings} />
        </CardContent>
      </Card>
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "reset" ? "Go back to the automatic plan?" : "Discard your changes?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "reset"
                ? "The drawn plan is deleted and the venue is laid out from the room list again, for the 2D plan, the PDF and the walkable venue. This cannot be undone."
                : "The plan goes back to how it was when you opened the editor."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={confirm === "reset" ? onReset : leave}>{confirm === "reset" ? "Reset to automatic" : "Discard changes"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/**
 * The other floor, to draw faintly under this one: its rooms and walkways, and its stairs and lifts, which
 * join the floors only when drawn in the same place on both.
 */
function ghostOf(plan: VenuePlan, floor: PlanFloor): PlanGhost | undefined {
  const other = floor === "ground" ? "level-1" : "ground";
  const there = floorView(plan, other);
  if (floor === "ground" && !there.rooms.length && !there.corridors.length) return undefined;
  return {
    areas: [...there.rooms.map((p) => p.rect), ...there.corridors.map((c) => c.rect)],
    links: there.fixtures.filter((f) => f.kind === "stairs" || f.kind === "lift").map((f) => ({ rect: f.rect, label: `${f.name || FIXTURE_INFO[f.kind].label} (${FLOOR_NAME[other]})` })),
  };
}

function ToolHint({ tool, walkwaysFull }: { tool: PlanTool; walkwaysFull: boolean }) {
  if (walkwaysFull) return <>A plan has at most {PLAN_MAX_WALKWAYS} walkways. Remove one to add another.</>;
  if (tool === "walkway") return <>Drag across the floor to draw a walkway. Esc to stop.</>;
  return <>Arrows nudge, Alt places freely, Ctrl or Cmd + scroll zooms, Space + drag pans, Ctrl or Cmd + Z undoes.</>;
}

function Status({ ok, checking, problems, warnings }: { ok: boolean; checking: boolean; problems: string[]; warnings: string[] }) {
  return (
    <div className="space-y-2 text-sm" aria-live="polite">
      {checking && <p className="text-muted-foreground">Checking the plan…</p>}
      {!checking && ok && (
        <p className="flex gap-2 text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Walkable: every room, doorway, stand and desk can be reached from the entrance.
        </p>
      )}
      {!checking && !ok && (
        <div role="alert" className="flex gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="space-y-1">
            <p className="font-medium">
              {problems.length === 1 ? "1 thing to fix before saving" : `${problems.length} things to fix before saving`}
            </p>
            <ul className="list-disc space-y-0.5 pl-4">
              {problems.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="space-y-1">
            <p className="font-medium">Worth a look (you can still save)</p>
            <ul className="list-disc space-y-0.5 pl-4">
              {warnings.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

/** A number in metres, applied on Enter or when the field loses focus, so one edit is one undo step. */
function MetreField({ id, label, value, onCommit, min }: { id: string; label: string; value: number; onCommit: (n: number) => void; min?: number }) {
  const [text, setText] = useState<string | null>(null);
  const apply = () => {
    if (text === null) return;
    const n = Number(text);
    setText(null);
    if (text.trim() === "" || !Number.isFinite(n) || n === value) return;
    onCommit(min === undefined ? n : Math.max(min, n));
  };
  const onKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") apply();
    if (e.key === "Escape") setText(null);
  };
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        name={id}
        type="number"
        inputMode="decimal"
        // The minimum is applied on commit, not as an attribute: with min 1.2 and step 0.5 the browser marks 5.4 as invalid.
        step={0.5}
        // Shown to the centimetre: sums like 9.6 - 8.8 carry float noise (0.8000000000000007).
        value={text ?? String(Math.round(value * 100) / 100)}
        onChange={(e) => setText(e.target.value)}
        onBlur={apply}
        onKeyDown={onKey}
        className="h-8 tabular-nums"
      />
    </div>
  );
}

function PlanPanel({
  plan,
  rooms,
  names,
  foyerId,
  selected,
  unplaced,
  onSelect,
  onChange,
  onRemove,
  floor,
  onMoveToFloor,
  onPlace,
  partner,
  joined,
  doorShut,
  sponsors,
  allFixtures,
}: {
  plan: VenuePlan;
  rooms: VenueRoom[];
  names: Map<string, string>;
  foyerId: string | null;
  selected: PlanTarget | null;
  unplaced: VenueRoom[];
  onSelect: (t: PlanTarget | null) => void;
  onChange: (p: VenuePlan) => void;
  /** Remove the selected walkway or fixture. */
  onRemove: () => void;
  /** The floor being edited, and moving a room or walkway to another. */
  floor: PlanFloor;
  onMoveToFloor: (t: PlanTarget, floor: PlanFloor) => void;
  /** Put a room on the list onto the plan. */
  onPlace: (id: string) => void;
  /** A selected stair or lift with nothing in the same place on the other floor: that floor, and adding one there. */
  partner: { floor: PlanFloor; fits: boolean; add: () => void } | null;
  /** The selected stair or lift is joined to one on the other floor, so removing it removes both. */
  joined: boolean;
  /** The selected room's door is left shut: it opens onto nothing, and the stairs or lift in the room are its way in. */
  doorShut: boolean;
  /** The event's sponsors in stand order, to give out stands. */
  sponsors: StandSponsorRef[];
  /** Every fixture on both floors: which stands each sponsor already holds. */
  allFixtures: PlanFixture[];
}) {
  const rect = selected ? rectOf(plan, selected) : null;
  if (!selected || !rect) {
    return (
      <div className="space-y-4 text-sm">
        {unplaced.length > 0 && (
          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <p className="font-medium">Not on the plan yet</p>
            <p className="text-xs">Rooms added to the list since the plan was drawn. Put each on the plan, then drag it where it belongs.</p>
            {unplaced.map((r) => (
              <Button
                key={r.id}
                size="sm"
                variant="outline"
                className="w-full justify-start bg-background"
                onClick={() => {
                  onPlace(r.id);
                }}
              >
                Put {r.name} on the plan
              </Button>
            ))}
          </div>
        )}
        <p className="text-muted-foreground">Click a room or walkway on the plan, or pick one here, to move it, resize it, turn it or move its door.</p>
        <ul className="space-y-1">
          {plan.rooms.map((p) => (
            <li key={p.id}>
              <button type="button" className="w-full rounded px-2 py-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary" onClick={() => onSelect({ kind: "room", id: p.id })}>
                {names.get(p.id) ?? p.id}
              </button>
            </li>
          ))}
          {plan.corridors.map((c) => (
            <li key={c.id}>
              <button type="button" className="w-full rounded px-2 py-1 text-left text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary" onClick={() => onSelect({ kind: "corridor", id: c.id })}>
                {c.name} (walkway)
              </button>
            </li>
          ))}
          {plan.fixtures.map((f) => (
            <li key={f.id}>
              <button type="button" className="w-full rounded px-2 py-1 text-left text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary" onClick={() => onSelect({ kind: "fixture", id: f.id })}>
                {fixtureLabel(f)}
                {fixtureNote(f, sponsors)}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const key = `${selected.kind}-${selected.id}`;
  const room = selected.kind === "room" ? rooms.find((r) => r.id === selected.id) : undefined;
  const placed = selected.kind === "room" ? plan.rooms.find((p) => p.id === selected.id) : undefined;
  const corridor = selected.kind === "corridor" ? plan.corridors.find((c) => c.id === selected.id) : undefined;
  const fixture = selected.kind === "fixture" ? plan.fixtures.find((f) => f.id === selected.id) : undefined;
  const minSide = fixture ? FIXTURE_MIN_SIDE : 3;
  const w = rect[2] - rect[0];
  const d = rect[3] - rect[1];

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-base font-semibold">{room?.name ?? corridor?.name ?? (fixture && fixtureLabel(fixture))}</p>
          <p className="text-xs text-muted-foreground">
            <SelectedKind room={room} fixture={fixture} />
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => onSelect(null)}>
          Done
        </Button>
      </div>
      {corridor && (
        <div className="space-y-1">
          <Label htmlFor={`${key}-name`} className="text-xs text-muted-foreground">
            Name
          </Label>
          <Input
            key={`${key}-name-${corridor.name}`}
            id={`${key}-name`}
            name={`${key}-name`}
            defaultValue={corridor.name}
            maxLength={60}
            className="h-8"
            onBlur={(e) => {
              const name = e.target.value.trim();
              if (name && name !== corridor.name) onChange(renameWalkway(plan, corridor.id, name));
            }}
          />
        </div>
      )}
      {fixture && isStand(fixture) && (
        <StandFields key={`${key}-${fixture.number}-${fixture.sponsorId}`} id={key} plan={plan} fixture={fixture} sponsors={sponsors} allFixtures={allFixtures} onChange={onChange} />
      )}
      {fixture && <FixtureFields key={`${key}-${fixture.name}-${fixture.dir}`} id={key} plan={plan} fixture={fixture} onChange={onChange} />}
      {fixture && partner && <PartnerField kind={fixture.kind} partner={partner} />}
      <fieldset className="grid grid-cols-2 gap-2">
        <legend className="mb-1 text-xs font-medium">Size and place (metres)</legend>
        <MetreField key={`${key}-w-${w}`} id={`${key}-w`} label="Width (west to east)" value={w} min={minSide} onCommit={(n) => onChange(setSize(plan, selected, n, d, foyerId))} />
        <MetreField key={`${key}-d-${d}`} id={`${key}-d`} label="Depth (north to south)" value={d} min={minSide} onCommit={(n) => onChange(setSize(plan, selected, w, n, foyerId))} />
        <MetreField key={`${key}-x-${rect[0]}`} id={`${key}-x`} label="West edge at" value={rect[0]} onCommit={(n) => onChange(moveTo(plan, selected, n, rect[1], foyerId))} />
        <MetreField key={`${key}-z-${rect[1]}`} id={`${key}-z`} label="North edge at" value={rect[1]} onCommit={(n) => onChange(moveTo(plan, selected, rect[0], n, foyerId))} />
      </fieldset>
      {(placed || corridor) && (
        <div className="space-y-1">
          <Label htmlFor={`${key}-floor`} className="text-xs text-muted-foreground">
            Floor
          </Label>
          {selected.id === foyerId ? (
            <p className="text-xs text-muted-foreground">{FLOOR_NAME.ground}. The foyer is the way in, so it stays there.</p>
          ) : (
            <Select value={floor} onValueChange={(v) => onMoveToFloor(selected, v as PlanFloor)}>
              <SelectTrigger id={`${key}-floor`} className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLAN_FLOORS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {FLOOR_NAME[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
      <Button size="sm" variant="outline" onClick={() => onChange(turn(plan, selected, foyerId))}>
        <RotateCw className="h-4 w-4" aria-hidden />
        Turn a quarter
      </Button>
      {placed && (
        <DoorFields
          id={`${key}-door`}
          title={selected.id === foyerId ? "Way on into the building" : "Door"}
          help={doorHelp(selected.id === foyerId, doorShut)}
          rect={rect}
          door={placed.door}
          onChange={(patch) => onChange(setDoor(plan, placed.id, patch))}
        />
      )}
      {placed && selected.id === foyerId && (
        <DoorFields
          id={`${key}-entrance`}
          title="Entrance"
          help="The glass doors in from outside: the blue dot. They must be on an outside wall."
          rect={rect}
          door={plan.entrance}
          onChange={(patch) => onChange(setDoor(plan, placed.id, patch, true))}
        />
      )}
      {fixture && <TeamFields key={`${key}-${fixture.note ?? ""}-${String(fixture.internal)}`} id={key} plan={plan} fixture={fixture} onChange={onChange} />}
      {(corridor || fixture) && (
        <Button size="sm" variant="outline" className="text-destructive" onClick={onRemove}>
          <Trash2 className="h-4 w-4" aria-hidden />
          {removeLabel(corridor !== undefined, fixture, joined)}
        </Button>
      )}
    </div>
  );
}

function doorHelp(foyer: boolean, shut: boolean): string {
  if (foyer) return "The foyer's opening onto a walkway or room.";
  if (shut) return "Left shut: nothing on this floor is on the other side, and the room is reached by its stairs or lift. Put it on a wall facing a walkway or room to open it.";
  return "The amber dot on the plan. It must open onto a walkway, the foyer or another room.";
}

function removeLabel(corridor: boolean, fixture: PlanFixture | undefined, joined: boolean): string {
  if (corridor) return "Remove walkway";
  // "Exhibition stand" reads "exhibition stand" mid-sentence; an acronym ("AV console") keeps its capitals.
  const what = fixture ? FIXTURE_INFO[fixture.kind].label.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()) : "";
  return joined ? `Remove ${what} on both floors` : `Remove ${what}`;
}

function SelectedKind({ room, fixture }: { room: VenueRoom | undefined; fixture: PlanFixture | undefined }) {
  if (room) return <>{`${ROOM_KIND_INFO[room.kind].label}, ${room.capacity.toLocaleString("en-GB")} people`}</>;
  if (fixture) return <>{FIXTURE_INFO[fixture.kind].help}</>;
  return <>Walkway</>;
}

/** Stairs or a lift with nothing in the same place on the other floor: put the matching one there in one click. */
function PartnerField({ kind, partner }: { kind: FixtureKind; partner: { floor: PlanFloor; fits: boolean; add: () => void } }) {
  const what = FIXTURE_INFO[kind].label.toLowerCase();
  return (
    <div className="space-y-1 rounded-md border border-sky-300 bg-sky-50 p-3 text-xs text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200">
      <p>Stairs and lifts join the floors when they stand in the same place on both. Nothing is there on {FLOOR_NAME[partner.floor]} yet.</p>
      {partner.fits ? (
        <Button size="sm" variant="outline" className="w-full bg-background" onClick={partner.add}>
          Put the matching {what} on {FLOOR_NAME[partner.floor]}
        </Button>
      ) : (
        <p className="font-medium">
          Nothing on {FLOOR_NAME[partner.floor]} stands {partner.floor === "ground" ? "under" : "over"} this spot. Move the {what} over a room or walkway that is there (the faint outline), or draw one there first.
        </p>
      )}
    </div>
  );
}

/** After a fixture's label in the list: a stand's sponsor (or Available), else its kind when it has a name of its own. */
function fixtureNote(f: PlanFixture, sponsors: StandSponsorRef[]): string {
  if (isStand(f)) return `, ${sponsors.find((sp) => sp.id === f.sponsorId)?.name ?? "Available"}`;
  return f.name ? ` (${FIXTURE_INFO[f.kind].label.toLowerCase()})` : "";
}

const AVAILABLE = "available";

/**
 * A stand's number and sponsor. The number is a label and can change at any time (the sponsor and the visits
 * stay with the stand); a sponsor may hold several stands (decision G5), and the list says which they hold.
 */
function StandFields({
  id,
  plan,
  fixture,
  sponsors,
  allFixtures,
  onChange,
}: {
  id: string;
  plan: VenuePlan;
  fixture: PlanFixture;
  sponsors: StandSponsorRef[];
  allFixtures: PlanFixture[];
  onChange: (p: VenuePlan) => void;
}) {
  const holds = (spId: string) => allFixtures.filter((f) => isStand(f) && f.id !== fixture.id && f.sponsorId === spId).map((f) => f.number ?? "?");
  const missing = fixture.sponsorId && !sponsors.some((sp) => sp.id === fixture.sponsorId);
  return (
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
      <div className="space-y-1">
        <Label htmlFor={`${id}-number`} className="text-xs text-muted-foreground">
          Number
        </Label>
        <Input
          id={`${id}-number`}
          name={`${id}-number`}
          defaultValue={fixture.number ?? ""}
          maxLength={8}
          className="h-8"
          onBlur={(e) => {
            const number = e.target.value.trim();
            if (number !== (fixture.number ?? "")) onChange(setFixture(plan, fixture.id, { number: number || undefined }));
          }}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-sponsor`} className="text-xs text-muted-foreground">
          Sponsor
        </Label>
        <Select value={fixture.sponsorId && !missing ? fixture.sponsorId : AVAILABLE} onValueChange={(v) => onChange(setFixture(plan, fixture.id, { sponsorId: v === AVAILABLE ? null : v }))}>
          <SelectTrigger id={`${id}-sponsor`} className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AVAILABLE}>Available</SelectItem>
            {sponsors.map((sp) => {
              const held = holds(sp.id);
              return (
                <SelectItem key={sp.id} value={sp.id}>
                  {sp.name}
                  {sp.tier ? ` (${sp.tier})` : ""}
                  {held.length ? `, also on ${held.join(", ")}` : ""}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </div>
      {sponsors.length === 0 && <p className="col-span-2 text-xs text-muted-foreground">Add the event&apos;s sponsors on its Sponsors page to give out stands.</p>}
    </div>
  );
}

/** For the team only: a note on the fixture, and whether exhibitors see it on the plan they are sent. */
function TeamFields({ id, plan, fixture, onChange }: { id: string; plan: VenuePlan; fixture: PlanFixture; onChange: (p: VenuePlan) => void }) {
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label htmlFor={`${id}-note`} className="text-xs text-muted-foreground">
          Note for the team (exhibitors never see it)
        </Label>
        <Input
          id={`${id}-note`}
          name={`${id}-note`}
          defaultValue={fixture.note ?? ""}
          placeholder={isStand(fixture) ? "Power 2 x 13 A, rigging point" : ""}
          maxLength={300}
          className="h-8"
          onBlur={(e) => {
            const note = e.target.value.trim();
            if (note !== (fixture.note ?? "")) onChange(setFixture(plan, fixture.id, { note }));
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id={`${id}-internal`} checked={isInternal(fixture)} onCheckedChange={(v) => onChange(setFixture(plan, fixture.id, { internal: v === true }))} />
        <Label htmlFor={`${id}-internal`} className="text-xs font-normal">
          Staff only: leave it off the exhibitors&apos; plan
        </Label>
      </div>
    </div>
  );
}

/** What the way a fixture faces is called: up a flight of stairs, a stand's open side, else its front. */
function facingLabel(f: PlanFixture): string {
  if (f.kind === "stairs") return "Goes up towards";
  return isStand(f) ? "Open towards" : "Faces";
}

/** A fixture's name (on its sign) and the way it faces. A stand is named by its number, so only its facing. */
function FixtureFields({ id, plan, fixture, onChange }: { id: string; plan: VenuePlan; fixture: PlanFixture; onChange: (p: VenuePlan) => void }) {
  const label = FIXTURE_INFO[fixture.kind].label;
  const stand = isStand(fixture);
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className={stand ? "hidden" : "space-y-1"}>
        <Label htmlFor={`${id}-name`} className="text-xs text-muted-foreground">
          Name on the plan
        </Label>
        <Input
          id={`${id}-name`}
          name={`${id}-name`}
          defaultValue={fixture.name}
          placeholder={label}
          maxLength={60}
          className="h-8"
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name !== fixture.name) onChange(setFixture(plan, fixture.id, { name }));
          }}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-dir`} className="text-xs text-muted-foreground">
          {facingLabel(fixture)}
        </Label>
        <Select value={fixture.dir} onValueChange={(v) => onChange(setFixture(plan, fixture.id, { dir: v as PlanWall }))}>
          <SelectTrigger id={`${id}-dir`} className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLAN_WALLS.map((wl) => (
              <SelectItem key={wl} value={wl}>
                {WALL_LABEL[wl]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

function DoorFields({
  id,
  title,
  help,
  rect,
  door,
  onChange,
}: {
  id: string;
  title: string;
  help: string;
  rect: [number, number, number, number];
  door: PlanDoor;
  onChange: (patch: Partial<PlanDoor>) => void;
}) {
  const [a0] = wallSpan(rect, door.wall);
  const from = isNS(door.wall) ? "west" : "north";
  return (
    <fieldset className="space-y-2 rounded-md border p-3">
      <legend className="px-1 text-xs font-medium">{title}</legend>
      <p className="text-xs text-muted-foreground">{help}</p>
      <div className="space-y-1">
        <Label htmlFor={`${id}-wall`} className="text-xs text-muted-foreground">
          Wall
        </Label>
        <Select value={door.wall} onValueChange={(v) => onChange({ wall: v as PlanWall })}>
          <SelectTrigger id={`${id}-wall`} className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PLAN_WALLS.map((wl) => (
              <SelectItem key={wl} value={wl}>
                {WALL_LABEL[wl]} wall
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <MetreField
          key={`${id}-at-${door.wall}-${door.at}`}
          id={`${id}-at`}
          label={`Centre, from the ${from} end`}
          value={Math.round((door.at - a0) * 100) / 100}
          onCommit={(n) => onChange({ at: a0 + n })}
        />
        <MetreField key={`${id}-width-${door.width}`} id={`${id}-width`} label="Width" value={door.width} min={1.2} onCommit={(n) => onChange({ width: n })} />
      </div>
    </fieldset>
  );
}

