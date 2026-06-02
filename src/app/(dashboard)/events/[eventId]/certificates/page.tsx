"use client";

/**
 * Certificates page — v3 multi-template model (2026-06-02).
 *
 * Four tabs:
 *
 *   1. Templates  — list of CertificateTemplate rows per category
 *                   (ATTENDANCE | APPRECIATION). Each row has its own
 *                   uploaded background PDF + positioned text boxes.
 *                   Add / Edit / Delete; editing opens the canvas
 *                   drag-and-drop editor inline.
 *   2. CME / CPD  — event-level hours + accrediting bodies (read by
 *                   the `{{cmeHours}}` / `{{accreditationBody}}` tokens
 *                   on either category of template).
 *   3. Preview    — pick a template, render a draft PDF with synthetic
 *                   recipient data.
 *   4. Issue      — pick a template, see the eligible recipient list,
 *                   trigger a CertificateIssueRun. Cron worker drains
 *                   PENDING runs every minute. Run-status polling
 *                   shows render + email progress.
 *
 * Design-approval gate removed 2026-06-02 — any ADMIN/ORGANIZER can
 * issue. The PDF-overlay model makes the design tangible enough (canvas
 * + preview) that a separate sign-off step is unwarranted.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import dynamic from "next/dynamic";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  GraduationCap,
  Plus,
  Trash2,
  Eye,
  Info,
  Mail,
  Send,
  PenLine,
  FileText,
  Loader2,
  CheckCircle2,
  XCircle,
  Pencil,
  Save,
} from "lucide-react";
import type { CertificateTextBox } from "@/components/certificates/certificate-canvas-editor";

// Lazy-load the canvas editor — pdfjs-dist + react-rnd stay off the
// dashboard's first-paint critical path until the operator opens the
// editor panel for a specific template.
const CertificateCanvasEditor = dynamic(
  () =>
    import("@/components/certificates/certificate-canvas-editor").then(
      (m) => m.CertificateCanvasEditor,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="h-96 rounded border bg-muted/30 animate-pulse flex items-center justify-center text-sm text-muted-foreground">
        Loading canvas editor…
      </div>
    ),
  },
);

// ── Types ────────────────────────────────────────────────────────────────────

type CertCategory = "ATTENDANCE" | "APPRECIATION";

const CERT_CATEGORIES: Array<{ key: CertCategory; label: string }> = [
  { key: "ATTENDANCE", label: "Certificate of Attendance" },
  { key: "APPRECIATION", label: "Certificate of Appreciation" },
];

interface CertificateTemplate {
  id: string;
  eventId: string;
  name: string;
  category: CertCategory;
  backgroundPdfUrl: string | null;
  textBoxes: CertificateTextBox[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  _count?: { issuedCertificates: number; issueRuns: number };
}

const ACCREDITOR_BODIES = ["DHA", "DOH", "SCFHS", "EACCME", "ACCME", "OTHER"] as const;
type AccreditorBody = (typeof ACCREDITOR_BODIES)[number];
type AccreditorBodyOrEmpty = AccreditorBody | "";

interface AccreditationRow {
  body: AccreditorBodyOrEmpty;
  reference: string;
  hours?: number;
  officialStatement?: string;
}

interface SettingsResponse {
  cmeHours: number | null;
  accreditations: AccreditationRow[];
}

interface EligibilityResp {
  type: CertCategory;
  tag: string | null;
  availableTags: Array<{ tag: string; count: number }>;
  untaggedCount: number;
  eligibleCount: number;
  eligible: Array<{
    kind: "registration" | "speaker";
    registrationId: string | null;
    speakerId: string | null;
    recipientName: string;
    recipientEmail: string | null;
    tags: string[];
  }>;
  sampleCap?: number;
  truncated?: boolean;
  exclusions: Array<{ reason: string; count?: number }>;
}

interface RunResp {
  runId: string;
  type: CertCategory;
  status:
    | "PENDING"
    | "RENDERING"
    | "AWAITING_REVIEW"
    | "SENDING"
    | "COMPLETED"
    | "FAILED"
    | "CANCELLED";
  totalCount: number;
  renderedCount: number;
  emailedCount: number;
  failedCount: number;
  progressPct: number;
  triggeredAt: string;
  rendererFinishedAt: string | null;
  emailerFinishedAt: string | null;
  lastTickAt: string | null;
  errors: unknown;
  sampleItems: Array<{
    id: string;
    recipientName: string;
    recipientEmail: string | null;
    renderedAt: string | null;
    emailedAt: string | null;
    errorPhase: string | null;
    errorMessage: string | null;
    issuedCertificateId: string | null;
  }>;
}

// ── Page component ───────────────────────────────────────────────────────────

export default function CertificatesPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const queryClient = useQueryClient();

  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [createDialog, setCreateDialog] = useState<{ open: boolean; category: CertCategory }>({
    open: false,
    category: "ATTENDANCE",
  });
  const [previewTemplateId, setPreviewTemplateId] = useState<string | null>(null);
  const [previewBust, setPreviewBust] = useState(0);
  const [issueTemplateId, setIssueTemplateId] = useState<string | null>(null);
  // Tag-driven manual selection (2026-06-02 evening). Required at
  // Issue time — operator picks from the availableTags overview that
  // the eligibility endpoint returns for the picked template.
  const [issueTag, setIssueTag] = useState<string>("");
  const [activeRunIds, setActiveRunIds] = useState<Record<string, string>>({});

  // ── Settings (CME) ────────────────────────────────────────────────────────
  const settingsQuery = useQuery<SettingsResponse>({
    queryKey: ["cert-settings", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/certificates/settings`);
      if (!res.ok) throw new Error(`Failed to load settings (${res.status})`);
      return (await res.json()) as SettingsResponse;
    },
  });

  // React 19 "store info from previous renders" pattern: track the
  // server data we last seeded draft from. Compare by structural
  // equality (JSON.stringify) NOT object reference — React Query's
  // refetchOnWindowFocus returns a fresh object on every refetch even
  // when JSON content is identical. Comparing by reference would blow
  // away an organizer's unsaved CME edits the moment they tab back to
  // the page.
  const [draftSettings, setDraftSettings] = useState<SettingsResponse | null>(null);
  const [seedSerialized, setSeedSerialized] = useState<string | null>(null);
  if (settingsQuery.data) {
    const nextSerialized = JSON.stringify(settingsQuery.data);
    if (nextSerialized !== seedSerialized) {
      setSeedSerialized(nextSerialized);
      // Only overwrite the draft on the FIRST load (no prior seed) or
      // when the user explicitly saved (the save mutation's onSuccess
      // sets draft + cache + we'll see a fresh serialization on next
      // render but draft already matches). If the user has unsaved
      // edits AND the server data drifts (rare — concurrent edit),
      // preserve the draft to avoid silent data loss.
      if (seedSerialized === null || draftSettings === null) {
        setDraftSettings(settingsQuery.data);
      }
    }
  }
  const editableSettings = draftSettings ?? settingsQuery.data ?? null;
  const settingsDirty = useMemo(() => {
    if (!draftSettings || !settingsQuery.data) return false;
    return JSON.stringify(draftSettings) !== JSON.stringify(settingsQuery.data);
  }, [draftSettings, settingsQuery.data]);

  const saveSettingsMutation = useMutation({
    mutationFn: async (body: SettingsResponse) => {
      const res = await fetch(`/api/events/${eventId}/certificates/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cmeHours: body.cmeHours,
          accreditations: body.accreditations
            .filter((a) => a.body !== "" && a.reference.trim().length > 0)
            .map((a) => ({
              body: a.body as AccreditorBody,
              reference: a.reference.trim(),
              hours: a.hours,
              officialStatement: a.officialStatement?.trim() || undefined,
            })),
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Save failed (${res.status})`);
      }
      return (await res.json()) as SettingsResponse;
    },
    onSuccess: (data) => {
      setDraftSettings(data);
      queryClient.setQueryData(["cert-settings", eventId], data);
      toast.success("CME settings saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function patchDraftSettings(patch: Partial<SettingsResponse>) {
    setDraftSettings((cur) => ({ ...(cur ?? settingsQuery.data!), ...patch }));
  }

  // ── Templates ────────────────────────────────────────────────────────────
  const templatesQuery = useQuery<{ templates: CertificateTemplate[] }>({
    queryKey: ["cert-templates", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/certificates/templates`);
      if (!res.ok) throw new Error(`Failed to load templates (${res.status})`);
      return (await res.json()) as { templates: CertificateTemplate[] };
    },
  });
  const templates = templatesQuery.data?.templates ?? [];
  const templatesByCategory: Record<CertCategory, CertificateTemplate[]> = {
    ATTENDANCE: templates.filter((t) => t.category === "ATTENDANCE"),
    APPRECIATION: templates.filter((t) => t.category === "APPRECIATION"),
  };

  const createTemplateMutation = useMutation({
    mutationFn: async (vars: { name: string; category: CertCategory }) => {
      const res = await fetch(`/api/events/${eventId}/certificates/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      const json = (await res.json().catch(() => ({}))) as {
        template?: CertificateTemplate;
        error?: string;
      };
      if (!res.ok || !json.template) throw new Error(json.error ?? `Create failed (${res.status})`);
      return json.template;
    },
    onSuccess: (template) => {
      queryClient.invalidateQueries({ queryKey: ["cert-templates", eventId] });
      setEditingTemplateId(template.id);
      toast.success(`Created "${template.name}"`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateTemplateMutation = useMutation({
    mutationFn: async (vars: {
      templateId: string;
      patch: {
        name?: string;
        backgroundPdfUrl?: string | null;
        textBoxes?: CertificateTextBox[];
      };
    }) => {
      const res = await fetch(
        `/api/events/${eventId}/certificates/templates/${vars.templateId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(vars.patch),
        },
      );
      const json = (await res.json().catch(() => ({}))) as {
        template?: CertificateTemplate;
        error?: string;
      };
      if (!res.ok || !json.template) throw new Error(json.error ?? `Update failed (${res.status})`);
      return json.template;
    },
    onSuccess: (template) => {
      // Optimistic patch — surgically replace the row in cache so the
      // canvas state stays in sync without a full refetch + remount.
      queryClient.setQueryData<{ templates: CertificateTemplate[] }>(
        ["cert-templates", eventId],
        (cur) =>
          cur
            ? {
                templates: cur.templates.map((t) =>
                  t.id === template.id ? { ...t, ...template } : t,
                ),
              }
            : cur,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: async (templateId: string) => {
      const res = await fetch(
        `/api/events/${eventId}/certificates/templates/${templateId}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
          issuedCount?: number;
          runCount?: number;
        };
        if (err.code === "TEMPLATE_HAS_HISTORY") {
          throw new Error(
            `Cannot delete — ${err.issuedCount ?? 0} certs issued + ${err.runCount ?? 0} runs reference this template. Audit trail must stay intact.`,
          );
        }
        throw new Error(err.error ?? `Delete failed (${res.status})`);
      }
      return templateId;
    },
    onSuccess: (templateId) => {
      queryClient.invalidateQueries({ queryKey: ["cert-templates", eventId] });
      if (editingTemplateId === templateId) setEditingTemplateId(null);
      if (previewTemplateId === templateId) setPreviewTemplateId(null);
      if (issueTemplateId === templateId) setIssueTemplateId(null);
      toast.success("Template deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Eligibility + run polling for Issue tab ───────────────────────────────
  // The eligibility endpoint serves two roles via the same response:
  //  (a) tag-only — no `tag` param, returns availableTags overview to
  //      populate the picker. eligibleCount = 0 (intentional).
  //  (b) tag + count — when issueTag is set, returns the filtered
  //      recipient list + sample preview so the operator sees who
  //      gets the cert before clicking Issue.
  // Re-fetch when either the template or the tag changes.
  const eligibilityQuery = useQuery<EligibilityResp>({
    queryKey: ["cert-eligibility", eventId, issueTemplateId, issueTag],
    queryFn: async () => {
      const params = new URLSearchParams({ templateId: issueTemplateId! });
      if (issueTag) params.set("tag", issueTag);
      const res = await fetch(
        `/api/events/${eventId}/certificates/eligible?${params.toString()}`,
      );
      if (!res.ok) throw new Error(`Eligibility query failed (${res.status})`);
      return (await res.json()) as EligibilityResp;
    },
    enabled: !!issueTemplateId,
    staleTime: 30_000,
  });

  const activeRunId = issueTemplateId ? activeRunIds[issueTemplateId] ?? null : null;
  const runQuery = useQuery<RunResp>({
    queryKey: ["cert-run", eventId, activeRunId],
    queryFn: async () => {
      const res = await fetch(
        `/api/events/${eventId}/certificates/runs/${activeRunId}`,
      );
      if (!res.ok) throw new Error(`Run poll failed (${res.status})`);
      return (await res.json()) as RunResp;
    },
    enabled: !!activeRunId,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      if (!status) return 4000;
      if (["COMPLETED", "FAILED", "CANCELLED"].includes(status)) return false;
      return 4000;
    },
  });

  const issueMutation = useMutation({
    mutationFn: async (vars: { templateId: string; tag: string }) => {
      const res = await fetch(`/api/events/${eventId}/certificates/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      const json = (await res.json().catch(() => ({}))) as {
        runId?: string;
        totalCount?: number;
        error?: string;
        code?: string;
      };
      if (!res.ok) {
        const err = new Error(json.error ?? `Issue failed (${res.status})`);
        (err as Error & { runId?: string }).runId = json.runId;
        throw err;
      }
      return json as { runId: string; totalCount: number };
    },
    onSuccess: (data) => {
      if (issueTemplateId) {
        setActiveRunIds((cur) => ({ ...cur, [issueTemplateId]: data.runId }));
      }
      toast.success(`Issuing ${data.totalCount} certificates — cron will start within 60 seconds.`);
    },
    onError: (e: Error & { runId?: string }) => {
      if (e.runId && issueTemplateId) {
        setActiveRunIds((cur) => ({ ...cur, [issueTemplateId]: e.runId! }));
        toast(e.message);
      } else {
        toast.error(e.message);
      }
    },
  });

  const sendMutation = useMutation({
    mutationFn: async (runId: string) => {
      const res = await fetch(`/api/events/${eventId}/certificates/runs/${runId}/send`, {
        method: "POST",
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `Send failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Emails are being sent — progress will update below.");
      queryClient.invalidateQueries({ queryKey: ["cert-run", eventId, activeRunId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelMutation = useMutation({
    mutationFn: async (runId: string) => {
      const res = await fetch(`/api/events/${eventId}/certificates/runs/${runId}/cancel`, {
        method: "POST",
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `Cancel failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Run cancelled.");
      queryClient.invalidateQueries({ queryKey: ["cert-run", eventId, activeRunId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Accreditation helpers ─────────────────────────────────────────────────
  function addAccreditation() {
    if (!editableSettings) return;
    patchDraftSettings({
      accreditations: [...editableSettings.accreditations, { body: "", reference: "" }],
    });
  }
  function removeAccreditation(idx: number) {
    if (!editableSettings) return;
    patchDraftSettings({
      accreditations: editableSettings.accreditations.filter((_, i) => i !== idx),
    });
  }
  function updateAccreditation(idx: number, patch: Partial<AccreditationRow>) {
    if (!editableSettings) return;
    patchDraftSettings({
      accreditations: editableSettings.accreditations.map((a, i) =>
        i === idx ? { ...a, ...patch } : a,
      ),
    });
  }

  const editingTemplate = editingTemplateId
    ? templates.find((t) => t.id === editingTemplateId) ?? null
    : null;

  // Debounced PATCH for the canvas editor. Per the review's B3: the
  // editor emits onChange on every keystroke / drag pixel / color
  // picker tick — a 5-character textbox content edit produced 5
  // PATCHes against a JSON column. Strategy:
  //   1. Update the React Query cache OPTIMISTICALLY on every onChange
  //      so the editor visuals stay snappy + the user sees their text
  //      land instantly.
  //   2. Coalesce the patch fields into a single pending payload.
  //   3. Fire ONE PATCH at most every 400ms (or on the next mount of
  //      a different template / unmount of the editor).
  const pendingPatchRef = useRef<{
    backgroundPdfUrl?: string | null;
    textBoxes?: CertificateTextBox[];
  } | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPatch = useCallback(
    (templateId: string) => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      const pending = pendingPatchRef.current;
      pendingPatchRef.current = null;
      if (pending && (pending.backgroundPdfUrl !== undefined || pending.textBoxes !== undefined)) {
        updateTemplateMutation.mutate({ templateId, patch: pending });
      }
    },
    [updateTemplateMutation],
  );

  const queueCanvasPatch = useCallback(
    (
      templateId: string,
      patch: { backgroundPdfUrl?: string | null; textBoxes?: CertificateTextBox[] },
    ) => {
      // Optimistic local update — keep the UI in sync regardless of
      // whether the debounced PATCH has fired yet.
      queryClient.setQueryData<{ templates: CertificateTemplate[] }>(
        ["cert-templates", eventId],
        (cur) =>
          cur
            ? {
                templates: cur.templates.map((t) =>
                  t.id === templateId
                    ? {
                        ...t,
                        ...(patch.backgroundPdfUrl !== undefined && {
                          backgroundPdfUrl: patch.backgroundPdfUrl,
                        }),
                        ...(patch.textBoxes !== undefined && { textBoxes: patch.textBoxes }),
                      }
                    : t,
                ),
              }
            : cur,
      );

      // Coalesce into the pending payload so a rapid sequence (e.g.
      // textBoxes + textBoxes + textBoxes) becomes one server write.
      pendingPatchRef.current = {
        ...(pendingPatchRef.current ?? {}),
        ...patch,
      };
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => flushPatch(templateId), 400);
    },
    [queryClient, eventId, flushPatch],
  );

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 p-6">
      {/* Page header */}
      <div className="flex items-start gap-3">
        <GraduationCap className="h-7 w-7 text-primary" />
        <div>
          <h1 className="text-2xl font-bold">Certificates</h1>
          <p className="text-sm text-muted-foreground">
            Upload designer-finished PDFs (or PNG/JPG — we convert), drop
            text boxes with{" "}
            <code className="bg-muted px-1 rounded text-xs">{`{{tokens}}`}</code>,
            preview, then bulk-issue to all eligible recipients.
          </p>
        </div>
      </div>

      <Tabs defaultValue="templates">
        <TabsList>
          <TabsTrigger value="templates">
            <PenLine className="h-4 w-4 mr-1.5" />
            Templates
          </TabsTrigger>
          <TabsTrigger value="cme">
            <FileText className="h-4 w-4 mr-1.5" />
            CME / CPD
          </TabsTrigger>
          <TabsTrigger value="preview">
            <Eye className="h-4 w-4 mr-1.5" />
            Preview
          </TabsTrigger>
          <TabsTrigger value="issue">
            <Send className="h-4 w-4 mr-1.5" />
            Issue
          </TabsTrigger>
        </TabsList>

        {/* ── TEMPLATES TAB ─────────────────────────────────────────── */}
        <TabsContent value="templates" className="space-y-6 mt-6">
          {editingTemplate ? (
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="flex items-center gap-2">
                      <Pencil className="h-5 w-5" />
                      <Input
                        value={editingTemplate.name}
                        onChange={(e) =>
                          // Live update via cache + debounced commit on blur.
                          // For now we commit on blur via onBlur below.
                          queryClient.setQueryData<{ templates: CertificateTemplate[] }>(
                            ["cert-templates", eventId],
                            (cur) =>
                              cur
                                ? {
                                    templates: cur.templates.map((t) =>
                                      t.id === editingTemplate.id
                                        ? { ...t, name: e.target.value }
                                        : t,
                                    ),
                                  }
                                : cur,
                          )
                        }
                        onBlur={(e) => {
                          if (e.target.value.trim().length === 0) return;
                          updateTemplateMutation.mutate({
                            templateId: editingTemplate.id,
                            patch: { name: e.target.value.trim() },
                          });
                        }}
                        className="font-semibold text-lg max-w-md"
                      />
                    </CardTitle>
                    <CardDescription className="mt-1">
                      <Badge variant="secondary">
                        {CERT_CATEGORIES.find((c) => c.key === editingTemplate.category)?.label}
                      </Badge>{" "}
                      · {editingTemplate.textBoxes.length} text boxes
                    </CardDescription>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => {
                      // Flush any pending debounced patch before
                      // closing — otherwise the last few edits stay
                      // local-only and the next reload reverts them.
                      flushPatch(editingTemplate.id);
                      setEditingTemplateId(null);
                    }}
                  >
                    Close editor
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <CertificateCanvasEditor
                  backgroundPdfUrl={editingTemplate.backgroundPdfUrl}
                  textBoxes={editingTemplate.textBoxes}
                  eventId={eventId}
                  onChange={(patch) => queueCanvasPatch(editingTemplate.id, patch)}
                />
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-6 md:grid-cols-2">
              {CERT_CATEGORIES.map((cat) => (
                <Card key={cat.key}>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <CardTitle>{cat.label}</CardTitle>
                        <CardDescription>
                          {templatesByCategory[cat.key].length}{" "}
                          {templatesByCategory[cat.key].length === 1 ? "template" : "templates"}
                        </CardDescription>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => setCreateDialog({ open: true, category: cat.key })}
                      >
                        <Plus className="h-4 w-4 mr-1" /> Add
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {templatesByCategory[cat.key].length === 0 ? (
                      <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                        No {cat.label.toLowerCase()} templates yet. Click{" "}
                        <strong>+ Add</strong> to upload your first design.
                      </div>
                    ) : (
                      templatesByCategory[cat.key].map((t) => (
                        <div
                          key={t.id}
                          className="flex items-center justify-between gap-2 rounded-md border p-3"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="font-medium truncate">{t.name}</div>
                            <div className="text-xs text-muted-foreground">
                              {t.backgroundPdfUrl ? "Background uploaded" : "No background yet"}
                              {" · "}
                              {t.textBoxes.length} text {t.textBoxes.length === 1 ? "box" : "boxes"}
                              {t._count && t._count.issuedCertificates > 0 && (
                                <>
                                  {" · "}
                                  <span className="text-amber-700">
                                    {t._count.issuedCertificates} issued
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setEditingTemplateId(t.id)}
                            >
                              <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => {
                                if (
                                  t._count &&
                                  (t._count.issuedCertificates > 0 || t._count.issueRuns > 0)
                                ) {
                                  toast.error(
                                    `Cannot delete "${t.name}" — ${t._count.issuedCertificates} certs issued.`,
                                  );
                                  return;
                                }
                                if (confirm(`Delete template "${t.name}"? This cannot be undone.`)) {
                                  deleteTemplateMutation.mutate(t.id);
                                }
                              }}
                              aria-label="Delete template"
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          </div>
                        </div>
                      ))
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Create dialog */}
          <Dialog
            open={createDialog.open}
            onOpenChange={(o) => setCreateDialog((cur) => ({ ...cur, open: o }))}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  New {CERT_CATEGORIES.find((c) => c.key === createDialog.category)?.label}{" "}
                  template
                </DialogTitle>
                <DialogDescription>
                  Give the template a name (e.g. &quot;Standard&quot;, &quot;VIP&quot;, &quot;Chairman&quot;).
                  You&apos;ll upload the background PDF + position text boxes in the next step.
                </DialogDescription>
              </DialogHeader>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  const name = String(fd.get("name") ?? "").trim();
                  if (!name) {
                    toast.error("Name is required");
                    return;
                  }
                  createTemplateMutation.mutate(
                    { name, category: createDialog.category },
                    {
                      onSuccess: () => setCreateDialog((cur) => ({ ...cur, open: false })),
                    },
                  );
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor="new-template-name">Name</Label>
                  <Input
                    id="new-template-name"
                    name="name"
                    placeholder={
                      createDialog.category === "ATTENDANCE"
                        ? "Standard Attendance"
                        : "Speaker Appreciation"
                    }
                    autoFocus
                    required
                    maxLength={120}
                  />
                </div>
                <DialogFooter className="mt-4">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setCreateDialog((cur) => ({ ...cur, open: false }))}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createTemplateMutation.isPending}>
                    {createTemplateMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4 mr-1" />
                    )}
                    Create
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </TabsContent>

        {/* ── CME / CPD TAB ─────────────────────────────────────────── */}
        <TabsContent value="cme" className="space-y-6 mt-6">
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle>CME / CPD configuration</CardTitle>
                  <CardDescription>
                    Per-event hours awarded + accrediting bodies. Rendered into cert
                    templates via the{" "}
                    <code className="bg-muted px-1 rounded text-xs">{`{{cmeHours}}`}</code>{" "}
                    and{" "}
                    <code className="bg-muted px-1 rounded text-xs">{`{{accreditationBody}}`}</code>{" "}
                    tokens.
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  onClick={() => editableSettings && saveSettingsMutation.mutate(editableSettings)}
                  disabled={!settingsDirty || saveSettingsMutation.isPending}
                >
                  <Save className="h-4 w-4 mr-1" />
                  Save
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-2 max-w-xs">
                <Label htmlFor="cmeHours">Total CME / CPD hours awarded</Label>
                <Input
                  id="cmeHours"
                  type="number"
                  step="0.5"
                  min="0"
                  max="999.9"
                  placeholder="e.g. 18.0"
                  value={editableSettings?.cmeHours ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    patchDraftSettings({ cmeHours: v === "" ? null : Number(v) });
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty if this event is not CME-accredited.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Accreditations</Label>
                    <p className="text-xs text-muted-foreground">
                      One row per accrediting body (events can carry multiple).
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={addAccreditation}
                    disabled={!editableSettings}
                  >
                    <Plus className="h-4 w-4 mr-1" /> Add accreditation
                  </Button>
                </div>
                {editableSettings?.accreditations.length === 0 && (
                  <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No accreditations yet.
                  </div>
                )}
                {editableSettings?.accreditations.map((row, idx) => (
                  <div
                    key={idx}
                    className="grid gap-3 rounded-md border p-3 md:grid-cols-[180px_1fr_120px_auto]"
                  >
                    <div>
                      <Label className="text-xs">Body</Label>
                      <Select
                        value={row.body}
                        onValueChange={(v) =>
                          updateAccreditation(idx, { body: v as AccreditorBody })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Pick accreditor" />
                        </SelectTrigger>
                        <SelectContent>
                          {ACCREDITOR_BODIES.map((b) => (
                            <SelectItem key={b} value={b}>
                              {b}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">Reference</Label>
                      <Input
                        placeholder="e.g. DHA-CPD-2026-0142"
                        value={row.reference}
                        onChange={(e) => updateAccreditation(idx, { reference: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Hours (override)</Label>
                      <Input
                        type="number"
                        step="0.5"
                        placeholder="default"
                        value={row.hours ?? ""}
                        onChange={(e) =>
                          updateAccreditation(idx, {
                            hours: e.target.value === "" ? undefined : Number(e.target.value),
                          })
                        }
                      />
                    </div>
                    <div className="flex items-end">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => removeAccreditation(idx)}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                    <div className="md:col-span-4">
                      <Label className="text-xs">
                        Official statement (override) — only if the accreditor requires verbatim
                        wording
                      </Label>
                      <Textarea
                        rows={2}
                        placeholder="e.g. This activity has been designated for a maximum of 18.0 European CME credits (ECMECs®)."
                        value={row.officialStatement ?? ""}
                        onChange={(e) =>
                          updateAccreditation(idx, {
                            officialStatement: e.target.value || undefined,
                          })
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── PREVIEW TAB ─────────────────────────────────────────── */}
        <TabsContent value="preview" className="space-y-6 mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Eye className="h-5 w-5" />
                Preview
              </CardTitle>
              <CardDescription>
                Renders a draft PDF using the event&apos;s real data + a synthetic
                recipient (&quot;Dr. Sample Attendee&quot;). No certificate is created,
                no email is sent.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {templates.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  Create a template in the <strong>Templates</strong> tab first.
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="grid gap-2 min-w-[280px]">
                      <Label>Template</Label>
                      <Select
                        value={previewTemplateId ?? ""}
                        onValueChange={(v) => setPreviewTemplateId(v)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Pick a template" />
                        </SelectTrigger>
                        <SelectContent>
                          {CERT_CATEGORIES.map((cat) => {
                            const tpls = templatesByCategory[cat.key];
                            if (tpls.length === 0) return null;
                            return tpls.map((t) => (
                              <SelectItem key={t.id} value={t.id}>
                                {cat.label} — {t.name}
                              </SelectItem>
                            ));
                          })}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      onClick={() => setPreviewBust((b) => b + 1)}
                      disabled={!previewTemplateId}
                    >
                      <Eye className="h-4 w-4 mr-1" />
                      Render preview
                    </Button>
                  </div>
                  {previewTemplateId && previewBust > 0 && (
                    <iframe
                      key={previewBust}
                      src={`/api/events/${eventId}/certificates/preview?templateId=${previewTemplateId}&t=${previewBust}`}
                      className="w-full h-[800px] rounded border"
                      title="Certificate preview"
                    />
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── ISSUE TAB ─────────────────────────────────────────── */}
        <TabsContent value="issue" className="space-y-6 mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Send className="h-5 w-5" />
                Issue certificates
              </CardTitle>
              <CardDescription>
                Pick a template, review the eligible recipient list, then click Issue.
                The cron worker renders + emails in the background.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {templates.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  Create a template first.
                </div>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2 max-w-2xl">
                    <div className="grid gap-2">
                      <Label>Template</Label>
                      <Select
                        value={issueTemplateId ?? ""}
                        onValueChange={(v) => {
                          setIssueTemplateId(v);
                          // Tag pool changes per template (registration tags
                          // for ATTENDANCE, speaker tags for APPRECIATION) —
                          // reset the selection so the operator picks fresh.
                          setIssueTag("");
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Pick a template" />
                        </SelectTrigger>
                        <SelectContent>
                          {CERT_CATEGORIES.map((cat) => {
                            const tpls = templatesByCategory[cat.key];
                            if (tpls.length === 0) return null;
                            return tpls.map((t) => (
                              <SelectItem key={t.id} value={t.id}>
                                {cat.label} — {t.name}
                              </SelectItem>
                            ));
                          })}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label>Tag</Label>
                      <Select
                        value={issueTag || "__none__"}
                        onValueChange={(v) => setIssueTag(v === "__none__" ? "" : v)}
                        disabled={!issueTemplateId || !eligibilityQuery.data}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Pick a tag" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">
                            <span className="text-muted-foreground">Pick a tag…</span>
                          </SelectItem>
                          {eligibilityQuery.data?.availableTags.map((t) => (
                            <SelectItem key={t.tag} value={t.tag}>
                              {t.tag} ({t.count})
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {eligibilityQuery.data &&
                        eligibilityQuery.data.availableTags.length === 0 &&
                        !eligibilityQuery.isLoading && (
                          <p className="text-xs text-amber-700">
                            <Info className="h-3.5 w-3.5 inline mr-1" />
                            No tags found in this category&apos;s pool. Tag people
                            from the {issueTemplateId &&
                              templates.find((t) => t.id === issueTemplateId)?.category ===
                                "ATTENDANCE"
                              ? "Registrations"
                              : "Speakers"}{" "}
                            page first.
                          </p>
                        )}
                      {eligibilityQuery.data &&
                        eligibilityQuery.data.untaggedCount > 0 &&
                        !issueTag && (
                          <p className="text-xs text-muted-foreground">
                            {eligibilityQuery.data.untaggedCount} {" "}
                            {eligibilityQuery.data.untaggedCount === 1 ? "person has" : "people have"}{" "}
                            no tags — they&apos;ll be skipped by every tag-based issue.
                          </p>
                        )}
                    </div>
                  </div>

                  {issueTemplateId && (
                    <>
                      {eligibilityQuery.isLoading ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" /> Computing eligible recipients…
                        </div>
                      ) : eligibilityQuery.data && issueTag ? (
                        <div className="space-y-3">
                          <div className="rounded-md border bg-primary/5 p-3">
                            <p className="font-medium">
                              {eligibilityQuery.data.eligibleCount} eligible recipient
                              {eligibilityQuery.data.eligibleCount === 1 ? "" : "s"}{" "}
                              tagged <strong>&quot;{issueTag}&quot;</strong>
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                              People who already hold an{" "}
                              {eligibilityQuery.data.type} cert for this event are excluded.
                            </p>
                          </div>
                          {eligibilityQuery.data.eligible.length > 0 && (
                            <div className="rounded-md border p-3 max-h-64 overflow-y-auto text-sm">
                              {eligibilityQuery.data.eligible.slice(0, 30).map((r, i) => (
                                <div
                                  key={i}
                                  className="flex items-center justify-between py-1 border-b last:border-b-0"
                                >
                                  <span className="truncate">{r.recipientName}</span>
                                  <span className="text-xs text-muted-foreground truncate ml-2">
                                    {r.recipientEmail}
                                  </span>
                                </div>
                              ))}
                              {eligibilityQuery.data.eligibleCount > 30 && (
                                <div className="text-xs text-muted-foreground pt-2 text-center">
                                  + {eligibilityQuery.data.eligibleCount - 30} more…
                                </div>
                              )}
                            </div>
                          )}
                          <Button
                            onClick={() => {
                              if (!issueTemplateId || !issueTag) return;
                              issueMutation.mutate({
                                templateId: issueTemplateId,
                                tag: issueTag,
                              });
                            }}
                            disabled={
                              eligibilityQuery.data.eligibleCount === 0 ||
                              issueMutation.isPending ||
                              !!activeRunId
                            }
                          >
                            {issueMutation.isPending ? (
                              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            ) : (
                              <Send className="h-4 w-4 mr-1" />
                            )}
                            Issue {eligibilityQuery.data.eligibleCount} certificates
                          </Button>
                        </div>
                      ) : null}

                      {/* Active run panel */}
                      {activeRunId && runQuery.data && (
                        <Card>
                          <CardHeader>
                            <CardTitle className="text-base flex items-center justify-between">
                              <span>Run {runQuery.data.runId.slice(0, 8)}</span>
                              <RunStatusBadge status={runQuery.data.status} />
                            </CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-3 text-sm">
                            <div className="flex flex-wrap gap-x-6 gap-y-1">
                              <span>Total: {runQuery.data.totalCount}</span>
                              <span>Rendered: {runQuery.data.renderedCount}</span>
                              <span>Emailed: {runQuery.data.emailedCount}</span>
                              <span className="text-red-600">Failed: {runQuery.data.failedCount}</span>
                            </div>
                            <div className="h-2 rounded-full bg-muted overflow-hidden">
                              <div
                                className="h-full bg-primary transition-all"
                                style={{ width: `${runQuery.data.progressPct}%` }}
                              />
                            </div>
                            <div className="flex gap-2">
                              {runQuery.data.status === "AWAITING_REVIEW" && (
                                <Button
                                  size="sm"
                                  onClick={() => sendMutation.mutate(runQuery.data!.runId)}
                                  disabled={sendMutation.isPending}
                                >
                                  <Mail className="h-4 w-4 mr-1" />
                                  Send emails
                                </Button>
                              )}
                              {["PENDING", "RENDERING", "AWAITING_REVIEW", "SENDING"].includes(
                                runQuery.data.status,
                              ) && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => cancelMutation.mutate(runQuery.data!.runId)}
                                  disabled={cancelMutation.isPending}
                                >
                                  Cancel
                                </Button>
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      )}
                    </>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function RunStatusBadge({ status }: { status: RunResp["status"] }) {
  const config: Record<RunResp["status"], { label: string; cls: string; icon: React.ReactNode }> = {
    PENDING: { label: "Pending", cls: "bg-gray-100 text-gray-800", icon: <Loader2 className="h-3 w-3 animate-spin" /> },
    RENDERING: { label: "Rendering", cls: "bg-blue-100 text-blue-800", icon: <Loader2 className="h-3 w-3 animate-spin" /> },
    AWAITING_REVIEW: { label: "Awaiting review", cls: "bg-amber-100 text-amber-800", icon: <Eye className="h-3 w-3" /> },
    SENDING: { label: "Sending", cls: "bg-blue-100 text-blue-800", icon: <Loader2 className="h-3 w-3 animate-spin" /> },
    COMPLETED: { label: "Completed", cls: "bg-emerald-100 text-emerald-800", icon: <CheckCircle2 className="h-3 w-3" /> },
    FAILED: { label: "Failed", cls: "bg-red-100 text-red-800", icon: <XCircle className="h-3 w-3" /> },
    CANCELLED: { label: "Cancelled", cls: "bg-gray-100 text-gray-600", icon: <XCircle className="h-3 w-3" /> },
  };
  const c = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${c.cls}`}
    >
      {c.icon} {c.label}
    </span>
  );
}
