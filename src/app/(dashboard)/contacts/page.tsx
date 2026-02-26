"use client";

import { useState, useCallback, useRef, useMemo } from "react";
import {
  useContacts,
  useDeleteContact,
  useContactTags,
  useUpdateContactTags,
  useBulkTagContacts,
} from "@/hooks/use-api";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TagInput } from "@/components/ui/tag-input";
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
  RefreshCw,
} from "lucide-react";
import { formatDate, formatPersonName } from "@/lib/utils";

interface Contact {
  id: string;
  title?: string | null;
  firstName: string;
  lastName: string;
  email: string;
  organization?: string;
  jobTitle?: string;
  specialty?: string;
  phone?: string;
  tags?: string[];
  createdAt: string;
}

const LIMIT = 50;

const TAG_COLORS = [
  "bg-sky-50 text-sky-700 border-sky-200",
  "bg-emerald-50 text-emerald-700 border-emerald-200",
  "bg-violet-50 text-violet-700 border-violet-200",
  "bg-amber-50 text-amber-700 border-amber-200",
  "bg-rose-50 text-rose-700 border-rose-200",
  "bg-cyan-50 text-cyan-700 border-cyan-200",
];

const AVATAR_BG = [
  "bg-[#00aade]/10 text-[#007a9e]",
  "bg-violet-100 text-violet-600",
  "bg-emerald-100 text-emerald-600",
  "bg-amber-100 text-amber-700",
  "bg-rose-100 text-rose-600",
  "bg-indigo-100 text-indigo-600",
];

function getTagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) % TAG_COLORS.length;
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

function getAvatarBg(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % AVATAR_BG.length;
  return AVATAR_BG[Math.abs(hash) % AVATAR_BG.length];
}

type TagMode = "add" | "remove" | "replace";

export default function ContactsPage() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());

  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const [tagDialogOpen, setTagDialogOpen] = useState(false);
  const [tagDialogMode, setTagDialogMode] = useState<TagMode>("add");
  const [tagDialogContactId, setTagDialogContactId] = useState<string | null>(null);
  const [tagDialogValue, setTagDialogValue] = useState<string[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filters: Record<string, string> = { page: String(page), limit: String(LIMIT) };
  if (search) filters.search = search;
  if (tagFilter.size > 0) filters.tags = [...tagFilter].join(",");

  const { data, isLoading, isFetching, refetch: refetchContacts } = useContacts(filters);
  const { data: tagsData, refetch: refetchTags } = useContactTags();
  const updateContactTags = useUpdateContactTags();
  const bulkTagContacts = useBulkTagContacts();
  const deleteContact = useDeleteContact();

  const contacts: Contact[] = useMemo(() => (data?.contacts ?? []) as Contact[], [data?.contacts]);
  const total: number = data?.total ?? 0;
  const totalPages: number = data?.totalPages ?? 1;
  const allTags: string[] = tagsData?.tags ?? [];

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

  const openTagDialog = useCallback(
    (contactId: string | null, defaultMode: TagMode) => {
      setTagDialogContactId(contactId);
      setTagDialogMode(defaultMode);
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

  const handleTagDialogSubmit = async () => {
    if (tagDialogValue.length === 0 && tagDialogMode !== "replace") {
      toast.error("Enter at least one tag");
      return;
    }
    try {
      if (tagDialogContactId) {
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
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Import failed");
      toast.dismiss(toastId);
      toast.success(
        `Imported ${json.created} contacts` +
        (json.skipped > 0 ? `, ${json.skipped} skipped (duplicates)` : "") +
        (json.errors?.length > 0 ? `, ${json.errors.length} errors` : "")
      );
      setPage(1);
    } catch (err: unknown) {
      toast.dismiss(toastId);
      toast.error(err instanceof Error ? err.message : "Import failed");
    }
  };

  const handleExportCSV = () => { window.location.href = "/api/contacts/export"; };

  const handleDownloadTemplate = () => {
    const csv = [
      "firstName,lastName,email,organization,jobTitle,specialty,phone,tags,notes",
      'John,Smith,john@example.com,Acme Corp,CEO,Cardiology,+1-555-0123,"VIP, Speaker",Met at conference 2025',
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

  const handleRefresh = useCallback(() => {
    refetchContacts();
    refetchTags();
  }, [refetchContacts, refetchTags]);

  const isBusy = updateContactTags.isPending || bulkTagContacts.isPending;

  return (
    <div className="min-h-screen bg-gray-50/40">
      {/* Page Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-9 h-9 rounded-xl bg-[#00aade]/10 flex items-center justify-center shrink-0">
              <Users className="h-4.5 w-4.5 text-[#00aade]" style={{ width: "1.125rem", height: "1.125rem" }} />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-gray-900">Contacts</h1>
              <p className="text-xs text-gray-400 mt-0.5">Organization-wide contact repository</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap justify-end">
            <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={handleImportCSV} />
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRefresh}
              disabled={isFetching}
              className="h-8 w-8 p-0 text-gray-400 hover:text-gray-600 hover:bg-gray-100"
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
            <div className="h-4 w-px bg-gray-200 mx-0.5" />
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownloadTemplate}
              className="h-8 text-xs border-gray-200 text-gray-600 hover:text-gray-900"
            >
              <FileDown className="h-3.5 w-3.5 mr-1.5" />
              Template
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              className="h-8 text-xs border-gray-200 text-gray-600 hover:text-gray-900"
            >
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              Import CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportCSV}
              className="h-8 text-xs border-gray-200 text-gray-600 hover:text-gray-900"
            >
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Export
            </Button>
            <Button size="sm" className="btn-gradient h-8 text-xs" asChild>
              <Link href="/contacts/new">
                <UserPlus className="h-3.5 w-3.5 mr-1.5" />
                Add Contact
              </Link>
            </Button>
          </div>
        </div>
      </div>

      <div className="px-6 py-5 space-y-4">
        {/* Stats */}
        <div className="flex gap-3">
          <div className="flex items-center gap-3 bg-white rounded-xl border border-gray-200 px-4 py-3.5 shadow-sm">
            <div className="w-8 h-8 rounded-lg bg-[#00aade]/10 flex items-center justify-center shrink-0">
              <Users className="h-4 w-4 text-[#00aade]" />
            </div>
            <div>
              <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Contacts</div>
              <div className="text-xl font-bold text-gray-900 leading-tight tabular-nums">{total.toLocaleString()}</div>
            </div>
          </div>
          <div className="flex items-center gap-3 bg-white rounded-xl border border-gray-200 px-4 py-3.5 shadow-sm">
            <div className="w-8 h-8 rounded-lg bg-violet-50 flex items-center justify-center shrink-0">
              <Tag className="h-4 w-4 text-violet-500" />
            </div>
            <div>
              <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Tags</div>
              <div className="text-xl font-bold text-gray-900 leading-tight tabular-nums">{allTags.length}</div>
            </div>
          </div>
        </div>

        {/* Search toolbar */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400 pointer-events-none" />
            <Input
              placeholder="Search name, email, organization…"
              className="pl-8 h-9 bg-white border-gray-200 text-sm focus-visible:ring-[#00aade]/20 focus-visible:border-[#00aade]"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => handleSearchChange("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Tag filter pills */}
        {allTags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 items-center">
            <span className="text-xs font-medium text-gray-400 mr-0.5 shrink-0">Filter:</span>
            {allTags.map((tag) => (
              <button
                type="button"
                key={tag}
                onClick={() => toggleTagFilter(tag)}
                className={`text-xs px-2.5 py-0.5 rounded-full border font-medium transition-all cursor-pointer ${
                  tagFilter.has(tag)
                    ? "bg-[#00aade] text-white border-[#00aade] shadow-sm"
                    : `${getTagColor(tag)} hover:opacity-80`
                }`}
              >
                {tag}
              </button>
            ))}
            {tagFilter.size > 0 && (
              <button
                type="button"
                onClick={() => { setTagFilter(new Set()); setPage(1); }}
                className="text-xs text-gray-400 hover:text-gray-600 ml-0.5 flex items-center gap-0.5 cursor-pointer"
              >
                <X className="h-3 w-3" />
                Clear
              </button>
            )}
          </div>
        )}

        {/* Bulk actions bar */}
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-3 px-4 py-2.5 bg-[#00aade]/5 rounded-xl border border-[#00aade]/20">
            <div className="flex items-center gap-2 shrink-0">
              <div className="w-5 h-5 rounded-full bg-[#00aade] flex items-center justify-center">
                <span className="text-[10px] font-bold text-white leading-none">{selectedIds.size}</span>
              </div>
              <span className="text-sm font-medium text-gray-700">selected</span>
            </div>
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="outline"
                onClick={() => openTagDialog(null, "add")}
                className="h-7 text-xs border-[#00aade]/30 text-[#00aade] hover:bg-[#00aade]/5 hover:border-[#00aade]/50"
              >
                <Tag className="h-3 w-3 mr-1" />
                Add Tags
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openTagDialog(null, "remove")}
                className="h-7 text-xs"
              >
                <X className="h-3 w-3 mr-1" />
                Remove
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openTagDialog(null, "replace")}
                className="h-7 text-xs"
              >
                Replace
              </Button>
            </div>
            <button
              type="button"
              className="ml-auto text-xs text-gray-400 hover:text-gray-600 cursor-pointer"
              onClick={() => setSelectedIds(new Set())}
            >
              Deselect all
            </button>
          </div>
        )}

        {/* Contacts table */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/60">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={contacts.length > 0 && selectedIds.size === contacts.length}
                    onChange={toggleSelectAll}
                    className="cursor-pointer rounded"
                  />
                </th>
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Contact</th>
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider hidden md:table-cell">Organization</th>
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider hidden lg:table-cell">Specialty</th>
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider hidden lg:table-cell">Tags</th>
                <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider hidden xl:table-cell">Added</th>
                <th className="w-24 px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="text-center py-16">
                    <div className="flex flex-col items-center gap-2 text-gray-400">
                      <RefreshCw className="h-5 w-5 animate-spin" />
                      <span className="text-xs">Loading contacts…</span>
                    </div>
                  </td>
                </tr>
              ) : contacts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-16">
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-12 h-12 rounded-2xl bg-gray-100 flex items-center justify-center">
                        <Users className="h-6 w-6 text-gray-300" />
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-gray-600">
                          {search || tagFilter.size > 0 ? "No contacts match" : "No contacts yet"}
                        </p>
                        <p className="text-xs text-gray-400">
                          {search || tagFilter.size > 0
                            ? "Try adjusting your search or filters"
                            : "Import a CSV or add contacts manually"}
                        </p>
                      </div>
                      {!search && tagFilter.size === 0 && (
                        <Button size="sm" className="btn-gradient mt-1" asChild>
                          <Link href="/contacts/new">
                            <UserPlus className="h-3.5 w-3.5 mr-1.5" />
                            Add First Contact
                          </Link>
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                contacts.map((contact) => {
                  const initials = `${contact.firstName[0] ?? ""}${contact.lastName[0] ?? ""}`.toUpperCase();
                  const avatarBg = getAvatarBg(`${contact.firstName}${contact.lastName}`);
                  return (
                    <tr
                      key={contact.id}
                      className={`border-b border-gray-50 last:border-0 hover:bg-gray-50/70 transition-colors group ${
                        selectedIds.has(contact.id) ? "bg-[#00aade]/[0.03]" : ""
                      }`}
                    >
                      <td className="px-4 py-3.5">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(contact.id)}
                          onChange={() => toggleSelect(contact.id)}
                          className="cursor-pointer rounded"
                        />
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${avatarBg}`}>
                            {initials}
                          </div>
                          <div className="min-w-0">
                            <Link
                              href={`/contacts/${contact.id}`}
                              className="font-medium text-gray-900 hover:text-[#00aade] transition-colors truncate block leading-snug"
                            >
                              {formatPersonName(contact.title, contact.firstName, contact.lastName)}
                            </Link>
                            <span className="text-xs text-gray-400 truncate block">{contact.email}</span>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3.5 hidden md:table-cell">
                        <div className="min-w-0">
                          <span className="text-sm text-gray-700 truncate block">
                            {contact.organization || <span className="text-gray-300">—</span>}
                          </span>
                          {contact.jobTitle && (
                            <span className="text-xs text-gray-400 truncate block">{contact.jobTitle}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 hidden lg:table-cell">
                        {contact.specialty ? (
                          <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-md font-medium">
                            {contact.specialty}
                          </span>
                        ) : (
                          <span className="text-gray-300 text-sm">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3.5 hidden lg:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {(contact.tags || []).slice(0, 3).map((tag: string) => (
                            <span
                              key={tag}
                              className={`text-xs px-2 py-0.5 rounded-full font-medium border ${getTagColor(tag)}`}
                            >
                              {tag}
                            </span>
                          ))}
                          {(contact.tags?.length ?? 0) > 3 && (
                            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full font-medium">
                              +{(contact.tags?.length ?? 0) - 3}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-xs text-gray-400 hidden xl:table-cell">
                        {formatDate(contact.createdAt)}
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="flex gap-0.5 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-gray-400 hover:text-[#00aade] hover:bg-[#00aade]/5"
                            title="Manage tags"
                            onClick={() => openTagDialog(contact.id, "add")}
                          >
                            <Tag className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-gray-400 hover:text-gray-700 hover:bg-gray-100"
                            asChild
                          >
                            <Link href={`/contacts/${contact.id}/edit`} title="Edit">
                              <Pencil className="h-3.5 w-3.5" />
                            </Link>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-gray-400 hover:text-rose-500 hover:bg-rose-50"
                            title="Delete"
                            onClick={() => setDeleteId(contact.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-400">
              {(page - 1) * LIMIT + 1}–{Math.min(page * LIMIT, total)} of {total.toLocaleString()} contacts
              {isFetching && <span className="ml-2 text-[#00aade]">Refreshing…</span>}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 border-gray-200"
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="px-3 text-xs text-gray-600 font-medium tabular-nums">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 border-gray-200"
                disabled={page === totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Tag Assignment Dialog */}
      <Dialog open={tagDialogOpen} onOpenChange={setTagDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">
              {tagDialogContactId
                ? "Manage Tags"
                : `Tag ${selectedIds.size} Contact${selectedIds.size !== 1 ? "s" : ""}`}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="flex gap-1 p-1 bg-gray-100 rounded-lg">
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
                  className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-all cursor-pointer ${
                    tagDialogMode === m
                      ? "bg-white shadow-sm text-gray-800"
                      : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {m === "add" ? "Add" : m === "remove" ? "Remove" : "Replace"}
                </button>
              ))}
            </div>

            {tagDialogContactId && (() => {
              const contact = contacts.find((c) => c.id === tagDialogContactId);
              const currentTags = contact?.tags ?? [];
              return currentTags.length > 0 ? (
                <div className="space-y-1.5">
                  <p className="text-xs text-gray-400 font-medium">Current tags</p>
                  <div className="flex flex-wrap gap-1">
                    {currentTags.map((tag) => (
                      <span key={tag} className={`text-xs px-2 py-0.5 rounded-full font-medium border ${getTagColor(tag)}`}>
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-gray-400">No tags on this contact yet.</p>
              );
            })()}

            <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2">
              {tagDialogMode === "add" && "New tags will be added. Existing tags are kept."}
              {tagDialogMode === "remove" && "These tags will be removed. Other tags remain."}
              {tagDialogMode === "replace" && "All existing tags will be replaced with these."}
            </p>

            {allTags.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-gray-400 font-medium">Quick select from existing</p>
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
                        tagDialogValue.includes(tag) ? "opacity-30" : "hover:opacity-70"
                      }`}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs text-gray-500 font-medium">
                {tagDialogMode === "add" ? "Tags to add" : tagDialogMode === "remove" ? "Tags to remove" : "Replace with"}
              </Label>
              <TagInput
                value={tagDialogValue}
                onChange={setTagDialogValue}
                placeholder="Type a tag and press Enter or comma"
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setTagDialogOpen(false)}>Cancel</Button>
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
            <AlertDialogTitle>Delete Contact?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove this contact. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-rose-500 text-white hover:bg-rose-600"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
