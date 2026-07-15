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

  // Same rule for the worker tier: only the reminders job shim may reach into
  // src/crm/.
  {
    files: ["worker/**/*.ts"],
    ignores: ["worker/jobs/crm-reminders.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/crm", "@/crm/*", "@/crm/**"],
              message:
                "Only worker/jobs/crm-reminders.ts may import from src/crm/. See docs/CRM_MODULE_PLAN.md §7.0.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
