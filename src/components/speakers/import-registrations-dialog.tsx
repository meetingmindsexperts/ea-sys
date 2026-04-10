"use client";

import { useState, useRef } from "react";
import { useRegistrations, useImportRegistrationsToSpeakers } from "@/hooks/use-api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Search, Users } from "lucide-react";
import { formatPersonName } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/use-api";

interface ImportRegistrationsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: string;
}

const statusColors: Record<string, string> = {
  CONFIRMED: "bg-green-100 text-green-800",
  PENDING: "bg-yellow-100 text-yellow-800",
  WAITLISTED: "bg-blue-100 text-blue-800",
  CHECKED_IN: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-gray-100 text-gray-800",
};

interface Registration {
  id: string;
  status: string;
  attendee: {
    title?: string | null;
    firstName: string;
    lastName: string;
    email: string;
    organization?: string | null;
  };
  ticketType: {
    name: string;
  } | null;
}

export function ImportRegistrationsDialog({
  open,
  onOpenChange,
  eventId,
}: ImportRegistrationsDialogProps) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryClient = useQueryClient();

  const { data: registrationsData, isLoading } = useRegistrations(eventId);
  const importToSpeakers = useImportRegistrationsToSpeakers(eventId);

  const allRegistrations: Registration[] = (registrationsData ?? []) as Registration[];

  // Filter out cancelled and apply search
  const registrations = allRegistrations.filter((r) => {
    if (r.status === "CANCELLED") return false;
    if (!debouncedSearch) return true;
    const q = debouncedSearch.toLowerCase();
    return (
      r.attendee.firstName.toLowerCase().includes(q) ||
      r.attendee.lastName.toLowerCase().includes(q) ||
      r.attendee.email.toLowerCase().includes(q) ||
      (r.attendee.organization && r.attendee.organization.toLowerCase().includes(q)) ||
      (r.ticketType?.name?.toLowerCase().includes(q) ?? false)
    );
  });

  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => setDebouncedSearch(value), 300);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === registrations.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(registrations.map((r) => r.id)));
    }
  };

  const handleImport = async () => {
    if (selectedIds.size === 0) {
      toast.error("Select at least one registration");
      return;
    }

    try {
      const result = (await importToSpeakers.mutateAsync(
        Array.from(selectedIds)
      )) as { created: number; skipped: number };

      toast.success(
        `Imported ${result.created} speaker${result.created !== 1 ? "s" : ""}${
          result.skipped > 0 ? `, ${result.skipped} skipped (already exist)` : ""
        }`
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.speakers(eventId) });
      setSelectedIds(new Set());
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[90vw] lg:min-w-[750px] lg:max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Import Registrations as Speakers</DialogTitle>
          <DialogDescription>
            Select registrations from this event to add as speakers.
            {registrations.length > 0 &&
              ` ${registrations.length} registration${registrations.length !== 1 ? "s" : ""} available.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 flex-1 overflow-hidden flex flex-col min-h-0">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, email, organization, or registration type…"
              className="pl-9"
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
          </div>

          {/* Selection info */}
          {selectedIds.size > 0 && (
            <div className="flex items-center justify-between text-sm bg-primary/5 rounded-md px-3 py-2">
              <span className="font-medium text-primary">
                {selectedIds.size} selected
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground text-xs underline"
                onClick={() => setSelectedIds(new Set())}
              >
                Clear selection
              </button>
            </div>
          )}

          {/* Registration table */}
          <div className="border rounded-md overflow-auto flex-1 min-h-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="w-10 px-3 py-2.5">
                    <input
                      type="checkbox"
                      title="Select all"
                      checked={
                        registrations.length > 0 &&
                        selectedIds.size === registrations.length
                      }
                      onChange={toggleSelectAll}
                      className="cursor-pointer"
                    />
                  </th>
                  <th className="text-left px-3 py-2.5 font-medium">Name</th>
                  <th className="text-left px-3 py-2.5 font-medium">Email</th>
                  <th className="text-left px-3 py-2.5 font-medium hidden sm:table-cell">
                    Organization
                  </th>
                  <th className="text-left px-3 py-2.5 font-medium hidden md:table-cell">
                    Registration Type
                  </th>
                  <th className="text-left px-3 py-2.5 font-medium hidden md:table-cell">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoading ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="text-center py-8 text-muted-foreground"
                    >
                      Loading…
                    </td>
                  </tr>
                ) : registrations.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="text-center py-8 text-muted-foreground"
                    >
                      <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
                      {debouncedSearch
                        ? "No registrations match your search."
                        : "No registrations for this event yet."}
                    </td>
                  </tr>
                ) : (
                  registrations.map((reg) => (
                    <tr
                      key={reg.id}
                      className={`cursor-pointer hover:bg-muted/30 transition-colors ${
                        selectedIds.has(reg.id) ? "bg-primary/5" : ""
                      }`}
                      onClick={() => toggleSelect(reg.id)}
                    >
                      <td
                        className="px-3 py-2.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          title={`Select ${reg.attendee.firstName} ${reg.attendee.lastName}`}
                          checked={selectedIds.has(reg.id)}
                          onChange={() => toggleSelect(reg.id)}
                          className="cursor-pointer"
                        />
                      </td>
                      <td className="px-3 py-2.5 font-medium">
                        {formatPersonName(
                          reg.attendee.title,
                          reg.attendee.firstName,
                          reg.attendee.lastName
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground text-xs">
                        {reg.attendee.email}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground hidden sm:table-cell">
                        {reg.attendee.organization || "—"}
                      </td>
                      <td className="px-3 py-2.5 hidden md:table-cell">
                        <span className="text-xs bg-muted px-2 py-0.5 rounded-md font-medium">
                          {reg.ticketType?.name ?? "—"}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 hidden md:table-cell">
                        <Badge
                          variant="outline"
                          className={
                            statusColors[reg.status] ?? "bg-gray-100 text-gray-800"
                          }
                        >
                          {reg.status}
                        </Badge>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            className="btn-gradient"
            onClick={handleImport}
            disabled={importToSpeakers.isPending || selectedIds.size === 0}
          >
            {importToSpeakers.isPending
              ? "Importing…"
              : `Import ${selectedIds.size > 0 ? selectedIds.size : ""} as Speaker${
                  selectedIds.size !== 1 ? "s" : ""
                }`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
