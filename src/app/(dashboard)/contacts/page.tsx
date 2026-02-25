"use client";

import { useState, useCallback, useRef, useMemo } from "react";
import {
  useContacts,
  useCreateContact,
  useUpdateContact,
  useDeleteContact,
  useContactTags,
  useUpdateContactTags,
  useBulkTagContacts,
} from "@/hooks/use-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PhotoUpload } from "@/components/ui/photo-upload";
import { CountrySelect } from "@/components/ui/country-select";
import { TagInput } from "@/components/ui/tag-input";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  UserPlus,
  Upload,
  Download,
  FileDown,
  Search,
  Pencil,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Users,
  Tag,
  X,
} from "lucide-react";
import { formatDate } from "@/lib/utils";

interface Contact {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  organization?: string;
  jobTitle?: string;
  phone?: string;
  photo?: string;
  city?: string;
  country?: string;
  tags?: string[];
  notes?: string;
  createdAt: string;
}

const LIMIT = 50;

const TAG_COLORS = [
  "bg-blue-100 text-blue-800",
  "bg-green-100 text-green-800",
  "bg-purple-100 text-purple-800",
  "bg-amber-100 text-amber-800",
  "bg-rose-100 text-rose-800",
  "bg-cyan-100 text-cyan-800",
];

function getTagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) % TAG_COLORS.length;
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

const emptyForm = {
  firstName: "",
  lastName: "",
  email: "",
  organization: "",
  jobTitle: "",
  phone: "",
  photo: null as string | null,
  city: "",
  country: "",
  tags: [] as string[],
  notes: "",
};

type TagMode = "add" | "remove" | "replace";

export default function ContactsPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());

  // Add/Edit sheet
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [form, setForm] = useState(emptyForm);

  // Delete
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Tag dialog (bulk or single)
  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [tagDialogMode, setTagDialogMode] = useState<TagMode>("add");
  const [tagDialogContactId, setTagDialogContactId] = useState<string | null>(null); // null = bulk
  const [tagDialogValue, setTagDialogValue] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const filters: Record<string, string> = { page: String(page), limit: String(LIMIT) };
  if (search) filters.search = search;
  if (tagFilter.size > 0) filters.tags = [...tagFilter].join(",");

  const { data, isLoading, isFetching } = useContacts(filters);
  const { data: tagsData } = useContactTags();
  const createContact = useCreateContact();
  const updateContact = useUpdateContact(editingContact?.id || "");
  const updateContactTags = useUpdateContactTags();
  const bulkTagContacts = useBulkTagContacts();
  const deleteContact = useDeleteContact();

  const contacts: Contact[] = useMemo(
    () => (data?.contacts ?? []) as Contact[],
    [data?.contacts]
  );
  const total: number = data?.total ?? 0;
  const totalPages: number = data?.totalPages ?? 1;
  const allTags: string[] = tagsData?.tags ?? [];

  // Debounced search
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => {
      setSearch(value);
      setPage(1);
    }, 400);
  };

  const toggleTagFilter = (tag: string) => {
    setTagFilter((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) { next.delete(tag); } else { next.add(tag); }
      return next;
    });
    setPage(1);
  };

  const openAdd = useCallback(() => {
    setEditingContact(null);
    setForm(emptyForm);
    setSheetOpen(true);
  }, []);

  const openEdit = useCallback((contact: Contact) => {
    setEditingContact(contact);
    setForm({
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      organization: contact.organization || "",
      jobTitle: contact.jobTitle || "",
      phone: contact.phone || "",
      photo: contact.photo || null,
      city: contact.city || "",
      country: contact.country || "",
      tags: contact.tags || [],
      notes: contact.notes || "",
    });
    setSheetOpen(true);
  }, []);

  // Open tag dialog for a single contact or bulk (contactId=null)
  const openTagDialog = useCallback(
    (contactId: string | null, defaultMode: TagMode) => {
      setTagDialogContactId(contactId);
      setTagDialogMode(defaultMode);
      // Pre-fill with current tags only for replace mode on single contact
      if (contactId && defaultMode === "replace") {
        const contact = contacts.find((c) => c.id === contactId);
        setTagDialogValue(contact?.tags ?? []);
      } else {
        setTagDialogValue([]);
      }
      setTagDialogOpen(true);
    },
    [contacts]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim().toLowerCase(),
      organization: form.organization.trim() || undefined,
      jobTitle: form.jobTitle.trim() || undefined,
      phone: form.phone.trim() || undefined,
      photo: form.photo || undefined,
      city: form.city.trim() || undefined,
      country: form.country.trim() || undefined,
      tags: form.tags,
      notes: form.notes.trim() || undefined,
    };

    try {
      if (editingContact) {
        await updateContact.mutateAsync(payload);
        toast.success("Contact updated");
      } else {
        await createContact.mutateAsync(payload);
        toast.success("Contact added");
      }
      setSheetOpen(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save contact");
    }
  };

  const handleTagDialogSubmit = async () => {
    if (tagDialogValue.length === 0 && tagDialogMode !== "replace") {
      toast.error("Enter at least one tag");
      return;
    }
    try {
      if (tagDialogContactId) {
        // Single contact — compute new tags client-side then PUT
        const contact = contacts.find((c) => c.id === tagDialogContactId);
        const currentTags = contact?.tags ?? [];
        let newTags: string[];
        if (tagDialogMode === "add") {
          newTags = [...new Set([...currentTags, ...tagDialogValue])];
        } else if (tagDialogMode === "remove") {
          const toRemove = new Set(tagDialogValue);
          newTags = currentTags.filter((t) => !toRemove.has(t));
        } else {
          newTags = tagDialogValue;
        }
        await updateContactTags.mutateAsync({ contactId: tagDialogContactId, tags: newTags });
        toast.success("Tags updated");
      } else {
        // Bulk
        await bulkTagContacts.mutateAsync({
          contactIds: [...selectedIds],
          tags: tagDialogValue,
          mode: tagDialogMode,
        });
        const verb =
          tagDialogMode === "add" ? "added to" : tagDialogMode === "remove" ? "removed from" : "replaced on";
        toast.success(`Tags ${verb} ${selectedIds.size} contact${selectedIds.size !== 1 ? "s" : ""}`);
        setSelectedIds(new Set());
      }
      setTagDialogOpen(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to update tags");
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await deleteContact.mutateAsync(deleteId);
      toast.success("Contact deleted");
      setDeleteId(null);
    } catch {
      toast.error("Failed to delete contact");
    }
  };

  const handleImportCSV = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    e.target.value = "";

    const toastId = toast.loading("Importing contacts…");
    try {
      const res = await fetch("/api/contacts/import", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      toast.dismiss(toastId);
      toast.success(`Imported ${data.created} contacts${data.skipped > 0 ? `, ${data.skipped} skipped (duplicates)` : ""}${data.errors?.length > 0 ? `, ${data.errors.length} errors` : ""}`);
      setPage(1);
    } catch (err: unknown) {
      toast.dismiss(toastId);
      toast.error(err instanceof Error ? err.message : "Import failed");
    }
  };

  const handleExportCSV = () => {
    window.location.href = "/api/contacts/export";
  };

  const handleDownloadTemplate = () => {
    const csv = [
      "firstName,lastName,email,organization,jobTitle,phone,tags,notes",
      'John,Smith,john@example.com,Acme Corp,CEO,+1-555-0123,"VIP, Speaker",Met at conference 2025',
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "contacts-template.csv";
    a.click();
    URL.revokeObjectURL(url);
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

  const isBusy = updateContactTags.isPending || bulkTagContacts.isPending;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Contacts</h1>
          <p className="text-muted-foreground text-sm">Org-wide contact repository</p>
        </div>
        <div className="flex gap-2">
          <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={handleImportCSV} />
          <Button variant="outline" size="sm" onClick={handleDownloadTemplate}>
            <FileDown className="h-4 w-4 mr-1" /> CSV Template
          </Button>
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
            <Upload className="h-4 w-4 mr-1" /> Import CSV
          </Button>
          <Button variant="outline" size="sm" onClick={handleExportCSV}>
            <Download className="h-4 w-4 mr-1" /> Export CSV
          </Button>
          <Button size="sm" className="btn-gradient" onClick={openAdd}>
            <UserPlus className="h-4 w-4 mr-1" /> Add Contact
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 max-w-xs">
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <Users className="h-3.5 w-3.5" /> Total
          </div>
          <div className="text-2xl font-bold">{total.toLocaleString()}</div>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <Tag className="h-3.5 w-3.5" /> Tags
          </div>
          <div className="text-2xl font-bold">{allTags.length}</div>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by name, email, organization…"
          className="pl-9"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
        />
      </div>

      {/* Tag filter bar */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-xs text-muted-foreground font-medium mr-1">Filter by tag:</span>
          {allTags.map((tag) => (
            <button
              type="button"
              key={tag}
              onClick={() => toggleTagFilter(tag)}
              className={`text-xs px-2.5 py-1 rounded-full border font-medium transition-colors cursor-pointer ${
                tagFilter.has(tag)
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border hover:bg-muted " + getTagColor(tag)
              }`}
            >
              {tag}
            </button>
          ))}
          {tagFilter.size > 0 && (
            <button
              type="button"
              onClick={() => { setTagFilter(new Set()); setPage(1); }}
              className="text-xs text-muted-foreground underline ml-1 cursor-pointer"
            >
              Clear filter
            </button>
          )}
        </div>
      )}

      {/* Bulk actions bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-muted/60 rounded-lg border">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => openTagDialog(null, "add")}>
              <Tag className="h-3.5 w-3.5 mr-1" /> Add Tags
            </Button>
            <Button size="sm" variant="outline" onClick={() => openTagDialog(null, "remove")}>
              <X className="h-3.5 w-3.5 mr-1" /> Remove Tags
            </Button>
            <Button size="sm" variant="outline" onClick={() => openTagDialog(null, "replace")}>
              Replace Tags
            </Button>
          </div>
          <button
            type="button"
            className="ml-auto text-xs text-muted-foreground underline cursor-pointer"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="w-10 px-3 py-3">
                <input
                  type="checkbox"
                  checked={contacts.length > 0 && selectedIds.size === contacts.length}
                  onChange={toggleSelectAll}
                  className="cursor-pointer"
                />
              </th>
              <th className="text-left px-3 py-3 font-medium">Name</th>
              <th className="text-left px-3 py-3 font-medium">Email</th>
              <th className="text-left px-3 py-3 font-medium hidden md:table-cell">Organization</th>
              <th className="text-left px-3 py-3 font-medium hidden lg:table-cell">Tags</th>
              <th className="text-left px-3 py-3 font-medium hidden lg:table-cell">Added</th>
              <th className="w-28 px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : contacts.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-12 text-muted-foreground">
                  {search || tagFilter.size > 0
                    ? "No contacts match your search."
                    : "No contacts yet. Import a CSV or add one manually."}
                </td>
              </tr>
            ) : (
              contacts.map((contact) => (
                <tr key={contact.id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(contact.id)}
                      onChange={() => toggleSelect(contact.id)}
                      className="cursor-pointer"
                    />
                  </td>
                  <td className="px-3 py-3 font-medium">
                    {contact.firstName} {contact.lastName}
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">{contact.email}</td>
                  <td className="px-3 py-3 text-muted-foreground hidden md:table-cell">
                    {contact.organization || "—"}
                  </td>
                  <td className="px-3 py-3 hidden lg:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {(contact.tags || []).slice(0, 3).map((tag: string) => (
                        <span key={tag} className={`text-xs px-2 py-0.5 rounded-full font-medium ${getTagColor(tag)}`}>
                          {tag}
                        </span>
                      ))}
                      {(contact.tags?.length ?? 0) > 3 && (
                        <span className="text-xs text-muted-foreground">+{(contact.tags?.length ?? 0) - 3}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground text-xs hidden lg:table-cell">
                    {formatDate(contact.createdAt)}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex gap-1 justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Manage tags"
                        onClick={() => openTagDialog(contact.id, "add")}
                      >
                        <Tag className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(contact)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => setDeleteId(contact.id)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, total)} of {total.toLocaleString()}
            {isFetching && " · Loading…"}
          </span>
          <div className="flex gap-1">
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page === totalPages} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Add/Edit Sheet */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent className="w-full sm:max-w-full overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{editingContact ? "Edit Contact" : "Add Contact"}</SheetTitle>
            <SheetDescription>
              {editingContact ? "Update contact details." : "Add a new contact to your org repository."}
            </SheetDescription>
          </SheetHeader>
          <form onSubmit={handleSubmit} className="space-y-4 mt-6">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>First Name *</Label>
                <Input value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} required />
              </div>
              <div className="space-y-1.5">
                <Label>Last Name *</Label>
                <Input value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} required />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Email *</Label>
              <Input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} required />
            </div>
            <div className="space-y-1.5">
              <Label>Organization</Label>
              <Input value={form.organization} onChange={(e) => setForm((f) => ({ ...f, organization: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Job Title</Label>
              <Input value={form.jobTitle} onChange={(e) => setForm((f) => ({ ...f, jobTitle: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Photo</Label>
              <PhotoUpload
                value={form.photo}
                onChange={(photo) => setForm((f) => ({ ...f, photo }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>City</Label>
                <Input value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Country</Label>
                <CountrySelect
                  value={form.country}
                  onChange={(country) => setForm((f) => ({ ...f, country }))}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Tags</Label>
              <TagInput
                value={form.tags}
                onChange={(tags) => setForm((f) => ({ ...f, tags }))}
                placeholder="Type a tag and press Enter or comma"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Notes</Label>
              <textarea
                className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-[80px] resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
            <div className="flex gap-2 pt-2">
              <Button type="button" variant="outline" className="flex-1" onClick={() => setSheetOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" className="flex-1 btn-gradient" disabled={createContact.isPending || updateContact.isPending}>
                {editingContact ? "Save Changes" : "Add Contact"}
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>

      {/* Tag Assignment Dialog */}
      <Dialog open={tagDialogOpen} onOpenChange={setTagDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {tagDialogContactId
                ? "Manage Tags"
                : `Assign Tags — ${selectedIds.size} contact${selectedIds.size !== 1 ? "s" : ""}`}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Mode selector */}
            <div className="flex gap-1 p-1 bg-muted rounded-lg">
              {(["add", "remove", "replace"] as TagMode[]).map((m) => (
                <button
                  type="button"
                  key={m}
                  onClick={() => {
                    setTagDialogMode(m);
                    if (m === "replace" && tagDialogContactId) {
                      const contact = contacts.find((c) => c.id === tagDialogContactId);
                      setTagDialogValue(contact?.tags ?? []);
                    } else if (m !== "replace") {
                      setTagDialogValue([]);
                    }
                  }}
                  className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors cursor-pointer ${
                    tagDialogMode === m
                      ? "bg-background shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {m === "add" ? "Add Tags" : m === "remove" ? "Remove Tags" : "Replace Tags"}
                </button>
              ))}
            </div>

            {/* Current tags preview for single contact */}
            {tagDialogContactId && (() => {
              const contact = contacts.find((c) => c.id === tagDialogContactId);
              const currentTags = contact?.tags ?? [];
              return currentTags.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground font-medium">Current tags:</p>
                  <div className="flex flex-wrap gap-1">
                    {currentTags.map((tag) => (
                      <span key={tag} className={`text-xs px-2 py-0.5 rounded-full font-medium ${getTagColor(tag)}`}>
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">This contact has no tags yet.</p>
              );
            })()}

            {/* Mode description */}
            <p className="text-xs text-muted-foreground">
              {tagDialogMode === "add" && "These tags will be added. Existing tags are kept."}
              {tagDialogMode === "remove" && "These tags will be removed. Other tags remain."}
              {tagDialogMode === "replace" && "All existing tags will be replaced with the tags below."}
            </p>

            {/* Existing tag suggestions */}
            {allTags.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground font-medium">Click to select:</p>
                <div className="flex flex-wrap gap-1">
                  {allTags.map((tag) => (
                    <button
                      type="button"
                      key={tag}
                      onClick={() => {
                        if (!tagDialogValue.includes(tag)) {
                          setTagDialogValue((v) => [...v, tag]);
                        }
                      }}
                      className={`text-xs px-2 py-0.5 rounded-full font-medium border cursor-pointer transition-opacity ${getTagColor(tag)} ${
                        tagDialogValue.includes(tag) ? "opacity-40" : "hover:opacity-80"
                      }`}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Tag input for new tags */}
            <div className="space-y-1.5">
              <Label>
                {tagDialogMode === "add" ? "Tags to add" : tagDialogMode === "remove" ? "Tags to remove" : "New tags"}
              </Label>
              <TagInput
                value={tagDialogValue}
                onChange={setTagDialogValue}
                placeholder="Type a tag and press Enter or comma"
              />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setTagDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              className="btn-gradient"
              onClick={handleTagDialogSubmit}
              disabled={isBusy || (tagDialogValue.length === 0 && tagDialogMode !== "replace")}
            >
              {isBusy ? "Saving…" : "Apply"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Contact</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the contact. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
