"use client";

/**
 * Searchable corporate-project picker (Nov 12, 2026): the deal form, and the
 * board and report filters. A deal is for an event OR a corporate project, so
 * this sits where the event picker would.
 *
 * `allowCreate` (the deal form) offers the typed name as a new project, the way
 * the account picker does: a rep entering a deal for work nobody has listed yet
 * is not sent to another page first. It is created with its name only; client,
 * days and owner are filled in on the Projects page.
 *
 * `fallbackName` names the selected project when it is not in the list (an
 * archived project still on a deal): the form shows what the deal holds.
 *
 * A typed name that is refused as taken is not a dead end (review of e92d660f):
 * the refusal names the project holding it, so the picker selects that one, or
 * says it is archived and how to get it back. An archived project keeps its
 * name and is not in this list, so "Create" is offered for it.
 */
import { useState } from "react";
import { BriefcaseBusiness, Check, ChevronsUpDown, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api-fetch";
import { fetchCrmProject, useCreateProject, useCrmProjects } from "@/crm/hooks/use-crm-api";

/** The server's rule for "the same name": trimmed, any case, inner spaces collapsed. */
function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** The project that already holds a refused name, when the refusal says which. */
function takenProjectId(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== "NAME_TAKEN") return null;
  const meta = err.data?.meta as { existingProjectId?: unknown } | undefined;
  return typeof meta?.existingProjectId === "string" ? meta.existingProjectId : null;
}

export function ProjectCombobox({
  value,
  onChange,
  clearLabel = "No project",
  className,
  allowClear = true,
  allowCreate = false,
  placeholder,
  fallbackName,
}: {
  value: string | null;
  /** `name` comes with a pick, so the caller can show it before its own list catches up. */
  onChange: (projectId: string | null, name?: string | null) => void;
  clearLabel?: string;
  className?: string;
  allowClear?: boolean;
  allowCreate?: boolean;
  placeholder?: string;
  fallbackName?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { data } = useCrmProjects();
  const create = useCreateProject();
  const projects = data?.projects ?? [];

  const selected = projects.find((p) => p.id === value) ?? null;
  const selectedName = selected?.name ?? (value ? fallbackName : null) ?? null;
  const typed = search.trim();
  const q = typed.toLowerCase();
  const filtered = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;
  const exact = projects.some((p) => nameKey(p.name) === nameKey(typed));

  function pick(id: string | null, name?: string | null) {
    onChange(id, name ?? null);
    setOpen(false);
    setSearch("");
  }

  /** True when the refused name was dealt with: its project selected, or the person told it is archived. */
  async function settleTakenName(err: unknown): Promise<boolean> {
    const existingId = takenProjectId(err);
    if (!existingId) return false;
    try {
      const existing = await fetchCrmProject(existingId);
      if (existing.archivedAt) {
        toast.error(`"${existing.name}" is an archived project`, {
          description: "It keeps its name. Restore it from the Archived view of the Projects page, which needs the permission to archive, or use another name.",
        });
        return true;
      }
      toast.info(`"${existing.name}" already exists, so it was selected.`);
      pick(existing.id, existing.name);
      return true;
    } catch {
      // The read failed: fall back to the refusal's own message.
      return false;
    }
  }

  async function createTyped() {
    try {
      const res = await create.mutateAsync({ name: typed });
      toast.success(`Created the project "${res.project.name}"`, {
        description: "Add its client, dates and owner on the Projects page.",
      });
      pick(res.project.id, res.project.name);
    } catch (err) {
      if (await settleTakenName(err)) return;
      toast.error(err instanceof Error ? err.message : "Could not create the project");
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("justify-between font-normal", className)}
        >
          <span className={cn("flex min-w-0 items-center gap-2 truncate", !selectedName && "text-muted-foreground")}>
            <BriefcaseBusiness className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{selectedName ?? placeholder ?? clearLabel}</span>
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[16rem] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search corporate projects…" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>{allowCreate ? "No project yet. Type its name to create it." : "No corporate projects match."}</CommandEmpty>
            {allowClear && (
              <CommandGroup>
                <CommandItem value="__clear__" onSelect={() => pick(null)}>
                  <X className="mr-2 h-4 w-4 text-muted-foreground" />
                  <span className="text-muted-foreground">{clearLabel}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {filtered.length > 0 && (
              <CommandGroup heading="Corporate projects">
                {filtered.slice(0, 100).map((p) => (
                  <CommandItem key={p.id} value={p.id} onSelect={() => pick(p.id, p.name)}>
                    <Check className={cn("mr-2 h-4 w-4 shrink-0", value === p.id ? "opacity-100" : "opacity-0")} />
                    <span className="min-w-0">
                      <span className="block truncate">{p.name}</span>
                      {(p.company || p.event) && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {[p.company?.name, p.event ? `counts under ${p.event.name}` : null].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {allowCreate && typed && !exact && (
              <CommandGroup>
                <CommandItem value="__create__" disabled={create.isPending} onSelect={createTyped}>
                  <Plus className="mr-2 h-4 w-4" />
                  <span className="truncate">Create the project &ldquo;{typed}&rdquo;</span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
