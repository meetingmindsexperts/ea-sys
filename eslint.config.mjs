import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // pdfjs-dist worker — 1.3MB minified third-party bundle copied into
    // public/pdfjs/ by scripts/copy-pdfjs-worker.mjs at postinstall.
    // Linting third-party minified code is noise; skip the folder.
    "public/pdfjs/**",
  ]),

  // ── CRM module import boundary (docs/CRM_MODULE_PLAN.md §7.0) ──────────────
  //
  // The CRM is a bounded module INSIDE the app: src/crm/ may import core, but
  // CORE MUST NEVER IMPORT src/crm/. That one-way rule is what keeps the module
  // liftable later — and, more immediately, keeps the CRM from quietly becoming
  // a twelfth thing you have to hold in your head while debugging a registration.
  //
  // Enforced mechanically rather than by discipline, because "we'll remember" is
  // precisely how the webinar module's decouplable namespace started to leak.
  //
  // §7.0 permits exactly THREE core-side code touch points (plus the schema FKs,
  // which aren't imports): the sidebar entry, the MCP tool registration, and the
  // worker job shim. They are exempted by name below, so adding a fourth is a
  // deliberate act — editing this file — rather than an accident nobody notices.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      // ── INSIDE the module (§7.0 defines the namespace as all three of these) ──
      // Code root, API namespace, UI namespace. These ARE the CRM; the one-way
      // rule governs what CORE may import, not what the module imports from
      // itself.
      "src/crm/**",
      "src/app/api/crm/**",
      "src/app/(dashboard)/crm/**",

      // ── Permitted core-side touch points (§7.0) — keep this list SHORT ──
      "src/components/layout/sidebar.tsx",
      "src/lib/agent/mcp-server-builder.ts",
      "src/lib/agent/register-mcp-tools.ts",
      // NOTE: contact-detail-sheet.tsx was briefly exempted here (July 14) so the
      // CRM could put a company/lifecycle picker on the EVENT contact sheet. That
      // was reverted the same day: business contacts (pharma reps, exhibitor sales)
      // are a DIFFERENT POPULATION and now live in their own CrmContact table, so
      // core's contact sheet has no CRM fields and needs no exemption. Back to three.
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/crm", "@/crm/*", "@/crm/**"],
              message:
                "Core must not import from src/crm/. The CRM import boundary is one-way (src/crm/ -> core only) — see docs/CRM_MODULE_PLAN.md §7.0. If you genuinely need a new core-side touch point, add it to the exemption list in eslint.config.mjs deliberately.",
            },
          ],
        },
      ],
    },
  },

  // Same rule for the worker tier: only the CRM job shims may reach into
  // src/crm/.
  {
    files: ["worker/**/*.ts"],
    ignores: ["worker/jobs/crm-reminders.ts", "worker/jobs/crm-inbound-email.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/crm", "@/crm/*", "@/crm/**"],
              message:
                "Only the CRM job shims (worker/jobs/crm-reminders.ts, crm-inbound-email.ts) may import from src/crm/. See docs/CRM_MODULE_PLAN.md §7.0.",
            },
          ],
        },
      ],
    },
  },

  // ── HR module import boundary (docs/HR_MODULE_PLAN.md §2) ─────────────────
  //
  // Same one-way rule as the CRM above, for the same reason: src/hr/ may import
  // core, core must never import src/hr/. Mechanical rather than disciplinary,
  // because "we'll remember" is how a bounded namespace stops being bounded.
  //
  // The HR module has a second reason to hold this line that the CRM does not.
  // It is MASTER-SILO ONLY (HR_MODULE_ENABLED), so a core file importing from
  // src/hr/ would drag a module that is switched off on the platform into a code
  // path that runs there. The flag would still refuse the request; the import
  // would still be dead weight in every tenant's bundle, and the next person
  // would reasonably conclude the module ships everywhere.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      // Inside the module: code root, API namespace, UI namespace.
      "src/hr/**",
      "src/app/api/hr/**",
      "src/app/(dashboard)/hr/**",
      // Permitted core-side touch points. Keep this list SHORT; adding a fourth
      // should mean editing this file on purpose, not noticing later.
      "src/components/layout/sidebar.tsx",
      "src/lib/agent/mcp-server-builder.ts",
      "src/lib/agent/register-mcp-tools.ts",
      // NOTE: the availability flag deliberately does NOT live in src/hr/. It
      // needed three exemptions here within one step, which is the signal that a
      // file is on the wrong side of a boundary, so it moved to
      // src/lib/module-flags.ts and the list stayed at three.
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/hr", "@/hr/*", "@/hr/**"],
              message:
                "Core must not import from src/hr/. The HR import boundary is one-way (src/hr/ -> core only) and the module is master-silo only — see docs/HR_MODULE_PLAN.md §2. If you genuinely need a new core-side touch point, add it to the exemption list in eslint.config.mjs deliberately.",
            },
          ],
        },
      ],
    },
  },

  // Same rule for the worker tier: only the HR job shim may reach into src/hr/.
  {
    files: ["worker/**/*.ts"],
    ignores: ["worker/jobs/hr-year-roll.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/hr", "@/hr/*", "@/hr/**"],
              message:
                "Only the HR job shim (worker/jobs/hr-year-roll.ts) may import from src/hr/. See docs/HR_MODULE_PLAN.md §2.",
            },
          ],
        },
      ],
    },
  },

  // ── Analytics core import boundary (docs/ANALYTICS_PLAN.md §7) ─────────────
  //
  // The INVERSE of the CRM rule above, and stricter. src/analytics/core/ must
  // import NOTHING from EA-SYS: not @/lib/db, not the logger, not next/server.
  // Node built-ins are fine.
  //
  // The point is that core/ could be lifted out as a standalone package. That
  // is not a commitment to publish it (§7.4 leaves that decision open), but the
  // discipline is worth having either way: a directory that imports nothing is
  // one you can test without a database and reason about without holding the
  // rest of the app in your head.
  //
  // The adapter lives one level up, in src/analytics/store/, which may import
  // whatever it likes. If core seems to need something from the app, the answer
  // is almost always to pass it in as a parameter instead.
  {
    files: ["src/analytics/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/*", "@/**", "../*", "../**"],
              message:
                "src/analytics/core/ must not import from EA-SYS — it is meant to be extractable (docs/ANALYTICS_PLAN.md §7). Pass what you need in as a parameter, or put the code in src/analytics/store/ which has no such restriction.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
