"use client";

/**
 * The CRM change-log timeline — the "detailed activity log" on every record page.
 * Renders no heading of its own: the host RecordCard supplies the "History" header,
 * so the section chrome stays consistent with every other card.
 *
 * SYSTEM history: created / edited (with field-level before→after) / archived /
 * restored / stage-moved / won / lost / contact linked. Distinct from the human
 * notes ("I called them") the deal sheet calls "Activity" — this is what CHANGED,
 * by whom, and when.
 *
 * Money is redacted server-side: a value diff a MEMBER may not see arrives with the
 * `dealValue` key stripped, so this renders "Value changed" without a number rather
 * than leaking one.
 */
import {
  Pencil,
  Plus,
  Archive,
  ArchiveRestore,
  ArrowRight,
  Trophy,
  XCircle,
  CheckCircle2,
  RotateCcw,
  Link2,
  Loader2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  activityActionLabel,
  fieldLabel,
  personName,
  type CrmActivityEntityType,
  type CrmActivityRow,
  type CrmFieldChange,
} from "@/crm/lib/crm-types";
import { useCrmActivity } from "@/crm/hooks/use-crm-api";

const ACTION_ICON: Record<string, { icon: LucideIcon; className: string }> = {
  CREATE: { icon: Plus, className: "text-emerald-600" },
  UPDATE: { icon: Pencil, className: "text-sky-600" },
  ARCHIVE: { icon: Archive, className: "text-rose-600" },
  RESTORE: { icon: ArchiveRestore, className: "text-emerald-600" },
  STAGE_MOVE: { icon: ArrowRight, className: "text-violet-600" },
  WON: { icon: Trophy, className: "text-emerald-600" },
  LOST: { icon: XCircle, className: "text-rose-600" },
  COMPLETE: { icon: CheckCircle2, className: "text-emerald-600" },
  REOPEN: { icon: RotateCcw, className: "text-amber-600" },
  CONTACT_ADDED: { icon: Link2, className: "text-sky-600" },
  CONTACT_REMOVED: { icon: Link2, className: "text-rose-600" },
  LINK_EVENT_CONTACT: { icon: Link2, className: "text-sky-600" },
  UNLINK_EVENT_CONTACT: { icon: Link2, className: "text-rose-600" },
};

/** Render one primitive value from a diff — dates short, money hidden as "hidden". */
function renderValue(v: string | number | boolean | null): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") {
    // ISO date → short local date; leave other strings alone.
    const d = new Date(v);
    if (/^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(d.getTime())) return d.toLocaleDateString();
    return v.length > 60 ? `${v.slice(0, 60)}…` : v;
  }
  return String(v);
}

function FieldDiff({ field, change }: { field: string; change: CrmFieldChange }) {
  return (
    <li className="text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{fieldLabel(field)}:</span>{" "}
      <span className="line-through">{renderValue(change.from)}</span>{" "}
      <ArrowRight className="inline h-3 w-3" />{" "}
      <span className="text-foreground">{renderValue(change.to)}</span>
    </li>
  );
}

function summaryLine(row: CrmActivityRow): string | null {
  const c = row.changes;
  if (!c) return null;
  if (row.action === "STAGE_MOVE" && typeof c.toStage === "string") return `→ ${c.toStage}`;
  if (row.action === "LOST" && typeof c.lostReason === "string") return c.lostReason;
  if ((row.action === "ARCHIVE" || row.action === "RESTORE" || row.action === "CREATE") && typeof c.name === "string") {
    return c.name;
  }
  return null;
}

export function CrmActivityTimeline({
  entityType,
  entityId,
}: {
  entityType: CrmActivityEntityType;
  entityId: string | null | undefined;
}) {
  const { data: rows = [], isLoading } = useCrmActivity(entityType, entityId);

  return (
    <div className="space-y-3">
      {isLoading ? (
        <p className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading history…
        </p>
      ) : rows.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">No changes recorded yet.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const meta = ACTION_ICON[row.action] ?? { icon: Pencil, className: "text-muted-foreground" };
            const Icon = meta.icon;
            const diffs = row.changes?.changes;
            const summary = summaryLine(row);
            return (
              <li key={row.id} className="flex gap-3">
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${meta.className}`} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="font-medium">{activityActionLabel(row.action)}</span>
                    {summary && <span className="text-muted-foreground"> · {summary}</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {row.actor ? personName(row.actor) : "System"} ·{" "}
                    {new Date(row.createdAt).toLocaleString()}
                  </p>
                  {diffs && Object.keys(diffs).length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {Object.entries(diffs).map(([field, change]) => (
                        <FieldDiff key={field} field={field} change={change} />
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
