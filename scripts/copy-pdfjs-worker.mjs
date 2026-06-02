#!/usr/bin/env node
/**
 * Copy the pdfjs-dist Web Worker into `public/pdfjs/` so the cert
 * canvas editor can load it self-hosted (no external CDN, PDPL-friendly).
 * Run as part of `postinstall` so the file stays in lockstep with the
 * installed pdfjs-dist version on every CI run + EC2 deploy.
 *
 * Idempotent. Skips silently if pdfjs-dist isn't installed (e.g. a
 * --production install on a sub-project that doesn't need the editor).
 */
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const src = join(repoRoot, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
const destDir = join(repoRoot, "public/pdfjs");
const dest = join(destDir, "pdf.worker.min.mjs");

if (!existsSync(src)) {
  console.log("[copy-pdfjs-worker] pdfjs-dist not installed, skipping");
  process.exit(0);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[copy-pdfjs-worker] ${src} -> ${dest}`);
