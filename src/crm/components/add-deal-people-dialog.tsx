"use client";

/**
 * "Add people" for a deal (owner, Oct 27, 2026: the sidebar picker was too
 * cramped). A wide dialog with search: the deal's account people first, all
 * contacts for the odd outside person, tick several, one role, add them in one
 * go. "New contact" stays one click away.
 *
 * It never loads the whole contact list: the account tab asks for that
 * account's people, the all-contacts tab searches the server. The contacts list
 * is capped, so with thousands of contacts most people could not be picked
 * from a list of everyone.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Search, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CreateCrmContactDialog } from "@/crm/components/create-crm-contact-dialog";
import { useAddDealContact, useCrmContacts } from "@/crm/hooks/use-crm-api";
import { DEAL_CONTACT_ROLE_LABELS, type CrmContactRow, type CrmDealContactRole } from "@/crm/lib/crm-types";

const MIN_SEARCH = 2;
const MAX_SEARCH_RESULTS = 50;
const SEARCH_DEBOUNCE_MS = 250;

type Tab = "account" | "all";

/** The typed search, settled for SEARCH_DEBOUNCE_MS so each keystroke is not a request. */
function useSettled(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [value]);
  return settled;
}

/** Every typed word must appear in the name, job title or email (the server search's rule). */
function matchesWords(c: CrmContactRow, q: string): boolean {
  const hay = `${c.firstName} ${c.lastName} ${c.jobTitle ?? ""} ${c.email}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** What to say above the list when there is nothing to tick, or the list is cut. */
function listMessage(args: {
  tab: Tab;
  q: string;
  loading: boolean;
  shown: number;
  available: number;
  matched: number;
  accountName: string | null;
}): string | null {
  const { tab, q, loading, shown, available, matched, accountName } = args;
  if (tab === "all" && q.length < MIN_SEARCH) return `Type at least ${MIN_SEARCH} characters to search every contact.`;
  if (loading) return tab === "all" ? "Searching…" : `Loading ${accountName} people…`;
  if (matched === 0 && q) return `No contact matches “${q}”.`;
  if (matched === 0) return `Nobody at ${accountName} yet. Add them with New contact.`;
  if (available === 0) return "Everyone here is already on this deal.";
  if (available > shown) return `Showing ${shown} of ${available}. Type more of the name to narrow it down.`;
  return null;
}

export function AddDealPeopleDialog({
  open,
  onOpenChange,
  dealId,
  account,
  excludeIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dealId: string;
  account: { id: string; name: string } | null;
  excludeIds: Set<string>;
}) {
  const [tab, setTab] = useState<Tab>(account ? "account" : "all");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [role, setRole] = useState<CrmDealContactRole>("PRIMARY");
  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const add = useAddDealContact(dealId);
  const q = useSettled(search.trim());

  const onAccountTab = tab === "account" && !!account;
  const accountPeople = useCrmContacts({ companyId: account?.id }, { enabled: open && onAccountTab });
  const results = useCrmContacts({ q }, { enabled: open && !onAccountTab && q.length >= MIN_SEARCH, keepPrevious: true });

  const matched = useMemo(() => {
    if (onAccountTab) return (accountPeople.data ?? []).filter((c) => !q || matchesWords(c, q));
    return q.length >= MIN_SEARCH ? results.data ?? [] : [];
  }, [onAccountTab, accountPeople.data, results.data, q]);
  const available = matched.filter((c) => !excludeIds.has(c.id));
  const shown = onAccountTab ? available : available.slice(0, MAX_SEARCH_RESULTS);
  const loading = onAccountTab ? accountPeople.isLoading : q.length >= MIN_SEARCH && results.isLoading;
  const message = listMessage({
    tab: onAccountTab ? "account" : "all",
    q,
    loading,
    shown: shown.length,
    available: available.length,
    matched: matched.length,
    accountName: account?.name ?? null,
  });

  function reset() {
    setSearch("");
    setPicked(new Set());
    setTab(account ? "account" : "all");
  }

  function close(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function addPicked() {
    setSaving(true);
    let added = 0;
    try {
      // One at a time: the add endpoint takes one person, and a failure (shown by
      // the hook's toast) stops the run instead of half-reporting success.
      for (const crmContactId of picked) {
        await add.mutateAsync({ crmContactId, role });
        added++;
      }
      toast.success(added === 1 ? "Added 1 person to the deal" : `Added ${added} people to the deal`);
      close(false);
    } catch {
      if (added > 0) toast.message(`Added ${added} before the error; the rest were not added.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add people to this deal</DialogTitle>
            <DialogDescription>
              Tick everyone you are talking to, choose their role on the deal, then add them together.
            </DialogDescription>
          </DialogHeader>

          {account && (
            <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
              <TabsList>
                <TabsTrigger value="account">{account.name} people</TabsTrigger>
                <TabsTrigger value="all">All contacts</TabsTrigger>
              </TabsList>
            </Tabs>
          )}

          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={onAccountTab ? `Search ${account.name} people…` : "Search all contacts by name or email…"}
              aria-label="Search people"
              className="pl-8"
            />
          </div>

          {message && <p className="text-sm text-muted-foreground">{message}</p>}

          {shown.length > 0 && (
            <ul className="min-h-0 flex-1 divide-y overflow-y-auto rounded-md border">
              {shown.map((c) => (
                <li key={c.id}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/50">
                    <Checkbox checked={picked.has(c.id)} onCheckedChange={() => toggle(c.id)} aria-label={`Add ${c.firstName} ${c.lastName}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {c.firstName} {c.lastName}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {[c.jobTitle, onAccountTab ? null : c.company?.name, c.email].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <Button type="button" variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
              <UserPlus className="mr-2 h-3.5 w-3.5" />
              New contact
            </Button>
            <div className="flex items-center gap-2">
              <Select value={role} onValueChange={(v) => setRole(v as CrmDealContactRole)}>
                <SelectTrigger className="w-[11rem]" aria-label="Role on the deal">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(DEAL_CONTACT_ROLE_LABELS) as CrmDealContactRole[]).map((r) => (
                    <SelectItem key={r} value={r}>
                      {DEAL_CONTACT_ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" disabled={picked.size === 0 || saving} onClick={addPicked}>
                {picked.size <= 1 ? "Add person" : `Add ${picked.size} people`}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* A NEW contact: pre-linked to the deal's account and put on the deal with
          the chosen role. An existing email find-or-creates, then still links. */}
      <CreateCrmContactDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaultCompanyId={account?.id}
        onCreated={(contact) =>
          add.mutate(
            { crmContactId: contact.id, role },
            {
              onSuccess: () => {
                toast.success("Added to the deal");
                close(false);
              },
            },
          )
        }
      />
    </>
  );
}
