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
  Copy,
  Save,
} from "lucide-react";
import type { CertificateTextBox } from "@/components/certificates/certificate-canvas-editor";
import { CertEmailEditorDialog } from "@/components/certificates/cert-email-editor-dialog";
import {
  SYSTEM_DEFAULT_SUBJECT,
  defaultBodyForCategory,
} from "@/lib/certificates/email-tokens";

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
  /** Organizer-set default subject/body for the cover email. Null when
   *  the template hasn't been customized yet — the Issue dialog falls
   *  back to the per-category system default. */
  emailSubject: string | null;
  emailBody: string | null;
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
    /** URL to the rendered PDF — populated once the item passes RENDER.
     *  Click-to-view opens it inline in a new tab (the /uploads/[...path]
     *  route now serves application/pdf MIME so it inlines instead of
     *  downloading). */
    pdfUrl: string | null;
    /** Cert serial — useful as a stable label next to View. */
    serial: string | null;
  }>;
  /** ALL failed items on this run (not capped). Operator uses this to
   *  decide whether to retry or accept the partial run. */
  failedItems?: Array<{
    id: string;
    recipientName: string;
    recipientEmail: string | null;
    errorPhase: string | null;
    errorMessage: string | null;
    renderedAt: string | null;
    emailedAt: string | null;
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
  // Preview-dialog state. Driven from the canvas-editor card now —
  // the separate Preview tab was removed since operators want the
  // 'render a draft PDF with synthetic data' right next to the edit
  // surface (saves a tab switch per iteration). The bust counter
  // forces a fresh iframe load when the operator clicks Re-render
  // after tweaking the template.
  const [previewDialogOpen, setPreviewDialogOpen] = useState(false);
  const [previewBust, setPreviewBust] = useState(0);
  const [issueTemplateId, setIssueTemplateId] = useState<string | null>(null);
  // Tag-driven manual selection (2026-06-02 evening). Required at
  // Issue time — operator picks from the availableTags overview that
  // the eligibility endpoint returns for the picked template.
  const [issueTag, setIssueTag] = useState<string>("");
  // Email-editor dialog state. The Issue button opens this; on Confirm
  // the issueMutation fires with the dialog-confirmed subject + body.
  const [emailDialogOpen, setEmailDialogOpen] = useState(false);
  // Separate dialog state for the per-template "Edit cover email
  // defaults" button inside the canvas-editor card — saves to the
  // template's emailSubject / emailBody columns via PATCH instead of
  // firing an issue run.
  const [tmplEmailDialogOpen, setTmplEmailDialogOpen] = useState(false);
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
        emailSubject?: string | null;
        emailBody?: string | null;
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

  // Duplicate clones the row + copies the background PDF on disk so the
  // clone is fully independent — editing one doesn't affect the other.
  // Lands at sortOrder = max+1 within the same category, name appended
  // with " (copy)". Server returns the new row; we just invalidate the
  // templates list so the clone shows up at the end of the category
  // group on the next render.
  const duplicateTemplateMutation = useMutation({
    mutationFn: async (templateId: string) => {
      const res = await fetch(
        `/api/events/${eventId}/certificates/templates/${templateId}/duplicate`,
        { method: "POST" },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        if (err.code === "BACKGROUND_PDF_MISSING") {
          throw new Error(
            "Source template's background PDF could not be read (it may be on a different machine). Re-upload the background on the source template before duplicating.",
          );
        }
        throw new Error(err.error ?? `Duplicate failed (${res.status})`);
      }
      return (await res.json()) as { template: { id: string; name: string } };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["cert-templates", eventId] });
      toast.success(`Duplicated as "${data.template.name}"`);
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
  // All runs list — both non-terminal (in progress) AND terminal (sent
  // / cancelled / failed). The page's `activeRunIds` state is React-
  // only (lost on refresh) so without this server-backed list, in-
  // progress runs become invisible after a refresh AND historical
  // runs become invisible entirely. Client-side partition into two
  // groups so the panel can render 'Runs in progress' (active) above
  // 'Run history' (terminal) with different polling cadences baked
  // into the same fetch.
  //
  // Polling: 4s while any active run exists (counter changes mid-tick),
  // stops when only terminal rows remain (they don't change). Manual
  // refetch fires after every state-transition mutation (issue, send,
  // cancel, retry) via queryClient.invalidateQueries.
  const allRunsQuery = useQuery<{
    runs: Array<{
      id: string;
      type: CertCategory;
      status: RunResp["status"];
      totalCount: number;
      renderedCount: number;
      emailedCount: number;
      failedCount: number;
      triggeredAt: string;
      rendererFinishedAt: string | null;
      emailerFinishedAt: string | null;
      certificateTemplate: { id: string; name: string } | null;
    }>;
  }>({
    queryKey: ["cert-runs-all", eventId],
    queryFn: async () => {
      const res = await fetch(`/api/events/${eventId}/certificates/runs?status=all`);
      if (!res.ok) throw new Error(`Runs query failed (${res.status})`);
      return res.json();
    },
    refetchInterval: (q) => {
      // Poll only while at least one active run is in flight.
      const hasActive = q.state.data?.runs.some((r) =>
        ["PENDING", "RENDERING", "AWAITING_REVIEW", "SENDING"].includes(r.status),
      );
      return hasActive ? 4000 : false;
    },
  });

  const allRunsList = allRunsQuery.data?.runs ?? [];
  const ACTIVE_STATUSES = ["PENDING", "RENDERING", "AWAITING_REVIEW", "SENDING"] as const;
  const activeRuns = allRunsList.filter((r) =>
    (ACTIVE_STATUSES as readonly string[]).includes(r.status),
  );
  const historyRuns = allRunsList.filter(
    (r) => !(ACTIVE_STATUSES as readonly string[]).includes(r.status),
  );

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
    mutationFn: async (vars: {
      templateId: string;
      tag: string;
      emailSubject: string;
      emailBody: string;
    }) => {
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
      // Refresh the in-progress + history lists so the new run
      // appears immediately (otherwise the polling-on-active loop
      // hasn't started yet for a freshly-created run).
      queryClient.invalidateQueries({ queryKey: ["cert-runs-all", eventId] });
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
      queryClient.invalidateQueries({ queryKey: ["cert-runs-all", eventId] });
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
      queryClient.invalidateQueries({ queryKey: ["cert-runs-all", eventId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Retry failed items. Resets the items + bumps run status back into
  // the appropriate phase so the cron picks them up next tick. Endpoint
  // is idempotent + returns the split (render vs email reset counts).
  const retryFailedMutation = useMutation({
    mutationFn: async (runId: string) => {
      const res = await fetch(
        `/api/events/${eventId}/certificates/runs/${runId}/retry-failed`,
        { method: "POST" },
      );
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        retried?: number;
        renderFailedReset?: number;
        emailFailedReset?: number;
        nextStatus?: string;
        error?: string;
        code?: string;
        currentStatus?: string;
      };
      if (!res.ok) {
        if (json.code === "RUN_BUSY") {
          throw new Error(
            `Run is currently ${json.currentStatus}. Wait for the active phase to finish before retrying.`,
          );
        }
        throw new Error(json.error ?? `Retry failed (${res.status})`);
      }
      return json;
    },
    onSuccess: (json) => {
      const retried = json.retried ?? 0;
      if (retried === 0) {
        toast(json.error ?? "No failed items to retry.");
      } else {
        const bits: string[] = [];
        if (json.renderFailedReset) bits.push(`${json.renderFailedReset} render`);
        if (json.emailFailedReset) bits.push(`${json.emailFailedReset} email`);
        toast.success(
          `Retrying ${retried} failed ${retried === 1 ? "item" : "items"}` +
            (bits.length ? ` (${bits.join(" + ")}) — run resumed at ${json.nextStatus}` : ""),
        );
      }
      queryClient.invalidateQueries({ queryKey: ["cert-run", eventId, activeRunId] });
      queryClient.invalidateQueries({ queryKey: ["cert-runs-all", eventId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Local UI state — whether the failures detail panel is expanded.
  // Resets per run so a fresh run opens collapsed.
  const [failuresExpanded, setFailuresExpanded] = useState(false);

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
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      onClick={() => {
                        // Flush pending canvas patches before previewing
                        // so the rendered PDF reflects the latest tweaks
                        // (debounced PATCH may still be pending in the
                        // queueCanvasPatch ref).
                        flushPatch(editingTemplate.id);
                        setPreviewBust((b) => b + 1);
                        setPreviewDialogOpen(true);
                      }}
                    >
                      <Eye className="h-4 w-4 mr-1" />
                      Preview
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setTmplEmailDialogOpen(true)}
                    >
                      <Mail className="h-4 w-4 mr-1" />
                      Cover email
                    </Button>
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
                              onClick={() => duplicateTemplateMutation.mutate(t.id)}
                              disabled={
                                duplicateTemplateMutation.isPending &&
                                duplicateTemplateMutation.variables === t.id
                              }
                              aria-label="Duplicate template"
                              title="Duplicate template"
                            >
                              <Copy className="h-4 w-4" />
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
                              title="Delete template"
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

        {/* ── ISSUE TAB ─────────────────────────────────────────── */}
        <TabsContent value="issue" className="space-y-6 mt-6">
          {/* Runs in progress — non-terminal runs surviving across page
              refreshes. The page's local activeRunIds state is React-only
              (lost on refresh / tab close), so without this server-backed
              list, a run sitting at AWAITING_REVIEW becomes invisible
              the moment the operator reloads. Resume lifts the run into
              the active panel below by picking its template + seeding
              activeRunIds — the existing per-run polling + Send/Cancel
              UI takes over from there. */}
          {activeRuns.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Loader2 className="h-4 w-4 text-amber-600 animate-spin" />
                  Runs in progress ({activeRuns.length})
                </CardTitle>
                <CardDescription>
                  Active certificate-issue runs for this event. Resume one to
                  spot-check rendered PDFs, send emails, or cancel.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {activeRuns.map((r) => {
                  const isCurrent = Boolean(
                    issueTemplateId && activeRunIds[issueTemplateId] === r.id,
                  );
                  return (
                    <div
                      key={r.id}
                      className="flex items-center justify-between gap-2 rounded-md border p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium truncate">
                            {r.certificateTemplate?.name ??
                              `${r.type} (template deleted)`}
                          </span>
                          <RunStatusBadge status={r.status} />
                        </div>
                        <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3">
                          <span>Total: {r.totalCount}</span>
                          <span>Rendered: {r.renderedCount}</span>
                          <span>Emailed: {r.emailedCount}</span>
                          {r.failedCount > 0 && (
                            <span className="text-red-600">
                              Failed: {r.failedCount}
                            </span>
                          )}
                          <span className="text-muted-foreground/70">
                            triggered{" "}
                            {new Date(r.triggeredAt).toLocaleString(undefined, {
                              dateStyle: "short",
                              timeStyle: "short",
                            })}
                          </span>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant={isCurrent ? "secondary" : "outline"}
                        onClick={() => {
                          // Pick the run's template so the panel below
                          // renders for it. The activeRunIds entry
                          // (keyed by templateId) drives the per-run
                          // polling query.
                          if (r.certificateTemplate) {
                            setIssueTemplateId(r.certificateTemplate.id);
                            setActiveRunIds((cur) => ({
                              ...cur,
                              [r.certificateTemplate!.id]: r.id,
                            }));
                            setIssueTag("");
                          }
                        }}
                        disabled={!r.certificateTemplate || isCurrent}
                      >
                        {isCurrent ? "Showing below" : "Resume"}
                      </Button>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {/* Run history — terminal runs (COMPLETED, FAILED, CANCELLED)
              for audit-trail visibility. Operator wants to see 'what
              I sent yesterday', 'which batches failed', 'did I already
              issue to this cohort'. Capped at 50 by the endpoint;
              ordered newest-first. Each row clickable to View — same
              mutation path as Resume above, loads the run into the
              per-run panel below where the spot-check PDF links still
              work for COMPLETED runs (the cert PDFs are kept forever
              for audit). FAILED runs are also viewable so the
              operator can see what went wrong; CANCELLED runs are
              there for completeness. */}
          {historyRuns.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  Run history ({historyRuns.length})
                </CardTitle>
                <CardDescription>
                  Past certificate-issue runs &mdash; sent, cancelled, and
                  failed. Click <strong>View</strong> on a row to inspect
                  rendered PDFs, the recipient list, or per-item failure
                  reasons. The cert PDFs are preserved forever for audit.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {historyRuns.map((r) => {
                  const isCurrent = Boolean(
                    issueTemplateId && activeRunIds[issueTemplateId] === r.id,
                  );
                  const finishedAt = r.emailerFinishedAt ?? r.rendererFinishedAt;
                  return (
                    <div
                      key={r.id}
                      className="flex items-center justify-between gap-2 rounded-md border p-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium truncate">
                            {r.certificateTemplate?.name ??
                              `${r.type} (template deleted)`}
                          </span>
                          <RunStatusBadge status={r.status} />
                        </div>
                        <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3">
                          <span>Total: {r.totalCount}</span>
                          <span>
                            Emailed:{" "}
                            <strong
                              className={
                                r.emailedCount === r.totalCount
                                  ? "text-emerald-700"
                                  : ""
                              }
                            >
                              {r.emailedCount}
                            </strong>
                          </span>
                          {r.failedCount > 0 && (
                            <span className="text-red-600">
                              Failed: {r.failedCount}
                            </span>
                          )}
                          <span className="text-muted-foreground/70">
                            {r.status === "COMPLETED"
                              ? "sent"
                              : r.status === "CANCELLED"
                                ? "cancelled"
                                : "ended"}{" "}
                            {finishedAt
                              ? new Date(finishedAt).toLocaleString(undefined, {
                                  dateStyle: "short",
                                  timeStyle: "short",
                                })
                              : new Date(r.triggeredAt).toLocaleString(undefined, {
                                  dateStyle: "short",
                                  timeStyle: "short",
                                })}
                          </span>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant={isCurrent ? "secondary" : "ghost"}
                        onClick={() => {
                          if (r.certificateTemplate) {
                            setIssueTemplateId(r.certificateTemplate.id);
                            setActiveRunIds((cur) => ({
                              ...cur,
                              [r.certificateTemplate!.id]: r.id,
                            }));
                            setIssueTag("");
                          }
                        }}
                        disabled={!r.certificateTemplate || isCurrent}
                      >
                        {isCurrent ? "Showing below" : "View"}
                      </Button>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          )}

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
                              // Issue click opens a send confirmation showing the
                              // cover email saved on the selected template (no
                              // inline editing). The mutation fires from that
                              // dialog's Send button.
                              if (!issueTemplateId || !issueTag) return;
                              setEmailDialogOpen(true);
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

                            {/* Failures detail — per-recipient errorMessage
                                so the operator can see WHO failed + WHY
                                without going to /logs. Expandable to keep
                                the panel compact when there are none. */}
                            {runQuery.data.failedCount > 0 && (
                              <div className="rounded-md border border-red-200 bg-red-50 p-3">
                                <button
                                  type="button"
                                  className="flex items-center justify-between w-full text-left"
                                  onClick={() => setFailuresExpanded((v) => !v)}
                                >
                                  <span className="font-medium text-red-900">
                                    <XCircle className="h-4 w-4 inline mr-1.5" />
                                    {runQuery.data.failedCount}{" "}
                                    {runQuery.data.failedCount === 1
                                      ? "failure"
                                      : "failures"}
                                  </span>
                                  <span className="text-xs text-red-700">
                                    {failuresExpanded ? "Hide details" : "Show details"}
                                  </span>
                                </button>
                                {failuresExpanded &&
                                  runQuery.data.failedItems &&
                                  runQuery.data.failedItems.length > 0 && (
                                    <div className="mt-3 space-y-2 max-h-64 overflow-y-auto pr-1">
                                      {runQuery.data.failedItems.map((f) => (
                                        <div
                                          key={f.id}
                                          className="rounded border border-red-200 bg-white p-2 text-xs"
                                        >
                                          <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                              <div className="font-medium truncate">
                                                {f.recipientName}
                                              </div>
                                              <div className="text-muted-foreground truncate">
                                                {f.recipientEmail ?? "(no email)"}
                                              </div>
                                            </div>
                                            <Badge
                                              variant="outline"
                                              className="shrink-0 border-red-300 text-red-700"
                                            >
                                              {f.errorPhase ?? "?"}
                                            </Badge>
                                          </div>
                                          {f.errorMessage && (
                                            <div className="mt-1 text-red-700 break-words">
                                              {f.errorMessage}
                                            </div>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                              </div>
                            )}

                            {/* Spot-check rendered certificates — the
                                AWAITING_REVIEW gate's whole point is to
                                let the operator verify the PDFs LOOK
                                RIGHT before emails fan out. We surface
                                a clickable link per rendered item that
                                opens the PDF inline in a new tab.
                                Visible at AWAITING_REVIEW (the gate
                                itself), SENDING (in case the operator
                                wants to spot-check while emails are
                                going out), and COMPLETED (post-hoc
                                verification). Capped at the first 20
                                via the API's sampleItems take. */}
                            {["AWAITING_REVIEW", "SENDING", "COMPLETED"].includes(
                              runQuery.data.status,
                            ) &&
                              runQuery.data.sampleItems.some((s) => s.pdfUrl) && (
                                <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                                  <div className="flex items-center justify-between mb-2">
                                    <p className="text-sm font-medium text-amber-900">
                                      <Eye className="h-4 w-4 inline mr-1.5" />
                                      {runQuery.data.status === "AWAITING_REVIEW"
                                        ? "Spot-check before sending"
                                        : "Rendered certificates"}
                                    </p>
                                    <span className="text-xs text-amber-700">
                                      {runQuery.data.sampleItems.filter((s) => s.pdfUrl).length}{" "}
                                      shown
                                      {runQuery.data.renderedCount > 20 &&
                                        ` of ${runQuery.data.renderedCount}`}
                                    </span>
                                  </div>
                                  {runQuery.data.status === "AWAITING_REVIEW" && (
                                    <p className="text-xs text-amber-800 mb-2">
                                      Click a recipient to open their rendered cert PDF.
                                      Verify the design + text positions look right before
                                      clicking <strong>Send emails</strong>.
                                    </p>
                                  )}
                                  {/* For large runs, explain that the
                                      sample is 20 random recipients
                                      and full visual inspection isn't
                                      expected — rendering is
                                      deterministic so a 5-row sample
                                      validates the whole batch. */}
                                  {runQuery.data.renderedCount > 20 && (
                                    <p className="text-xs text-amber-800 mb-2 italic">
                                      Showing 20 of {runQuery.data.renderedCount} rendered
                                      certs. Rendering is deterministic per recipient — if
                                      these samples look correct, the rest will too. Edge
                                      cases (long names, special characters) that DO break
                                      are caught by the Failures panel above.
                                    </p>
                                  )}
                                  {/* Dev-mode hint: in local dev pointing
                                      at the prod Supabase DB, the cert
                                      may have been rendered on EC2's
                                      disk — meaning the local server
                                      can't serve it. Tells the operator
                                      WHY a 404 might happen + what to
                                      do about it. NODE_ENV check keeps
                                      this off the prod UI. */}
                                  {typeof window !== "undefined" &&
                                    window.location.hostname === "localhost" && (
                                      <p className="text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded p-2 mb-2">
                                        <strong>Dev mode tip:</strong> if a link 404s
                                        in local dev, the cert was likely rendered by
                                        the prod EC2 cron (which shares your Supabase
                                        DB but writes to its own disk). For local UAT,
                                        disable the prod cron OR test on prod
                                        (events.meetingmindsgroup.com) directly. The
                                        PDF exists on EC2 even if your local server
                                        can&apos;t reach it.
                                      </p>
                                    )}
                                  <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                                    {runQuery.data.sampleItems
                                      .filter((s) => s.pdfUrl)
                                      .map((s) => (
                                        <a
                                          key={s.id}
                                          href={s.pdfUrl!}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="flex items-center justify-between gap-2 rounded border border-amber-200 bg-white px-2 py-1.5 text-xs hover:bg-amber-100 transition-colors"
                                        >
                                          <span className="font-medium truncate">
                                            {s.recipientName}
                                          </span>
                                          <span className="text-amber-700 shrink-0 font-mono text-[10px]">
                                            {s.serial ?? "—"}
                                          </span>
                                        </a>
                                      ))}
                                  </div>
                                </div>
                              )}

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
                              {/* Retry failed — only meaningful when there
                                  ARE failures AND the run is in a status
                                  the API will accept the retry from. */}
                              {runQuery.data.failedCount > 0 &&
                                ["PENDING", "AWAITING_REVIEW", "COMPLETED", "FAILED", "CANCELLED"].includes(
                                  runQuery.data.status,
                                ) && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      retryFailedMutation.mutate(runQuery.data!.runId)
                                    }
                                    disabled={retryFailedMutation.isPending}
                                  >
                                    {retryFailedMutation.isPending ? (
                                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                    ) : null}
                                    Retry {runQuery.data.failedCount} failed
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

      {/* Preview dialog — opens from the canvas editor's Preview button.
          Renders a draft PDF for the template using the event's real
          data + a synthetic recipient ("Dr. Sample Attendee"). No DB
          writes, no email, no serial allocation — the cert serial reads
          PREVIEW-DRAFT-{TYPE} so an accidental print can never be
          mistaken for a real cert. previewBust cache-busts the iframe
          so Re-render after canvas tweaks always shows fresh output. */}
      {editingTemplate && (
        <Dialog open={previewDialogOpen} onOpenChange={setPreviewDialogOpen}>
          <DialogContent className="sm:max-w-5xl max-h-[85vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Eye className="h-5 w-5" />
                Preview &mdash; {editingTemplate.name}
              </DialogTitle>
              <DialogDescription>
                Synthetic recipient (&ldquo;Dr. Sample Attendee&rdquo;) with
                real event data. Serial reads <code className="text-xs">PREVIEW-DRAFT-{editingTemplate.category}</code> so
                an accidental print can&apos;t be confused with a real cert.
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 min-h-[600px] overflow-hidden rounded border">
              {previewBust > 0 && (
                <iframe
                  key={previewBust}
                  // #view=Fit tells the browser's PDF viewer to scale the
                  // whole page to fit the iframe (vs the default fit-to-
                  // width, which clips a portrait cert below the fold on
                  // a landscape-shaped dialog). #toolbar=0 hides the PDF
                  // viewer chrome — Re-render/Close already live in the
                  // dialog footer, the duplicate toolbar is just noise.
                  src={`/api/events/${eventId}/certificates/preview?templateId=${editingTemplate.id}&t=${previewBust}#view=Fit&toolbar=0`}
                  className="min-h-[550px] w-full h-full"
                  title="Certificate preview"
                />
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  flushPatch(editingTemplate.id);
                  setPreviewBust((b) => b + 1);
                }}
              >
                <Eye className="h-4 w-4 mr-1" />
                Re-render
              </Button>
              <Button onClick={() => setPreviewDialogOpen(false)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Per-template email-defaults dialog — opens from the canvas
          editor card's "Cover email" button. PATCHes the template
          row's emailSubject + emailBody (the Issue dialog later
          pre-fills from these). */}
      {editingTemplate && (
        <CertEmailEditorDialog
          open={tmplEmailDialogOpen}
          onOpenChange={setTmplEmailDialogOpen}
          category={editingTemplate.category}
          initialSubject={editingTemplate.emailSubject ?? SYSTEM_DEFAULT_SUBJECT}
          initialBody={
            editingTemplate.emailBody ?? defaultBodyForCategory(editingTemplate.category)
          }
          submitLabel="Save defaults"
          helperText={`Defaults for the "${editingTemplate.name}" template. These pre-fill the Issue dialog every time you issue from this template. Operators can still tweak per-run.`}
          submitting={updateTemplateMutation.isPending}
          onSubmit={({ emailSubject, emailBody }) => {
            updateTemplateMutation.mutate(
              {
                templateId: editingTemplate.id,
                patch: { emailSubject, emailBody },
              },
              { onSuccess: () => setTmplEmailDialogOpen(false) },
            );
          }}
        />
      )}

      {/* Issue confirmation — the cover email is NOT edited here. It's
          whatever is saved on the selected cert template (set up once in the
          Templates tab), falling back to the cert system default if blank. The
          send snapshots subject + body onto the run row, so a later template
          edit doesn't change in-flight emails. Mounted at page level so it's
          anchored regardless of the active tab. */}
      {(() => {
        const target = issueTemplateId
          ? templates.find((t) => t.id === issueTemplateId) ?? null
          : null;
        if (!target) return null;
        const subject = target.emailSubject?.trim().length
          ? target.emailSubject
          : SYSTEM_DEFAULT_SUBJECT;
        const body = target.emailBody?.trim().length
          ? target.emailBody
          : defaultBodyForCategory(target.category);
        const usingDefault = !target.emailSubject?.trim().length && !target.emailBody?.trim().length;
        const count = eligibilityQuery.data?.eligibleCount ?? 0;
        return (
          <Dialog open={emailDialogOpen} onOpenChange={setEmailDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  Issue &amp; email {count} {count === 1 ? "certificate" : "certificates"}?
                </DialogTitle>
                <DialogDescription>
                  The cover email saved on the <strong>{target.name}</strong>{" "}
                  template is sent, with each certificate PDF attached. Tokens
                  (e.g. <code>{`{{recipientName}}`}</code>) resolve per recipient.
                  {usingDefault
                    ? " This template has no custom cover email, so the system default is used."
                    : " To change it, edit this template's cover email in the Templates tab."}
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                <span className="text-xs font-medium text-muted-foreground">Subject</span>
                <p className="mt-0.5 font-medium break-words">{subject}</p>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setEmailDialogOpen(false)}
                  disabled={issueMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    if (!issueTemplateId || !issueTag) return;
                    issueMutation.mutate(
                      { templateId: issueTemplateId, tag: issueTag, emailSubject: subject, emailBody: body },
                      { onSuccess: () => setEmailDialogOpen(false) },
                    );
                  }}
                  disabled={issueMutation.isPending || count === 0}
                >
                  {issueMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4 mr-1" />
                  )}
                  Send
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        );
      })()}
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
