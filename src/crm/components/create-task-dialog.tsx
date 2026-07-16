"use client";

/**
 * Standalone task creation — the "New task" button on the Tasks tab.
 *
 * Until this existed, a task could only be born from a deal's follow-up box, so
 * "renew the Medtronic frame agreement" (not tied to any one deal) had nowhere
 * to live — the API always accepted unattached tasks; this is the form over it
 * (the "API exists, UI doesn't" gap, CRM_STATUS §4).
 *
 * Same reminder contract as the deal follow-up: a due date arms the reminder AT
 * the due date — the worker emails the owner when it falls due.
 */
import { useState } from "react";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateTask, useCrmReps } from "@/crm/hooks/use-crm-api";

const UNASSIGNED = "__none__";

export function CreateTaskDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { data: session } = useSession();
  const { data: reps = [] } = useCrmReps();
  const createTask = useCreateTask();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueAt, setDueAt] = useState("");
  // Default to "mine" — the person creating a follow-up almost always means
  // their own. The current user may not be in the reps list (e.g. ORGANIZER);
  // the synthetic option below keeps the Select truthful either way.
  const [ownerId, setOwnerId] = useState<string>(session?.user?.id ?? UNASSIGNED);

  const currentUserInReps = reps.some((r) => r.id === session?.user?.id);

  function reset() {
    setTitle("");
    setDescription("");
    setDueAt("");
    setOwnerId(session?.user?.id ?? UNASSIGNED);
  }

  async function handleSubmit() {
    if (!title.trim()) {
      toast.error("Give the task a title");
      return;
    }
    try {
      await createTask.mutateAsync({
        title: title.trim(),
        description: description.trim() || null,
        dueAt: dueAt || null,
        // A due date arms the reminder at the due date — the worker's contract.
        remindAt: dueAt || null,
        ownerId: ownerId === UNASSIGNED ? null : ownerId,
      });
    } catch {
      // Surfaced by the hook's onError toast; keep the form for a retry.
      return;
    }
    toast.success("Task added");
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          <DialogDescription asChild>
            <span>
              A follow-up that isn&apos;t tied to one deal — renewals, prospecting, admin.
              Deal follow-ups are added from the deal page.
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="task-title">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Renew the Medtronic frame agreement"
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSubmit();
              }}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-desc">Details</Label>
            <Textarea
              id="task-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="task-due">Due</Label>
              <Input id="task-due" type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                A due date also sets the reminder — the owner gets an email when it&apos;s due.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Owner</Label>
              <Select value={ownerId} onValueChange={setOwnerId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* The creator may not be a listed rep (e.g. ORGANIZER) — keep
                      their option rendering truthfully instead of a blank trigger. */}
                  {!currentUserInReps && session?.user?.id && (
                    <SelectItem value={session.user.id}>Me</SelectItem>
                  )}
                  {reps.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.id === session?.user?.id ? "Me" : `${r.firstName} ${r.lastName}`}
                    </SelectItem>
                  ))}
                  <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={createTask.isPending || !title.trim()}>
            {createTask.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
            Add task
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
