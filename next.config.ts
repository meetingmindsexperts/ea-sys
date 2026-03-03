import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  output: "standalone",

  // Allow Next.js Image optimization for Supabase Storage CDN URLs
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },

  // Optimize barrel imports for large packages - reduces bundle size significantly
  experimental: {
    optimizePackageImports: [
      "lucide-react",
      "@radix-ui/react-icons",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-dialog",
      "@radix-ui/react-select",
      "@radix-ui/react-tabs",
      "@radix-ui/react-avatar",
      "@radix-ui/react-tooltip",
    ],
  },

  // Transpile specific packages for better tree-shaking
  transpilePackages: ["@getbrevo/brevo"],

  // Enable Turbopack (default in Next.js 16)
  turbopack: {},
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Suppress source map upload logs unless in CI
  silent: !process.env.CI,

  // Disable telemetry
  telemetry: false,
});
