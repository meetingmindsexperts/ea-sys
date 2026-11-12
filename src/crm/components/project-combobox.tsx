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
 */
import { useState } from "react";
import { BriefcaseBusiness, Check, ChevronsUpDown, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { useCreateProject, useCrmProjects } from "@/crm/hooks/use-crm-api";

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
  onChange: (projectId: string | null) => void;
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
  const exact = projects.some((p) => p.name.trim().toLowerCase() === q);

  function pick(id: string | null) {
    onChange(id);
    setOpen(false);
    setSearch("");
  }

  async function createTyped() {
    try {
      const res = await create.mutateAsync({ name: typed });
      toast.success(`Created the project "${res.project.name}"`, {
        description: "Add its client, dates and owner on the Projects page.",
      });
      pick(res.project.id);
    } catch (err) {
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
                  <CommandItem key={p.id} value={p.id} onSelect={() => pick(p.id)}>
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
