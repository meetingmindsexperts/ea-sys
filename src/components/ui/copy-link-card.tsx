"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link2, Copy, Check } from "lucide-react";

interface CopyLinkCardProps {
  label: string;
  description: string;
  slug: string;
  path?: string;
}

export function CopyLinkCard({ label, description, slug, path = "register" }: CopyLinkCardProps) {
  const [copied, setCopied] = useState(false);

  const publicUrl = `${process.env.NEXT_PUBLIC_APP_URL || ""}/e/${slug}/${path}`;

  const handleCopy = () => {
    const url = `${window.location.origin}/e/${slug}/${path}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Link2 className="h-4 w-4 text-primary" />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">{description}</p>
        <div className="flex items-center gap-2">
          <code className="flex-1 rounded-md bg-muted px-3 py-2 text-sm font-mono truncate select-all">
            {publicUrl}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={handleCopy}
          >
            {copied ? (
              <><Check className="h-4 w-4 mr-1 text-green-600" /> Copied</>
            ) : (
              <><Copy className="h-4 w-4 mr-1" /> Copy</>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
