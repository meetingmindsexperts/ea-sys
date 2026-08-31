"use client";

/**
 * /hr/employees/[employeeId]: one person's record.
 *
 * A page, not a dialog. The dialog it replaces held eleven fields including the
 * three seed figures that decide somebody's leave balance, and a modal is the
 * wrong container for that: it cannot be linked to, cannot be read alongside the
 * numbers it changes, and gives no room to show what those numbers currently
 * are. The record layout is the one the CRM already uses for deals and accounts,
 * promoted to `@/components/record-layout` when this needed it rather than
 * copied. Two modules cannot import each other, so the alternative was a second
 * copy that would drift.
 *
 * WHY THE BALANCE SITS BESIDE THE FORM. The three seeds (carried-in days,
 * opening sick used, opening comp-off) are meaningless on their own; what they
 * do is move a balance. Editing them next to the balance they move means a typo
 * is visible immediately rather than at year end.
 */

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  useHrBalance,
  useHrEmployeeExit,
  useUpdateHrEmployee,
  type HrEmployee,
} from "@/hr/hooks/use-hr-api";
import { HR_ANNUAL_ENTITLEMENT_DAYS } from "@/hr/lib/hr-constants";
import {
  Dash, Fact, Facts, RecordCard, RecordGrid, RecordHeader,
} from "@/components/record-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, CalendarDays, Loader2, LogOut, User } from "lucide-react";

type Status = "ACTIVE" | "RESIGNED" | "TERMINATED";

/** Empty string means "not set", which for a nullable number is null and NOT 0. */
function numOrNull(v: string): number | null {
  return v.trim() === "" ? null : Number(v);
}

export default function HrEmployeePage({
  params,
}: {
  params: Promise<{ employeeId: string }>;
}) {
  const { employeeId } = use(params);
  const router = useRouter();
  const { data, isLoading, isError, error } = useHrBalance(employeeId);
  const update = useUpdateHrEmployee();
  const recordExit = useHrEmployeeExit();

  const employee = data?.employee;
  const balance = data?.balance;

  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [exitOpen, setExitOpen] = useState(false);
  const [exitForm, setExitForm] = useState<{ exitDate: string; status: "RESIGNED" | "TERMINATED" }>(
    { exitDate: "", status: "RESIGNED" },
  );

  // Seed the form from the loaded record ONCE, using the previous-render pattern
  // rather than an effect: an effect would race the fetch and blank a field the
  // moment a background refetch resolved mid-edit.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (employee && seededFor !== employee.id) {
    setSeededFor(employee.id);
    setForm(toForm(employee));
  }

  function toForm(e: HrEmployee) {
    return {
      name: e.name,
      department: e.department ?? "",
      jobTitle: e.jobTitle ?? "",
      joiningDate: e.joiningDate,
      exitDate: e.exitDate ?? "",
      status: e.status,
      annualEntitlementDays:
        e.annualEntitlementDays === null ? "" : String(e.annualEntitlementDays),
      carryoverDays: String(e.carryoverDays),
      openingSickUsed: String(e.openingSickUsed),
      openingCompOff: String(e.openingCompOff),
      notes: e.notes ?? "",
    };
  }

  async function save() {
    if (!form || !employee) return;
    if (!form.name.trim() || !form.joiningDate) {
      toast.error("Name and joining date are required.");
      return;
    }
    try {
      await update.mutateAsync({
        id: employee.id,
        name: form.name.trim(),
        department: form.department.trim() || null,
        jobTitle: form.jobTitle.trim() || null,
        joiningDate: form.joiningDate,
        // Explicit null, never omitted: omitting means "unchanged", which is how
        // an Active employee keeps a leaving date nobody can clear.
        exitDate: form.exitDate || null,
        status: form.status as Status,
        annualEntitlementDays: numOrNull(form.annualEntitlementDays),
        carryoverDays: Number(form.carryoverDays) || 0,
        openingSickUsed: Number(form.openingSickUsed) || 0,
        openingCompOff: Number(form.openingCompOff) || 0,
        notes: form.notes.trim() || null,
      });
      toast.success("Saved.");
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
      </div>
    );
  }
  if (isError || !employee || !balance || !form) {
    return (
      <div className="mx-auto mt-20 max-w-md rounded-lg border border-amber-300 bg-amber-50 p-6 text-center">
        <h2 className="font-semibold text-amber-900">Couldn&apos;t load this employee</h2>
        <p className="mt-2 text-sm text-amber-800">
          {(error as Error)?.message ?? "They may have been removed."}
        </p>
        <Button asChild variant="secondary" className="mt-4">
          <Link href="/hr/employees">Back to employees</Link>
        </Button>
      </div>
    );
  }

  const set = (k: string) => (v: string) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(employee));
  const isLeaver = employee.status !== "ACTIVE";

  return (
    <div className="space-y-5">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link href="/hr/employees"><ArrowLeft className="h-4 w-4" /> Employees</Link>
      </Button>

      <RecordHeader
        icon={User}
        title={employee.name}
        subtitle={
          [employee.empCode, employee.jobTitle, employee.department]
            .filter(Boolean)
            .join(" · ")
        }
        badges={
          <>
            {isLeaver ? (
              <Badge variant="outline" className="text-muted-foreground">
                {employee.status === "RESIGNED" ? "Resigned" : "Terminated"}
              </Badge>
            ) : (
              <Badge variant="secondary">Active</Badge>
            )}
            {balance.annual.entitlementOverridden && (
              <Badge variant="outline" title="Agreed with management, not the standard rule">
                entitlement agreed
              </Badge>
            )}
          </>
        }
        actions={
          <>
            {!isLeaver && (
              <Button variant="outline" size="sm" onClick={() => {
                setExitForm({ exitDate: "", status: "RESIGNED" });
                setExitOpen(true);
              }}>
                <LogOut className="h-4 w-4" /> Record a leaver
              </Button>
            )}
            <Button asChild variant="secondary" size="sm">
              <Link href="/hr/attendance"><CalendarDays className="h-4 w-4" /> Attendance</Link>
            </Button>
          </>
        }
        stats={
          balance.employedInYear
            ? [
                { label: `Annual ${balance.leaveYear}`, value: balance.annual.balance },
                { label: "Taken", value: balance.annual.taken },
                { label: "Sick (full pay) left", value: balance.sick.full.remaining },
                { label: "Comp-off", value: balance.compOff.balance },
              ]
            : undefined
        }
      />

      <RecordGrid
        sidebar={
          <>
            <RecordCard title={`Leave ${balance.leaveYear}`}>
              {balance.employedInYear ? (
                <Facts>
                  <Fact label="Entitlement">
                    {balance.annual.entitlement}
                    {balance.annual.entitlementOverridden && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        agreed, not the rule
                      </span>
                    )}
                    {!balance.annual.entitlementOverridden && !balance.hasCompletedFirstYear && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        first year not complete
                      </span>
                    )}
                  </Fact>
                  <Fact label="Carried in">
                    {balance.annual.carriedIn}
                    {balance.annual.carriedIn !== balance.annual.carriedInStored && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        capped from {balance.annual.carriedInStored}
                      </span>
                    )}
                  </Fact>
                  <Fact label="Taken">{balance.annual.taken}</Fact>
                  <Fact label="Balance">
                    <span className={balance.annual.balance < 0 ? "text-destructive" : undefined}>
                      {balance.annual.balance}
                    </span>
                  </Fact>
                  <Fact label="Sick used (full / half / unpaid)">
                    {balance.sick.full.used} / {balance.sick.half.used} / {balance.sick.unpaid.used}
                  </Fact>
                  <Fact label="Comp-off (earned − taken)">
                    {balance.compOff.earned} − {balance.compOff.taken} = {balance.compOff.balance}
                  </Fact>
                </Facts>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Not employed in {balance.leaveYear}, so there is no balance to show.
                </p>
              )}
            </RecordCard>

            <RecordCard title="Dates">
              <Facts>
                <Fact label="Joined">{employee.joiningDate}</Fact>
                <Fact label="Last working day">{employee.exitDate ?? <Dash />}</Fact>
                <Fact label="Next anniversary">{balance.nextAnniversary}</Fact>
                <Fact label="Seeds belong to">
                  {employee.seedLeaveYear ?? <Dash />}
                </Fact>
              </Facts>
            </RecordCard>
          </>
        }
      >
        <RecordCard title="Details">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name *" value={form.name} onChange={set("name")} />
            <Field label="Employee code" value={employee.empCode} disabled
              hint="Fixed after creation: reports join on it." />
            <Field label="Department" value={form.department} onChange={set("department")} />
            <Field label="Job title" value={form.jobTitle} onChange={set("jobTitle")} />
            <Field label="Joining date *" type="date" value={form.joiningDate}
              onChange={set("joiningDate")} />
            <Field label="Last working day" type="date" value={form.exitDate}
              onChange={set("exitDate")} min={form.joiningDate || undefined}
              hint="Empty means still employed. Clearing it puts a leaver recorded by mistake back; set the status to Active in the same save, or the save is refused. Moving either date so that recorded days fall outside the employment is refused too: clear those days first." />
            <div className="space-y-1">
              <Label className="text-xs">Status</Label>
              <Select value={form.status} onValueChange={set("status")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="RESIGNED">Resigned</SelectItem>
                  <SelectItem value="TERMINATED">Terminated</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                A last working day in the future with the status still Active is somebody
                serving notice, which is a real state and is left alone. Resigned or Terminated
                needs a last working day, and Active cannot keep one that has passed.
              </p>
            </div>
          </div>
        </RecordCard>

        <RecordCard title="Leave figures">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Annual entitlement"
              type="number"
              step="0.5"
              min="0"
              placeholder="Standard rule"
              value={form.annualEntitlementDays}
              onChange={set("annualEntitlementDays")}
              hint={`Empty uses the rule: ${HR_ANNUAL_ENTITLEMENT_DAYS} days once the first year is complete, none before it. A number is a figure agreed with management, and a leaver's final year is usually negotiated. Zero is a valid agreement and is not the same as empty.`}
            />
            <Field
              label="Carried-in annual days"
              type="number"
              step="0.5"
              value={form.carryoverDays}
              onChange={set("carryoverDays")}
              hint="Capped at 30. A negative carries in full: leave taken in advance follows the person."
            />
            <Field label="Opening sick days used" type="number" step="0.5"
              value={form.openingSickUsed} onChange={set("openingSickUsed")}
              hint="Counts against the FULL-pay tier only." />
            <Field label="Opening comp-off" type="number" step="0.5"
              value={form.openingCompOff} onChange={set("openingCompOff")} />
          </div>
        </RecordCard>

        <RecordCard title="Notes">
          <Textarea
            rows={4}
            value={form.notes}
            onChange={(e) => set("notes")(e.target.value)}
            placeholder="Anything worth knowing about this person's leave record."
          />
        </RecordCard>

        <div className="flex items-center gap-2">
          <Button onClick={save} disabled={!dirty || update.isPending}>
            {update.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Save changes
          </Button>
          <Button
            variant="ghost"
            disabled={!dirty}
            onClick={() => setForm(toForm(employee))}
          >
            Discard
          </Button>
          {dirty && (
            <span className="text-xs text-muted-foreground">Unsaved changes</span>
          )}
        </div>
      </RecordGrid>

      <Dialog open={exitOpen} onOpenChange={setExitOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record a leaver</DialogTitle>
            <DialogDescription>
              {employee.name} is kept, never deleted: the record is the evidence for
              gratuity and leave encashment.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Last working day</Label>
              <Input type="date" value={exitForm.exitDate} min={employee.joiningDate}
                onChange={(e) => setExitForm((f) => ({ ...f, exitDate: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Reason</Label>
              <Select value={exitForm.status}
                onValueChange={(v) => setExitForm((f) => ({ ...f, status: v as "RESIGNED" | "TERMINATED" }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="RESIGNED">Resigned</SelectItem>
                  <SelectItem value="TERMINATED">Terminated</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setExitOpen(false)}>Cancel</Button>
            <Button
              disabled={!exitForm.exitDate || recordExit.isPending}
              onClick={async () => {
                try {
                  await recordExit.mutateAsync({
                    id: employee.id,
                    exitDate: exitForm.exitDate,
                    status: exitForm.status,
                  });
                  toast.success(`${employee.name} recorded as ${exitForm.status.toLowerCase()}.`);
                  setExitOpen(false);
                  setSeededFor(null);
                  router.refresh();
                } catch (err) {
                  toast.error((err as Error).message);
                }
              }}
            >
              {recordExit.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({
  label, value, onChange, hint, disabled, type = "text", step, min, placeholder,
}: {
  label: string;
  value: string;
  onChange?: (v: string) => void;
  hint?: string;
  disabled?: boolean;
  type?: string;
  step?: string;
  min?: string;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type={type}
        step={step}
        min={min}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value)}
      />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
