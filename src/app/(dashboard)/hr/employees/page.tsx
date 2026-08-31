"use client";

/**
 * /hr/employees — the roster.
 *
 * A list, and nothing more. Editing lives on the employee's own page
 * (`/hr/employees/[id]`): the dialog that used to sit here held eleven fields
 * including the three seeds that decide a leave balance, which is more than a
 * modal should carry and gave no room to show the balance those seeds move.
 *
 * What is left here is the one action a list is the right place for: adding
 * somebody. That form asks for the minimum needed to create a person and no
 * more — everything else is managed on their record once they exist. Splitting
 * it that way is also what stops the same eleven fields being maintained twice.
 *
 * Leavers are kept, never deleted: the record is the evidence for gratuity and
 * leave encashment, so there is deliberately no delete anywhere on this page.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useCreateHrEmployee, useHrEmployees } from "@/hr/hooks/use-hr-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { ChevronRight, Loader2, Plus, Users } from "lucide-react";

const EMPTY_ADD = {
  empCode: "", name: "", department: "", jobTitle: "", joiningDate: "",
};

export default function HrEmployeesPage() {
  const router = useRouter();
  const [includeExited, setIncludeExited] = useState(true);
  const { data: employees = [], isLoading, isError, error } = useHrEmployees(includeExited);
  const create = useCreateHrEmployee();

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_ADD);
  const [prevOpen, setPrevOpen] = useState(false);
  if (adding !== prevOpen) {
    setPrevOpen(adding);
    // Re-seed on every closed -> open transition, so a half-typed person is not
    // still sitting there tomorrow.
    if (adding) setForm(EMPTY_ADD);
  }

  async function add() {
    if (!form.empCode.trim() || !form.name.trim() || !form.joiningDate) {
      toast.error("Employee code, name and joining date are required.");
      return;
    }
    try {
      const res = await create.mutateAsync({
        empCode: form.empCode.trim(),
        name: form.name.trim(),
        department: form.department.trim() || null,
        jobTitle: form.jobTitle.trim() || null,
        joiningDate: form.joiningDate,
      });
      setAdding(false);
      toast.success(`${res.employee.name} added. Set their leave figures on their record.`);
      // Straight to the record, because a new person always needs the fields the
      // add form deliberately does not ask for.
      router.push(`/hr/employees/${res.employee.id}`);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  if (isError) {
    return (
      <div className="mx-auto mt-20 max-w-md rounded-lg border border-amber-300 bg-amber-50 p-6 text-center">
        <h2 className="font-semibold text-amber-900">Couldn&apos;t load employees</h2>
        <p className="mt-2 text-sm text-amber-800">{(error as Error)?.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Users className="h-6 w-6 text-primary" />
            Employees
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Leavers are kept, never deleted: the record is the evidence for gratuity
            and leave encashment.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setIncludeExited((v) => !v)}>
            {includeExited ? "Active only" : "Include leavers"}
          </Button>
          <Button asChild variant="secondary"><Link href="/hr">Leave summary</Link></Button>
          <Button asChild variant="secondary"><Link href="/hr/attendance">Attendance</Link></Button>
          <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" />Add employee</Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Code</th>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-left font-medium">Department</th>
                <th className="px-3 py-2 text-left font-medium">Joined</th>
                <th className="px-3 py-2 text-left font-medium">Left</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Carried in</th>
                <th className="px-3 py-2 text-right font-medium">Entitlement</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {employees.map((e) => (
                <tr
                  key={e.id}
                  onClick={() => router.push(`/hr/employees/${e.id}`)}
                  className="cursor-pointer hover:bg-muted/40"
                >
                  <td className="px-3 py-2 font-mono text-xs">{e.empCode}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{e.name}</div>
                    <div className="text-xs text-muted-foreground">{e.jobTitle ?? ""}</div>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{e.department ?? "—"}</td>
                  <td className="px-3 py-2 tabular-nums">{e.joiningDate}</td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">
                    {e.exitDate ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    {e.status === "ACTIVE" ? (
                      <Badge variant="secondary">Active</Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">
                        {e.status === "RESIGNED" ? "Resigned" : "Terminated"}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{e.carryoverDays}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {/* Blank means the standard rule, which is the common case and
                        does not need repeating on 23 rows. A number here always
                        means somebody agreed it. */}
                    {e.annualEntitlementDays === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        {e.annualEntitlementDays}
                        <Badge variant="outline" className="text-[10px]">agreed</Badge>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
                  </td>
                </tr>
              ))}
              {employees.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-10 text-center text-muted-foreground">
                    No employees yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add employee</DialogTitle>
            <DialogDescription>
              Just enough to create the person. Leave figures, exit dates and notes are
              set on their record, which opens as soon as you save.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Employee code *</Label>
                <Input
                  value={form.empCode}
                  placeholder="EMP026"
                  onChange={(e) => setForm((f) => ({ ...f, empCode: e.target.value }))}
                />
                <p className="text-[11px] text-muted-foreground">
                  Fixed after creation: reports join on it.
                </p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Joining date *</Label>
                <Input
                  type="date"
                  value={form.joiningDate}
                  onChange={(e) => setForm((f) => ({ ...f, joiningDate: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Full name *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Department</Label>
                <Input
                  value={form.department}
                  onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Job title</Label>
                <Input
                  value={form.jobTitle}
                  onChange={(e) => setForm((f) => ({ ...f, jobTitle: e.target.value }))}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button onClick={add} disabled={create.isPending}>
              {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Add employee
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
