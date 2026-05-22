"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Camera, CameraOff } from "lucide-react";

interface CameraScannerProps {
  onScan: (code: string) => void;
}

export default function CameraScanner({ onScan }: CameraScannerProps) {
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const rawId = useId();
  const containerId = "checkin-camera-" + rawId.replace(/:/g, "-");

  useEffect(() => {
    return () => {
      // Cleanup on unmount (e.g. switching back to the Scanner/Manual tab).
      // stop() is ASYNC; clear() throws "Cannot clear while scan is in progress"
      // if called before stop() resolves. A throw here escapes into React's
      // effect-cleanup and bubbles to the dashboard error boundary
      // ("Something went wrong"). So: null the ref first, then sequence
      // stop() -> clear() and swallow every error — a teardown failure must
      // never crash the page.
      const scanner = scannerRef.current;
      scannerRef.current = null;
      if (!scanner) return;
      Promise.resolve()
        .then(() => scanner.stop())
        .catch(() => { /* not scanning / already stopped */ })
        .then(() => {
          try {
            scanner.clear();
          } catch {
            /* element already gone */
          }
        });
    };
  }, []);

  const startCamera = async () => {
    setError(null);
    // Defensive: tear down any lingering instance before starting a new one,
    // otherwise the browser can report the camera as already in use.
    if (scannerRef.current) {
      const old = scannerRef.current;
      scannerRef.current = null;
      try { await old.stop(); } catch { /* not scanning */ }
      try { old.clear(); } catch { /* already cleared */ }
    }
    try {
      const scanner = new Html5Qrcode(containerId);
      scannerRef.current = scanner;

      await scanner.start(
        { facingMode: "environment" },
        {
          fps: 10,
          qrbox: { width: 250, height: 150 },
          aspectRatio: 1.5,
        },
        (decodedText) => {
          onScan(decodedText);
        },
        () => {
          // Ignore scan failures (no code detected in frame)
        }
      );
      setStarted(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Camera access denied";
      // Surface in the UI (no server logger on the client) + browser console
      // with context so it's findable in devtools / Sentry breadcrumbs.
      console.error("[check-in] camera start failed", err);
      setError(msg);
      scannerRef.current = null;
    }
  };

  const stopCamera = async () => {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    if (scanner) {
      try { await scanner.stop(); } catch { /* not scanning */ }
      try { scanner.clear(); } catch { /* already cleared */ }
    }
    setStarted(false);
  };

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div
          id={containerId}
          className="rounded-lg overflow-hidden bg-black"
          style={{ minHeight: started ? 280 : 0 }}
        />

        {!started && (
          <div className="flex flex-col items-center gap-3 py-6">
            <Camera className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground text-center">
              Use your device camera to scan barcodes and QR codes
            </p>
            <Button onClick={startCamera}>
              <Camera className="mr-2 h-4 w-4" />
              Start Camera
            </Button>
          </div>
        )}

        {started && (
          <Button variant="outline" onClick={stopCamera} className="w-full">
            <CameraOff className="mr-2 h-4 w-4" />
            Stop Camera
          </Button>
        )}

        {error && (
          <p className="text-sm text-red-500 text-center">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}
