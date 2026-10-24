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
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { toast } from "sonner";
import { useSession } from "next-auth/react";
import { AlertCircle, Box, CheckCircle2, Loader2, MousePointer2, Plus, Redo2, RotateCw, Route, Trash2, Undo2, ZoomIn, ZoomOut } from "lucide-react";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useSaveVenuePlan, type VenueRoomsData } from "@/hooks/use-api";
import { ApiError } from "@/lib/api-fetch";
import { generateLayout, type Rect } from "@/lib/venue/layout";
import { checkLayout } from "@/lib/venue/layout-check";
import {
  FIXTURE_INFO,
  FIXTURE_KINDS,
  FIXTURE_MIN_SIDE,
  PLAN_MAX_WALKWAYS,
  PLAN_WALLS,
  planFromLayout,
  planIssues,
  planSchema,
  wallSpan,
  type FixtureKind,
  type PlanFixture, type PlanDoor, type PlanWall, type VenuePlan } from "@/lib/venue/plan";
import { layoutFromPlan } from "@/lib/venue/plan-layout";
import {
  addFixture,
  canAddFixture,
  removeFixture,
  setFixture,
  addWalkway,
  canAddWalkway,
  spotBeside,
  keepListedRooms,
  nudge,
  overlapping,
  placeRoom,
  rectOf,
  removeWalkway,
  renameWalkway,
  setDoor,
  setSize,
  moveTo,
  tooSmall,
  turn,
  unplacedRooms,
  type PlanTarget,
} from "@/lib/venue/plan-edit";
import { ROOM_KIND_INFO, type VenueRoom } from "@/lib/venue/rooms";
import { PLAN_ZOOMS, VenuePlanCanvas, stepZoom, type PlanTool } from "@/components/venue/venue-plan-canvas";

const WALL_LABEL: Record<PlanWall, string> = { n: "North", e: "East", s: "South", w: "West" };
const isNS = (w: PlanWall) => w === "n" || w === "s";

type StoredPlan = NonNullable<VenueRoomsData["plan"]>;

/** What the server would say about this plan, worked out here first. */
function judge(rooms: VenueRoom[], plan: VenuePlan): { problems: string[]; warnings: string[] } {
  const warnings = tooSmall(plan, rooms);
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
  field.value = JSON.stringify(plan);
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
  form.remove();
}

const NUDGE: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

export function VenuePlanEditor({ eventId, slug, rooms, stored, onClose }: { eventId: string; slug: string | null; rooms: VenueRoom[]; stored: StoredPlan | null; onClose: () => void }) {
  const save = useSaveVenuePlan(eventId);
  const initial = useMemo(() => (stored ? keepListedRooms(stored.plan, rooms) : planFromLayout(generateLayout(rooms, { eventName: "" }))), [stored, rooms]);
  const hist = useHistory(initial);
  // The version as opened. The page re-reads the plan when the window regains focus, and saving with that
  // newer version would quietly overwrite a colleague's save; with this one, theirs makes ours a 409.
  const [version] = useState(stored?.version ?? 0);
  const { plan, push } = hist;
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
  const layout = useMemo(() => layoutFromPlan(rooms, plan, { eventName: "" }).layout, [rooms, plan]);
  const flagged = useMemo(() => overlapping(plan), [plan]);
  // The walkability walk takes a few milliseconds on a large building; deferred so dragging stays smooth.
  const settled = useDeferredValue(hist.committed);
  const verdict = useMemo(() => judge(rooms, settled), [rooms, settled]);
  const checking = settled !== hist.committed;
  const unplaced = unplacedRooms(plan, rooms);

  const change = useCallback(
    (next: VenuePlan) => {
      push(next);
      setServerIssues([]);
    },
    [push],
  );

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
    else if (selected?.kind === "fixture") change(removeFixture(plan, selected.id));
    else return;
    setSelected(null);
  }, [selected, plan, change]);

  const addFixtureOf = (kind: FixtureKind) => {
    // In the selected room or walkway, else the foyer: somewhere the organiser is looking.
    const host = selected && selected.kind !== "fixture" ? rectOf(plan, selected) : (plan.rooms.find((p) => p.id === foyerId)?.rect ?? null);
    const added = addFixture(plan, kind, host);
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
        if (e.shiftKey) hist.redo();
        else hist.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        hist.redo();
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
      change(nudge(hist.committed, selected, dir[0] * step, dir[1] * step, foyerId));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hist, selected, removeSelected, change, foyerId]);

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
                  change(keepListedRooms(offer.plan, rooms));
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
            <Button size="sm" variant={tool === "select" ? "default" : "outline"} aria-pressed={tool === "select"} onClick={() => setTool("select")}>
              <MousePointer2 className="h-4 w-4" aria-hidden />
              Select and move
            </Button>
            <Button size="sm" variant={tool === "walkway" ? "default" : "outline"} aria-pressed={tool === "walkway"} onClick={() => setTool("walkway")} disabled={walkwaysFull}>
              <Route className="h-4 w-4" aria-hidden />
              Draw a walkway
            </Button>
            <Button size="sm" variant="outline" onClick={() => addAndSelect(spotBeside(plan, 6, 20))} disabled={walkwaysFull}>
              <Plus className="h-4 w-4" aria-hidden />
              Add a walkway
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={!canAddFixture(plan)}>
                  <Plus className="h-4 w-4" aria-hidden />
                  Add stairs, lift, toilets…
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-80">
                {FIXTURE_KINDS.map((k) => (
                  <DropdownMenuItem key={k} onSelect={() => addFixtureOf(k)} className="flex-col items-start gap-0.5">
                    <span className="font-medium">{FIXTURE_INFO[k].label}</span>
                    <span className="text-xs text-muted-foreground">{FIXTURE_INFO[k].help}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="mx-1 h-6 w-px bg-border" aria-hidden />
            <Button size="sm" variant="ghost" onClick={hist.undo} disabled={!hist.canUndo} aria-label="Undo">
              <Undo2 className="h-4 w-4" aria-hidden />
              Undo
            </Button>
            <Button size="sm" variant="ghost" onClick={hist.redo} disabled={!hist.canRedo} aria-label="Redo">
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
              onLive={hist.setLive}
              onCommit={change}
              onDrawn={addAndSelect}
              zoom={zoom}
              onZoom={setZoom}
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
                  onChange(placeRoom(plan, rooms, r.id));
                  onSelect({ kind: "room", id: r.id });
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
                {f.name || FIXTURE_INFO[f.kind].label}
                {f.name ? ` (${FIXTURE_INFO[f.kind].label.toLowerCase()})` : ""}
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
          <p className="text-base font-semibold">{room?.name ?? corridor?.name ?? (fixture && (fixture.name || FIXTURE_INFO[fixture.kind].label))}</p>
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
      {fixture && <FixtureFields key={`${key}-${fixture.name}-${fixture.dir}`} id={key} plan={plan} fixture={fixture} onChange={onChange} />}
      <fieldset className="grid grid-cols-2 gap-2">
        <legend className="mb-1 text-xs font-medium">Size and place (metres)</legend>
        <MetreField key={`${key}-w-${w}`} id={`${key}-w`} label="Width (west to east)" value={w} min={minSide} onCommit={(n) => onChange(setSize(plan, selected, n, d, foyerId))} />
        <MetreField key={`${key}-d-${d}`} id={`${key}-d`} label="Depth (north to south)" value={d} min={minSide} onCommit={(n) => onChange(setSize(plan, selected, w, n, foyerId))} />
        <MetreField key={`${key}-x-${rect[0]}`} id={`${key}-x`} label="West edge at" value={rect[0]} onCommit={(n) => onChange(moveTo(plan, selected, n, rect[1], foyerId))} />
        <MetreField key={`${key}-z-${rect[1]}`} id={`${key}-z`} label="North edge at" value={rect[1]} onCommit={(n) => onChange(moveTo(plan, selected, rect[0], n, foyerId))} />
      </fieldset>
      <Button size="sm" variant="outline" onClick={() => onChange(turn(plan, selected, foyerId))}>
        <RotateCw className="h-4 w-4" aria-hidden />
        Turn a quarter
      </Button>
      {placed && (
        <DoorFields
          id={`${key}-door`}
          title={selected.id === foyerId ? "Way on into the building" : "Door"}
          help={selected.id === foyerId ? "The foyer's opening onto a walkway or room." : "The amber dot on the plan. It must open onto a walkway, the foyer or another room."}
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
      {(corridor || fixture) && (
        <Button size="sm" variant="outline" className="text-destructive" onClick={onRemove}>
          <Trash2 className="h-4 w-4" aria-hidden />
          {corridor ? "Remove walkway" : `Remove ${(fixture && FIXTURE_INFO[fixture.kind].label.toLowerCase()) ?? ""}`}
        </Button>
      )}
    </div>
  );
}

function SelectedKind({ room, fixture }: { room: VenueRoom | undefined; fixture: PlanFixture | undefined }) {
  if (room) return <>{`${ROOM_KIND_INFO[room.kind].label}, ${room.capacity.toLocaleString("en-GB")} people`}</>;
  if (fixture) return <>{FIXTURE_INFO[fixture.kind].help}</>;
  return <>Walkway</>;
}

/** A fixture's name (on its sign) and the way it faces. */
function FixtureFields({ id, plan, fixture, onChange }: { id: string; plan: VenuePlan; fixture: PlanFixture; onChange: (p: VenuePlan) => void }) {
  const label = FIXTURE_INFO[fixture.kind].label;
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="space-y-1">
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
          {fixture.kind === "stairs" ? "Goes up towards" : "Faces"}
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

