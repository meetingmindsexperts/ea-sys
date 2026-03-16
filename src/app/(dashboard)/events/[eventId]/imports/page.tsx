"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { useImportLogs } from "@/hooks/use-api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, History, ChevronDown, ChevronUp } from "lucide-react";

interface SkippedContact {
  email: string;
  reason: string;
}

interface ImportLog {
  id: string;
  source: string;
  entityType: string;
  totalProcessed: number;
  totalCreated: number;
  totalSkipped: number;
  totalErrors: number;
  skippedDetails: SkippedContact[];
  errors: string[];
  createdAt: string;
}

export default function ImportsPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const { data: logs = [], isLoading } = useImportLogs(eventId);
  const [selectedLog, setSelectedLog] = useState<ImportLog | null>(null);

  const typedLogs = logs as ImportLog[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Import History</h1>
        <p className="text-sm text-muted-foreground mt-1">
          View past imports and skipped contact details.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4" />
            Import Logs
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12 gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading import history...
            </div>
          ) : typedLogs.length === 0 ? (
            <div className="text-center py-12 text-sm text-muted-foreground">
              No imports yet for this event.
            </div>
          ) : (
            <div className="border rounded-md overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Processed</TableHead>
                    <TableHead className="text-right">Created</TableHead>
                    <TableHead className="text-right">Skipped</TableHead>
                    <TableHead className="text-right">Errors</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {typedLogs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="text-xs whitespace-nowrap">
                        {new Date(log.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs capitalize">
                          {log.source}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {log.totalProcessed}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-green-600">
                        {log.totalCreated}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-amber-600">
                        {log.totalSkipped}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-destructive">
                        {log.totalErrors}
                      </TableCell>
                      <TableCell>
                        {(log.totalSkipped > 0 || log.totalErrors > 0) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSelectedLog(log)}
                          >
                            Details
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Detail dialog */}
      <ImportLogDetailDialog
        log={selectedLog}
        onClose={() => setSelectedLog(null)}
      />
    </div>
  );
}

function ImportLogDetailDialog({
  log,
  onClose,
}: {
  log: ImportLog | null;
  onClose: () => void;
}) {
  const [showSkipped, setShowSkipped] = useState(true);
  const [showErrors, setShowErrors] = useState(true);

  if (!log) return null;

  const skipped = (log.skippedDetails ?? []) as SkippedContact[];
  const errors = (log.errors ?? []) as string[];

  return (
    <Dialog open={!!log} onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Import Details
            <Badge variant="outline" className="text-xs capitalize">
              {log.source}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="text-sm text-muted-foreground mb-2">
          {new Date(log.createdAt).toLocaleString()} &mdash;{" "}
          <strong>{log.totalProcessed}</strong> processed,{" "}
          <span className="text-green-600"><strong>{log.totalCreated}</strong> created</span>,{" "}
          <span className="text-amber-600"><strong>{log.totalSkipped}</strong> skipped</span>,{" "}
          <span className="text-destructive"><strong>{log.totalErrors}</strong> errors</span>
        </div>

        <div className="flex-1 overflow-auto space-y-3">
          {/* Skipped contacts */}
          {skipped.length > 0 && (
            <div className="border rounded-md">
              <button
                type="button"
                className="w-full flex items-center justify-between p-3 text-sm font-medium text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded-t-md"
                onClick={() => setShowSkipped((v) => !v)}
              >
                <span>{skipped.length} skipped contact{skipped.length !== 1 ? "s" : ""}</span>
                {showSkipped ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
              {showSkipped && (
                <div className="max-h-48 overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-1.5 font-medium">Email</th>
                        <th className="text-left px-3 py-1.5 font-medium">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {skipped.map((s, i) => (
                        <tr key={i}>
                          <td className="px-3 py-1 font-mono">{s.email}</td>
                          <td className="px-3 py-1 text-muted-foreground">{s.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Errors */}
          {errors.length > 0 && (
            <div className="border rounded-md">
              <button
                type="button"
                className="w-full flex items-center justify-between p-3 text-sm font-medium text-destructive bg-destructive/5 rounded-t-md"
                onClick={() => setShowErrors((v) => !v)}
              >
                <span>{errors.length} error{errors.length !== 1 ? "s" : ""}</span>
                {showErrors ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </button>
              {showErrors && (
                <ul className="max-h-48 overflow-auto text-xs text-muted-foreground p-3 space-y-0.5">
                  {errors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {skipped.length === 0 && errors.length === 0 && (
            <div className="text-center py-8 text-sm text-muted-foreground">
              No details to show — all contacts were imported successfully.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
