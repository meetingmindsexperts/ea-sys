"use client";

/**
 * Create or edit a corporate project (Nov 12, 2026): its name, the client
 * account, its days, its place and the colleague responsible for it. The link
 * to an event is NOT here: it is a correction, made on the project's own page
 * where what it changes is spelled out.
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CompanyCombobox, type CompanySelection } from "@/crm/components/company-combobox";
import { resolveDealCompanyId } from "@/crm/components/crm-deal-form-fields";
import { useCreateCompany, useCreateProject, useCrmReps, useUpdateProject } from "@/crm/hooks/use-crm-api";
import type { CrmProjectRow } from "@/crm/lib/crm-types";

const NO_OWNER = "__none__";

interface ProjectFormState {
  name: string;
  company: CompanySelection | null;
  startDate: string;
  endDate: string;
  location: string;
  ownerId: string | null;
}

function formFrom(project?: CrmProjectRow | null): ProjectFormState {
  return {
    name: project?.name ?? "",
    company: project?.company ? { id: project.company.id, name: project.company.name } : null,
    startDate: project?.startDate ?? "",
    endDate: project?.endDate ?? "",
    location: project?.location ?? "",
    ownerId: project?.owner?.id ?? null,
  };
}

/** First failing rule as a message, or null when the form is sound. */
function invalid(f: ProjectFormState): string | null {
  if (!f.name.trim()) return "Give the project a name";
  if (f.startDate && f.endDate && f.endDate < f.startDate) return "The end date is before the start date";
  return null;
}

export function ProjectDialog({
  open,
  onOpenChange,
  project,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Edit this project; omit to create one. */
  project?: CrmProjectRow | null;
}) {
  const [form, setForm] = useState<ProjectFormState>(() => formFrom(project));
  const [saving, setSaving] = useState(false);
  const { data: reps = [] } = useCrmReps();
  const createCompany = useCreateCompany();
  const createProject = useCreateProject();
  const updateProject = useUpdateProject(project?.id ?? "");
  const set = (patch: Partial<ProjectFormState>) => setForm((f) => ({ ...f, ...patch }));

  async function handleSubmit() {
    const problem = invalid(form);
    if (problem) {
      toast.error(problem);
      return;
    }
    setSaving(true);
    try {
      const companyId = await resolveDealCompanyId(form.company, (b) => createCompany.mutateAsync(b));
      const body = {
        name: form.name.trim(),
        companyId,
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        location: form.location.trim() || null,
        ownerId: form.ownerId,
      };
      if (project) await updateProject.mutateAsync(body);
      else await createProject.mutateAsync(body);
      toast.success(project ? "Project saved" : "Project created");
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the project");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{project ? "Edit corporate project" : "New corporate project"}</DialogTitle>
          <DialogDescription>
            Work you sell that is not an event in the system: a client&rsquo;s own meeting, an advisory board, an experts tour.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="project-name">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="project-name"
              name="project-name"
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Novartis Advisory Board, March 2027"
              maxLength={255}
            />
          </div>
          <div className="space-y-2">
            <Label>Client account</Label>
            <CompanyCombobox value={form.company} onChange={(company) => set({ company })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="project-start">Start date</Label>
              <Input id="project-start" name="project-start" type="date" value={form.startDate} onChange={(e) => set({ startDate: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="project-end">End date</Label>
              <Input id="project-end" name="project-end" type="date" value={form.endDate} min={form.startDate || undefined} onChange={(e) => set({ endDate: e.target.value })} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-location">Location</Label>
            <Input
              id="project-location"
              name="project-location"
              value={form.location}
              onChange={(e) => set({ location: e.target.value })}
              placeholder="Dubai, UAE"
              maxLength={255}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-owner">Project owner</Label>
            <Select value={form.ownerId ?? NO_OWNER} onValueChange={(v) => set({ ownerId: v === NO_OWNER ? null : v })}>
              <SelectTrigger id="project-owner" className="w-full">
                <SelectValue placeholder="No owner" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_OWNER}>No owner</SelectItem>
                {reps.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.firstName} {u.lastName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" className="btn-gradient text-white" onClick={handleSubmit} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {project ? "Save" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
