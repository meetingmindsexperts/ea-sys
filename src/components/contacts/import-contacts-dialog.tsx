"use client";

import { useState, useRef } from "react";
import { useContacts, useImportContactsToSpeakers, useImportContactsToRegistrations, useTickets } from "@/hooks/use-api";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Search, Users } from "lucide-react";

interface ImportContactsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventId: string;
  mode: "speaker" | "registration";
  onSuccess?: (result: { created: number; skipped: number }) => void;
}

const TAG_COLORS = [
  "bg-blue-100 text-blue-800",
  "bg-green-100 text-green-800",
  "bg-purple-100 text-purple-800",
  "bg-amber-100 text-amber-800",
];

function getTagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) % TAG_COLORS.length;
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

export function ImportContactsDialog({
  open,
  onOpenChange,
  eventId,
  mode,
  onSuccess,
}: ImportContactsDialogProps) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [ticketTypeId, setTicketTypeId] = useState("");
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filters: Record<string, string> = { limit: "50" };
  if (debouncedSearch) filters.search = debouncedSearch;

  const { data, isLoading } = useContacts(filters);
  const { data: ticketsData } = useTickets(eventId);
  const importToSpeakers = useImportContactsToSpeakers(eventId);
  const importToRegistrations = useImportContactsToRegistrations(eventId);

  interface Contact { id: string; firstName: string; lastName: string; email: string; organization?: string; tags?: string[]; }
  interface Ticket { id: string; name: string; }
  const contacts: Contact[] = (data?.contacts ?? []) as Contact[];
  const tickets: Ticket[] = (ticketsData ?? []) as Ticket[];
  const total: number = data?.total ?? 0;

  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => setDebouncedSearch(value), 400);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === contacts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(contacts.map((c) => c.id)));
    }
  };

  const handleImport = async () => {
    if (selectedIds.size === 0) {
      toast.error("Select at least one contact");
      return;
    }

    if (mode === "registration" && !ticketTypeId) {
      toast.error("Select a registration type");
      return;
    }

    try {
      let result: { created: number; skipped: number };

      if (mode === "speaker") {
        result = await importToSpeakers.mutateAsync(Array.from(selectedIds)) as { created: number; skipped: number };
      } else {
        result = await importToRegistrations.mutateAsync({
          contactIds: Array.from(selectedIds),
          ticketTypeId,
        }) as { created: number; skipped: number };
      }

      toast.success(
        `Imported ${result.created} ${mode === "speaker" ? "speaker" : "registration"}${result.created !== 1 ? "s" : ""}${result.skipped > 0 ? `, ${result.skipped} skipped (already exist)` : ""}`
      );
      onSuccess?.(result);
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    }
  };

  const isPending = importToSpeakers.isPending || importToRegistrations.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            Import Contacts as {mode === "speaker" ? "Speakers" : "Registrations"}
          </DialogTitle>
          <DialogDescription>
            Select contacts from your org repository to import into this event.
            {total > 0 && ` ${total.toLocaleString()} contacts available.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 flex-1 overflow-hidden flex flex-col min-h-0">
          {/* Ticket type selector for registrations */}
          {mode === "registration" && (
            <div className="space-y-1.5">
              <Label>Registration Type *</Label>
              <Select value={ticketTypeId} onValueChange={setTicketTypeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a registration type" />
                </SelectTrigger>
                <SelectContent>
                  {tickets.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, email, organization…"
              className="pl-9"
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
          </div>

          {/* Selection info */}
          {selectedIds.size > 0 && (
            <div className="flex items-center justify-between text-sm bg-primary/5 rounded-md px-3 py-2">
              <span className="font-medium text-primary">{selectedIds.size} selected</span>
              <button
                className="text-muted-foreground hover:text-foreground text-xs underline"
                onClick={() => setSelectedIds(new Set())}
              >
                Clear selection
              </button>
            </div>
          )}

          {/* Contact table */}
          <div className="border rounded-md overflow-auto flex-1 min-h-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="w-10 px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={contacts.length > 0 && selectedIds.size === contacts.length}
                      onChange={toggleSelectAll}
                      className="cursor-pointer"
                    />
                  </th>
                  <th className="text-left px-3 py-2.5 font-medium">Name</th>
                  <th className="text-left px-3 py-2.5 font-medium">Email</th>
                  <th className="text-left px-3 py-2.5 font-medium hidden sm:table-cell">Organization</th>
                  <th className="text-left px-3 py-2.5 font-medium hidden md:table-cell">Tags</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoading ? (
                  <tr>
                    <td colSpan={5} className="text-center py-8 text-muted-foreground">Loading…</td>
                  </tr>
                ) : contacts.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center py-8 text-muted-foreground">
                      <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
                      {debouncedSearch ? "No contacts match your search." : "No contacts in your org yet."}
                    </td>
                  </tr>
                ) : (
                  contacts.map((contact) => (
                    <tr
                      key={contact.id}
                      className={`cursor-pointer hover:bg-muted/30 transition-colors ${selectedIds.has(contact.id) ? "bg-primary/5" : ""}`}
                      onClick={() => toggleSelect(contact.id)}
                    >
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(contact.id)}
                          onChange={() => toggleSelect(contact.id)}
                          className="cursor-pointer"
                        />
                      </td>
                      <td className="px-3 py-2.5 font-medium">
                        {contact.firstName} {contact.lastName}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground text-xs">{contact.email}</td>
                      <td className="px-3 py-2.5 text-muted-foreground hidden sm:table-cell">
                        {contact.organization || "—"}
                      </td>
                      <td className="px-3 py-2.5 hidden md:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {(contact.tags || []).slice(0, 2).map((tag: string) => (
                            <span key={tag} className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${getTagColor(tag)}`}>
                              {tag}
                            </span>
                          ))}
                        </div>
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
            disabled={isPending || selectedIds.size === 0}
          >
            {isPending
              ? "Importing…"
              : `Import ${selectedIds.size > 0 ? selectedIds.size : ""} as ${mode === "speaker" ? "Speaker" : "Registration"}${selectedIds.size !== 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
