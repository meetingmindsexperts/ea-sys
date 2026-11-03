"use client";

/**
 * The registrations page's "Generate DTCM codes from DET" card
 * (docs/DTCM_ETICKET_PLAN.md §5.3, step 4). Organisers only (`dtcm.import`).
 *
 * Nothing is bought until the organiser has seen the preflight (who, how many,
 * in which DET environment, who is skipped and why, whether the sections can
 * hold it) and confirmed that exact count and environment; the server refuses
 * if either changed in between. The run itself is the worker's: this card
 * starts it, shows its progress and can cancel it.
 */
import { useState } from "react";
import { AlertTriangle, Loader2, Ticket } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  useCancelDtcmRun,
  useDtcmRun,
  useDtcmRunPreflight,
  useStartDtcmRun,
  type DtcmRunPreflight,
  type DtcmRunSummary,
} from "@/hooks/use-api";

const ENV_LABEL = { staging: "SANDBOX (test)", production: "PRODUCTION (real)" } as const;

export function DtcmRunCard({ eventId }: { eventId: string }) {
  const { data } = useDtcmRun(eventId, true);
  const preflight = useDtcmRunPreflight(eventId);
  const start = useStartDtcmRun(eventId);
  const cancel = useCancelDtcmRun(eventId);
  const [checked, setChecked] = useState<DtcmRunPreflight | null>(null);

  const run = data?.run ?? null;
  const running = run?.status === "RUNNING";

  const handleCheck = async () => {
    setChecked(null);
    try {
      const out = await preflight.mutateAsync();
      if (out.preflightError) {
        toast.error(out.preflightError.message, { duration: 12000 });
        return;
      }
      setChecked(out.preflight);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not check with DET");
    }
  };

  const handleStart = async () => {
    if (!checked) return;
    const what = `Buy ${checked.eligible} ${ENV_LABEL[checked.environment]} DTCM tickets from DET for performance ${checked.performanceCode}?`;
    if (!window.confirm(what)) return;
    try {
      await start.mutateAsync({ environment: checked.environment, performanceCode: checked.performanceCode, count: checked.eligible });
      setChecked(null);
      toast.success("DTCM run started. Codes appear on registrations as DET issues them.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the run", { duration: 12000 });
    }
  };

  const handleCancel = async () => {
    if (!window.confirm("Stop the DTCM run? Tickets already bought stay bought.")) return;
    try {
      await cancel.mutateAsync();
      toast.success("DTCM run stopped.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not stop the run");
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Ticket className="h-4 w-4 text-amber-600" /> DTCM codes from DET
        </p>
        {running ? (
          <Button size="sm" variant="outline" onClick={handleCancel} disabled={cancel.isPending}>
            Stop run
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={handleCheck} disabled={preflight.isPending}>
            {preflight.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Check who needs a code
          </Button>
        )}
      </div>

      {run && <RunStatus run={run} />}

      {!running && checked && (
        <Preflight checked={checked} starting={start.isPending} onStart={handleStart} onDismiss={() => setChecked(null)} />
      )}
    </div>
  );
}

function RunStatus({ run }: { run: DtcmRunSummary }) {
  const { purchased, failed, uncertain, inFlight } = run.progress;
  const done = purchased + failed + uncertain;
  const pct = run.expected > 0 ? Math.min(100, Math.round((done / run.expected) * 100)) : 0;
  const label: Record<DtcmRunSummary["status"], string> = {
    RUNNING: "Working",
    STOPPED: "Stopped",
    COMPLETED: "Finished",
    CANCELLED: "Cancelled",
  };
  return (
    <div className="space-y-1.5 text-xs">
      <p>
        <span className="font-medium">{label[run.status]}</span> ({ENV_LABEL[run.environment]}): {purchased} bought, {failed} failed
        {uncertain > 0 && <span className="font-medium text-red-600">, {uncertain} uncertain</span>}
        {inFlight > 0 && `, ${inFlight} in progress`} of {run.expected}.
      </p>
      {run.status === "RUNNING" && (
        <div className="h-1.5 w-full overflow-hidden rounded bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
      {run.soldOutAreas.length > 0 && <p className="text-amber-700">DET reported sold out: {run.soldOutAreas.join(", ")}. Those were skipped.</p>}
      {run.stopReason && run.status === "STOPPED" && (
        <p className="flex items-start gap-1.5 text-red-600">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {run.stopReason}
        </p>
      )}
      {uncertain > 0 && (
        <p className="text-muted-foreground">Open each uncertain registration to resolve it before running again.</p>
      )}
    </div>
  );
}

function Preflight({
  checked,
  starting,
  onStart,
  onDismiss,
}: {
  checked: DtcmRunPreflight;
  starting: boolean;
  onStart: () => void;
  onDismiss: () => void;
}) {
  const canStart = checked.eligible > 0 && !checked.overCapacity;
  return (
    <div className="space-y-3 rounded-md border border-slate-200 p-3 text-xs">
      <p>
        A run would buy <span className="font-semibold">{checked.eligible}</span> tickets in{" "}
        <span className="font-semibold">{ENV_LABEL[checked.environment]}</span> for performance{" "}
        <span className="font-mono">{checked.performanceCode}</span>. {checked.notNeeded} registrations need none
        (cancelled, virtual, or already coded).
      </p>

      {checked.problems.length > 0 && (
        <div>
          <p className="font-medium text-amber-700">Skipped until fixed:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-amber-800">
            {checked.problems.map((p) => (
              <li key={p.reason}>
                {p.count} &times; {p.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {checked.sections.length > 0 && (
        <table className="w-full">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">Section</th>
              <th className="py-1 pr-3 text-right font-medium">To buy</th>
              <th className="py-1 text-right font-medium">DET seats</th>
            </tr>
          </thead>
          <tbody>
            {checked.sections.map((s) => (
              <tr key={s.area} className="border-t">
                <td className="py-1 pr-3">
                  <span className="font-mono">{s.area}</span> {s.name}
                </td>
                <td className={s.over ? "py-1 pr-3 text-right font-medium text-red-600" : "py-1 pr-3 text-right"}>{s.needed}</td>
                <td className="py-1 text-right">{s.headroom ?? "?"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {checked.overCapacity && (
        <p className="text-red-600">More registrations than DET seats in a section. Change the DET sections or ask DET for more seats.</p>
      )}

      <div className="flex gap-2">
        <Button size="sm" onClick={onStart} disabled={!canStart || starting}>
          {starting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Buy {checked.eligible} {checked.environment === "production" ? "real" : "test"} tickets
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Not now
        </Button>
      </div>
    </div>
  );
}
