"use client";

/**
 * /hr/employees — the employee register: add, edit, and record a leaver.
 *
 * THE EXIT FLOW NEVER DELETES. Setting an exit date is what removes somebody
 * from the active list, and the record stays visible forever: it is the evidence
 * for end-of-service gratuity and leave encashment, and it outlives both the
 * login and the employment. There is deliberately no delete button.
 *
 * The exit date is the LAST WORKING DAY, inclusive, and the form says so.
 * Getting that off by one silently drops whatever the person did on their final
 * day, which is exactly the day somebody is most likely to be taking leave.
 */

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  useHrEmployees,
  useCreateHrEmployee,
  useUpdateHrEmployee,
  useHrEmployeeExit,
  type HrEmployee,
} from "@/hr/hooks/use-hr-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, LogOut, Pencil, Plus, Users } from "lucide-react";

const EMPTY = {
  empCode: "", name: "", department: "", jobTitle: "",
  joiningDate: "", exitDate: "", status: "ACTIVE" as "ACTIVE" | "RESIGNED" | "TERMINATED",
  carryoverDays: "0", openingSickUsed: "0", openingCompOff: "0", notes: "",
};

export default function HrEmployeesPage() {
  const [includeExited, setIncludeExited] = useState(true);
  const { data: employees = [], isLoading, isError, error } = useHrEmployees(includeExited);
  const create = useCreateHrEmployee();
  const update = useUpdateHrEmployee();
  const exit = useHrEmployeeExit();

  const [editing, setEditing] = useState<HrEmployee | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [exiting, setExiting] = useState<HrEmployee | null>(null);
  const [exitForm, setExitForm] = useState({ exitDate: "", status: "RESIGNED" as "RESIGNED" | "TERMINATED" });

  function openAdd() {
    setForm({ ...EMPTY });
    setEditing(null);
    setAdding(true);
  }
  function openEdit(e: HrEmployee) {
    setForm({
      empCode: e.empCode,
      name: e.name,
      department: e.department ?? "",
      jobTitle: e.jobTitle ?? "",
      joiningDate: e.joiningDate,
      exitDate: e.exitDate ?? "",
      status: e.status as "ACTIVE" | "RESIGNED" | "TERMINATED",
      carryoverDays: String(e.carryoverDays),
      openingSickUsed: String(e.openingSickUsed),
      openingCompOff: String(e.openingCompOff),
      notes: e.notes ?? "",
    });
    setEditing(e);
    setAdding(true);
  }

  async function save() {
    if (!form.empCode.trim() || !form.name.trim() || !form.joiningDate) {
      toast.error("Employee code, name and joining date are required.");
      return;
    }
    const payload = {
      empCode: form.empCode.trim(),
      name: form.name.trim(),
      department: form.department.trim() || null,
      jobTitle: form.jobTitle.trim() || null,
      joiningDate: form.joiningDate,
      carryoverDays: Number(form.carryoverDays) || 0,
      openingSickUsed: Number(form.openingSickUsed) || 0,
      openingCompOff: Number(form.openingCompOff) || 0,
      notes: form.notes.trim() || null,
    };
    try {
      if (editing) {
        // empCode is not sent on edit: it is the business key the workbook and
        // every report join on, and renaming it silently orphans that history.
        const { empCode: _unused, ...patch } = payload;
        void _unused;
        await update.mutateAsync({
          id: editing.id,
          ...patch,
          // Empty means "still employed" and must CLEAR the stored date, so it
          // is sent as an explicit null rather than omitted. Omitting it is how
          // an employee ends up Active with a leaving date still on file — the
          // exact state that could not be corrected before.
          exitDate: form.exitDate || null,
          status: form.status,
        });
        toast.success("Employee updated.");
      } else {
        await create.mutateAsync(payload);
        toast.success("Employee added.");
      }
      setAdding(false);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function saveExit() {
    if (!exiting || !exitForm.exitDate) {
      toast.error("Pick the last working day.");
      return;
    }
    try {
      await exit.mutateAsync({ id: exiting.id, ...exitForm });
      toast.success(`${exiting.name} recorded as ${exitForm.status.toLowerCase()}.`);
      setExiting(null);
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
          <Button onClick={openAdd}><Plus className="h-4 w-4" />Add employee</Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Code</th>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-left font-medium">Department</th>
                <th className="px-3 py-2 text-left font-medium">Joined</th>
                <th className="px-3 py-2 text-left font-medium">Left</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Carried in</th>
                <th className="px-3 py-2 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {employees.map((e) => (
                <tr key={e.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2 font-mono text-xs">{e.empCode}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{e.name}</div>
                    {e.jobTitle && <div className="text-xs text-muted-foreground">{e.jobTitle}</div>}
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
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(e)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {e.status === "ACTIVE" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          title="Record a leaver"
                          onClick={() => {
                            setExiting(e);
                            setExitForm({ exitDate: "", status: "RESIGNED" });
                          }}
                        >
                          <LogOut className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {employees.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                    No employees yet. Add one, or run the workbook import.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.name}` : "Add employee"}</DialogTitle>
            <DialogDescription asChild>
              <span className="text-sm text-muted-foreground">
                Annual leave starts at the first anniversary; nothing accrues before it.
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Employee code *</Label>
              <Input
                value={form.empCode}
                disabled={!!editing}
                onChange={(e) => setForm((f) => ({ ...f, empCode: e.target.value }))}
                placeholder="EMP026"
              />
              {editing && (
                <p className="text-[11px] text-muted-foreground">
                  Fixed after creation: reports join on it.
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Name *</Label>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Department</Label>
              <Input value={form.department} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Job title</Label>
              <Input value={form.jobTitle} onChange={(e) => setForm((f) => ({ ...f, jobTitle: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Joining date *</Label>
              <Input type="date" value={form.joiningDate} onChange={(e) => setForm((f) => ({ ...f, joiningDate: e.target.value }))} />
            </div>
            {editing && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">Last working day</Label>
                  <Input
                    type="date"
                    value={form.exitDate}
                    min={form.joiningDate || undefined}
                    onChange={(e) => setForm((f) => ({ ...f, exitDate: e.target.value }))}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Leave empty if they are still employed. Clearing it is how a leaver
                    recorded by mistake is put back &mdash; set the status to Active as well.
                  </p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Status</Label>
                  <Select
                    value={form.status}
                    onValueChange={(v) => setForm((f) => ({ ...f, status: v as typeof f.status }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ACTIVE">Active</SelectItem>
                      <SelectItem value="RESIGNED">Resigned</SelectItem>
                      <SelectItem value="TERMINATED">Terminated</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    A last working day in the future with the status still Active is a
                    person serving notice, which is a real state and is left alone.
                  </p>
                </div>
              </>
            )}
            <div className="space-y-1">
              <Label className="text-xs">Carried-in annual days</Label>
              <Input type="number" step="0.5" value={form.carryoverDays} onChange={(e) => setForm((f) => ({ ...f, carryoverDays: e.target.value }))} />
              <p className="text-[11px] text-muted-foreground">
                Capped at 30. A negative carries in full: leave taken in advance follows the person.
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Opening sick days used</Label>
              <Input type="number" step="0.5" value={form.openingSickUsed} onChange={(e) => setForm((f) => ({ ...f, openingSickUsed: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Opening comp-off</Label>
              <Input type="number" step="0.5" value={form.openingCompOff} onChange={(e) => setForm((f) => ({ ...f, openingCompOff: e.target.value }))} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">Notes</Label>
              <Input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            <Button onClick={save} disabled={create.isPending || update.isPending}>
              {(create.isPending || update.isPending) && <Loader2 className="h-4 w-4 animate-spin" />}
              {editing ? "Save changes" : "Add employee"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!exiting} onOpenChange={(open) => !open && setExiting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record a leaver</DialogTitle>
            <DialogDescription asChild>
              <span className="text-sm text-muted-foreground">
                {exiting?.name}&apos;s record is kept, not deleted. Attendance can no
                longer be recorded after the last working day.
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Last working day *</Label>
              <Input
                type="date"
                value={exitForm.exitDate}
                onChange={(e) => setExitForm((f) => ({ ...f, exitDate: e.target.value }))}
              />
              <p className="text-[11px] text-muted-foreground">
                Inclusive: leave taken on this day still counts.
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Reason</Label>
              <Select
                value={exitForm.status}
                onValueChange={(v) => setExitForm((f) => ({ ...f, status: v as "RESIGNED" | "TERMINATED" }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="RESIGNED">Resigned</SelectItem>
                  <SelectItem value="TERMINATED">Terminated</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setExiting(null)}>Cancel</Button>
            <Button onClick={saveExit} disabled={exit.isPending}>
              {exit.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Record exit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
