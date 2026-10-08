#!/usr/bin/env node
/**
 * Rebuild the EHC online venue EA-SYS serves at /e/<slug>/venue.
 *
 *   npm run venue:build             # the vendor's own build.py (python3)
 *   npm run venue:build -- --node   # the same join in Node, no Python needed
 *   VENUE_BUILDER=node npm run venue:build
 *
 * Same two-builder arrangement as scripts/blueprint-build.mjs (owner's choice,
 * Oct 8, 2026): both write identical bytes to vendor/ehc-venue/dist/. The page
 * is then written into src/lib/venue/page-html.generated.json (JSON, not .ts:
 * it is the vendor's browser code, and the repo's source scanners read every
 * .ts file). Python only ever runs on the machine that rebuilds, never on the
 * server. Run after ANY change under vendor/ehc-venue/src/.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extractVocab } from "./venue-vocab.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(ROOT, "vendor/ehc-venue");
const DIST = path.join(VENDOR, "dist");
const OUT = path.join(ROOT, "src/lib/venue/page-html.generated.json");
const VOCAB_OUT = path.join(ROOT, "src/lib/venue/persona-vocab.generated.json");

/** build.py's module order: each file uses what the ones before define. */
const ORDER = ["engine", "textures", "world", "chars", "physics", "audio", "filter", "social", "abilities", "team", "game"];

const useNode = process.argv.includes("--node") || process.env.VENUE_BUILDER === "node";

function buildWithNode() {
  const src = (f) => readFileSync(path.join(VENDOR, "src", f), "utf8");
  const page = src("shell.html") + "\n<script>\n" + ORDER.map((n) => src(`${n}.js`)).join("\n") + "\n</script>\n";
  mkdirSync(DIST, { recursive: true });
  writeFileSync(path.join(DIST, "index.html"), page);
  writeFileSync(
    path.join(DIST, "test.html"),
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
      "<style>body{margin:0}[hidden]{display:none!important}</style><script>window.__EHC_TEST=1</script></head><body>" +
      page +
      "</body></html>",
  );
  const screens = path.join(VENDOR, "screens.json");
  if (!existsSync(screens)) writeFileSync(screens, "{}\n");
  copyFileSync(screens, path.join(DIST, "screens.json"));
  console.log(`${Buffer.byteLength(page)} bytes -> dist/index.html (node)`);
}

function buildWithPython() {
  try {
    execFileSync("python3", [path.join(VENDOR, "build.py")], { stdio: "inherit" });
  } catch (err) {
    console.error("\npython3 could not run build.py. Use the Node builder instead:\n  npm run venue:build -- --node\n");
    throw err;
  }
}

if (useNode) buildWithNode();
else buildWithPython();

const html = readFileSync(path.join(DIST, "index.html"), "utf8");
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ generatedBy: "scripts/venue-build.mjs", source: "vendor/ehc-venue/dist/index.html", html }) + "\n");
console.log(`${Buffer.byteLength(html)} bytes -> ${path.relative(ROOT, OUT)}`);

const vocab = extractVocab(readFileSync(path.join(VENDOR, "src/social.js"), "utf8"), readFileSync(path.join(VENDOR, "src/world.js"), "utf8"));
writeFileSync(VOCAB_OUT, JSON.stringify(vocab) + "\n");
console.log(`${vocab.ROLES.length} roles, ${vocab.PEOPLE_NAMES.f.length + vocab.PEOPLE_NAMES.m.length} names -> ${path.relative(ROOT, VOCAB_OUT)}`);

