"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  Camera,
  Keyboard,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Users,
  ScanBarcode,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEvent, useRegistrations } from "@/hooks/use-api";
import { formatPersonName } from "@/lib/utils";
import { toast } from "sonner";

// Lazy-load camera scanner (heavy library)
const CameraScanner = dynamic(() => import("./camera-scanner"), {
  ssr: false,
  loading: () => (
    <div className="h-64 bg-muted/50 rounded-lg animate-pulse flex items-center justify-center">
      <Camera className="h-8 w-8 text-muted-foreground" />
    </div>
  ),
});

interface ScanResult {
  id: string;
  type: "success" | "error" | "warning";
  name: string;
  message: string;
  ticketType?: string;
  timestamp: Date;
}

// Audio feedback using Web Audio API
function playBeep(success: boolean) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = success ? 800 : 300;
    osc.type = success ? "sine" : "square";
    gain.gain.value = 0.3;
    osc.start();
    osc.stop(ctx.currentTime + (success ? 0.15 : 0.3));
  } catch {
    // Audio not supported
  }
}

export default function CheckInPage() {
  const params = useParams();
  const eventId = params.eventId as string;
  const { data: event } = useEvent(eventId);
  const { data: registrations = [] } = useRegistrations(eventId);

  const [mode, setMode] = useState<"camera" | "manual">("manual");
  const [manualInput, setManualInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [recentScans, setRecentScans] = useState<ScanResult[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastScanRef = useRef<string>("");

  const checkedInCount = registrations.filter((r) => r.status === "CHECKED_IN").length;
  const totalCount = registrations.filter((r) => r.status !== "CANCELLED").length;

  // Auto-focus manual input
  useEffect(() => {
    if (mode === "manual") {
      inputRef.current?.focus();
    }
  }, [mode]);

  const handleCheckIn = useCallback(async (code: string) => {
    const trimmed = code.trim();
    if (!trimmed || scanning) return;

    // Debounce — prevent double-scan of same code within 2s
    if (trimmed === lastScanRef.current) return;
    lastScanRef.current = trimmed;
    setTimeout(() => { lastScanRef.current = ""; }, 2000);

    setScanning(true);

    try {
      // Use the PUT endpoint which searches by qrCode/barcode
      const res = await fetch(
        `/api/events/${eventId}/registrations/_/check-in`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ qrCode: trimmed }),
        }
      );

      const data = await res.json();

      if (res.ok) {
        const name = formatPersonName(
          data.attendee?.title,
          data.attendee?.firstName || "",
          data.attendee?.lastName || "",
        );

        const result: ScanResult = {
          id: crypto.randomUUID(),
          type: "success",
          name,
          message: "Checked in successfully",
          ticketType: data.ticketType?.name,
          timestamp: new Date(),
        };
        setRecentScans((prev) => [result, ...prev.slice(0, 9)]);
        if (soundEnabled) playBeep(true);
      } else if (res.status === 400 && data.error?.includes("Already checked in")) {
        const name = data.registration
          ? formatPersonName(
              data.registration.attendee?.title,
              data.registration.attendee?.firstName || "",
              data.registration.attendee?.lastName || "",
            )
          : "Unknown";

        const result: ScanResult = {
          id: crypto.randomUUID(),
          type: "warning",
          name,
          message: "Already checked in",
          timestamp: new Date(),
        };
        setRecentScans((prev) => [result, ...prev.slice(0, 9)]);
        if (soundEnabled) playBeep(false);
      } else {
        const result: ScanResult = {
          id: crypto.randomUUID(),
          type: "error",
          name: trimmed,
          message: data.error || "Not found",
          timestamp: new Date(),
        };
        setRecentScans((prev) => [result, ...prev.slice(0, 9)]);
        if (soundEnabled) playBeep(false);
      }
    } catch (err) {
      console.error("[check-in] scan failed", err);
      toast.error("Network error");
    } finally {
      setScanning(false);
      setManualInput("");
      inputRef.current?.focus();
    }
  }, [eventId, scanning, soundEnabled]);

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleCheckIn(manualInput);
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b shadow-sm sticky top-0 z-10">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href={`/events/${eventId}/registrations`}>
              <ArrowLeft className="h-5 w-5 text-muted-foreground" />
            </Link>
            <div>
              <h1 className="font-bold text-lg leading-tight">Check-In</h1>
              {event && (
                <p className="text-xs text-muted-foreground truncate max-w-[200px] sm:max-w-none">
                  {event.name}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSoundEnabled(!soundEnabled)}
              className="h-8 w-8"
            >
              {soundEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-4 space-y-4">
        {/* Stats */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                <span className="text-sm font-medium">Attendance</span>
              </div>
              <div className="text-right">
                <span className="text-2xl font-bold text-primary">{checkedInCount}</span>
                <span className="text-lg text-muted-foreground"> / {totalCount}</span>
              </div>
            </div>
            {totalCount > 0 && (
              <div className="mt-2 w-full bg-slate-100 rounded-full h-2">
                <div
                  className="bg-primary rounded-full h-2 transition-all"
                  style={{ width: `${Math.round((checkedInCount / totalCount) * 100)}%` }}
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Mode Tabs */}
        <div className="flex rounded-lg bg-white border p-1 gap-1">
          <button
            onClick={() => setMode("camera")}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-medium transition-colors ${
              mode === "camera"
                ? "bg-primary text-white"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            <Camera className="h-4 w-4" />
            Camera
          </button>
          <button
            onClick={() => setMode("manual")}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-medium transition-colors ${
              mode === "manual"
                ? "bg-primary text-white"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            <Keyboard className="h-4 w-4" />
            Scanner / Manual
          </button>
        </div>

        {/* Scanner Area */}
        {mode === "camera" ? (
          <CameraScanner onScan={handleCheckIn} />
        ) : (
          <Card>
            <CardContent className="p-4">
              <form onSubmit={handleManualSubmit} className="flex gap-2">
                <div className="relative flex-1">
                  <ScanBarcode className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    ref={inputRef}
                    value={manualInput}
                    onChange={(e) => setManualInput(e.target.value)}
                    placeholder="Scan or type barcode..."
                    className="pl-10 h-12 text-lg font-mono"
                    autoFocus
                    autoComplete="off"
                  />
                </div>
                <Button type="submit" className="h-12 px-6" disabled={!manualInput.trim() || scanning}>
                  Check In
                </Button>
              </form>
              <p className="text-xs text-muted-foreground mt-2">
                Point a hardware barcode scanner at this field, or type a barcode/QR code and press Enter.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Recent Scans */}
        {recentScans.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-muted-foreground px-1">Recent Scans</h3>
            <div className="space-y-1.5">
              {recentScans.map((scan) => (
                <div
                  key={scan.id}
                  className={`flex items-center gap-3 rounded-lg border p-3 bg-white ${
                    scan.type === "success"
                      ? "border-green-200"
                      : scan.type === "warning"
                        ? "border-amber-200"
                        : "border-red-200"
                  }`}
                >
                  {scan.type === "success" ? (
                    <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
                  ) : scan.type === "warning" ? (
                    <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
                  ) : (
                    <XCircle className="h-5 w-5 text-red-500 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{scan.name}</p>
                    <p className="text-xs text-muted-foreground">{scan.message}</p>
                  </div>
                  {scan.ticketType && (
                    <Badge variant="outline" className="shrink-0 text-xs">
                      {scan.ticketType}
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground shrink-0">
                    {scan.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
