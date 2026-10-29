"use client";

/**
 * "Showing N of M" and a Load more button under a server-paged CRM list
 * (Oct 29, 2026; contacts and accounts). Unlike the truncation banner, nothing
 * is hidden: every row is one click away, and the sort is the server's, so
 * the first page is the true top of the list.
 */
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ListLoadMore({
  shown,
  total,
  noun,
  hasMore,
  loading,
  onLoadMore,
}: {
  shown: number;
  /** Rows matching the filters; null until the first page has arrived. */
  total: number | null;
  /** Plural noun for the copy, e.g. "contacts". */
  noun: string;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
      <p className="tabular-nums" role="status">
        Showing {shown.toLocaleString()}
        {total !== null && ` of ${total.toLocaleString()}`} {noun}
      </p>
      {hasMore && (
        <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loading}>
          {loading && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
          Load more
        </Button>
      )}
    </div>
  );
}
