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
]);

export default eslintConfig;
