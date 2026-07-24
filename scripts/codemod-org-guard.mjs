// One-off codemod: guard the `organizationId!` footgun across event API routes.
//
// For each src/app/api/events/**/route.ts that uses
// `session.user.organizationId!`:
//   1. add `import { requireOrgId } from "@/lib/require-org";`
//   2. after EACH standard auth block
//        if (!session?.user) { return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
//      insert:
//        const orgGuard = requireOrgId(session);
//        if ("error" in orgGuard) return orgGuard.error;
//   3. replace every `session.user.organizationId!` with `orgGuard.orgId`
//
// Idempotent (skips files that already import requireOrgId). tsc is the safety
// net: any handler that used the footgun but lacks the standard auth block ends
// up referencing an undefined `orgGuard` → a tsc error we fix by hand.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "src/app/api/events");
const FOOTGUN = /session\.user\.organizationId!/g;

// Standard auth block, tolerant of whitespace between tokens.
const AUTH_BLOCK =
  /if \(!session\?\.user\) \{\s*return NextResponse\.json\(\s*\{ error: "Unauthorized" \},\s*\{ status: 401 \},?\s*\);\s*\}/g;

const GUARD = `
    const orgGuard = requireOrgId(session);
    if ("error" in orgGuard) return orgGuard.error;`;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

let changed = 0;
const skipped = [];
const noAuthBlock = [];

for (const file of walk(ROOT)) {
  let src = readFileSync(file, "utf8");
  if (!FOOTGUN.test(src)) continue;
  FOOTGUN.lastIndex = 0;
  if (src.includes('from "@/lib/require-org"')) {
    skipped.push(file);
    continue;
  }

  const authMatches = src.match(AUTH_BLOCK)?.length ?? 0;
  if (authMatches === 0) {
    noAuthBlock.push(file);
    continue; // leave for manual handling
  }

  // 1. import — after the auth import if present, else after the first import.
  if (/import \{ auth \} from "@\/lib\/auth";/.test(src)) {
    src = src.replace(
      /import \{ auth \} from "@\/lib\/auth";/,
      `import { auth } from "@/lib/auth";\nimport { requireOrgId } from "@/lib/require-org";`,
    );
  } else {
    src = src.replace(/(^import .*;$)/m, `$1\nimport { requireOrgId } from "@/lib/require-org";`);
  }

  // 2. insert the guard after each auth block.
  src = src.replace(AUTH_BLOCK, (m) => m + GUARD);

  // 3. replace the footgun.
  src = src.replace(FOOTGUN, "orgGuard.orgId");

  writeFileSync(file, src, "utf8");
  changed++;
}

console.log(`codemod: rewrote ${changed} file(s)`);
if (skipped.length) console.log(`already-guarded (skipped): ${skipped.length}`);
if (noAuthBlock.length) {
  console.log(`NO standard auth block — MANUAL (${noAuthBlock.length}):`);
  for (const f of noAuthBlock) console.log("   " + f.replace(process.cwd() + "/", ""));
}
