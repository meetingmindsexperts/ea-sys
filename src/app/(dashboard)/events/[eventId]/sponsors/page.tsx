"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { PhotoUpload } from "@/components/ui/photo-upload";
import {
  Award,
  Plus,
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
  Loader2,
  Save,
  ExternalLink,
} from "lucide-react";
import { toast } from "sonner";
import {
  useSponsors,
  useUpdateSponsors,
  type SponsorEntry,
  type SponsorTier,
} from "@/hooks/use-api";

const TIERS: Array<{ value: SponsorTier; label: string; badgeClass: string }> = [
  { value: "platinum", label: "Platinum", badgeClass: "bg-slate-200 text-slate-900 border-slate-300" },
  { value: "gold", label: "Gold", badgeClass: "bg-amber-100 text-amber-900 border-amber-300" },
  { value: "silver", label: "Silver", badgeClass: "bg-gray-100 text-gray-800 border-gray-300" },
  { value: "bronze", label: "Bronze", badgeClass: "bg-orange-100 text-orange-900 border-orange-300" },
  { value: "partner", label: "Partner", badgeClass: "bg-blue-100 text-blue-900 border-blue-300" },
  { value: "exhibitor", label: "Exhibitor", badgeClass: "bg-purple-100 text-purple-900 border-purple-300" },
];

const TIER_ORDER: Record<SponsorTier, number> = {
  platinum: 0,
  gold: 1,
  silver: 2,
  bronze: 3,
  partner: 4,
  exhibitor: 5,
};

type EditableSponsor = SponsorEntry;

function makeId(): string {
  // Client-only cuid-lite — enough entropy to avoid collisions within a
  // single event's sponsor list.
  return `spn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function blankSponsor(sortOrder: number): EditableSponsor {
  return {
    id: makeId(),
    name: "",
    logoUrl: undefined,
    websiteUrl: undefined,
    tier: "partner",
    description: undefined,
    sortOrder,
  };
}

export default function SponsorsPage() {
  const params = useParams();
  const eventId = params.eventId as string;

  const { data, isLoading } = useSponsors(eventId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-96">
        <p className="text-sm text-muted-foreground">Failed to load sponsors.</p>
      </div>
    );
  }

  // Keyed on server-version identity so a refetched server list resets the
  // editor cleanly; inside SponsorsEditor, lazy-init state from props is
  // safe because the component remounts when the key changes.
  return (
    <SponsorsEditor
      key={`sponsors-${data.sponsors.length}-${data.sponsors.map((s) => s.id).join(",")}`}
      eventId={eventId}
      initialSponsors={data.sponsors}
    />
  );
}

function SponsorsEditor({
  eventId,
  initialSponsors,
}: {
  eventId: string;
  initialSponsors: SponsorEntry[];
}) {
  const updateSponsors = useUpdateSponsors(eventId);

  // Lazy-init draft from props — safe because this component only mounts
  // when server data is ready and remounts on server-side identity changes.
  const [draft, setDraft] = useState<EditableSponsor[]>(() => initialSponsors);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingDraft, setEditingDraft] = useState<EditableSponsor | null>(null);

  const isDirty = useMemo(
    () => JSON.stringify(initialSponsors) !== JSON.stringify(draft),
    [initialSponsors, draft],
  );

  const openAdd = () => {
    setEditingIndex(null);
    setEditingDraft(blankSponsor(draft.length));
    setDialogOpen(true);
  };

  const openEdit = (index: number) => {
    setEditingIndex(index);
    setEditingDraft({ ...draft[index] });
    setDialogOpen(true);
  };

  const saveDialog = () => {
    if (!editingDraft) return;
    if (!editingDraft.name.trim()) {
      toast.error("Sponsor name is required");
      return;
    }
    setDraft((prev) => {
      if (editingIndex === null) {
        return [...prev, editingDraft];
      }
      const next = [...prev];
      next[editingIndex] = editingDraft;
      return next;
    });
    setDialogOpen(false);
    setEditingDraft(null);
    setEditingIndex(null);
  };

  const removeAt = (index: number) => {
    setDraft((prev) => prev.filter((_, i) => i !== index));
  };

  const moveAt = (index: number, direction: -1 | 1) => {
    setDraft((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const handleSave = async () => {
    try {
      // Reassign sortOrder from array index so the server side and
      // client side agree on ordering regardless of move history.
      const normalized = draft.map((s, i) => ({ ...s, sortOrder: i }));
      await updateSponsors.mutateAsync(normalized);
      toast.success(`Saved ${normalized.length} sponsor${normalized.length === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save sponsors");
    }
  };

  const handleDiscard = () => {
    setDraft(initialSponsors);
    toast.info("Changes discarded");
  };

  // Group by tier for the visible list
  const grouped = [...draft].sort((a, b) => {
    const ta = a.tier ? TIER_ORDER[a.tier] : 999;
    const tb = b.tier ? TIER_ORDER[b.tier] : 999;
    if (ta !== tb) return ta - tb;
    return a.sortOrder - b.sortOrder;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Award className="h-8 w-8" />
            Sponsors
          </h1>
          <p className="text-muted-foreground mt-1">
            Sponsors and exhibitors shown on public session pages. Grouped by tier.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isDirty && (
            <Button variant="outline" onClick={handleDiscard} disabled={updateSponsors.isPending}>
              Discard
            </Button>
          )}
          <Button
            onClick={handleSave}
            disabled={!isDirty || updateSponsors.isPending}
          >
            {updateSponsors.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save changes
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Sponsor list</CardTitle>
              <CardDescription>
                {draft.length === 0
                  ? "No sponsors yet. Add one to get started."
                  : `${draft.length} sponsor${draft.length === 1 ? "" : "s"}. Use the arrows to reorder within a tier.`}
              </CardDescription>
            </div>
            <Button variant="outline" onClick={openAdd}>
              <Plus className="h-4 w-4 mr-2" />
              Add sponsor
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {draft.length === 0 ? (
            <div className="rounded-lg border border-dashed p-10 text-center space-y-3">
              <Award className="h-10 w-10 text-muted-foreground mx-auto" />
              <p className="text-sm text-muted-foreground">
                Sponsors you add here appear on the public session page in a
                dedicated Sponsors tab.
              </p>
              <Button onClick={openAdd}>
                <Plus className="h-4 w-4 mr-2" />
                Add your first sponsor
              </Button>
            </div>
          ) : (
            <div className="divide-y">
              {grouped.map((sponsor) => {
                const originalIndex = draft.findIndex((s) => s.id === sponsor.id);
                const tierMeta = TIERS.find((t) => t.value === sponsor.tier);
                return (
                  <div
                    key={sponsor.id}
                    className="flex items-center gap-4 py-3"
                  >
                    {/* Logo thumbnail */}
                    <div className="w-16 h-16 rounded border bg-muted/30 flex items-center justify-center shrink-0 overflow-hidden">
                      {sponsor.logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={sponsor.logoUrl}
                          alt={sponsor.name}
                          className="object-contain w-full h-full"
                        />
                      ) : (
                        <Award className="h-6 w-6 text-muted-foreground" />
                      )}
                    </div>

                    {/* Name + tier + website */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium truncate">{sponsor.name}</p>
                        {tierMeta && (
                          <Badge
                            variant="outline"
                            className={tierMeta.badgeClass}
                          >
                            {tierMeta.label}
                          </Badge>
                        )}
                      </div>
                      {sponsor.websiteUrl && (
                        <a
                          href={sponsor.websiteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1"
                        >
                          {sponsor.websiteUrl}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      {sponsor.description && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                          {sponsor.description}
                        </p>
                      )}
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => moveAt(originalIndex, -1)}
                        disabled={originalIndex === 0}
                        title="Move up"
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => moveAt(originalIndex, 1)}
                        disabled={originalIndex === draft.length - 1}
                        title="Move down"
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => openEdit(originalIndex)}
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => removeAt(originalIndex)}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        title="Remove"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add/edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingIndex === null ? "Add sponsor" : "Edit sponsor"}
            </DialogTitle>
            <DialogDescription>
              Changes are held as a draft until you click Save changes on the main page.
            </DialogDescription>
          </DialogHeader>
          {editingDraft && (
            <div className="space-y-4">
              <div>
                <Label>Logo</Label>
                <PhotoUpload
                  value={editingDraft.logoUrl ?? null}
                  onChange={(url) =>
                    setEditingDraft({
                      ...editingDraft,
                      logoUrl: url ?? undefined,
                    })
                  }
                />
              </div>

              <div>
                <Label htmlFor="sponsor-name">
                  Name <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="sponsor-name"
                  value={editingDraft.name}
                  onChange={(e) =>
                    setEditingDraft({ ...editingDraft, name: e.target.value })
                  }
                  placeholder="Acme Corporation"
                  maxLength={255}
                />
              </div>

              <div>
                <Label htmlFor="sponsor-tier">Tier</Label>
                <Select
                  value={editingDraft.tier ?? "partner"}
                  onValueChange={(v) =>
                    setEditingDraft({
                      ...editingDraft,
                      tier: v as SponsorTier,
                    })
                  }
                >
                  <SelectTrigger id="sponsor-tier" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIERS.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="sponsor-website">Website URL</Label>
                <Input
                  id="sponsor-website"
                  type="url"
                  value={editingDraft.websiteUrl ?? ""}
                  onChange={(e) =>
                    setEditingDraft({
                      ...editingDraft,
                      websiteUrl: e.target.value,
                    })
                  }
                  placeholder="https://example.com"
                  maxLength={2000}
                />
              </div>

              <div>
                <Label htmlFor="sponsor-description">Description</Label>
                <Textarea
                  id="sponsor-description"
                  value={editingDraft.description ?? ""}
                  onChange={(e) =>
                    setEditingDraft({
                      ...editingDraft,
                      description: e.target.value,
                    })
                  }
                  placeholder="Short tagline or sponsor blurb (optional)"
                  maxLength={2000}
                  rows={3}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={saveDialog}>
              {editingIndex === null ? "Add to draft" : "Update draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
