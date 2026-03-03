/**
 * Startup validation for required environment variables.
 * Called from instrumentation.ts so the app fails fast with clear errors
 * instead of crashing later with opaque Prisma/auth errors.
 */

const REQUIRED_VARS = [
  "DATABASE_URL",
  "NEXTAUTH_SECRET",
  "NEXTAUTH_URL",
] as const;

const RECOMMENDED_VARS = [
  "NEXT_PUBLIC_APP_URL",
  "BREVO_API_KEY",
  "EMAIL_FROM",
] as const;

export function validateEnv(): void {
  const missing: string[] = [];

  for (const key of REQUIRED_VARS) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    const message = [
      "",
      "=".repeat(60),
      " FATAL: Missing required environment variables",
      "=".repeat(60),
      "",
      ...missing.map((key) => `  - ${key}`),
      "",
      " The application cannot start without these variables.",
      " Check your .env file or deployment configuration.",
      "=".repeat(60),
      "",
    ].join("\n");

    console.error(message);
    process.exit(1);
  }

  // Warn about recommended but non-critical vars
  const warnings: string[] = [];
  for (const key of RECOMMENDED_VARS) {
    if (!process.env[key]) {
      warnings.push(key);
    }
  }

  if (warnings.length > 0) {
    console.warn(
      `[env] Warning: Missing recommended environment variables: ${warnings.join(", ")}. Some features (email, public URLs) may not work correctly.`
    );
  }

  // Validate Supabase Storage vars when provider is set to "supabase"
  if (process.env.STORAGE_PROVIDER === "supabase") {
    const supabaseVars = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
    const missingSupabase = supabaseVars.filter((key) => !process.env[key]);
    if (missingSupabase.length > 0) {
      const message = [
        "",
        "=".repeat(60),
        " FATAL: STORAGE_PROVIDER=supabase but missing required variables",
        "=".repeat(60),
        "",
        ...missingSupabase.map((key) => `  - ${key}`),
        "",
        " Set these in your .env file or deployment configuration.",
        "=".repeat(60),
        "",
      ].join("\n");
      console.error(message);
      process.exit(1);
    }
  }
}
